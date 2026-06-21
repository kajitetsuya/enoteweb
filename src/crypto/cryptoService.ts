import sodium from 'libsodium-wrappers-sumo'
import { SECRET_KEY_BYTE_LENGTH } from './secretKey'

export const ENVELOPE_HEADER = '-----BEGIN ENOTEWEB ENCRYPTED TEXT-----'
export const ENVELOPE_FOOTER = '-----END ENOTEWEB ENCRYPTED TEXT-----'

export const DEFAULT_KDF_PARAMS = {
  opslimit: 3,
  memlimit: 67_108_864,
} as const

export const MAX_KDF_PARAMS = {
  opslimit: 10,
  memlimit: 268_435_456,
} as const

// The version written on every save. Opening an older-version envelope and
// saving migrates it to this version (see SPEC Section 7).
export const ENVELOPE_VERSION = 1
// Every version this build can read. Adding a future version means appending it
// here while keeping every still-supported prior version, then promoting
// ENVELOPE_VERSION only after read support ships.
export const SUPPORTED_READ_VERSIONS: readonly number[] = [1]
export const APP_ID = 'enoteweb'
export const KDF_ALGORITHM = 'argon2id13'
export const AEAD_ALGORITHM = 'xchacha20poly1305-ietf'
export const SECRET_KEY_MODE_NONE = 'none'
export const SECRET_KEY_MODE_REQUIRED = 'required-v1'

export type SecretKeyMode = typeof SECRET_KEY_MODE_NONE | typeof SECRET_KEY_MODE_REQUIRED

const SALT_BYTES = 16
const NONCE_BYTES = 24
const STANDARD_BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type EnvelopeMetadata = {
  [key: string]: JsonValue
  v: typeof ENVELOPE_VERSION
  app: typeof APP_ID
  kdf: typeof KDF_ALGORITHM
  opslimit: number
  memlimit: number
  secretKey?: SecretKeyMode
  aead: typeof AEAD_ALGORITHM
  salt: string
  nonce: string
}

export type EncryptedEnvelopeBody = EnvelopeMetadata & {
  ciphertext: string
}

export type EncryptOptions = {
  opslimit?: number
  memlimit?: number
  secretKeyBytes?: Uint8Array | null
  // Document-level accidental-edit safeguard (SPEC §7/§11) — written into the
  // authenticated metadata only when true, so flag-less envelopes (every file
  // written before the feature, and files re-saved by older apps) read as
  // writable. Not access control: it carries no extra secret.
  readOnly?: boolean
}

export type DecryptOptions = {
  secretKeyBytes?: Uint8Array | null
}

export class SecretKeyRequiredError extends Error {
  constructor() {
    super('Secret key is required.')
    this.name = 'SecretKeyRequiredError'
  }
}

// The single reader for the envelope's read-only flag: exactly boolean `true`
// counts; absent or any other value is writable (forward-compatibility:
// readers never reject unknown or unexpected field values here).
export const isEnvelopeReadOnly = (body: EncryptedEnvelopeBody) => body.readOnly === true

const isPlainObject = (value: object) => {
  const prototype = Object.getPrototypeOf(value)

  return prototype === Object.prototype || prototype === null
}

const normalizeCanonicalValue = (value: unknown, path: string): JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error(`Invalid envelope: ${path} must be a finite integer.`)
    }

    return value
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeCanonicalValue(item, `${path}[${index}]`))
  }

  if (typeof value === 'object' && value !== null) {
    if (!isPlainObject(value)) {
      throw new Error(`Invalid envelope: ${path} must be a plain JSON object.`)
    }

    const record = value as Record<string, unknown>
    // Null-prototype accumulator: assignment then has data-property semantics
    // for every key, so a "__proto__" unknown field becomes an own property and
    // stays in the canonical JSON instead of being silently dropped (SPEC §7:
    // a reader must never drop unknown fields when computing AAD).
    const normalized: { [key: string]: JsonValue } = Object.create(null) as {
      [key: string]: JsonValue
    }

    for (const key of Object.keys(record).sort()) {
      normalized[key] = normalizeCanonicalValue(record[key], `${path}.${key}`)
    }

    return normalized
  }

  throw new Error(`Invalid envelope: ${path} is not JSON-serializable.`)
}

export const canonicalizeEnvelopeMetadata = (metadata: Record<string, unknown>) => {
  const normalized = normalizeCanonicalValue(metadata, 'metadata')

  if (typeof normalized !== 'object' || normalized === null || Array.isArray(normalized)) {
    throw new Error('Invalid envelope: metadata must be a JSON object.')
  }

  return JSON.stringify(normalized)
}

const getAuthenticatedMetadata = (body: EncryptedEnvelopeBody): EnvelopeMetadata => {
  const metadata = { ...body } as Record<string, JsonValue>

  delete metadata.ciphertext
  return metadata as EnvelopeMetadata
}

const serializeEnvelopeBody = (body: EncryptedEnvelopeBody) =>
  JSON.stringify(normalizeCanonicalValue(body, 'envelope'))

