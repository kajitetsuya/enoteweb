export type SearchOptions = {
  caseSensitive: boolean
  regex: boolean
  wholeWord: boolean
}

export type SearchErrorCode =
  | 'empty-query'
  | 'invalid-regex'
  | 'regex-too-expensive'
  | 'too-many-matches'

export type SearchMatch = {
  from: number
  lineNumber: number
  lineText: string
  snippet: string
  text: string
  to: number
}

export type SearchMatchesResult = {
  error: SearchErrorCode | null
  limited: boolean
  matches: SearchMatch[]
  message: string
  ok: boolean
}

export type SearchValidationResult = {
  error: SearchErrorCode | null
  message: string
  ok: boolean
}

export type ReplaceAllResult = {
  count: number
  error: SearchErrorCode | null
  message: string
  ok: boolean
  text: string
}

export type TextSelection = {
  from: number
  to: number
}

export type TextChange = {
  from: number
  insert: string
  to: number
}

export type ReplaceOneResult = {
  change: TextChange | null
  count: number
  error: SearchErrorCode | null
  message: string
  nextSelection: TextSelection | null
  ok: boolean
}

export type SearchConfig = {
  maxMatches?: number
  timeoutMs?: number
}

const DEFAULT_MAX_MATCHES = 10_000
const DEFAULT_TIMEOUT_MS = 500
const WORD_CHARACTER = /[A-Za-z0-9_]/

const now = () => globalThis.performance?.now() ?? Date.now()

const escapeRegExp = (value: string) => value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')

const createErrorResult = (error: SearchErrorCode, message: string): SearchMatchesResult => ({
  error,
  limited: false,
  matches: [],
  message,
  ok: false,
})

// A group that itself contains `+`/`*` and is then quantified by `+`, `*`, or
// `{n,}` can multiply backtracking (`(a+)+b`, `(.*)+x`), so it is rejected. A
// trailing `?` is deliberately NOT in the class: an outer `?` makes the group
// optional — applied at most once — so `(foo+)?` costs exactly what the
// already-allowed `foo+` costs and cannot multiply backtracking.
const isLikelyExpensiveRegex = (pattern: string) =>
  /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test(pattern) ||
  /\((?:[^()\\]|\\.)*\.\*(?:[^()\\]|\\.)*\)[+*{]/.test(pattern)

const buildSearchRegExp = (
  query: string,
  options: SearchOptions,
): { error: SearchMatchesResult; regex: null } | { error: null; regex: RegExp } => {
  if (!query) {
    return { error: createErrorResult('empty-query', 'Enter text to find.'), regex: null }
  }

  const source = options.regex ? query : escapeRegExp(query)

  if (options.regex && isLikelyExpensiveRegex(source)) {
    return {
      error: createErrorResult('regex-too-expensive', 'Regex too expensive.'),
      regex: null,
    }
  }

  try {
    // Patterns that can match the empty string (such as `^`, `$`, `\b`, or `a*`)
    // are allowed. The global scan in findSearchMatches guarantees forward
    // progress on zero-length matches, so they cannot cause an infinite loop.
    const regex = new RegExp(source, options.caseSensitive ? 'g' : 'gi')

    return { error: null, regex }
  } catch {
    return { error: createErrorResult('invalid-regex', 'Invalid regex.'), regex: null }
  }
}

export const validateSearchQuery = (
  query: string,
  options: SearchOptions,
): SearchValidationResult => {
  const built = buildSearchRegExp(query, options)

  return built.error
    ? { error: built.error.error, message: built.error.message, ok: false }
    : { error: null, message: '', ok: true }
}

const isWordCharacter = (value: string | undefined) => Boolean(value && WORD_CHARACTER.test(value))

const isWholeWordMatch = (text: string, from: number, to: number) =>
  !isWordCharacter(text[from - 1]) && !isWordCharacter(text[to])

const getLineStarts = (text: string) => {
  const starts = [0]

  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      starts.push(index + 1)
    }
  }

  return starts
}

const getLineIndex = (lineStarts: number[], position: number) => {
  let low = 0
  let high = lineStarts.length - 1

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const lineStart = lineStarts[middle] ?? 0

    if (lineStart <= position) {
      low = middle + 1
    } else {
      high = middle - 1
    }
  }

  return Math.max(0, high)
}

const getLineText = (text: string, lineStart: number) => {
  const lineEnd = text.indexOf('\n', lineStart)
  const rawLine = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd)

  return rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
}

