import sodium from 'libsodium-wrappers-sumo'

export const SECRET_KEY_BYTE_LENGTH = 32
export const SECRET_KEY_CHECKSUM_BYTE_LENGTH = 4
export const SECRET_KEY_STRING_LENGTH = 48

const BASE64URL_NO_PADDING = /^[A-Za-z0-9_-]{48}$/
const CHECKSUM_DOMAIN = new TextEncoder().encode('enoteweb secret key checksum v1')

const readySodium = async () => {
  await sodium.ready
  return sodium
}

const buildChecksumInput = (secretKeyBytes: Uint8Array) => {
  const input = new Uint8Array(CHECKSUM_DOMAIN.length + secretKeyBytes.length)

  input.set(CHECKSUM_DOMAIN, 0)
  input.set(secretKeyBytes, CHECKSUM_DOMAIN.length)
  return input
}

const computeChecksum = (secretKeyBytes: Uint8Array) => {
  const input = buildChecksumInput(secretKeyBytes)

  try {
    return sodium.crypto_hash_sha256(input).slice(0, SECRET_KEY_CHECKSUM_BYTE_LENGTH)
  } finally {
    input.fill(0)
  }
}

const checksumMatches = (actual: Uint8Array, expected: Uint8Array) => {
  if (actual.length !== expected.length) {
    return false
  }

  let mismatch = 0
  for (let index = 0; index < actual.length; index++) {
    mismatch |= (actual[index] ?? 0) ^ (expected[index] ?? 0)
  }

  return mismatch === 0
}

export const formatSecretKeyString = (secretKeyBytes: Uint8Array) => {
  if (secretKeyBytes.length !== SECRET_KEY_BYTE_LENGTH) {
    throw new Error('Invalid Secret key.')
  }

  const encodedBytes = new Uint8Array(SECRET_KEY_BYTE_LENGTH + SECRET_KEY_CHECKSUM_BYTE_LENGTH)

  encodedBytes.set(secretKeyBytes, 0)
  encodedBytes.set(computeChecksum(secretKeyBytes), SECRET_KEY_BYTE_LENGTH)
  try {
    return sodium.to_base64(encodedBytes, sodium.base64_variants.URLSAFE_NO_PADDING)
  } finally {
    encodedBytes.fill(0)
  }
}

export const generateSecretKeyString = async () => {
  await readySodium()
  return formatSecretKeyString(sodium.randombytes_buf(SECRET_KEY_BYTE_LENGTH))
}

export const parseSecretKeyString = async (value: string) => {
  await readySodium()

  const trimmed = value.trim()
  if (!BASE64URL_NO_PADDING.test(trimmed)) {
    throw new Error('Invalid Secret key.')
  }

  const decoded = sodium.from_base64(trimmed, sodium.base64_variants.URLSAFE_NO_PADDING)
  if (decoded.length !== SECRET_KEY_BYTE_LENGTH + SECRET_KEY_CHECKSUM_BYTE_LENGTH) {
    decoded.fill(0)
    throw new Error('Invalid Secret key.')
  }

  const secretKeyBytes = decoded.slice(0, SECRET_KEY_BYTE_LENGTH)
  const checksum = decoded.slice(SECRET_KEY_BYTE_LENGTH)

  if (!checksumMatches(checksum, computeChecksum(secretKeyBytes))) {
    decoded.fill(0)
    checksum.fill(0)
    secretKeyBytes.fill(0)
    throw new Error('Invalid Secret key.')
  }

  decoded.fill(0)
  checksum.fill(0)
  return secretKeyBytes
}
