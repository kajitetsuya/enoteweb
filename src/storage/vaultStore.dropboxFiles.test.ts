import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createPathDropboxFileKey,
  DROPBOX_FILE_TARGET_CAP,
  VaultStore,
  type DropboxFileDraft,
} from './vaultStore'

let dbCounter = 0

const testDbName = () => {
  dbCounter += 1
  return `enoteweb-dropbox-files-test-${Date.now()}-${dbCounter}`
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', {
    value: new IDBFactory(),
    configurable: true,
  })
})

const fileDraft = (key: string, overrides: Partial<DropboxFileDraft> = {}): DropboxFileDraft => ({
  key,
  name: `${key}.txt`,
  pathDisplay: `/Notes/${key}.txt`,
  pathLower: `/notes/${key}.txt`,
  ...overrides,
})

describe('VaultStore Dropbox file records', () => {
  it('upserts records, preserves createdAt, and lists newest-opened first', async () => {
    const store = new VaultStore(testDbName())

    await store.putDropboxFile(fileDraft('id:a'), new Date('2026-06-12T10:00:00.000Z'))
    await store.putDropboxFile(fileDraft('id:b'), new Date('2026-06-12T11:00:00.000Z'))
    await store.putDropboxFile(
      fileDraft('id:a', { envelope: 'envelope-a2' }),
      new Date('2026-06-12T12:00:00.000Z'),
    )

    const records = await store.getDropboxFiles()

    // id:a kept its original lastOpenedAt (the upsert did not touch it), so
    // id:b is still the most recently opened.
    expect(records.map((record) => record.key)).toEqual(['id:b', 'id:a'])

    const recordA = await store.getDropboxFile('id:a')

    expect(recordA).toMatchObject({
      createdAt: '2026-06-12T10:00:00.000Z',
      envelope: 'envelope-a2',
      updatedAt: '2026-06-12T12:00:00.000Z',
    })
  })

  it('merges undefined draft fields from the existing record instead of nulling them', async () => {
    const store = new VaultStore(testDbName())

    await store.putDropboxFile(
      fileDraft('id:a', {
        baseRev: 'rev-1',
        envelope: 'cache-1',
        pendingLocalEnvelope: 'pending-1',
      }),
    )
    await store.putDropboxFile(fileDraft('id:a', { baseRev: 'rev-2' }))

    expect(await store.getDropboxFile('id:a')).toMatchObject({
      baseRev: 'rev-2',
      envelope: 'cache-1',
      pendingLocalEnvelope: 'pending-1',
    })
  })

  it('touchDropboxFileOpened moves a record to the top of the list', async () => {
    const store = new VaultStore(testDbName())

    await store.putDropboxFile(fileDraft('id:a'), new Date('2026-06-12T10:00:00.000Z'))
    await store.putDropboxFile(fileDraft('id:b'), new Date('2026-06-12T11:00:00.000Z'))
    await store.touchDropboxFileOpened('id:a', new Date('2026-06-12T12:00:00.000Z'))

    const records = await store.getDropboxFiles()

    expect(records.map((record) => record.key)).toEqual(['id:a', 'id:b'])
  })

  it('evicts the oldest-opened synced record beyond the target cap, never unsynced ones', async () => {
    const store = new VaultStore(testDbName())

    // Fill to the cap. The oldest record carries unsynced changes.
    for (let index = 0; index < DROPBOX_FILE_TARGET_CAP; index += 1) {
      const minutes = String(index).padStart(2, '0')

      await store.putDropboxFile(
        fileDraft(`id:f${index}`, {
          pendingLocalEnvelope: index === 0 ? 'unsynced-edit' : null,
        }),
        new Date(`2026-06-12T10:${minutes}:00.000Z`),
      )
    }

    const { evictedKeys } = await store.putDropboxFile(
      fileDraft('id:new'),
      new Date('2026-06-12T12:00:00.000Z'),
    )

    // id:f0 is the oldest but unsynced; id:f1 is the oldest evictable.
    expect(evictedKeys).toEqual(['id:f1'])
    expect(await store.getDropboxFile('id:f0')).not.toBeNull()
    expect(await store.getDropboxFile('id:f1')).toBeNull()
    expect((await store.getDropboxFiles()).length).toBe(DROPBOX_FILE_TARGET_CAP)
  })

  it('temporarily exceeds the cap rather than evict unsynced records', async () => {
    const store = new VaultStore(testDbName())

    for (let index = 0; index < DROPBOX_FILE_TARGET_CAP; index += 1) {
      const minutes = String(index).padStart(2, '0')

      await store.putDropboxFile(
        fileDraft(`id:f${index}`, { pendingLocalEnvelope: `unsynced-${index}` }),
        new Date(`2026-06-12T10:${minutes}:00.000Z`),
      )
    }

    const { evictedKeys } = await store.putDropboxFile(
      fileDraft('id:new'),
      new Date('2026-06-12T12:00:00.000Z'),
    )

    expect(evictedKeys).toEqual([])
    expect((await store.getDropboxFiles()).length).toBe(DROPBOX_FILE_TARGET_CAP + 1)
  })

  it('clears the persisted selection when the selected record is deleted or evicted', async () => {
    const store = new VaultStore(testDbName())

    await store.putDropboxFile(fileDraft('id:a'))
    await store.putDropboxFile(fileDraft('id:b'))
    await store.setSelectedDropboxFileKey('id:a')

    await store.deleteDropboxFile('id:b')
    expect((await store.getDropboxSync())?.selectedFileKey).toBe('id:a')

    await store.deleteDropboxFile('id:a')
    expect((await store.getDropboxSync())?.selectedFileKey).toBeNull()
  })

  it('rekeys a path record to the file id, moving fields and the selection', async () => {
    const store = new VaultStore(testDbName())
    const pathKey = createPathDropboxFileKey('/notes/a.txt')

    await store.putDropboxFile(
      fileDraft(pathKey, {
        baseRev: 'rev-1',
        envelope: 'cache-1',
        pendingLocalEnvelope: 'pending-1',
      }),
      new Date('2026-06-12T10:00:00.000Z'),
    )
    await store.setSelectedDropboxFileKey(pathKey)

    const record = await store.rekeyDropboxFile(pathKey, 'id:a')

    expect(record).toMatchObject({
      baseRev: 'rev-1',
      envelope: 'cache-1',
      key: 'id:a',
      lastOpenedAt: '2026-06-12T10:00:00.000Z',
      pendingLocalEnvelope: 'pending-1',
    })
    expect(await store.getDropboxFile(pathKey)).toBeNull()
    expect((await store.getDropboxSync())?.selectedFileKey).toBe('id:a')
  })

  it('rekeying onto an existing id record keeps the target authoritative for cache fields', async () => {
    const store = new VaultStore(testDbName())
    const pathKey = createPathDropboxFileKey('/notes/a.txt')

    await store.putDropboxFile(
      fileDraft('id:a', {
        baseRev: 'rev-id',
        envelope: 'cache-id',
        lastSyncedEnvelope: 'synced-id',
        pendingLocalEnvelope: 'pending-id',
      }),
    )
    await store.putDropboxFile(
      fileDraft(pathKey, {
        baseRev: 'rev-path',
        envelope: 'cache-path',
        pendingLocalEnvelope: null,
      }),
    )

    const record = await store.rekeyDropboxFile(pathKey, 'id:a')

    // The id-keyed record's data survives; the stale path-keyed copy must not
    // overwrite it just because the rekey arrived later.
    expect(record).toMatchObject({
      baseRev: 'rev-id',
      envelope: 'cache-id',
      key: 'id:a',
      lastSyncedEnvelope: 'synced-id',
      pendingLocalEnvelope: 'pending-id',
    })
    expect(await store.getDropboxFile(pathKey)).toBeNull()
  })

  it('rekeying carries the pending envelope when the target has none', async () => {
    const store = new VaultStore(testDbName())
    const pathKey = createPathDropboxFileKey('/notes/a.txt')

    await store.putDropboxFile(
      fileDraft('id:a', { envelope: 'cache-id', pendingLocalEnvelope: null }),
    )
    await store.putDropboxFile(
      fileDraft(pathKey, { pendingLocalEnvelope: 'pending-path' }),
    )

    const record = await store.rekeyDropboxFile(pathKey, 'id:a')

    expect(record).toMatchObject({
      envelope: 'cache-id',
      pendingLocalEnvelope: 'pending-path',
    })
  })

  it('refuses to rekey when both records hold distinct pending envelopes', async () => {
    const store = new VaultStore(testDbName())
    const pathKey = createPathDropboxFileKey('/notes/a.txt')

    await store.putDropboxFile(fileDraft('id:a', { pendingLocalEnvelope: 'pending-id' }))
    await store.putDropboxFile(fileDraft(pathKey, { pendingLocalEnvelope: 'pending-path' }))
    await store.setSelectedDropboxFileKey(pathKey)

    // An automatic merge would necessarily destroy one unsynced edit: refuse,
    // keep both records, and leave the selection untouched.
    expect(await store.rekeyDropboxFile(pathKey, 'id:a')).toBeNull()
    expect((await store.getDropboxFile(pathKey))?.pendingLocalEnvelope).toBe('pending-path')
    expect((await store.getDropboxFile('id:a'))?.pendingLocalEnvelope).toBe('pending-id')
    expect((await store.getDropboxSync())?.selectedFileKey).toBe(pathKey)
  })

  it('upgrades an existing v1 database in place, keeping its data', async () => {
    const dbName = testDbName()

    // Hand-build a version-1 database with the version-1 store layout.
    const v1 = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 1)

      request.onupgradeneeded = () => {
        for (const storeName of ['vault', 'file', 'sync', 'settings']) {
          request.result.createObjectStore(storeName, { keyPath: 'key' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('open failed'))
    })

    await new Promise<void>((resolve, reject) => {
      const transaction = v1.transaction('vault', 'readwrite')

      transaction.objectStore('vault').put({
        key: 'primary',
        envelope: 'v1-envelope',
        activeProvider: 'draft',
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
        appVersion: '1.0.0',
      })
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('tx failed'))
    })
    v1.close()

    const store = new VaultStore(dbName)

    expect((await store.getVault())?.envelope).toBe('v1-envelope')
    expect(await store.getDropboxFiles()).toEqual([])
  })

})
