import { BUILD_VERSION, BUILT_AT } from './buildInfo'
import { isManifestNewer, parseVersionManifest, type VersionManifest } from './update/versionManifest'

declare global {
  interface Window {
    __ENOTEWEB_SW_READY_STATE__?: 'unsupported' | 'disabled' | 'ready' | 'error'
  }
}

export type UpdateCheckResult =
  | { status: 'update-available'; latest: VersionManifest }
  | { status: 'up-to-date' }
  | { status: 'error' }

// ---------------------------------------------------------------------------
// Registration + passive "update available" detection
// ---------------------------------------------------------------------------

// Build versions are `<git-hash>.<UTC-timestamp>` (vite.config.ts); the
// timestamp segment is fixed-width and lexicographically ordered, so plain
// string comparison answers "is this build newer than the running page".
const buildTimestamp = (version: string) => version.slice(version.indexOf('.') + 1)

export const isNewerBuildVersion = (candidate: string, running: string) =>
  candidate !== running && buildTimestamp(candidate) > buildTimestamp(running)

let registration: ServiceWorkerRegistration | null = null
let stagedAvailable = false
const stagedListeners = new Set<(available: boolean) => void>()

const setStagedAvailable = (available: boolean) => {
  if (stagedAvailable === available) {
    return
  }

  stagedAvailable = available
  for (const listener of stagedListeners) {
    listener(available)
  }
}

// A newly *installed* (waiting) worker while a controller already exists means
// the browser has staged another build in the background. This drives the
// passive indicator only — it never starts an update on its own (SPEC Section 14).
// Same strictly-newer guard as at startup: a same-or-older build (for example
// after a server rollback) must not read as an available update.
const trackInstalling = (worker: ServiceWorker | null) => {
  if (!worker) {
    return
  }

  const onStateChange = () => {
    // Remove the listener at any terminal state, not only `installed` with a
    // controller, so a first-install (no controller yet, this worker becomes the
    // long-lived controller) or a `redundant` (superseded) worker does not retain
    // it. The version check still runs only when a controller already exists to
    // compare against — i.e. an update, not a first install — so behavior is
    // unchanged (the query could never fire after the `installed` state anyway).
    if (worker.state === 'installed') {
      worker.removeEventListener('statechange', onStateChange)
      if (navigator.serviceWorker.controller) {
        void queryWorkerVersion(worker, 5_000).then((version) => {
          if (version !== null && isNewerBuildVersion(version, BUILD_VERSION)) {
            setStagedAvailable(true)
          }
        })
      }
    } else if (worker.state === 'redundant') {
      worker.removeEventListener('statechange', onStateChange)
    }
  }
  worker.addEventListener('statechange', onStateChange)
}

export const subscribeStagedUpdate = (listener: (available: boolean) => void): (() => void) => {
  stagedListeners.add(listener)
  listener(stagedAvailable)
  return () => {
    stagedListeners.delete(listener)
  }
}

// Another window applied an update and the worker broadcast VERSION_PINNED: the
// pinned build moved out from under this (still-running, older) window, so it
// must reload onto the new pin before the old cache is pruned. The
// subscriber (App) reloads — safe because the cross-window guard in applyUpdate
// guarantees only LOCKED windows are still running when an update repoints the
// pin. Mirrors subscribeStagedUpdate's shape.
const versionPinnedListeners = new Set<(version: string) => void>()

const notifyVersionPinned = (version: string) => {
  for (const listener of versionPinnedListeners) {
    listener(version)
  }
}

export const subscribeVersionPinned = (listener: (version: string) => void): (() => void) => {
  versionPinnedListeners.add(listener)
  return () => {
    versionPinnedListeners.delete(listener)
  }
}

// The first and only page-side listener for unsolicited SW→page messages (every
// other SW exchange uses a per-call MessageChannel port). Registered once from
// registerServiceWorker() in PROD. A VERSION_PINNED message for a build STRICTLY
// NEWER than this page's own (isNewerBuildVersion) means another window repointed
// the pin forward; a same/older version (a stale or rollback broadcast) is
// ignored so it can never drive a reload loop.
const onServiceWorkerMessage = (event: MessageEvent) => {
  const data = event.data as { type?: string; version?: string } | null
  if (
    data?.type === 'VERSION_PINNED' &&
    typeof data.version === 'string' &&
    isNewerBuildVersion(data.version, BUILD_VERSION)
  ) {
    notifyVersionPinned(data.version)
  }
}

