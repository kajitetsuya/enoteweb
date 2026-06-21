import { describe, expect, it } from 'vitest'
import { generateRandomString } from './randomString'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

describe('generateRandomString', () => {
  it('clamps an out-of-range-high value to 128', () => {
    // A 1e9 length would freeze the tab without the clamp; completing promptly
    // proves the clamp fired. The vitest 20s timeout is the backstop.
    const result = generateRandomString(1e9)
    expect(result).toHaveLength(128)
  })

  it('clamps an out-of-range-low value to 1', () => {
    const result = generateRandomString(0)
    expect(result).toHaveLength(1)
  })

  it('passes through an in-range value unchanged', () => {
    const result = generateRandomString(12)
    expect(result).toHaveLength(12)
  })

  it('uses only characters from A–Za–z0–9', () => {
    const result = generateRandomString(64)
    for (const char of result) {
      expect(ALPHABET).toContain(char)
    }
  })
})
