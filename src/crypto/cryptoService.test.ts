import { describe, expect, it } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import {
  APP_ID,
  CryptoService,
  DEFAULT_KDF_PARAMS,
  type EncryptedEnvelopeBody,
  ENVELOPE_FOOTER,
  ENVELOPE_HEADER,
  getEnvelopeSecretKeyMode,
  MAX_KDF_PARAMS,
  canonicalizeEnvelopeMetadata,
  isEnvelopeReadOnly,
  parseEnvelope,
  SECRET_KEY_MODE_NONE,
  SECRET_KEY_MODE_REQUIRED,
  SecretKeyRequiredError,
  serializeEnvelope,
} from './cryptoService'
import {
  formatSecretKeyString,
  generateSecretKeyString,
  parseSecretKeyString,
  SECRET_KEY_BYTE_LENGTH,
  SECRET_KEY_STRING_LENGTH,
} from './secretKey'

const fastKdf = {
  opslimit: 2,
  memlimit: 8_388_608,
}

// Encrypts with an extra metadata field that is present in the AAD at encrypt
// time, so a reader that folds unknown fields into AAD can still decrypt it.
const encryptWithExtraField = async (
  plaintext: string,
  password: string,
  extra: Record<string, unknown>,
  options: { includeSecretKey?: boolean } = {},
) => {
  await sodium.ready

  const salt = sodium.randombytes_buf(16)
  const nonce = sodium.randombytes_buf(24)
  const metadata = {
    v: 1,
    app: APP_ID,
    kdf: 'argon2id13',
    opslimit: fastKdf.opslimit,
    memlimit: fastKdf.memlimit,
    ...(options.includeSecretKey === false ? {} : { secretKey: SECRET_KEY_MODE_NONE }),
    aead: 'xchacha20poly1305-ietf',
    salt: sodium.to_base64(salt, sodium.base64_variants.ORIGINAL),
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
    ...extra,
  }
  const aad = canonicalizeEnvelopeMetadata(metadata)
  const key = sodium.crypto_pwhash(
    sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
    password,
    salt,
    metadata.opslimit,
    metadata.memlimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  )

  try {
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      aad,
      null,
      nonce,
      key,
    )

    return serializeEnvelope({
      ...metadata,
      ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL),
    } as unknown as EncryptedEnvelopeBody)
  } finally {
    key.fill(0)
  }
}

const encryptNonCanonicalEnvelope = async (
  plaintext: string,
  password: string,
  aadMode: 'stored-order' | 'none',
) => {
  await sodium.ready

  const salt = sodium.randombytes_buf(16)
  const nonce = sodium.randombytes_buf(24)
  const metadata = {
    v: 1,
    app: APP_ID,
    kdf: 'argon2id13',
    opslimit: fastKdf.opslimit,
    memlimit: fastKdf.memlimit,
    secretKey: SECRET_KEY_MODE_NONE,
    aead: 'xchacha20poly1305-ietf',
    salt: sodium.to_base64(salt, sodium.base64_variants.ORIGINAL),
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
  }
  const key = sodium.crypto_pwhash(
    sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
    password,
    salt,
    metadata.opslimit,
    metadata.memlimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  )
  try {
    const aad = aadMode === 'stored-order' ? JSON.stringify(metadata) : null
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      aad,
      null,
      nonce,
      key,
    )
    const body = {
      ...metadata,
      ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL),
    }

    return `${ENVELOPE_HEADER}\n${JSON.stringify(body)}\n-----END ENOTEWEB ENCRYPTED TEXT-----`
  } finally {
    key.fill(0)
  }
}