const waitForController = (timeoutMs: number) => {
  if (navigator.serviceWorker.controller) {
    return Promise.resolve()
  }

  return new Promise<void>((resolve) => {
    const done = () => {
      window.clearTimeout(timer)
      navigator.serviceWorker.removeEventListener('controllerchange', done)
      resolve()
    }
    const timer = window.setTimeout(done, timeoutMs)
    navigator.serviceWorker.addEventListener('controllerchange', done)
  })
}

export const registerServiceWorker = async () => {
  if (!import.meta.env.PROD) {
    window.__ENOTEWEB_SW_READY_STATE__ = 'disabled'
    return
  }

  if (!('serviceWorker' in navigator)) {
    window.__ENOTEWEB_SW_READY_STATE__ = 'unsupported'
    return
  }

  try {
    // updateViaCache: 'all' lets the HTTP cache govern how often the browser
    // re-fetches sw.js, rather than bypassing it on every navigation.
    // import.meta.env.BASE_URL is the configured deploy base (always ends in '/'),
    // so the registration path and scope resolve under a subpath deploy instead of
    // the domain root (SPEC §14). At the default base '/' this is unchanged.
    registration = await navigator.serviceWorker.register(
      `${import.meta.env.BASE_URL}sw.js`,
      { scope: import.meta.env.BASE_URL, updateViaCache: 'all' },
    )

    registration.addEventListener('updatefound', () => {
      trackInstalling(registration?.installing ?? null)
    })

    // Listen for the worker's VERSION_PINNED broadcast (another window applied an
    // update). Registered once, here, so subscribers added before this point
    // still receive it.
    navigator.serviceWorker.addEventListener('message', onServiceWorkerMessage)

    await navigator.serviceWorker.ready
    await waitForController(10_000)

    // The passive indicator covers both staged shapes — a WAITING
    // worker, and an ACTIVE worker that finished activating between launches
    // (no waiting worker ever exists in that session) while the page still
    // runs the older pinned build. Each candidate's embedded version must be
    // STRICTLY NEWER than the page's own: right after applying an update the
    // registration routinely holds a worker on an OLDER build than the page
    // (serving is pin-governed; the worker swap lags until every client
    // closes), and a bare version-difference check read that as "Update
    // available" forever.
    const stagedCandidates = [registration.waiting, navigator.serviceWorker.controller]

    for (const worker of stagedCandidates) {
      if (!worker) {
        continue
      }

      const version = await queryWorkerVersion(worker, 5_000)

      if (version !== null && isNewerBuildVersion(version, BUILD_VERSION)) {
        setStagedAvailable(true)
        break
      }
    }

    window.__ENOTEWEB_SW_READY_STATE__ = 'ready'
  } catch {
    window.__ENOTEWEB_SW_READY_STATE__ = 'error'
  }
}

// ---------------------------------------------------------------------------
// User-initiated update check and apply (SPEC Section 14)
// ---------------------------------------------------------------------------

// How long the user-initiated check waits on the network before giving up. A
// stalled origin (server accepts but never responds) would otherwise leave the
// fetch pending forever and trap the user behind the "Checking…" modal.
const MANIFEST_TIMEOUT_MS = 8_000
const SW_UPDATE_TIMEOUT_MS = 8_000

// Resolve when `promise` settles or `ms` elapses, whichever is first; never
// rejects. registration.update() cannot be aborted, so on timeout we simply stop
// waiting and ignore its (possibly never-arriving) result.
const settleWithin = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> =>
  new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(undefined), ms)
    const stop = () => window.clearTimeout(timer)
    promise.then(
      (value) => {
        stop()
        resolve(value)
      },
      () => {
        stop()
        resolve(undefined)
      },
    )
  })

