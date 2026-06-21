// Generates a random alphanumeric string. Uses the platform CSPRNG rather than
// Math.random because the app forbids Math.random for security-sensitive values
// (SPEC §6) and a generated string may be used as a password. Rejection sampling
// (dropping bytes at/above the largest multiple of the alphabet size) avoids the
// modulo bias a plain `byte % 62` would introduce.

export const DEFAULT_RANDOM_STRING_LENGTH = 12
export const MIN_RANDOM_STRING_LENGTH = 1
export const MAX_RANDOM_STRING_LENGTH = 128

export const RANDOM_STRING_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

export const generateRandomString = (length = DEFAULT_RANDOM_STRING_LENGTH) => {
  // SPEC §11 bounds the length to 1–128. Clamp here as well as in the Settings
  // UI so a drifted/corrupted stored value can never spin this loop unbounded
  // and freeze the tab.
  const safeLength = Math.min(
    MAX_RANDOM_STRING_LENGTH,
    Math.max(
      MIN_RANDOM_STRING_LENGTH,
      Number.isFinite(length) ? Math.floor(length) : DEFAULT_RANDOM_STRING_LENGTH,
    ),
  )
  const alphabet = RANDOM_STRING_ALPHABET
  const unbiasedMax = Math.floor(256 / alphabet.length) * alphabet.length
  const byte = new Uint8Array(1)
  let result = ''

  while (result.length < safeLength) {
    crypto.getRandomValues(byte)
    const value = byte[0] ?? 0

    if (value < unbiasedMax) {
      result += alphabet.charAt(value % alphabet.length)
    }
  }

  return result
}