describe('CryptoService', () => {
  it('roundtrips an encrypted envelope', async () => {
    const envelope = await CryptoService.encrypt('hello secret', 'correct horse', fastKdf)
    const body = parseEnvelope(envelope)

    expect(envelope).toContain(ENVELOPE_HEADER)
    expect(body.app).toBe(APP_ID)
    expect(await CryptoService.decrypt(envelope, 'correct horse')).toBe('hello secret')
  })

  it('records default KDF parameters when no options are supplied', async () => {
    const envelope = await CryptoService.encrypt('defaults', 'password')
    const body = parseEnvelope(envelope)

    expect(body.opslimit).toBe(DEFAULT_KDF_PARAMS.opslimit)
    expect(body.memlimit).toBe(DEFAULT_KDF_PARAMS.memlimit)
    expect(body.secretKey).toBe(SECRET_KEY_MODE_NONE)
  })

  it('generates and parses self-checking Secret keys', async () => {
    const secretKey = await generateSecretKeyString()
    const secretKeyBytes = await parseSecretKeyString(` ${secretKey}\n`)

    expect(secretKey).toHaveLength(SECRET_KEY_STRING_LENGTH)
    expect(secretKey).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(secretKey).not.toContain(':')
    expect(secretKeyBytes).toHaveLength(SECRET_KEY_BYTE_LENGTH)
    expect(formatSecretKeyString(secretKeyBytes)).toBe(secretKey)
    await expect(parseSecretKeyString('not an enoteweb key')).rejects.toThrow('Invalid Secret key')
    expect(() => formatSecretKeyString(new Uint8Array(SECRET_KEY_BYTE_LENGTH - 1))).toThrow(
      'Invalid Secret key',
    )
  })

  it('uses password-only encryption when a local Secret key is supplied for a none envelope', async () => {
    await sodium.ready
    const localSecretKey = sodium.randombytes_buf(SECRET_KEY_BYTE_LENGTH)
    const envelope = await CryptoService.encrypt('password only', 'password', fastKdf)

    expect(getEnvelopeSecretKeyMode(parseEnvelope(envelope))).toBe(SECRET_KEY_MODE_NONE)
    await expect(
      CryptoService.decrypt(envelope, 'password', { secretKeyBytes: localSecretKey }),
    ).resolves.toBe('password only')
  })

  it('roundtrips required-v1 encryption with high-byte Secret key bytes', async () => {
    await sodium.ready
    const highByteSecretKey = await parseSecretKeyString(
      formatSecretKeyString(
        Uint8Array.from({ length: SECRET_KEY_BYTE_LENGTH }, (_, index) => 0x80 + index),
      ),
    )
    const envelope = await CryptoService.encrypt('secret-key text', 'password', {
      ...fastKdf,
      secretKeyBytes: highByteSecretKey,
    })
    const body = parseEnvelope(envelope)

    expect(body.secretKey).toBe(SECRET_KEY_MODE_REQUIRED)
    await expect(
      CryptoService.decrypt(envelope, 'password', { secretKeyBytes: highByteSecretKey }),
    ).resolves.toBe('secret-key text')
  })

  it('requires the Secret key before decrypting a required-v1 envelope', async () => {
    await sodium.ready
    const secretKeyBytes = sodium.randombytes_buf(SECRET_KEY_BYTE_LENGTH)
    const envelope = await CryptoService.encrypt('needs key', 'password', {
      ...fastKdf,
      secretKeyBytes,
    })

    await expect(CryptoService.decrypt(envelope, 'password')).rejects.toBeInstanceOf(
      SecretKeyRequiredError,
    )
  })

  it('fails required-v1 decryption with the wrong Secret key', async () => {
    await sodium.ready
    const secretKeyBytes = sodium.randombytes_buf(SECRET_KEY_BYTE_LENGTH)
    const wrongSecretKeyBytes = sodium.randombytes_buf(SECRET_KEY_BYTE_LENGTH)
    const envelope = await CryptoService.encrypt('hidden behind key', 'password', {
      ...fastKdf,
      secretKeyBytes,
    })

    await expect(
      CryptoService.decrypt(envelope, 'password', { secretKeyBytes: wrongSecretKeyBytes }),
    ).rejects.toThrow()
  })

  it('rejects unsupported Secret-key metadata values', async () => {
    const body = parseEnvelope(await CryptoService.encrypt('hidden', 'password', fastKdf))

    expect(() =>
      parseEnvelope(
        serializeEnvelope({
          ...body,
          secretKey: 'required-v2',
        } as unknown as EncryptedEnvelopeBody),
      ),
    ).toThrow()
  })

  it('reads an absent Secret-key field as none and writes it on the next save', async () => {
    const envelopeWithoutSecretKey = await encryptWithExtraField(
      'plain text',
      'password',
      {},
      { includeSecretKey: false },
    )
    const bodyWithoutSecretKey = parseEnvelope(envelopeWithoutSecretKey)

    expect(bodyWithoutSecretKey.secretKey).toBeUndefined()
    expect(getEnvelopeSecretKeyMode(bodyWithoutSecretKey)).toBe(SECRET_KEY_MODE_NONE)
    await expect(CryptoService.decrypt(envelopeWithoutSecretKey, 'password')).resolves.toBe('plain text')

    const rewritten = await CryptoService.encrypt(
      await CryptoService.decrypt(envelopeWithoutSecretKey, 'password'),
      'password',
      fastKdf,
    )
    expect(parseEnvelope(rewritten).secretKey).toBe(SECRET_KEY_MODE_NONE)
  })

  it('fails to decrypt when Secret-key metadata is stripped from a current envelope', async () => {
    const envelope = await CryptoService.encrypt('authenticated mode', 'password', fastKdf)
    const body: Record<string, unknown> = { ...parseEnvelope(envelope) }

    delete body.secretKey

    const stripped = serializeEnvelope(body as unknown as EncryptedEnvelopeBody)
    expect(getEnvelopeSecretKeyMode(parseEnvelope(stripped))).toBe(SECRET_KEY_MODE_NONE)
    await expect(CryptoService.decrypt(stripped, 'password')).rejects.toThrow()
  })

  it('fails with the wrong password', async () => {
    const envelope = await CryptoService.encrypt('hidden', 'right password', fastKdf)

    await expect(CryptoService.decrypt(envelope, 'wrong password')).rejects.toThrow()
  })

  it('accepts non-ASCII Unicode passwords without normalization', async () => {
    const password = '日本語のパスワード'
    const envelope = await CryptoService.encrypt('unicode password text', password, fastKdf)

    await expect(CryptoService.decrypt(envelope, password)).resolves.toBe('unicode password text')
    await expect(CryptoService.decrypt(envelope, `${password} `)).rejects.toThrow()
  })

  it('fails when authenticated metadata is tampered', async () => {
    const envelope = await CryptoService.encrypt('hidden', 'password', fastKdf)
    const body = parseEnvelope(envelope)
    const tampered = serializeEnvelope({
      ...body,
      opslimit: body.opslimit + 1,
    })

    await expect(CryptoService.decrypt(tampered, 'password')).rejects.toThrow()
  })

  it('includes unknown metadata fields in authenticated data', async () => {
    const envelope = await CryptoService.encrypt('hidden', 'password', fastKdf)
    const body = parseEnvelope(envelope)
    const tampered = serializeEnvelope({
      ...body,
      futureField: 'future metadata',
    })

    expect(parseEnvelope(tampered).futureField).toBe('future metadata')
    await expect(CryptoService.decrypt(tampered, 'password')).rejects.toThrow()
  })

  it('canonicalizes metadata in lexicographic key order', () => {
    expect(canonicalizeEnvelopeMetadata({ z: 1, a: 'first', m: true })).toBe(
      '{"a":"first","m":true,"z":1}',
    )
  })

  it('fails when ciphertext is tampered', async () => {
    const envelope = await CryptoService.encrypt('hidden', 'password', fastKdf)
    const body = parseEnvelope(envelope)
    const replacement = body.ciphertext.at(-1) === 'A' ? 'B' : 'A'
    const tampered = serializeEnvelope({
      ...body,
      ciphertext: `${body.ciphertext.slice(0, -1)}${replacement}`,
    })

    await expect(CryptoService.decrypt(tampered, 'password')).rejects.toThrow()
  })

  it('rejects envelopes with excessive KDF parameters', async () => {
    const envelope = await CryptoService.encrypt('hidden', 'password', fastKdf)
    const body = parseEnvelope(envelope)

    expect(() =>
      parseEnvelope(
        serializeEnvelope({
          ...body,
          memlimit: MAX_KDF_PARAMS.memlimit + 1,
        }),
      ),
    ).toThrow()

    expect(() =>
      parseEnvelope(
        serializeEnvelope({
          ...body,
          opslimit: MAX_KDF_PARAMS.opslimit + 1,
        }),
      ),
    ).toThrow()
  })

  it('uses a fresh nonce for each save', async () => {
    const first = parseEnvelope(await CryptoService.encrypt('same', 'password', fastKdf))
    const second = parseEnvelope(await CryptoService.encrypt('same', 'password', fastKdf))

    expect(first.nonce).not.toBe(second.nonce)
    expect(first.ciphertext).not.toBe(second.ciphertext)
  })

  it('rotates the password via Save As semantics (fresh encrypt of the plaintext)', async () => {
    const envelope = await CryptoService.encrypt('rotated secret', 'old password', fastKdf)
    const plaintext = await CryptoService.decrypt(envelope, 'old password')
    const rotated = await CryptoService.encrypt(plaintext, 'new password', fastKdf)
    const body = parseEnvelope(rotated)

    // The rotated copy is encrypted at the caller's current KDF policy with a
    // fresh salt and nonce, exactly like any other save (SPEC §10 Save As).
    expect(body.opslimit).toBe(fastKdf.opslimit)
    expect(body.memlimit).toBe(fastKdf.memlimit)
    await expect(CryptoService.decrypt(rotated, 'old password')).rejects.toThrow()
    await expect(CryptoService.decrypt(rotated, 'new password')).resolves.toBe('rotated secret')
  })

  it('preserves a leading BOM (U+FEFF) through the roundtrip', async () => {
    const text = '﻿starts with a byte-order mark'
    const envelope = await CryptoService.encrypt(text, 'password', fastKdf)

    await expect(CryptoService.decrypt(envelope, 'password')).resolves.toBe(text)
  })

  it('includes a __proto__ unknown field in the canonical JSON', () => {
    expect(
      canonicalizeEnvelopeMetadata(
        JSON.parse('{"a":1,"__proto__":{"x":1}}') as Record<string, unknown>,
      ),
    ).toBe('{"__proto__":{"x":1},"a":1}')
  })

  it('detects tampering that appends a __proto__ metadata field', async () => {
    const envelope = await CryptoService.encrypt('hidden', 'password', fastKdf)
    const json = envelope
      .slice(ENVELOPE_HEADER.length, envelope.length - ENVELOPE_FOOTER.length)
      .trim()
    const tampered = `${ENVELOPE_HEADER}\n${json.replace(/^\{/, '{"__proto__":{"evil":1},')}\n${ENVELOPE_FOOTER}`

    await expect(CryptoService.decrypt(tampered, 'password')).rejects.toThrow()
  })

  it('rejects KDF options above the accepted caps before deriving', async () => {
    await expect(
      CryptoService.encrypt('x', 'pw', { memlimit: MAX_KDF_PARAMS.memlimit + 1 }),
    ).rejects.toThrow()
    await expect(
      CryptoService.encrypt('x', 'pw', { opslimit: MAX_KDF_PARAMS.opslimit + 1 }),
    ).rejects.toThrow()
    await expect(CryptoService.encrypt('x', 'pw', { opslimit: 2.5 })).rejects.toThrow()
    await expect(CryptoService.encrypt('x', 'pw', { opslimit: 0 })).rejects.toThrow()
  })

  it('rejects envelopes encrypted with noncanonical authenticated data', async () => {
    const storedOrderEnvelope = await encryptNonCanonicalEnvelope(
      'stored-order aad',
      'password',
      'stored-order',
    )
    const noAadEnvelope = await encryptNonCanonicalEnvelope('no aad', 'password', 'none')

    await expect(CryptoService.decrypt(storedOrderEnvelope, 'password')).rejects.toThrow()
    await expect(CryptoService.decrypt(noAadEnvelope, 'password')).rejects.toThrow()
  })

  it('canonicalizes nested object keys recursively', () => {
    expect(canonicalizeEnvelopeMetadata({ z: 1, nested: { y: 2, x: 3 } })).toBe(
      '{"nested":{"x":3,"y":2},"z":1}',
    )
  })

  it('rejects an envelope missing the app field', async () => {
    const body = parseEnvelope(await CryptoService.encrypt('hidden', 'password', fastKdf))
    const withoutApp: Record<string, unknown> = { ...body }

    delete withoutApp.app

    expect(() => parseEnvelope(serializeEnvelope(withoutApp as unknown as typeof body))).toThrow()
  })

  it('rejects an envelope with a wrong app field', async () => {
    const body = parseEnvelope(await CryptoService.encrypt('hidden', 'password', fastKdf))
    const tampered = serializeEnvelope({
      ...body,
      app: 'not-enoteweb',
    } as unknown as EncryptedEnvelopeBody)

    expect(() => parseEnvelope(tampered)).toThrow()
  })

  it('decrypts an envelope carrying an unknown metadata field present at encrypt time', async () => {
    const envelope = await encryptWithExtraField('forward compatible', 'password', {
      futureField: 'v2 metadata',
      futureCount: 7,
    })
    const body = parseEnvelope(envelope)

    expect(body.futureField).toBe('v2 metadata')
    expect(body.futureCount).toBe(7)
    await expect(CryptoService.decrypt(envelope, 'password')).resolves.toBe('forward compatible')
  })

  it('rejects URL-safe or unpadded Base64 in binary fields', async () => {
    const body = parseEnvelope(await CryptoService.encrypt('hidden', 'password', fastKdf))

    expect(() => parseEnvelope(serializeEnvelope({ ...body, salt: 'AAAA-BBB_' }))).toThrow()
    expect(() => parseEnvelope(serializeEnvelope({ ...body, salt: 'AAA' }))).toThrow()
  })

  it('rejects an unsupported envelope version', async () => {
    const body = parseEnvelope(await CryptoService.encrypt('hidden', 'password', fastKdf))
    const tampered = serializeEnvelope({ ...body, v: 2 } as unknown as typeof body)

    expect(() => parseEnvelope(tampered)).toThrow()
  })

})

