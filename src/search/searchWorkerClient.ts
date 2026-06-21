import {
  createRegexTooExpensiveResult,
  createSupersededResult,
  findDirectionalSearchMatch,
  findSearchMatches,
  replaceAllMatches,
  replaceCurrentMatch,
  replaceSelectedMatchAndMove,
} from './searchEngine'
import searchWorkerUrl from './searchWorker.ts?worker&url'
import type {
  DirectionalSearchResult,
  ReplaceAllResult,
  ReplaceOneResult,
  SearchConfig,
  SearchMatchesResult,
  SearchOptions,
  SearchSupersededResult,
  SearchWorkerRequest,
  TextSelection,
} from './searchEngine'

const searchWorkerAssetUrl = searchWorkerUrl

export type { DirectionalSearchResult }

const DEFAULT_TIMEOUT_MS = 500
let nextRequestId = 0

// A single persistent module worker handles all regex requests, reused across
// requests instead of spawned per request. It is created lazily on first regex
// use, terminated and recreated only when a regex times out, is superseded by a
// newer request, errors, or the vault is locked. The worker holds no document
// text, query, or replacement in module-global state between requests.
let searchWorker: Worker | null = null
let activeRequest:
  | {
      id: number
      resolve: (value: unknown) => void
      timeoutId: number
      timeoutResult: unknown
    }
  | null = null

const disposeSearchWorker = () => {
  if (searchWorker) {
    searchWorker.terminate()
    searchWorker = null
  }
}

const settleActiveRequest = (result: unknown) => {
  if (!activeRequest) {
    return
  }

  const { resolve, timeoutId } = activeRequest
  window.clearTimeout(timeoutId)
  activeRequest = null
  resolve(result)
}

const ensureSearchWorker = () => {
  if (searchWorker) {
    return searchWorker
  }

  const worker = new Worker(searchWorkerAssetUrl, { type: 'module' })

  worker.onmessage = (event: MessageEvent<{ id: number; result: unknown }>) => {
    if (!activeRequest || event.data.id !== activeRequest.id) {
      return
    }

    settleActiveRequest(event.data.result)
  }

  worker.onerror = () => {
    const timeoutResult = activeRequest?.timeoutResult
    disposeSearchWorker()
    settleActiveRequest(timeoutResult)
  }

  searchWorker = worker
  return worker
}

// Terminate the persistent regex search worker and settle any in-flight request.
// Call on lock/logout so no document text, query, or replacement lingers in a
// worker between unlocked sessions.
export const terminateSearchWorker = () => {
  const timeoutResult = activeRequest?.timeoutResult
  disposeSearchWorker()
  settleActiveRequest(timeoutResult)
}

const runSearchWorker = <T>(
  request: SearchWorkerRequest,
  timeoutResult: T,
  timeoutMs: number,
): Promise<T | SearchSupersededResult> => {
  if (typeof Worker === 'undefined') {
    return Promise.resolve(timeoutResult)
  }

  // Only one regex request runs at a time. If a previous request is still in
  // flight when a newer one arrives, supersede it: terminate the worker (the
  // in-flight request may be a runaway regex) and respawn for the new request.
  // The superseded request settles with the `superseded` sentinel — NOT its
  // timeout/`regex-too-expensive` result — so consumers ignore it (no stale
  // "Regex too expensive." while the user keeps typing). The real safety bound
  // is still the 500ms worker kill on a genuine timeout.
  if (activeRequest) {
    disposeSearchWorker()
    settleActiveRequest(createSupersededResult())
  }

  return new Promise<T>((resolve) => {
    const id = nextRequestId
    nextRequestId += 1

    const worker = ensureSearchWorker()
    const timeoutId = window.setTimeout(() => {
      // Runaway or too-expensive regex: kill the worker to stop it. It is lazily
      // recreated on the next request.
      disposeSearchWorker()
      settleActiveRequest(timeoutResult)
    }, timeoutMs)

    activeRequest = {
      id,
      resolve: resolve as unknown as (value: unknown) => void,
      timeoutId,
      timeoutResult,
    }
    worker.postMessage({ ...request, id })
  })
}

export const findSearchMatchesSafely = (
  text: string,
  query: string,
  options: SearchOptions,
  config: SearchConfig = {},
) =>
  options.regex
    ? runSearchWorker<SearchMatchesResult>(
        { type: 'find-matches', text, query, options },
        createRegexTooExpensiveResult(text),
        config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      )
    : Promise.resolve(findSearchMatches(text, query, options, config))

export const findDirectionalSearchMatchSafely = (
  text: string,
  query: string,
  options: SearchOptions,
  selection: TextSelection,
  direction: 'next' | 'previous',
  config: SearchConfig = {},
) =>
  options.regex
    ? runSearchWorker<DirectionalSearchResult>(
        { type: 'find-directional', text, query, options, selection, direction },
        createRegexTooExpensiveResult(text),
        config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      )
    : Promise.resolve(findDirectionalSearchMatch(text, query, options, selection, direction, config))

export const replaceAllMatchesSafely = (
  text: string,
  query: string,
  options: SearchOptions,
  replacement: string,
  config: SearchConfig = {},
) =>
  options.regex
    ? runSearchWorker<ReplaceAllResult>(
        { type: 'replace-all', text, query, options, replacement },
        createRegexTooExpensiveResult(text),
        config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      )
    : Promise.resolve(replaceAllMatches(text, query, options, replacement, config))

export const replaceCurrentMatchSafely = (
  text: string,
  query: string,
  options: SearchOptions,
  selection: TextSelection,
  replacement: string,
  config: SearchConfig = {},
) =>
  options.regex
    ? runSearchWorker<ReplaceOneResult>(
        { type: 'replace-current', text, query, options, selection, replacement },
        createRegexTooExpensiveResult(text),
        config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      )
    : Promise.resolve(replaceCurrentMatch(text, query, options, selection, replacement, config))

export const replaceSelectedMatchAndMoveSafely = (
  text: string,
  query: string,
  options: SearchOptions,
  selection: TextSelection,
  replacement: string,
  direction: 'next' | 'previous',
  config: SearchConfig = {},
) =>
  options.regex
    ? runSearchWorker<ReplaceOneResult>(
        { type: 'replace-selected', text, query, options, selection, replacement, direction },
        createRegexTooExpensiveResult(text),
        config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      )
    : Promise.resolve(
        replaceSelectedMatchAndMove(text, query, options, selection, replacement, direction, config),
      )
