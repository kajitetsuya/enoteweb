import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isSupersededResult } from './searchEngine'
import type { SearchOptions } from './searchEngine'

// The worker is referenced via a Vite `?worker&url` import; in the test
// environment we only need a stable string so `new Worker(url, ...)` is called.
vi.mock('./searchWorker.ts?worker&url', () => ({ default: 'search-worker-stub-url' }))

const regexOptions: SearchOptions = {
  caseSensitive: false,
  regex: true,
  wholeWord: false,
}

// A Worker stub that never posts a response back and never errors, so an
// in-flight request stays pending until it is either superseded or timed out by
// the client itself: the superseded-request condition under test.
class SilentWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  postMessage() {}
  terminate() {}
}

describe('searchWorkerClient supersede handling', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', SilentWorker as unknown as typeof Worker)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('settles an in-flight regex request as a no-op when a newer one supersedes it', async () => {
    // Import after the Worker stub is installed so the module-level Worker check
    // sees it. resetModules() in afterEach keeps the client state isolated.
    const { findSearchMatchesSafely } = await import('./searchWorkerClient')

    const first = findSearchMatchesSafely('aaaa', 'a+', regexOptions)
    // A second request arrives before the first settles: it must supersede the
    // first, terminating the (silent) worker and resolving the first promise.
    const second = findSearchMatchesSafely('aaaa', 'aa+', regexOptions)

    const firstResult = await first

    // The superseded request settles as the ignore-me sentinel, NOT as a
    // `regex-too-expensive` error from a superseded request.
    expect(isSupersededResult(firstResult)).toBe(true)
    expect(firstResult.error).toBe(null)
    expect(firstResult.ok).toBe(false)

    // The newer request is still in flight (the silent worker never replies);
    // the client times it out at 500ms, which IS a genuine timeout and so does
    // surface `regex-too-expensive` — confirming the two outcomes are distinct.
    vi.advanceTimersByTime(500)
    const secondResult = await second

    expect(isSupersededResult(secondResult)).toBe(false)
    expect(secondResult.error).toBe('regex-too-expensive')
  })
})