const makeSnippet = (lineText: string, fromInLine: number, toInLine: number) => {
  const maxLength = 180

  if (lineText.length <= maxLength) {
    return lineText
  }

  const midpoint = Math.floor((fromInLine + toInLine) / 2)
  const start = Math.max(0, midpoint - 80)
  const end = Math.min(lineText.length, start + maxLength)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < lineText.length ? '...' : ''

  return `${prefix}${lineText.slice(start, end)}${suffix}`
}

export const findSearchMatches = (
  text: string,
  query: string,
  options: SearchOptions,
  config: SearchConfig = {},
): SearchMatchesResult => {
  const built = buildSearchRegExp(query, options)

  if (built.error) {
    return built.error
  }

  const maxMatches = config.maxMatches ?? DEFAULT_MAX_MATCHES
  const deadline = now() + (config.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const matches: SearchMatch[] = []
  const lineStarts = getLineStarts(text)
  let match: RegExpExecArray | null

  while ((match = built.regex.exec(text)) !== null) {
    if (now() > deadline) {
      return createErrorResult('regex-too-expensive', 'Regex too expensive.')
    }

    const matchedText = match[0] ?? ''
    const from = match.index

    // A zero-length match (for example from `^`, `$`, `\b`, or `a*` matching
    // empty at a position) is not a useful highlight and would not advance the
    // global scan on its own. Skip it and step forward so iteration always makes
    // progress and cannot loop forever. Step a whole code point: when the scan
    // sits on a high surrogate, advance two code units so the next match cannot
    // begin in the middle of an astral character.
    if (matchedText === '') {
      const code = text.charCodeAt(from)
      const isHighSurrogate = code >= 0xd800 && code <= 0xdbff
      built.regex.lastIndex = from + (isHighSurrogate ? 2 : 1)
      continue
    }

    const to = from + matchedText.length

    if (!options.wholeWord || isWholeWordMatch(text, from, to)) {
      if (matches.length >= maxMatches) {
        return {
          error: null,
          limited: true,
          matches,
          message: `Too many matches. Showing first ${maxMatches}.`,
          ok: true,
        }
      }

      const lineIndex = getLineIndex(lineStarts, from)
      const lineStart = lineStarts[lineIndex] ?? 0
      const lineText = getLineText(text, lineStart)

      matches.push({
        from,
        lineNumber: lineIndex + 1,
        lineText,
        snippet: makeSnippet(lineText, from - lineStart, to - lineStart),
        text: matchedText,
        to,
      })
    }
  }

  return {
    error: null,
    limited: false,
    matches,
    message: `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}.`,
    ok: true,
  }
}

const expandReplacement = (
  template: string,
  match: RegExpExecArray,
  offset: number,
  source: string,
) => {
  const captures = match.slice(1)
  const groups = match.groups ?? {}

  return template.replace(/\$(\$|&|`|'|<[$A-Z_a-z][$\w]*>|[0-9]{1,2})/g, (token, key) => {
    if (key === '$') {
      return '$'
    }

    if (key === '&') {
      return match[0] ?? ''
    }

    if (key === '`') {
      return source.slice(0, offset)
    }

    if (key === "'") {
      return source.slice(offset + (match[0]?.length ?? 0))
    }

    if (key.startsWith('<') && key.endsWith('>')) {
      const groupName = key.slice(1, -1)
      return Object.prototype.hasOwnProperty.call(groups, groupName) ? (groups[groupName] ?? '') : token
    }

    const numericKey = Number(key)

    if (!Number.isInteger(numericKey) || numericKey <= 0) {
      return token
    }

    if (numericKey <= captures.length) {
      return captures[numericKey - 1] ?? ''
    }

    if (key.length === 2) {
      const firstDigit = Number(key[0])

      if (Number.isInteger(firstDigit) && firstDigit > 0 && firstDigit <= captures.length) {
        return `${captures[firstDigit - 1] ?? ''}${key[1] ?? ''}`
      }
    }

    return token
  })
}

export const getReplacementForMatch = (
  text: string,
  query: string,
  options: SearchOptions,
  match: SearchMatch,
  replacement: string,
) => {
  // Replacement-token semantics ($&, $1, $<name>, ...) are a regex-mode
  // feature (SPEC §12). In literal mode the replacement text is inserted
  // verbatim — "$$100" must stay "$$100".
  if (!options.regex) {
    return replacement
  }

  const built = buildSearchRegExp(query, options)

  if (built.error) {
    return replacement
  }

  built.regex.lastIndex = match.from
  const regexMatch = built.regex.exec(text)

  if (!regexMatch || regexMatch.index !== match.from || (regexMatch[0] ?? '') !== match.text) {
    return replacement
  }

  return expandReplacement(replacement, regexMatch, match.from, text)
}

