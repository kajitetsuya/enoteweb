import { describe, expect, it } from 'vitest'
import { countGraphemes, countWords, extractLastWord, extractLastWordRange } from './textMetrics'

describe('countGraphemes', () => {
  it('returns zero for an empty string', () => {
    expect(countGraphemes('')).toBe(0)
  })

  it('counts ASCII characters one-to-one', () => {
    expect(countGraphemes('hello')).toBe(5)
  })

  it('counts each Japanese character as one grapheme', () => {
    expect(countGraphemes('こんにちは')).toBe(5)
  })

  it('counts a multi-code-unit emoji as a single grapheme', () => {
    // U+1F600 is two UTF-16 code units but one user-perceived character.
    expect('😀'.length).toBe(2)
    expect(countGraphemes('😀')).toBe(1)
  })

  it('counts a ZWJ emoji sequence as a single grapheme', () => {
    // 👨‍👩‍👧 is 8 UTF-16 code units / 5 code points, but one grapheme cluster.
    const family = '👨‍👩‍👧'
    expect(family.length).toBe(8)
    expect(countGraphemes(family)).toBe(1)
  })

  it('counts newlines as characters', () => {
    expect(countGraphemes('a\nb')).toBe(3)
  })
})

describe('countWords', () => {
  it('returns zero for an empty or whitespace-only string', () => {
    expect(countWords('')).toBe(0)
    expect(countWords('   \n\t ')).toBe(0)
  })

  it('counts space-separated words', () => {
    expect(countWords('the quick brown fox')).toBe(4)
  })

  it('ignores surrounding and repeated whitespace', () => {
    expect(countWords('  hello   world  ')).toBe(2)
  })

  it('does not count punctuation as words', () => {
    expect(countWords('hello, world!')).toBe(2)
  })

  it('segments space-free Japanese text into multiple words', () => {
    // Word segmentation is dictionary-based; a space-free Japanese run is more
    // than one word (unlike a naive whitespace split, which would yield 1).
    expect(countWords('私は学生です')).toBeGreaterThan(1)
  })
})

describe('extractLastWordRange', () => {
  it('returns the offsets the gutter selection highlights', () => {
    // "the quick brown fox" → "fox" spans [16, 19); slicing it returns the word.
    const range = extractLastWordRange('the quick brown fox')
    expect(range).toEqual({ start: 16, end: 19 })
    expect('the quick brown fox'.slice(range.start, range.end)).toBe('fox')
  })

  it('excludes trailing whitespace from the range', () => {
    expect(extractLastWordRange('foo bar baz   ')).toEqual({ start: 8, end: 11 })
  })

  it('collapses to an empty range for a blank or whitespace-only line', () => {
    expect(extractLastWordRange('')).toEqual({ start: 0, end: 0 })
    // The empty range sits at the end of the trailing whitespace (end === start),
    // so the caller selects nothing.
    expect(extractLastWordRange('   ')).toEqual({ start: 0, end: 0 })
  })
})

describe('extractLastWord', () => {
  it('returns the last space-separated token', () => {
    expect(extractLastWord('the quick brown fox')).toBe('fox')
  })

  it('ignores trailing whitespace', () => {
    expect(extractLastWord('foo bar baz   ')).toBe('baz')
    expect(extractLastWord('foo\t')).toBe('foo')
  })

  it('returns the whole line when there is no whitespace', () => {
    expect(extractLastWord('singletoken')).toBe('singletoken')
  })

  it('keeps punctuation as part of the token', () => {
    expect(extractLastWord('end of line.')).toBe('line.')
  })

  it('returns an empty string for blank or whitespace-only lines', () => {
    expect(extractLastWord('')).toBe('')
    expect(extractLastWord('   \t ')).toBe('')
  })

  it('stays fast on a long leading token followed by more text', () => {
    // Performance invariant: a 50k-char token + space + tail is handled
    // instantly by the linear scan and must not regress to quadratic.
    expect(extractLastWord(`${'a'.repeat(50_000)} b`)).toBe('b')
    expect(extractLastWord(`${'あ'.repeat(50_000)} 終わり`)).toBe('終わり')
  })

  it('treats NBSP and other Unicode spaces as whitespace', () => {
    // The separator below is U+00A0 (NBSP), which JS `\s` matches.
    expect(extractLastWord('alpha beta')).toBe('beta')
  })
})