export const serializeEnvelope = (body: EncryptedEnvelopeBody) =>
  `${ENVELOPE_HEADER}\n${serializeEnvelopeBody(body)}\n${ENVELOPE_FOOTER}`

const assertString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid envelope: ${field} must be a non-empty string.`)
  }

  return value
}

const assertBase64String = (value: unknown, field: string) => {
  const stringValue = assertString(value, field)

  if (!STANDARD_BASE64.test(stringValue)) {
    throw new Error(`Invalid envelope: ${field} must use standard Base64.`)
  }

  return stringValue
}

const assertNumber = (value: unknown, field: string, maxValue: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid envelope: ${field} must be a positive integer.`)
  }

  if (value > maxValue) {
    throw new Error(`Invalid envelope: ${field} exceeds the supported limit.`)
  }

  return value
}

const assertSecretKeyMode = (value: unknown): SecretKeyMode | undefined => {
  if (value === undefined) {
    return undefined
  }

  if (value === SECRET_KEY_MODE_NONE || value === SECRET_KEY_MODE_REQUIRED) {
    return value
  }

  throw new Error('Invalid envelope: secretKey must be none or required-v1.')
}

export const getEnvelopeSecretKeyMode = (body: Pick<EncryptedEnvelopeBody, 'secretKey'>) =>
  body.secretKey ?? SECRET_KEY_MODE_NONE

export const parseEnvelope = (envelope: string): EncryptedEnvelopeBody => {
  const trimmed = envelope.trim()

  if (!trimmed.startsWith(ENVELOPE_HEADER) || !trimmed.endsWith(ENVELOPE_FOOTER)) {
    throw new Error('Invalid envelope: missing Enoteweb header or footer.')
  }

  const json = trimmed
    .slice(ENVELOPE_HEADER.length, trimmed.length - ENVELOPE_FOOTER.length)
    .trim()
  const parsed: unknown = JSON.parse(json)

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid envelope: body must be a JSON object.')
  }

  const record = parsed as Record<string, unknown>
  const v = record.v
  const app = record.app
  const kdf = record.kdf
  const aead = record.aead
  const secretKey = assertSecretKeyMode(record.secretKey)

  if (typeof v !== 'number' || !SUPPORTED_READ_VERSIONS.includes(v)) {
    throw new Error('Unsupported envelope version.')
  }

  if (app !== APP_ID) {
    throw new Error('Unsupported envelope app.')
  }

  if (kdf !== KDF_ALGORITHM) {
    throw new Error('Unsupported key derivation algorithm.')
  }

  if (aead !== AEAD_ALGORITHM) {
    throw new Error('Unsupported AEAD algorithm.')
  }

  const body = {
    ...record,
    v,
    app,
    kdf,
    opslimit: assertNumber(record.opslimit, 'opslimit', MAX_KDF_PARAMS.opslimit),
    memlimit: assertNumber(record.memlimit, 'memlimit', MAX_KDF_PARAMS.memlimit),
    ...(secretKey === undefined ? {} : { secretKey }),
    aead,
    salt: assertBase64String(record.salt, 'salt'),
    nonce: assertBase64String(record.nonce, 'nonce'),
    ciphertext: assertBase64String(record.ciphertext, 'ciphertext'),
  } as EncryptedEnvelopeBody

  canonicalizeEnvelopeMetadata(getAuthenticatedMetadata(body))
  return body
}

const decodeBase64 = (value: string) =>
  sodium.from_base64(value, sodium.base64_variants.ORIGINAL)

const encodeBase64 = (value: Uint8Array) =>
  sodium.to_base64(value, sodium.base64_variants.ORIGINAL)

const readySodium = async () => {
  await sodium.ready
  return sodium
}

const SECRET_KEY_KDF_DOMAIN = new TextEncoder().encode('enoteweb-secret-key-kdf-v1\0')

const assertSecretKeyBytes = (value: Uint8Array, field: string) => {
  if (value.length !== SECRET_KEY_BYTE_LENGTH) {
    throw new Error(`Invalid ${field}.`)
  }
}

const writeUint32BigEndian = (target: Uint8Array, offset: number, value: number) => {
  target[offset] = (value >>> 24) & 0xff
  target[offset + 1] = (value >>> 16) & 0xff
  target[offset + 2] = (value >>> 8) & 0xff
  target[offset + 3] = value & 0xff
}

const buildSecretKeyKdfInput = (password: string, secretKeyBytes: Uint8Array) => {
  assertSecretKeyBytes(secretKeyBytes, 'Secret key')

  const passwordBytes = new TextEncoder().encode(password)
  const input = new Uint8Array(
    SECRET_KEY_KDF_DOMAIN.length + 4 + passwordBytes.length + 4 + secretKeyBytes.length,
  )
  let offset = 0

  input.set(SECRET_KEY_KDF_DOMAIN, offset)
  offset += SECRET_KEY_KDF_DOMAIN.length
  writeUint32BigEndian(input, offset, passwordBytes.length)
  offset += 4
  input.set(passwordBytes, offset)
  offset += passwordBytes.length
  writeUint32BigEndian(input, offset, secretKeyBytes.length)
  offset += 4
  input.set(secretKeyBytes, offset)

  passwordBytes.fill(0)
  return input
}