const findDirectionalMatch = (
  matches: SearchMatch[],
  selection: TextSelection,
  direction: 'next' | 'previous',
) => {
  const position = direction === 'next' ? selection.to : selection.from
  const matchIndex =
    direction === 'next'
      ? matches.findIndex((match) => match.from >= position)
      : matches.findLastIndex((match) => match.to <= position)
  const wrappedIndex =
    matchIndex === -1 ? (direction === 'next' ? 0 : matches.length - 1) : matchIndex

  return {
    index: wrappedIndex,
    match: matches[wrappedIndex] ?? null,
  }
}

const findSelectedMatch = (matches: SearchMatch[], selection: TextSelection) =>
  matches.find((match) => match.from === selection.from && match.to === selection.to) ?? null

export const findDirectionalSearchMatch = (
  text: string,
  query: string,
  options: SearchOptions,
  selection: TextSelection,
  direction: 'next' | 'previous',
  config: SearchConfig = {},
) => {
  const result = findSearchMatches(text, query, options, config)

  if (!result.ok) {
    return {
      currentIndex: -1,
      error: result.error,
      match: null,
      matchCount: 0,
      message: result.message,
      ok: false,
    }
  }

  if (result.matches.length === 0) {
    return {
      currentIndex: -1,
      error: null,
      match: null,
      matchCount: 0,
      message: 'No matches.',
      ok: false,
    }
  }

  const { index, match } = findDirectionalMatch(result.matches, selection, direction)

  if (!match) {
    return {
      currentIndex: -1,
      error: null,
      match: null,
      matchCount: 0,
      message: 'No matches.',
      ok: false,
    }
  }

  return {
    currentIndex: index,
    error: null,
    match,
    matchCount: result.matches.length,
    message: `${index + 1} of ${result.matches.length}`,
    ok: true,
  }
}

export const replaceCurrentMatch = (
  text: string,
  query: string,
  options: SearchOptions,
  selection: TextSelection,
  replacement: string,
  config: SearchConfig = {},
): ReplaceOneResult => {
  const result = findSearchMatches(text, query, options, config)

  if (!result.ok) {
    return {
      change: null,
      count: 0,
      error: result.error,
      message: result.message,
      nextSelection: null,
      ok: false,
    }
  }

  const selectedMatch =
    findSelectedMatch(result.matches, selection) ??
    result.matches.find((match) => match.from >= selection.from) ??
    result.matches[0] ??
    null

  if (!selectedMatch) {
    return {
      change: null,
      count: 0,
      error: null,
      message: 'No matches.',
      nextSelection: null,
      ok: false,
    }
  }

  const insertedText = getReplacementForMatch(text, query, options, selectedMatch, replacement)

  return {
    change: { from: selectedMatch.from, to: selectedMatch.to, insert: insertedText },
    count: 1,
    error: null,
    message: `Replaced 1 of ${result.matches.length}.`,
    nextSelection: {
      from: selectedMatch.from,
      to: selectedMatch.from + insertedText.length,
    },
    ok: true,
  }
}

export const replaceSelectedMatchAndMove = (
  text: string,
  query: string,
  options: SearchOptions,
  selection: TextSelection,
  replacement: string,
  direction: 'next' | 'previous',
  config: SearchConfig = {},
): ReplaceOneResult => {
  const result = findSearchMatches(text, query, options, config)

  if (!result.ok) {
    return {
      change: null,
      count: 0,
      error: result.error,
      message: result.message,
      nextSelection: null,
      ok: false,
    }
  }

  if (result.matches.length === 0) {
    return {
      change: null,
      count: 0,
      error: null,
      message: 'No matches.',
      nextSelection: null,
      ok: false,
    }
  }

  const selectedMatch = findSelectedMatch(result.matches, selection)

  if (!selectedMatch) {
    const searchResult = findDirectionalSearchMatch(
      text,
      query,
      options,
      selection,
      direction,
      config,
    )

    return {
      change: null,
      count: 0,
      error: searchResult.error,
      message: searchResult.message,
      nextSelection: searchResult.match
        ? { from: searchResult.match.from, to: searchResult.match.to }
        : null,
      ok: searchResult.ok,
    }
  }

  const insertedText = getReplacementForMatch(text, query, options, selectedMatch, replacement)
  const nextText = `${text.slice(0, selectedMatch.from)}${insertedText}${text.slice(
    selectedMatch.to,
  )}`
  const nextResult = findSearchMatches(nextText, query, options, config)
  const nextPosition = selectedMatch.from + insertedText.length
  const nextMatch =
    direction === 'next'
      ? (nextResult.ok &&
          (nextResult.matches.find((match) => match.from >= nextPosition) ?? nextResult.matches[0])) ||
        null
      : (nextResult.ok &&
          (nextResult.matches.findLast((match) => match.to <= selectedMatch.from) ??
            nextResult.matches.at(-1))) ||
        null

  return {
    change: { from: selectedMatch.from, to: selectedMatch.to, insert: insertedText },
    count: 1,
    error: null,
    message: `Replaced 1 of ${result.matches.length}.`,
    nextSelection: nextMatch
      ? { from: nextMatch.from, to: nextMatch.to }
      : { from: selectedMatch.from, to: selectedMatch.from },
    ok: true,
  }
}

