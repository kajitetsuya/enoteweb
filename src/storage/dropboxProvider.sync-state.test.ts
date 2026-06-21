import {
  describe,
  expect,
  it,
  DropboxProvider,
  VaultStore,
  testDbName,
} from './dropboxProvider.testkit'

describe('DropboxProvider hasUnsyncedLocalChanges (no network)', () => {
  const makeProvider = (store: VaultStore) =>
    new DropboxProvider({
      appKey: 'dropbox-app-key',
      getHref: () => 'https://example.test/',
      navigate: () => undefined,
      store,
    })

  it('reports synced when the local cache equals the last-synced envelope', async () => {
    const store = new VaultStore(testDbName())
    await store.saveEnvelope('env-1', new Date(), 'dropbox')
    await store.saveDropboxSync({
      lastSyncedEnvelope: 'env-1',
      lastSyncStatus: 'synced',
      pendingLocalEnvelope: null,
    })

    expect(await makeProvider(store).hasUnsyncedLocalChanges()).toBe(false)
  })

  it('reports unsynced when a pending local envelope exists', async () => {
    const store = new VaultStore(testDbName())
    await store.saveEnvelope('env-1', new Date(), 'dropbox')
    await store.saveDropboxSync({ lastSyncedEnvelope: 'env-1', pendingLocalEnvelope: 'env-2' })

    expect(await makeProvider(store).hasUnsyncedLocalChanges()).toBe(true)
  })

  it('reports unsynced on a drifted remoteConflictRev-only conflict signal', async () => {
    const store = new VaultStore(testDbName())
    await store.saveEnvelope('env-1', new Date(), 'dropbox')
    await store.saveDropboxSync({
      lastSyncedEnvelope: 'env-1',
      pendingLocalEnvelope: null,
      remoteConflictRev: 'rev-9',
    })

    expect(await makeProvider(store).hasUnsyncedLocalChanges()).toBe(true)
  })

  it('reports unsynced when the local cache diverges from the last-synced envelope', async () => {
    const store = new VaultStore(testDbName())
    await store.saveEnvelope('env-local', new Date(), 'dropbox')
    await store.saveDropboxSync({ lastSyncedEnvelope: 'env-remote', pendingLocalEnvelope: null })

    expect(await makeProvider(store).hasUnsyncedLocalChanges()).toBe(true)
  })

  it('reports synced when offline but the cache still equals the last-synced envelope', async () => {
    Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: false })
    const store = new VaultStore(testDbName())
    await store.saveEnvelope('env-1', new Date(), 'dropbox')
    await store.saveDropboxSync({
      lastSyncedEnvelope: 'env-1',
      lastSyncStatus: 'offline',
      pendingLocalEnvelope: null,
    })

    expect(await makeProvider(store).hasUnsyncedLocalChanges()).toBe(false)
  })

  it('getSyncState surfaces hasUnsyncedLocal under the same rule (Draft saves count)', async () => {
    const store = new VaultStore(testDbName())
    await store.saveEnvelope('env-1', new Date(), 'dropbox')
    await store.saveDropboxSync({ lastSyncedEnvelope: 'env-1', pendingLocalEnvelope: null })

    expect((await makeProvider(store).getSyncState()).hasUnsyncedLocal).toBe(false)

    // An autosave while Dropbox is NOT the active provider touches only the
    // vault record: the sync record still claims "synced", but the vault no
    // longer equals the last-synced snapshot — the app's Save/sync button
    // must read this as unsynced (it muted with "Already synced" before).
    await store.saveEnvelope('env-2', new Date(), 'draft')

    expect((await makeProvider(store).getSyncState()).hasUnsyncedLocal).toBe(true)
  })
})

describe('DropboxProvider hasSelectedRemote (no network)', () => {
  const makeProvider = (store: VaultStore) =>
    new DropboxProvider({
      appKey: 'dropbox-app-key',
      getHref: () => 'https://example.test/',
      navigate: () => undefined,
      store,
    })

  it('is true when a file id is recorded', async () => {
    const store = new VaultStore(testDbName())
    await store.saveDropboxSync({ selectedFileId: 'id:notes' })

    expect(await makeProvider(store).hasSelectedRemote()).toBe(true)
  })

  it('is true for a path-only record with no file id (lower path)', async () => {
    const store = new VaultStore(testDbName())
    await store.saveDropboxSync({
      selectedFileId: null,
      selectedPathLower: '/notes/notes.txt',
      selectedPathDisplay: null,
    })

    expect(await makeProvider(store).hasSelectedRemote()).toBe(true)
  })

  it('is true for a display-path-only record', async () => {
    const store = new VaultStore(testDbName())
    await store.saveDropboxSync({
      selectedFileId: null,
      selectedPathLower: null,
      selectedPathDisplay: '/Notes/notes.txt',
    })

    expect(await makeProvider(store).hasSelectedRemote()).toBe(true)
  })

  it('is false when no remote file is selected', async () => {
    const store = new VaultStore(testDbName())
    await store.saveDropboxSync({
      selectedFileId: null,
      selectedPathLower: null,
      selectedPathDisplay: null,
    })

    expect(await makeProvider(store).hasSelectedRemote()).toBe(false)
  })
})
