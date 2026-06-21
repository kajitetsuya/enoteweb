import { beforeAll, describe, expect, it } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import {
  formatSecretKeyString,
  generateSecretKeyString,
  parseSecretKeyString,
  SECRET_KEY_BYTE_LENGTH,
  SECRET_KEY_CHECKSUM_BYTE_LENGTH,
  SECRET_KEY_STRING_LENGTH,
} from './secretKey'

const INVALID_MESSAGE = 'Invalid Secret key.'

// A base64url (no padding) payload that decodes to `length` synthetic bytes.
// Built with sodium so the encoding is real and the regex passes; the bytes are
// throwaway test fixtures, not a credential.
const payloadOfLength = (length: number) =>
  sodium.to_base64(new Uint8Array(length).fill(7), sodium.base64_variants.URLSAFE_NO_PADDING)

const mutateBase64UrlChar = (value: string, index = value.length - 1) => {
  const replacement = value[index] === 'A' ? 'B' : 'A'

  return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`
}

beforeAll(async () => {
  await sodium.ready
})

describe('parseSecretKeyString', () => {
  it('round-trips a generated self-checking key back to its 32-byte payload', async () => {
    const key = await generateSecretKeyString()

    expect(key).toHaveLength(SECRET_KEY_STRING_LENGTH)
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(key).not.toContain(':')

    const bytes = await parseSecretKeyString(key)

    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes).toHaveLength(SECRET_KEY_BYTE_LENGTH)
  })

  it('trims leading and trailing whitespace around an otherwise valid key', async () => {
    const key = await generateSecretKeyString()
    const expected = await parseSecretKeyString(key)

    const padded = `  \t${key}\n `
    const trimmed = await parseSecretKeyString(padded)

    expect(trimmed).toHaveLength(SECRET_KEY_BYTE_LENGTH)
    // Trimming yields the SAME bytes as the unpadded key.
    expect([...trimmed]).toEqual([...expected])
  })

  describe('rejections', () => {
    // The case table is built INSIDE the test (after `await sodium.ready` in
    // beforeAll) because payloadOfLength calls sodium.to_base64 — constructing it
    // at describe-collection time would run before sodium is ready under the full
    // parallel suite.
    const buildCases = (): Array<[name: string, value: string]> => {
      const validKey = formatSecretKeyString(new Uint8Array(SECRET_KEY_BYTE_LENGTH).fill(7))
      const rawPayloadOnly = payloadOfLength(SECRET_KEY_BYTE_LENGTH)

      return [
        ['a raw payload without checksum', rawPayloadOnly],
        ['an empty string', ''],
        ['a checksum mismatch', mutateBase64UrlChar(validKey)],
        // Standard-Base64 characters the URL-safe regex must reject.
        ['a "+" character', `AA+${validKey.slice(3)}`],
        ['a "/" character', `AA/${validKey.slice(3)}`],
        ['a "=" padding character', `${validKey}==`],
        ['a payload decoding to 35 bytes', payloadOfLength(35)],
        ['a payload decoding to 37 bytes', payloadOfLength(37)],
      ]
    }

    it('rejects every malformed value with the Invalid Secret key message', async () => {
      for (const [, value] of buildCases()) {
        await expect(parseSecretKeyString(value)).rejects.toThrow(INVALID_MESSAGE)
      }
    })
  })
})

describe('formatSecretKeyString', () => {
  it('formats a 32-byte payload as a 48-character self-checking key', async () => {
    const payload = new Uint8Array(SECRET_KEY_BYTE_LENGTH).fill(9)
    const formatted = formatSecretKeyString(payload)

    expect(formatted).toHaveLength(SECRET_KEY_STRING_LENGTH)
    expect(formatted).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(sodium.from_base64(formatted, sodium.base64_variants.URLSAFE_NO_PADDING)).toHaveLength(
      SECRET_KEY_BYTE_LENGTH + SECRET_KEY_CHECKSUM_BYTE_LENGTH,
    )
    await expect(parseSecretKeyString(formatted)).resolves.toEqual(payload)
  })

  it('canonicalizes a parsed payload back to the same key string', async () => {
    const formatted = formatSecretKeyString(new Uint8Array(SECRET_KEY_BYTE_LENGTH).fill(9))
    const parsed = await parseSecretKeyString(formatted)

    expect(formatSecretKeyString(parsed)).toBe(formatted)
  })

  it('rejects a key that is not exactly 32 bytes', () => {
    expect(() => formatSecretKeyString(new Uint8Array(31))).toThrow(INVALID_MESSAGE)
    expect(() => formatSecretKeyString(new Uint8Array(33))).toThrow(INVALID_MESSAGE)
    expect(() => formatSecretKeyString(new Uint8Array(0))).toThrow(INVALID_MESSAGE)
  })
})
