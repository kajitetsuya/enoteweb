/// <reference lib="webworker" />

import {
  createRegexTooExpensiveResult,
  findDirectionalSearchMatch,
  findSearchMatches,
  replaceAllMatches,
  replaceCurrentMatch,
  replaceSelectedMatchAndMove,
} from './searchEngine'
import type { SearchWorkerRequest } from './searchEngine'

// Each request carries an `id` so the client can correlate the response.
type IdentifiedSearchWorkerRequest = SearchWorkerRequest & { id: number }

const worker = self as DedicatedWorkerGlobalScope

worker.addEventListener('message', (event: MessageEvent<IdentifiedSearchWorkerRequest>) => {
  const request = event.data

  try {
    const result =
      request.type === 'find-matches'
        ? findSearchMatches(request.text, request.query, request.options)
        : request.type === 'find-directional'
          ? findDirectionalSearchMatch(
              request.text,
              request.query,
              request.options,
              request.selection,
              request.direction,
            )
          : request.type === 'replace-all'
            ? replaceAllMatches(request.text, request.query, request.options, request.replacement)
            : request.type === 'replace-current'
              ? replaceCurrentMatch(
                  request.text,
                  request.query,
                  request.options,
                  request.selection,
                  request.replacement,
                )
              : replaceSelectedMatchAndMove(
                  request.text,
                  request.query,
                  request.options,
                  request.selection,
                  request.replacement,
                  request.direction,
                )

    worker.postMessage({ id: request.id, result })
  } catch {
    worker.postMessage({
      id: request.id,
      result: createRegexTooExpensiveResult(request.text),
    })
  }
})
