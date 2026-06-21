import { expect, test } from '@playwright/test'
import sodium from 'libsodium-wrappers-sumo'

const ENVELOPE_HEADER = '-----BEGIN ENOTEWEB ENCRYPTED TEXT-----'
const ENVELOPE_FOOTER = '-----END ENOTEWEB ENCRYPTED TEXT-----'

const canonicalize = (metadata: Record<string, unknown>) =>
  JSON.stringify(
    Object.keys(metadata)
      .sort()
      .reduce<Record<string, unknown>>((nextMetadata, key) => {
        nextMetadata[key] = metadata[key]
        return nextMetadata
      }, {}),
  )

const createCanonicalEnvelope = async (plaintext: string, password: string) => {
  await sodium.ready

  const salt = sodium.randombytes_buf(16)
  const nonce = sodium.randombytes_buf(24)
  const metadata = {
    v: 1,
    app: 'enoteweb',
    kdf: 'argon2id13',
    opslimit: 2,
    memlimit: 8_388_608,
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
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      canonicalize(metadata),
      null,
      nonce,
      key,
    )
    const body = {
      ...metadata,
      ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL),
    }

    return `${ENVELOPE_HEADER}\n${JSON.stringify(body)}\n${ENVELOPE_FOOTER}`
  } finally {
    key.fill(0)
  }
}

test('Browse opens a canonical local file after rebuild', async ({ page }) => {
  const password = 'previous-build password'
  const marker = 'PREVIOUS_BUILD_LOCAL_FILE_MARKER'
  const envelope = await createCanonicalEnvelope(marker, password)

  await page.addInitScript((encryptedEnvelope) => {
    class TestFileHandle {
      readonly kind = 'file'
      readonly name = 'previous-build.txt'

      async getFile() {
        return new File([encryptedEnvelope], this.name, { type: 'text/plain' })
      }

      async queryPermission() {
        return 'prompt'
      }

      async requestPermission() {
        return 'granted'
      }

      async createWritable() {
        return {
          async close() {
            return undefined
          },
          async write() {
            return undefined
          },
        }
      }

      async isSameEntry(otherHandle: { name?: string }) {
        return otherHandle?.name === this.name
      }
    }

    Object.defineProperty(globalThis, 'showOpenFilePicker', {
      configurable: true,
      value: async () => [new TestFileHandle()],
    })
    Object.defineProperty(globalThis, 'showSaveFilePicker', {
      configurable: true,
      value: async () => new TestFileHandle(),
    })
  }, envelope)

  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Browse' })).toBeVisible()

  // File first, password second (SPEC §2): Browse opens the picker, then the
  // unlock password dialog — the home has no password field (SPEC §10/§17).
  await page.getByRole('button', { name: 'Browse' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Unlock' }).click()

  await expect(page.locator('.cm-content')).toContainText(marker, { timeout: 30_000 })
})
