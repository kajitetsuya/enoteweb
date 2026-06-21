import { describe, expect, it } from 'vitest'
import { findSearchMatches, replaceAllMatches, validateSearchQuery } from './searchEngine'
import type { SearchOptions } from './searchEngine'

const literalOptions: SearchOptions = {
  caseSensitive: false,
  regex: false,
  wholeWord: false,
}

describe('searchEngine', () => {
  it('finds literal matches with line snippets', () => {
    const result = findSearchMatches('Alpha\nbeta alpha', 'alpha', literalOptions)

    expect(result.ok).toBe(true)
    expect(result.matches).toHaveLength(2)
    expect(result.matches[0]).toMatchObject({
      from: 0,
      lineNumber: 1,
      snippet: 'Alpha',
      text: 'Alpha',
      to: 5,
    })
    expect(result.matches[1]).toMatchObject({
      lineNumber: 2,
      snippet: 'beta alpha',
      text: 'alpha',
    })
  })

  it('filters whole-word matches', () => {
    const result = findSearchMatches('cat scatter cat_ cat', 'cat', {
      ...literalOptions,
      wholeWord: true,
    })

    expect(result.matches.map((match) => match.from)).toEqual([0, 17])
  })

  it('reports invalid regex patterns', () => {
    const result = findSearchMatches('text', '(', {
      ...literalOptions,
      regex: true,
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('invalid-regex')
  })

  it('validates regex patterns before UI actions run', () => {
    const result = validateSearchQuery('(', {
      ...literalOptions,
      regex: true,
    })

    expect(result).toMatchObject({
      error: 'invalid-regex',
      message: 'Invalid regex.',
      ok: false,
    })
  })

  it('rejects likely expensive regex patterns', () => {
    const result = findSearchMatches('aaaaaaaaaaaaaaaa', '(a+)+b', {
      ...literalOptions,
      regex: true,
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('regex-too-expensive')
  })

  it('still rejects every catastrophic nested-quantifier shape (SPEC §12)', () => {
    // Removing the trailing `?` from the expensive-regex guard must not let any
    // of these through: each has an inner +/* multiplied by an outer +/*/{ .
    const regexOptions: SearchOptions = { ...literalOptions, regex: true }

    for (const pattern of ['(a+)+b', '(a+)*b', '(.*)+x', '(x+x+)+y']) {
      const result = findSearchMatches('aaaaaaaaaaaaaaaa', pattern, regexOptions)

      expect(result.ok, `${pattern} should be rejected`).toBe(false)
      expect(result.error, `${pattern} should be rejected`).toBe('regex-too-expensive')
    }
  })

  it('accepts safe optional groups that an outer ? does not multiply', () => {
    // `(X+)?` applies the group at most once, so it cannot multiply
    // backtracking and must not be flagged expensive — it returns matches (or
    // "0 matches"), never `regex-too-expensive`.
    const regexOptions: SearchOptions = { ...literalOptions, regex: true }

    for (const pattern of ['(foo+)?', '(ab+)?', '(a*)?']) {
      const result = findSearchMatches('foo ab aaa', pattern, regexOptions)

      expect(result.ok, `${pattern} should be accepted`).toBe(true)
      expect(result.error, `${pattern} should be accepted`).toBe(null)
    }
  })

  it('caps displayed matches', () => {
    const result = findSearchMatches('aaaa', 'a', literalOptions, { maxMatches: 2 })

    expect(result.ok).toBe(true)
    expect(result.limited).toBe(true)
    expect(result.matches).toHaveLength(2)
  })

  it('replaces regex matches with JavaScript capture semantics', () => {
    const result = replaceAllMatches('alpha 12 beta 34', '(?<word>\\w+) (?<num>\\d+)', {
      ...literalOptions,
      regex: true,
    }, '$<num>-$<word>')

    expect(result.ok).toBe(true)
    expect(result.count).toBe(2)
    expect(result.text).toBe('12-alpha 34-beta')
  })

  it('inserts literal-mode replacements verbatim, without $-token expansion', () => {
    // Replacement tokens are a regex-mode feature (SPEC §12); a literal
    // replacement containing $$ / $& / $` must reach the document unchanged.
    expect(replaceAllMatches('price X', 'X', literalOptions, '$$100').text).toBe('price $$100')
    expect(replaceAllMatches('the cat', 'cat', literalOptions, '[$&]').text).toBe('the [$&]')
    expect(replaceAllMatches('a b', 'b', literalOptions, "$`").text).toBe("a $`")
  })

  it('allows empty-capable patterns instead of rejecting them', () => {
    const regexOptions: SearchOptions = { ...literalOptions, regex: true }

    expect(validateSearchQuery('a*', regexOptions).ok).toBe(true)
    expect(validateSearchQuery('^', regexOptions).ok).toBe(true)
    expect(validateSearchQuery('\\b', regexOptions).ok).toBe(true)
  })

  it('collects non-empty runs and skips zero-length matches for empty-capable patterns', () => {
    const result = findSearchMatches('aaa bbb aa', 'a*', {
      ...literalOptions,
      regex: true,
    })

    expect(result.ok).toBe(true)
    expect(result.error).toBe(null)
    expect(result.matches.map((match) => match.text)).toEqual(['aaa', 'aa'])
  })

  it('does not hang or error on a pattern that only matches empty', () => {
    const result = findSearchMatches('cat car cot', '\\b', {
      ...literalOptions,
      regex: true,
    })

    expect(result.ok).toBe(true)
    expect(result.error).toBe(null)
    expect(result.matches).toHaveLength(0)
  })

  it('does not start a match inside a surrogate pair after a zero-length step', () => {
    // '🎉a' is 🎉a: high surrogate (index 0), low surrogate (index 1),
    // 'a' (index 2). The pattern '[\uDF89a]*' matches empty at index 0 (the high
    // surrogate is not in the class), so the global scan must step past the whole
    // astral character to index 2. A +1 step would land on the low surrogate at
    // index 1 and collect a non-empty match that begins mid-character.
    const result = findSearchMatches('🎉a', '[\\uDF89a]*', {
      ...literalOptions,
      regex: true,
    })

    expect(result.ok).toBe(true)
    expect(result.error).toBe(null)
    expect(result.matches).toEqual([
      expect.objectContaining({ from: 2, text: 'a', to: 3 }),
    ])
  })
})
