import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BUILD_VERSION } from './buildInfo'
import {
  applyUpdate,
  checkForUpdates,
  isNewerBuildVersion,
  registerServiceWorker,
  subscribeVersionPinned,
  UpdateBlockedError,
} from './registerServiceWorker'

describe('isNewerBuildVersion flags only strictly newer builds', () => {
  it('flags only strictly newer builds', () => {
    expect(isNewerBuildVersion('abc1234.20260611T040000000Z', 'abc1234.20260611T030000000Z')).toBe(
      true,
    )
    // Same build: no indicator.
    expect(isNewerBuildVersion('abc1234.20260611T030000000Z', 'abc1234.20260611T030000000Z')).toBe(
      false,
    )
    // The post-update shape — a registration worker on an OLDER build than
    // the page (pin moved, worker swap lagging) — must NOT raise the badge.
    expect(isNewerBuildVersion('abc1234.20260611T020000000Z', 'def5678.20260611T030000000Z')).toBe(
      false,
    )
    // Different hash, newer timestamp: a genuinely newer build.
    expect(isNewerBuildVersion('def5678.20260612T010000000Z', 'abc1234.20260611T030000000Z')).toBe(
      true,
    )
  })
})

// A `fetch` that never settles on its own and only rejects when its abort signal
// fires — the real-world "stalled origin" the timeout exists to defend against.
const stalledFetch = () =>
  vi.stubGlobal(
    'fetch',
    (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        )
      }),
  )

describe('checkForUpdates network bounds', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('reports an error instead of hanging when the manifest fetch stalls past the timeout', async () => {
    stalledFetch()

    const result = checkForUpdates()
    // Nothing resolves until the 8s client timeout aborts the request.
    await vi.advanceTimersByTimeAsync(8_000)

    await expect(result).resolves.toEqual({ status: 'error' })
  })

  it('collapses a caller cancel to an error result (the UI suppresses it)', async () => {
    stalledFetch()

    const controller = new AbortController()
    const result = checkForUpdates(controller.signal)
    controller.abort()

    // No timer advance needed: the cancel aborts the in-flight fetch immediately.
    await expect(result).resolves.toEqual({ status: 'error' })
  })
})

// An update must never repoint the pin / prune the old cache
// while ANY window has a document unlocked. The unlocked session holds the
// exclusive 'enoteweb-vault' Web Lock, so navigator.locks.query() answers
// "another window unlocked?" without leaking lock state into the SW module.
describe('applyUpdate cross-window guard', () => {
  let reloadSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // jsdom's window.location.reload is non-configurable; replace location with a
    // plain object so reloadOnce()'s call is observable.
    reloadSpy = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { reload: reloadSpy },
      writable: true,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const stubLocksQuery = (held: Array<{ name: string }>) => {
    vi.stubGlobal('navigator', {
      ...navigator,
      locks: { query: vi.fn(async () => ({ held })) },
    })
  }

  it('refuses (throws UpdateBlockedError, never reloads/repoints) when another window holds the vault lock', async () => {
    stubLocksQuery([{ name: 'enoteweb-vault' }])

    await expect(applyUpdate(BUILD_VERSION)).rejects.toBeInstanceOf(UpdateBlockedError)
    // The guard runs before the !registration→reloadOnce branch and before any
    // worker message, so nothing was reloaded and no pin could be repointed.
    expect(reloadSpy).not.toHaveBeenCalled()
  })

  it('does not refuse (no UpdateBlockedError) when no window holds the vault lock', async () => {
    stubLocksQuery([{ name: 'some-other-lock' }])

    // applyUpdate may resolve, or reject for unrelated reasons depending on the
    // module-level SW `registration` left by a prior (shuffled) test; the guard
    // invariant is only that it never throws UpdateBlockedError here.
    await applyUpdate(BUILD_VERSION).then(
      () => undefined,
      (error) => expect(error).not.toBeInstanceOf(UpdateBlockedError),
    )
  })

  it('degrades open (does not refuse) when navigator.locks.query is unavailable', async () => {
    vi.stubGlobal('navigator', { ...navigator, locks: undefined })

    await applyUpdate(BUILD_VERSION).then(
      () => undefined,
      (error) => expect(error).not.toBeInstanceOf(UpdateBlockedError),
    )
  })
})

// The worker broadcasts VERSION_PINNED after repointing the pin; the
// page-side listener reloads a window only on a STRICTLY NEWER pinned build, so
// a stale/rollback broadcast can never drive a reload loop. The App layer adds
// the !isUnlocked belt-and-braces — an unlocked window is never auto-reloaded
// (it shows the passive notice instead); a locked window reloads onto the new
// pin. That App-layer guard is asserted in App.update.test.tsx.
describe('VERSION_PINNED page-side listener', () => {
  const newerVersion = () => {
    // Build versions are `<hash>.<UTC-timestamp>`; bump the year so the timestamp
    // segment sorts strictly after the running build regardless of when it was cut.
    const stamp = BUILD_VERSION.slice(BUILD_VERSION.indexOf('.') + 1)
    return `feedface.9${stamp.slice(1)}`
  }

  let swTarget: EventTarget
  let unsubscribe: (() => void) | null = null

  beforeEach(async () => {
    vi.stubEnv('PROD', true)

    swTarget = new EventTarget()
    const fakeRegistration = {
      addEventListener: vi.fn(),
      installing: null,
      waiting: null,
      active: null,
    }
    vi.stubGlobal('navigator', {
      ...navigator,
      serviceWorker: Object.assign(swTarget, {
        register: vi.fn(async () => fakeRegistration),
        ready: Promise.resolve(fakeRegistration),
        controller: {},
      }),
    })

    // Registers the single 'message' listener (onServiceWorkerMessage).
    await registerServiceWorker()
  })

  afterEach(() => {
    unsubscribe?.()
    unsubscribe = null
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('notifies subscribers on a strictly-newer pinned version', () => {
    const listener = vi.fn()
    unsubscribe = subscribeVersionPinned(listener)

    const version = newerVersion()
    swTarget.dispatchEvent(
      Object.assign(new Event('message'), { data: { type: 'VERSION_PINNED', version } }),
    )

    expect(listener).toHaveBeenCalledExactlyOnceWith(version)
  })

  it('ignores a same-or-older pinned version (no reload loop)', () => {
    const listener = vi.fn()
    unsubscribe = subscribeVersionPinned(listener)

    // Same build, then a strictly older one (rollback): neither must notify.
    for (const version of [BUILD_VERSION, 'aaaaaaa.10000101T000000000Z']) {
      swTarget.dispatchEvent(
        Object.assign(new Event('message'), { data: { type: 'VERSION_PINNED', version } }),
      )
    }

    expect(listener).not.toHaveBeenCalled()
  })
})
