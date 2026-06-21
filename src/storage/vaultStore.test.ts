import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { CryptoService } from '../crypto/cryptoService'
import { VaultStore } from './vaultStore'

const fastKdf = {
  opslimit: 2,
  memlimit: 8_388_608,
}

let dbCounter = 0

const testDbName = () => {
  dbCounter += 1
  return `enoteweb-test-${Date.now()}-${dbCounter}`
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', {
    value: new IDBFactory(),
    configurable: true,
  })
})

describe('VaultStore', () => {
  it('persists an encrypted envelope across store instances', async () => {
    const dbName = testDbName()
    const envelope = await CryptoService.encrypt('reload survives', 'password', fastKdf)
    const firstStore = new VaultStore(dbName)

    await firstStore.saveEnvelope(envelope, new Date('2026-05-31T10:00:00.000Z'))
    firstStore.close()

    const secondStore = new VaultStore(dbName)
    const record = await secondStore.getVault()

    expect(record?.envelope).toBe(envelope)
    expect(record).toMatchObject({
      activeProvider: 'draft',
      appVersion: '1.0.0',
      createdAt: '2026-05-31T10:00:00.000Z',
      key: 'primary',
      updatedAt: '2026-05-31T10:00:00.000Z',
    })
  })

  it('stores encrypted envelopes and metadata without plaintext', async () => {
    const dbName = testDbName()
    const marker = 'PLAINTEXT_MARKER_SHOULD_NOT_PERSIST'
    const envelope = await CryptoService.encrypt(marker, 'password', fastKdf)
    const store = new VaultStore(dbName)

    await store.saveEnvelope(envelope)

    const rawRecord = await store.getVault()
    const serialized = JSON.stringify(rawRecord)

    expect(serialized).toContain('ciphertext')
    expect(serialized).not.toContain(marker)
    expect(await CryptoService.decrypt(rawRecord?.envelope ?? '', 'password')).toBe(marker)
  })

  it('updates autosave timestamps without changing createdAt', async () => {
    const dbName = testDbName()
    const store = new VaultStore(dbName)
    const firstEnvelope = await CryptoService.encrypt('one', 'password', fastKdf)
    const secondEnvelope = await CryptoService.encrypt('two', 'password', fastKdf)

    await store.saveEnvelope(firstEnvelope, new Date('2026-05-31T10:00:00.000Z'))
    await store.saveEnvelope(secondEnvelope, new Date('2026-05-31T10:01:00.000Z'))

    const record = await store.getVault()

    expect(record?.createdAt).toBe('2026-05-31T10:00:00.000Z')
    expect(record?.updatedAt).toBe('2026-05-31T10:01:00.000Z')
  })

  it('creates the spec object stores', async () => {
    const dbName = testDbName()
    const store = new VaultStore(dbName)

    await store.getVault()

    const openRequest = indexedDB.open(dbName)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      openRequest.onsuccess = () => resolve(openRequest.result)
      openRequest.onerror = () => reject(openRequest.error)
    })

    expect(Array.from(db.objectStoreNames)).toEqual([
      'dropboxFile',
      'file',
      'settings',
      'sync',
      'vault',
    ])
    db.close()
  })

  it('persists the optional Secret key setting', async () => {
    const dbName = testDbName()
    const store = new VaultStore(dbName)
    const opaqueSecretKey = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEfGhIj'

    await store.saveSetting({
      key: 'secretKey',
      value: opaqueSecretKey,
    })

    expect(await store.getSetting('secretKey')).toEqual({
      key: 'secretKey',
      value: opaqueSecretKey,
    })

    await store.saveSetting({ key: 'secretKey', value: null })
    expect(await store.getSetting('secretKey')).toEqual({ key: 'secretKey', value: null })
  })

  it('persists and clears Dropbox sync auth without clearing encrypted cache', async () => {
    const dbName = testDbName()
    const store = new VaultStore(dbName)
    const envelope = await CryptoService.encrypt('dropbox cache', 'password', fastKdf)

    await store.saveEnvelope(envelope, new Date('2026-06-01T10:00:00.000Z'), 'dropbox')
    await store.saveDropboxSync({
      accountLabel: 'dbid:test',
      baseRev: 'rev-a',
      codeVerifier: 'verifier',
      lastSyncAt: '2026-06-01T10:01:00.000Z',
      lastSyncedEnvelope: envelope,
      lastSyncStatus: 'synced',
      linked: true,
      oauthState: 'state',
      refreshToken: 'refresh-token',
      selectedFileId: 'id:notes',
      selectedName: 'notes.txt',
      selectedPathDisplay: '/Notes/notes.txt',
      selectedPathLower: '/notes/notes.txt',
    })

    const savedSync = await store.getDropboxSync()

    expect(savedSync).toMatchObject({
      accountLabel: 'dbid:test',
      baseRev: 'rev-a',
      linked: true,
      selectedFileId: 'id:notes',
      selectedPathDisplay: '/Notes/notes.txt',
      refreshToken: 'refresh-token',
    })

    await store.pauseDropboxLink()

    const pausedSync = await store.getDropboxSync()
    const savedVault = await store.getVault()

    expect(pausedSync).toMatchObject({
      // accountLabel is intentionally kept across an unlink so a later Link can
      // name the previously connected account in its confirmation prompt.
      accountLabel: 'dbid:test',
      linked: false,
      refreshToken: 'refresh-token',
      selectedFileId: 'id:notes',
      selectedPathDisplay: '/Notes/notes.txt',
    })

    await store.clearDropboxAuth()

    const clearedSync = await store.getDropboxSync()

    expect(clearedSync).toMatchObject({
      accountLabel: 'dbid:test',
      linked: false,
      refreshToken: null,
      selectedFileId: 'id:notes',
      selectedPathDisplay: '/Notes/notes.txt',
    })
    expect(savedVault?.envelope).toBe(envelope)
  })

  it('retries after a failed IndexedDB open instead of caching the rejection', async () => {
    const dbName = testDbName()
    const store = new VaultStore(dbName)
    const realIndexedDB = globalThis.indexedDB
    let openCalls = 0
    const flakyIndexedDB = {
      open(...args: Parameters<IDBFactory['open']>) {
        openCalls += 1

        if (openCalls === 1) {
          // A one-off failing open request: fires onerror asynchronously,
          // like a transient storage-pressure failure at launch.
          const failingRequest = {
            error: new DOMException('transient open failure', 'UnknownError'),
            onblocked: null as (() => void) | null,
            onerror: null as (() => void) | null,
            onsuccess: null as (() => void) | null,
            onupgradeneeded: null as (() => void) | null,
          }

          queueMicrotask(() => failingRequest.onerror?.())
          return failingRequest as unknown as IDBOpenDBRequest
        }

        return realIndexedDB.open(...args)
      },
    }

    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: flakyIndexedDB,
    })

    try {
      await expect(store.getVault()).rejects.toThrow()

      // The rejection must not be memoized: the next operation re-opens and
      // succeeds, so one transient failure cannot poison the whole session.
      await store.saveEnvelope('envelope-after-retry', new Date())
      expect((await store.getVault())?.envelope).toBe('envelope-after-retry')
      expect(openCalls).toBeGreaterThan(1)
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', {
        configurable: true,
        value: realIndexedDB,
      })
    }
  })

  it('closes the connection on versionchange so a future upgrade is not deadlocked', async () => {
    const dbName = testDbName()
    const store = new VaultStore(dbName)

    await store.saveEnvelope('envelope-before-upgrade', new Date())

    // Simulate a newer build bumping the DB version in another tab: without an
    // onversionchange handler, this open would block forever.
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 3)

      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('open failed'))
    })

    expect(upgraded.version).toBe(3)
    upgraded.close()
  })
})