describe('read-only envelope flag (SPEC Sections 7 and 11)', () => {
  it('round-trips readOnly: encrypt writes it, parse reads it, decrypt succeeds', async () => {
    const envelope = await CryptoService.encrypt('locked note', 'pw', {
      ...fastKdf,
      readOnly: true,
    })

    expect(isEnvelopeReadOnly(parseEnvelope(envelope))).toBe(true)
    await expect(CryptoService.decrypt(envelope, 'pw')).resolves.toBe('locked note')
  })

  it('an envelope without the read-only flag reads as writable', async () => {
    const envelope = await CryptoService.encrypt('plain note', 'pw', fastKdf)

    expect(parseEnvelope(envelope).readOnly).toBeUndefined()
    expect(isEnvelopeReadOnly(parseEnvelope(envelope))).toBe(false)
  })

  it('reads an unknown read-only flag value and still decrypts', async () => {
    const envelope = await encryptWithExtraField('future note', 'pw', { readOnly: true })

    expect(isEnvelopeReadOnly(parseEnvelope(envelope))).toBe(true)
    await expect(CryptoService.decrypt(envelope, 'pw')).resolves.toBe('future note')
  })

  it('treats non-boolean readOnly values as writable, never as a parse error', async () => {
    const envelope = await encryptWithExtraField('odd note', 'pw', { readOnly: 'yes' })

    expect(isEnvelopeReadOnly(parseEnvelope(envelope))).toBe(false)
    await expect(CryptoService.decrypt(envelope, 'pw')).resolves.toBe('odd note')
  })
})