const deriveKey = (
  password: string,
  salt: Uint8Array,
  opslimit: number,
  memlimit: number,
  secretKeyBytes?: Uint8Array | null,
) => {
  const passwordInput = secretKeyBytes ? buildSecretKeyKdfInput(password, secretKeyBytes) : password

  try {
    return sodium.crypto_pwhash(
      sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
      passwordInput,
      salt,
      opslimit,
      memlimit,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    )
  } finally {
    if (passwordInput instanceof Uint8Array) {
      passwordInput.fill(0)
    }
  }
}

const validateDecodedBytes = (bytes: Uint8Array, length: number, field: string) => {
  if (bytes.length !== length) {
    throw new Error(`Invalid envelope: ${field} has the wrong length.`)
  }
}

// ignoreBOM keeps a leading U+FEFF in the decoded text: without it TextDecoder
// silently strips the BOM, breaking exact-text roundtrip (SPEC §11).
const decodeUtf8 = (bytes: Uint8Array) =>
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)

const assertKdfPolicyOption = (value: number, field: string, maxValue: number) => {
  if (!Number.isInteger(value) || value <= 0 || value > maxValue) {
    throw new Error(`Invalid KDF policy: ${field} must be a positive integer within the accepted cap.`)
  }
}

export const CryptoService = {
  async encrypt(plaintext: string, password: string, options: EncryptOptions = {}) {
    await readySodium()

    const opslimit = options.opslimit ?? DEFAULT_KDF_PARAMS.opslimit
    const memlimit = options.memlimit ?? DEFAULT_KDF_PARAMS.memlimit
    const secretKeyBytes = options.secretKeyBytes ?? null

    // Enforce the same caps the parser enforces on read, so no caller can ever
    // run an unbounded derivation or write an envelope this app refuses to open.
    assertKdfPolicyOption(opslimit, 'opslimit', MAX_KDF_PARAMS.opslimit)
    assertKdfPolicyOption(memlimit, 'memlimit', MAX_KDF_PARAMS.memlimit)
    if (secretKeyBytes) {
      assertSecretKeyBytes(secretKeyBytes, 'Secret key')
    }

    const salt = sodium.randombytes_buf(SALT_BYTES)
    const nonce = sodium.randombytes_buf(NONCE_BYTES)
    const metadata = {
      v: ENVELOPE_VERSION,
      app: APP_ID,
      kdf: KDF_ALGORITHM,
      opslimit,
      memlimit,
      secretKey: secretKeyBytes ? SECRET_KEY_MODE_REQUIRED : SECRET_KEY_MODE_NONE,
      aead: AEAD_ALGORITHM,
      salt: encodeBase64(salt),
      nonce: encodeBase64(nonce),
      ...(options.readOnly === true ? { readOnly: true } : {}),
    } satisfies EnvelopeMetadata
    const aad = canonicalizeEnvelopeMetadata(metadata)
    const key = deriveKey(password, salt, opslimit, memlimit, secretKeyBytes)

    try {
      const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        plaintext,
        aad,
        null,
        nonce,
        key,
      )

      return serializeEnvelope({ ...metadata, ciphertext: encodeBase64(ciphertext) })
    } finally {
      key.fill(0)
    }
  },

  async decrypt(envelope: string, password: string, options: DecryptOptions = {}) {
    await readySodium()

    const body = parseEnvelope(envelope)
    const secretKeyMode = getEnvelopeSecretKeyMode(body)
    const secretKeyBytes = options.secretKeyBytes ?? null

    if (secretKeyMode === SECRET_KEY_MODE_REQUIRED && !secretKeyBytes) {
      throw new SecretKeyRequiredError()
    }

    if (secretKeyBytes) {
      assertSecretKeyBytes(secretKeyBytes, 'Secret key')
    }

    const salt = decodeBase64(body.salt)
    const nonce = decodeBase64(body.nonce)
    const ciphertext = decodeBase64(body.ciphertext)

    validateDecodedBytes(salt, SALT_BYTES, 'salt')
    validateDecodedBytes(nonce, NONCE_BYTES, 'nonce')

    const aad = canonicalizeEnvelopeMetadata(getAuthenticatedMetadata(body))
    const key = deriveKey(
      password,
      salt,
      body.opslimit,
      body.memlimit,
      secretKeyMode === SECRET_KEY_MODE_REQUIRED ? secretKeyBytes : null,
    )

    try {
      const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        ciphertext,
        aad,
        nonce,
        key,
      )

      return decodeUtf8(plaintext)
    } finally {
      key.fill(0)
    }
  },
}

// Password rotation is deliberately not a dedicated API: the product flow is
// Save As with a new password (a fresh encrypt of the current plaintext),
// optionally overwriting the existing file. See SPEC §10.