export const replaceAllMatches = (
  text: string,
  query: string,
  options: SearchOptions,
  replacement: string,
  config: SearchConfig = {},
): ReplaceAllResult => {
  const result = findSearchMatches(text, query, options, config)

  if (!result.ok) {
    return {
      count: 0,
      error: result.error,
      message: result.message,
      ok: false,
      text,
    }
  }

  if (result.limited) {
    return {
      count: 0,
      error: 'too-many-matches',
      message: result.message,
      ok: false,
      text,
    }
  }

  let cursor = 0
  let nextText = ''

  for (const match of result.matches) {
    nextText += text.slice(cursor, match.from)
    nextText += getReplacementForMatch(text, query, options, match, replacement)
    cursor = match.to
  }

  nextText += text.slice(cursor)

  return {
    count: result.matches.length,
    error: null,
    message: `Replaced ${result.matches.length} ${result.matches.length === 1 ? 'match' : 'matches'}.`,
    ok: true,
    text: nextText,
  }
}

export type DirectionalSearchResult = ReturnType<typeof findDirectionalSearchMatch>

// The request payloads exchanged with the regex search worker. The worker side
// adds an `id` field for correlating responses (see SearchWorkerRequest & { id }).
export type SearchWorkerRequest =
  | {
      options: SearchOptions
      query: string
      text: string
      type: 'find-matches'
    }
  | {
      direction: 'next' | 'previous'
      options: SearchOptions
      query: string
      selection: TextSelection
      text: string
      type: 'find-directional'
    }
  | {
      options: SearchOptions
      query: string
      replacement: string
      text: string
      type: 'replace-all'
    }
  | {
      options: SearchOptions
      query: string
      replacement: string
      selection: TextSelection
      text: string
      type: 'replace-current'
    }
  | {
      direction: 'next' | 'previous'
      options: SearchOptions
      query: string
      replacement: string
      selection: TextSelection
      text: string
      type: 'replace-selected'
    }

// The result returned for a regex search/replace that is killed by the worker
// timeout, superseded by a newer request, or thrown inside the worker. It
// satisfies every search/replace result shape so any caller can use it.
export const createRegexTooExpensiveResult = (
  text = '',
): SearchMatchesResult & ReplaceAllResult & ReplaceOneResult & DirectionalSearchResult => ({
  change: null,
  count: 0,
  currentIndex: -1,
  error: 'regex-too-expensive',
  limited: false,
  match: null,
  matchCount: 0,
  matches: [],
  message: 'Regex too expensive.',
  nextSelection: null,
  ok: false,
  text,
})

// Sentinel for a regex request that a newer request superseded before it
// settled. It is distinct from both a successful match result and an error
// result: consumers must treat it as "ignore — do nothing" (no highlight wipe,
// no error text, no document change). The `superseded: true` discriminant is
// the only field consumers should branch on; the rest of the shape mirrors the
// other result objects so it satisfies every search/replace result type and any
// caller can receive it through `runSearchWorker<T>`.
export type SearchSupersededResult = SearchMatchesResult &
  ReplaceAllResult &
  ReplaceOneResult &
  DirectionalSearchResult & { superseded: true }

export const isSupersededResult = (result: unknown): result is SearchSupersededResult =>
  typeof result === 'object' && result !== null && (result as { superseded?: unknown }).superseded === true

export const createSupersededResult = (text = ''): SearchSupersededResult => ({
  change: null,
  count: 0,
  currentIndex: -1,
  error: null,
  limited: false,
  match: null,
  matchCount: 0,
  matches: [],
  message: '',
  nextSelection: null,
  ok: false,
  superseded: true,
  text,
})