const fetchManifest = async (externalSignal?: AbortSignal): Promise<VersionManifest | null> => {
  // One controller fed by two abort sources — the timeout below and the optional
  // caller signal (a user "Cancel"). The timer is cleared only in `finally`, so
  // it stays armed across both fetch() *and* response.text(): a body that streams
  // forever is aborted too, not just slow headers.
  const controller = new AbortController()
  const onExternalAbort = () => controller.abort()
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
  const timer = window.setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS)

  try {
    // no-store so neither the HTTP cache nor the service-worker cache can mask a
    // newer published manifest. Same-origin only (stays within connect-src 'self').
    // Fetched under the deploy base (next to index.html), so a subpath deploy
    // does not 404 on the domain root (SPEC §14).
    const response = await fetch(`${import.meta.env.BASE_URL}version.json`, {
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok) {
      return null
    }

    return parseVersionManifest(await response.text())
  } catch {
    // Includes the AbortError from a timeout or a user cancel — both collapse to
    // "no manifest", which the caller reports as "could not check".
    return null
  } finally {
    window.clearTimeout(timer)
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }
}

export const checkForUpdates = async (signal?: AbortSignal): Promise<UpdateCheckResult> => {
  const manifest = await fetchManifest(signal)
  if (!manifest) {
    return { status: 'error' }
  }

  // Prod the browser to re-fetch sw.js so a newer build gets staged; failures or
  // a stall here must not turn an otherwise-successful manifest check into an
  // error, so we bound the wait and ignore the outcome.
  if (registration) {
    await settleWithin(registration.update(), SW_UPDATE_TIMEOUT_MS)
  }

  const running = { version: BUILD_VERSION, builtAt: BUILT_AT }
  return isManifestNewer(running, manifest)
    ? { status: 'update-available', latest: manifest }
    : { status: 'up-to-date' }
}

const messageWorker = (worker: ServiceWorker, message: unknown, timeoutMs: number) =>
  new Promise<unknown>((resolve, reject) => {
    const channel = new MessageChannel()
    const finish = () => {
      window.clearTimeout(timer)
      channel.port1.close()
    }
    const timer = window.setTimeout(() => {
      finish()
      reject(new Error('Service worker did not respond.'))
    }, timeoutMs)
    channel.port1.onmessage = (event) => {
      finish()
      resolve(event.data)
    }
    try {
      worker.postMessage(message, [channel.port2])
    } catch (error) {
      finish()
      reject(error)
    }
  })

const waitForWaitingWorker = (reg: ServiceWorkerRegistration, timeoutMs: number) =>
  new Promise<ServiceWorker | null>((resolve) => {
    if (reg.waiting) {
      resolve(reg.waiting)
      return
    }

    let settled = false
    const watched = new Set<ServiceWorker>()

    const cleanup = () => {
      window.clearTimeout(timer)
      reg.removeEventListener('updatefound', onUpdateFound)
      for (const [worker, settle] of stateListeners) {
        worker.removeEventListener('statechange', settle)
      }
      stateListeners.clear()
    }

    const finish = (worker: ServiceWorker | null) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve(worker)
    }

    const stateListeners = new Map<ServiceWorker, () => void>()
    const timer = window.setTimeout(() => finish(reg.waiting ?? null), timeoutMs)

    const watch = (worker: ServiceWorker | null) => {
      if (!worker || watched.has(worker)) {
        return
      }
      watched.add(worker)

      const settle = () => {
        if (worker.state === 'installed') {
          finish(reg.waiting ?? worker)
        }
      }

      // Catch an install that is already in progress as well as future state
      // transitions, so a freshly triggered update is not missed by a race.
      settle()
      if (!settled) {
        stateListeners.set(worker, settle)
        worker.addEventListener('statechange', settle)
      }
    }

    const onUpdateFound = () => watch(reg.installing)

    // Attach `updatefound` BEFORE the initial watch: if `watch(reg.installing)`
    // settles synchronously (an already-`installed` worker), `cleanup()` runs and
    // must find this listener already attached to remove it — otherwise it would
    // be added to an already-settled promise and leak on the long-lived `reg`.
    // Registering first is safe: `updatefound` only fires async when the browser
    // discovers a new worker, so this does not change which events are handled.
    reg.addEventListener('updatefound', onUpdateFound)
    watch(reg.installing)
  })

let reloaded = false
// Exported so the App's VERSION_PINNED handler reloads through the SAME
// double-reload guard as the apply flow's controllerchange path — the two can
// race (a window that both applied an update and received the broadcast), and
// only the first reload must win.
export const reloadOnce = () => {
  if (reloaded) {
    return
  }

  reloaded = true
  window.location.reload()
}

