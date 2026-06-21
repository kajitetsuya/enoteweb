// Character counting for the editor status bar. The app explicitly targets
// Japanese text and emoji, so "character" means a user-perceived character (an
// extended grapheme cluster), not a UTF-16 code unit. Intl.Segmenter does this
// correctly; where it is unavailable we fall back to counting Unicode code
// points (Array/for-of iteration over a string), which is still far closer to a
// human count than `string.length`.

let cachedSegmenter: Intl.Segmenter | null | undefined

const getGraphemeSegmenter = (): Intl.Segmenter | null => {
  if (cachedSegmenter !== undefined) {
    return cachedSegmenter
  }

  try {
    cachedSegmenter =
      typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null
  } catch {
    cachedSegmenter = null
  }

  return cachedSegmenter
}

/**
 * Counts the user-perceived characters (extended grapheme clusters) in `text`.
 * Falls back to Unicode code points when Intl.Segmenter is unavailable.
 */
export const countGraphemes = (text: string): number => {
  if (text.length === 0) {
    return 0
  }

  const segmenter = getGraphemeSegmenter()
  let count = 0

  if (segmenter) {
    for (const segment of segmenter.segment(text)) {
      void segment
      count += 1
    }
    return count
  }

  for (const codePoint of text) {
    void codePoint
    count += 1
  }

  return count
}

let cachedWordSegmenter: Intl.Segmenter | null | undefined

const getWordSegmenter = (): Intl.Segmenter | null => {
  if (cachedWordSegmenter !== undefined) {
    return cachedWordSegmenter
  }

  try {
    cachedWordSegmenter =
      typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(undefined, { granularity: 'word' })
        : null
  } catch {
    cachedWordSegmenter = null
  }

  return cachedWordSegmenter
}

/**
 * Counts the words in `text`. Uses Intl.Segmenter word segmentation and the
 * `isWordLike` flag, which counts word-like segments while ignoring whitespace
 * and punctuation and correctly segments space-free scripts such as Japanese.
 * Where Intl.Segmenter is unavailable it falls back to a whitespace split
 * (which counts a space-free run, e.g. a Japanese sentence, as a single word).
 */
export const countWords = (text: string): number => {
  const segmenter = getWordSegmenter()

  if (segmenter) {
    let count = 0

    for (const segment of segmenter.segment(text)) {
      if (segment.isWordLike) {
        count += 1
      }
    }

    return count
  }

  const trimmed = text.trim()

  return trimmed === '' ? 0 : trimmed.split(/\s+/).length
}

/**
 * Returns the `[start, end)` offsets (within `lineText`) of the last "word" — the
 * final run of non-whitespace characters, with any trailing whitespace excluded.
 * `end === start` means there is no word (a blank or whitespace-only line); a line
 * with no whitespace yields the whole line. Punctuation attached to the token is
 * kept. "Whitespace" is the JavaScript `\s` class (space, tab, NBSP, and other
 * Unicode spaces). The caller passes one line with the line break already excluded
 * (e.g. CodeMirror's `Line.text`). Used by the line-number gutter copy action,
 * which both copies and selects this range (Section 11), so the copy and the
 * selection share one source of truth.
 */
export const extractLastWordRange = (lineText: string): { start: number; end: number } => {
  // Linear reverse scan. The obvious regex (/(\S+)\s*$/) backtracks
  // quadratically when a long token is followed by whitespace and more text
  // (measured ~9.5s on a 50k-char token), so the scan is done by hand: skip
  // trailing whitespace, then take the preceding run of non-whitespace.
  const isWhitespace = (ch: string) => /\s/.test(ch)
  let end = lineText.length

  while (end > 0 && isWhitespace(lineText[end - 1] ?? '')) {
    end -= 1
  }

  let start = end

  while (start > 0 && !isWhitespace(lineText[start - 1] ?? '')) {
    start -= 1
  }

  return { start, end }
}

/** The last word of `lineText` (see `extractLastWordRange`), or `''` if none. */
export const extractLastWord = (lineText: string): string => {
  const { start, end } = extractLastWordRange(lineText)

  return lineText.slice(start, end)
}
