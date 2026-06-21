import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
export { describe, expect, it, vi }
import { CryptoService } from '../crypto/cryptoService'
export { CryptoService }
import { createPkceChallenge, DropboxProvider } from './dropboxProvider'
export { createPkceChallenge, DropboxProvider }
import { VaultStore, type DropboxFileDraft, type SyncRecordDraft } from './vaultStore'
export { VaultStore }
export type { DropboxFileDraft, SyncRecordDraft }

export const fastKdf = {
  memlimit: 8_388_608,
  opslimit: 2,
}

let dbCounter = 0

export const testDbName = () => {
  dbCounter += 1
  return `enoteweb-dropbox-test-${Date.now()}-${dbCounter}`
}

export const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers instanceof Headers ? Object.fromEntries(init.headers) : init.headers),
    },
    status: init.status ?? 200,
  })

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: new IDBFactory(),
  })
  Object.defineProperty(globalThis.navigator, 'onLine', {
    configurable: true,
    value: true,
  })
})

// State seeding: a selected per-file record plus account-level sync state —
// the shape the provider reads.
export const seedSelectedRecord = async (
  store: VaultStore,
  record: Partial<DropboxFileDraft> = {},
  sync: SyncRecordDraft = {},
) => {
  const key = record.key ?? 'id:vault'

  await store.putDropboxFile({
    name: 'vault.txt',
    pathDisplay: '/Notes/vault.txt',
    pathLower: '/notes/vault.txt',
    ...record,
    key,
  })
  await store.saveDropboxSync({
    linked: true,
    refreshToken: 'refresh-token',
    selectedFileKey: key,
    ...sync,
  })
}