const queryWorkerVersion = async (
  worker: ServiceWorker,
  timeoutMs: number,
): Promise<string | null> => {
  try {
    const reply = (await messageWorker(worker, { type: 'GET_VERSION' }, timeoutMs)) as {
      type?: string
      version?: string
    }
    return reply?.type === 'VERSION' && typeof reply.version === 'string' ? reply.version : null
  } catch {
    return null
  }
}

// Find the worker that actually carries the offered build. In the version-pinned
// model the worker we need may be `waiting` (staged, not yet activated) OR
// `active` — a background-staged build can activate while still serving the old
// pinned cache, in which case `registration.waiting` is null and only the active
// worker can repoint the pin.
const findWorkerForVersion = async (
  reg: ServiceWorkerRegistration,
  expectedVersion: string,
): Promise<ServiceWorker | null> => {
  const candidates = [reg.waiting, reg.active].filter((worker): worker is ServiceWorker =>
    Boolean(worker),
  )

  for (const worker of candidates) {
    if ((await queryWorkerVersion(worker, 5_000)) === expectedVersion) {
      return worker
    }
  }

  return null
}

// Thrown by applyUpdate when another window has a document unlocked (it still
// holds the cross-tab vault Web Lock). Repointing the pin then pruning the old
// build's cache would silently swap that window's build mid-session and could
// 404 a lazy asset it never cached. The caller surfaces this as a
// non-destructive message; the pin is left untouched.
export class UpdateBlockedError extends Error {
  constructor() {
    super('Another window has a document unlocked; update refused.')
    this.name = 'UpdateBlockedError'
  }
}

// "Is any *other* window unlocked?" — answerable without leaking lock state into
// the SW: the unlocked session holds the exclusive 'enoteweb-vault' lock (App's
// acquireVaultLock), and the updating window is on the locked screen and does
// NOT hold it, so a held lock seen here belongs to a different, unlocked window.
// Where navigator.locks.query is unavailable, we cannot tell — degrade open
// rather than block (matches acquireVaultLock's own absent-API behavior).
const anotherWindowUnlocked = async (): Promise<boolean> => {
  if (!navigator.locks?.query) {
    return false
  }
  const { held = [] } = await navigator.locks.query()
  return held.some((lock) => lock.name === 'enoteweb-vault')
}

// Activate the offered build: tell its worker (waiting or already-active) to
// precache, repoint the pinned version to itself, and prune; then reload. The
// reload is safe immediately because serving is pin-governed — once the pin is
// repointed, any controlling worker serves the new build. Only ever invoked from
// the locked/home screen (SPEC Section 14/15), so no in-memory plaintext is lost.
export const applyUpdate = async (expectedVersion?: string): Promise<void> => {
  // Cross-window invariant (SPEC Section 14): never repoint the pin / prune the
  // old cache while ANY window has a document unlocked. Checked first — before
  // any registration.update()/findWorkerForVersion()/messageWorker() — so a
  // refused update leaves the pin and every cache exactly as they were.
  if (await anotherWindowUnlocked()) {
    throw new UpdateBlockedError()
  }

  if (!registration) {
    reloadOnce()
    return
  }

  let target = expectedVersion
    ? await findWorkerForVersion(registration, expectedVersion)
    : null

  if (!target) {
    // Nothing staged yet (or no version given): prod the browser to fetch the
    // newer sw.js, then retry. Bounded so a stalled SW update can't hang the
    // apply flow; we ignore the outcome and still wait briefly for a staged worker.
    await settleWithin(registration.update(), SW_UPDATE_TIMEOUT_MS)

    const waiting = await waitForWaitingWorker(registration, 30_000)
    target = expectedVersion
      ? ((await findWorkerForVersion(registration, expectedVersion)) ?? waiting)
      : (waiting ?? registration.waiting ?? registration.active)
  }

  if (!target) {
    throw new Error('No staged update is available to apply.')
  }

  // Reload as soon as the new worker claims (covers the waiting→active path);
  // the explicit reload after the ack covers the already-active path.
  navigator.serviceWorker.addEventListener('controllerchange', reloadOnce, { once: true })

  const response = (await messageWorker(
    target,
    { type: 'ACTIVATE_UPDATE', expectedVersion },
    30_000,
  )) as { type?: string }

  if (response?.type === 'ACTIVATE_FAILED') {
    throw new Error('The update could not be activated.')
  }

  reloadOnce()
}
