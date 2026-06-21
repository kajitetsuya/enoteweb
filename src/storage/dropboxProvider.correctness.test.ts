import {
  describe,
  expect,
  it,
  vi,
  CryptoService,
  DropboxProvider,
  VaultStore,
  fastKdf,
  testDbName,
  jsonResponse,
  seedSelectedRecord,
} from './dropboxProvider.testkit'
import { DropboxProviderError } from './dropboxProvider'

describe('DropboxProvider correctness checks', () => {
  const tokenResponse = () =>
    jsonResponse({ access_token: 'access-token', expires_in: 14400, token_type: 'bearer' })

  const fileMetadata = (rev: string) => ({
    '.tag': 'file',
    id: 'id:vault',
    name: 'vault.txt',
    path_display: '/Notes/vault.txt',
    path_lower: '/notes/vault.txt',
    rev,
  })

  const headerValueOf = (init: unknown, name: string) =>
    String((init as { headers?: Record<string, string> } | undefined)?.headers?.[name])

  it('save() persists the pending envelope before the upload starts', async () => {
    const store = new VaultStore(testDbName())
    const envelope = await CryptoService.encrypt('newest text', 'password', fastKdf)
    let pendingAtUpload: string | null | undefined
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth2/token')) {
        return tokenResponse()
      }

      if (url.endsWith('/files/get_metadata')) {
        return jsonResponse(fileMetadata('rev-base'))
      }

      if (url.endsWith('/files/upload')) {
        pendingAtUpload = (await store.getDropboxFile('id:vault'))?.pendingLocalEnvelope
        return jsonResponse(fileMetadata('rev-after-upload'))
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as unknown as typeof fetch,
      store,
    })

    await seedSelectedRecord(store, {
      key: 'id:vault',
      baseRev: 'rev-base',
      lastSyncedEnvelope: 'env-old',
    })
    await provider.save(envelope)

    // Durability-first ordering: when the network upload began, the newest
    // envelope was already recorded as pending, so a process kill mid-upload
    // can never leave a 'synced' record hiding unsynced local bytes.
    expect(pendingAtUpload).toBe(envelope)
    expect(await store.getDropboxSync()).toMatchObject({ lastSyncStatus: 'synced' })
    expect(await store.getDropboxFile('id:vault')).toMatchObject({
      baseRev: 'rev-after-upload',
      envelope,
      lastSyncedEnvelope: envelope,
      pendingLocalEnvelope: null,
    })
  })

  it('load() never pulls the remote over a cache that diverges from the last-synced envelope', async () => {
    const store = new VaultStore(testDbName())
    const fetcher = vi.fn()
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      store,
    })

    // The mid-upload-kill shape: the selected file cache has newer bytes, while
    // the record still reflects the older last-synced snapshot.
    await seedSelectedRecord(store, {
      key: 'id:vault',
      baseRev: 'rev-base',
      envelope: 'env-newer-local',
      lastSyncedEnvelope: 'env-old',
    })

    await expect(provider.load()).resolves.toBe('env-newer-local')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('load() serves the local cache on a drifted remoteConflictRev-only record', async () => {
    const store = new VaultStore(testDbName())
    const fetcher = vi.fn()
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      store,
    })

    await seedSelectedRecord(
      store,
      { key: 'id:vault', envelope: 'env-1', lastSyncedEnvelope: 'env-1' },
      { remoteConflictRev: 'rev-drifted' },
    )

    await expect(provider.load()).resolves.toBe('env-1')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('a 409 route error (insufficient_space) is recorded as recoverable, not a conflict', async () => {
    const store = new VaultStore(testDbName())
    const envelope = await CryptoService.encrypt('text to push', 'password', fastKdf)
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth2/token')) {
        return tokenResponse()
      }

      if (url.endsWith('/files/get_metadata')) {
        return jsonResponse(fileMetadata('rev-base'))
      }

      if (url.endsWith('/files/upload')) {
        return jsonResponse({ error_summary: 'path/insufficient_space/..' }, { status: 409 })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as unknown as typeof fetch,
      store,
    })

    await seedSelectedRecord(store, {
      key: 'id:vault',
      baseRev: 'rev-base',
      lastSyncedEnvelope: 'env-old',
    })
    await provider.save(envelope)

    // No bogus conflict: the document is kept pending and retried, and no
    // remote snapshot download (recordConflict) was attempted.
    expect(await store.getDropboxSync()).toMatchObject({
      lastSyncStatus: 'pending-local',
      remoteConflictEnvelope: null,
      remoteConflictRev: null,
    })
    expect(await store.getDropboxFile('id:vault')).toMatchObject({
      pendingLocalEnvelope: envelope,
    })
    expect(fetcher.mock.calls.some((call) => String(call[0]).endsWith('/files/download'))).toBe(
      false,
    )
  })

  it('a deleted remote file surfaces as needs-attention, not permanent pending sync', async () => {
    const store = new VaultStore(testDbName())
    const envelope = await CryptoService.encrypt('sync me', 'password', fastKdf)
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth2/token')) {
        return tokenResponse()
      }

      if (url.endsWith('/files/get_metadata')) {
        return jsonResponse({ error_summary: 'path/not_found/..' }, { status: 409 })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as unknown as typeof fetch,
      store,
    })

    await seedSelectedRecord(store, {
      key: 'id:vault',
      baseRev: 'rev-base',
      envelope,
      lastSyncedEnvelope: envelope,
    })

    const status = await provider.syncNow()

    expect(status.state).toBe('error')
    expect((await store.getDropboxSync())?.lastSyncStatus).toBe('error')
    // The doomed second round-trip (upload after a failed metadata check) is gone.
    expect(fetcher.mock.calls.some((call) => String(call[0]).endsWith('/files/upload'))).toBe(
      false,
    )
  })

  it('a token exchange without a refresh token clears PKCE material and scrubs the URL', async () => {
    const store = new VaultStore(testDbName())
    const fetcher = vi.fn(async () =>
      jsonResponse({ access_token: 'short-lived', expires_in: 14400, token_type: 'bearer' }),
    )
    const replaceHref = vi.fn()
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as unknown as typeof fetch,
      replaceHref,
      store,
    })

    await store.saveDropboxSync({ codeVerifier: 'verifier', oauthState: 'state' })

    await expect(
      provider.completeLinkFromRedirect('https://example.test/app?code=abc&state=state'),
    ).rejects.toThrow('refresh token')

    expect(await store.getDropboxSync()).toMatchObject({
      codeVerifier: null,
      oauthState: null,
    })
    expect(replaceHref).toHaveBeenCalledWith('https://example.test/app')
  })

  it('a 200 token response without an access token fails instead of caching undefined', async () => {
    const store = new VaultStore(testDbName())
    const fetcher = vi.fn(async () =>
      jsonResponse({ refresh_token: 'refresh-token', token_type: 'bearer' }),
    )
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as unknown as typeof fetch,
      replaceHref: () => undefined,
      store,
    })

    await store.saveDropboxSync({ codeVerifier: 'verifier', oauthState: 'state' })

    await expect(
      provider.completeLinkFromRedirect('https://example.test/app?code=abc&state=state'),
    ).rejects.toThrow('malformed')
  })

  it('a 409 whose remote equals the pending envelope records synced, not a false conflict', async () => {
    const store = new VaultStore(testDbName())
    const envelope = await CryptoService.encrypt('the only true text', 'password', fastKdf)
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth2/token')) {
        return tokenResponse()
      }

      if (url.endsWith('/files/get_metadata')) {
        return jsonResponse(fileMetadata('rev-base'))
      }

      if (url.endsWith('/files/upload')) {
        // A previous upload already landed (e.g. before a crash cleared pending),
        // so this conditional upload 409s against the stale base rev.
        return jsonResponse({ error_summary: 'path/conflict/file/..' }, { status: 409 })
      }

      if (url.endsWith('/files/download')) {
        // The remote is byte-identical to what we were trying to push.
        return new Response(envelope, {
          headers: { 'dropbox-api-result': JSON.stringify(fileMetadata('rev-remote')) },
          status: 200,
        })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as unknown as typeof fetch,
      store,
    })

    await seedSelectedRecord(store, {
      key: 'id:vault',
      baseRev: 'rev-base',
      lastSyncedEnvelope: 'env-old',
    })
    await provider.save(envelope)

    // No bogus conflict: the remote matched our pending bytes, so it is adopted
    // as the new synced base instead of opening a no-op resolve flow.
    expect(await store.getDropboxSync()).toMatchObject({
      lastSyncStatus: 'synced',
      remoteConflictEnvelope: null,
      remoteConflictRev: null,
    })
    expect(await store.getDropboxFile('id:vault')).toMatchObject({
      baseRev: 'rev-remote',
      envelope,
      lastSyncedEnvelope: envelope,
      pendingLocalEnvelope: null,
    })
  })

  it('non-ASCII Dropbox paths are escaped to ASCII in Dropbox-API-Arg headers', async () => {
    const store = new VaultStore(testDbName())
    const envelope = await CryptoService.encrypt('日本語のノート', 'password', fastKdf)
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      void init

      if (url.endsWith('/oauth2/token')) {
        return tokenResponse()
      }

      return jsonResponse({
        '.tag': 'file',
        id: 'id:jp',
        name: 'ノート.txt',
        path_display: '/ノート.txt',
        path_lower: '/ノート.txt',
        rev: 'rev-jp',
      })
    })
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as unknown as typeof fetch,
      store,
    })

    await store.saveDropboxSync({ linked: true, refreshToken: 'refresh-token' })
    await provider.createRemoteFile('/ノート.txt', envelope)

    const uploadCall = fetcher.mock.calls.find((call) =>
      String(call[0]).endsWith('/files/upload'),
    )
    const headerValue = headerValueOf(uploadCall?.[1], 'Dropbox-API-Arg')

    // The header value must be a pure-ASCII ByteString (a real fetch would
    // throw on anything above U+00FF), while decoding back to the same path.
    expect([...headerValue].every((ch) => ch.charCodeAt(0) <= 0x7e)).toBe(true)
    expect(JSON.parse(headerValue)).toMatchObject({ path: '/ノート.txt' })
  })

  it("a corrupt remote file rejects with 'corrupt', not 'offline', when online", async () => {
    const store = new VaultStore(testDbName())
    const fileMetadata = (rev: string) => ({
      '.tag': 'file',
      id: 'id:vault',
      name: 'vault.txt',
      path_display: '/Notes/vault.txt',
      path_lower: '/notes/vault.txt',
      rev,
    })
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth2/token')) {
        return jsonResponse({ access_token: 'access-token', expires_in: 14400, token_type: 'bearer' })
      }

      if (url.endsWith('/files/download')) {
        return new Response('not an envelope', {
          headers: { 'dropbox-api-result': JSON.stringify(fileMetadata('rev-remote')) },
          status: 200,
        })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as unknown as typeof fetch,
      store,
    })

    await seedSelectedRecord(store, { key: 'id:vault' })

    // navigator.onLine is true (set by testkit beforeEach)
    const error = await provider.downloadRemoteFile('id:vault').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DropboxProviderError)
    // The key regression guard: a parse failure must never be mis-classified as
    // 'offline' (which would cause silent retries instead of surfacing the issue).
    expect((error as DropboxProviderError).code).toBe('corrupt')
    expect((error as DropboxProviderError).code).not.toBe('offline')
  })

  it("a corrupt remote file rejects with 'corrupt', not 'offline', even when offline", async () => {
    const store = new VaultStore(testDbName())
    const fileMetadata = (rev: string) => ({
      '.tag': 'file',
      id: 'id:vault',
      name: 'vault.txt',
      path_display: '/Notes/vault.txt',
      path_lower: '/notes/vault.txt',
      rev,
    })
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth2/token')) {
        return jsonResponse({ access_token: 'access-token', expires_in: 14400, token_type: 'bearer' })
      }

      if (url.endsWith('/files/download')) {
        return new Response('not an envelope', {
          headers: { 'dropbox-api-result': JSON.stringify(fileMetadata('rev-remote')) },
          status: 200,
        })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as unknown as typeof fetch,
      store,
    })

    await seedSelectedRecord(store, { key: 'id:vault' })

    // Override onLine to false: the error must still be 'corrupt', not 'offline'
    Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: false })

    const error = await provider.downloadRemoteFile('id:vault').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DropboxProviderError)
    expect((error as DropboxProviderError).code).toBe('corrupt')
    expect((error as DropboxProviderError).code).not.toBe('offline')
  })
})

describe('DropboxProvider openability gates', () => {
  const makeProvider = (store: VaultStore) =>
    new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: vi.fn() as typeof fetch,
      store,
    })

  it('load and loadLocalEnvelope serve the DRAFT, never the cache, while the record is not openable', async () => {
    const store = new VaultStore(testDbName())

    await store.saveEnvelope('draft-bytes', new Date(), 'draft')
    await seedSelectedRecord(
      store,
      { envelope: 'cache-bytes', lastSyncedEnvelope: 'cache-bytes' },
      { authLost: true, linked: false, refreshToken: null },
    )

    const provider = makeProvider(store)

    await expect(provider.load()).resolves.toBe('draft-bytes')
    await expect(provider.loadLocalEnvelope()).resolves.toBe('draft-bytes')
  })

  it('loadLocalEnvelope serves a voluntary-unlinked cache for read-only open', async () => {
    const store = new VaultStore(testDbName())

    await seedSelectedRecord(
      store,
      { envelope: 'cache-bytes' },
      { linked: false, refreshToken: null },
    )

    const provider = makeProvider(store)

    await expect(provider.load()).rejects.toThrow('No Dropbox local cache')
    await expect(provider.loadLocalEnvelope()).resolves.toBe('cache-bytes')
  })

  it('an unresolved account switch is equally not openable', async () => {
    const store = new VaultStore(testDbName())

    await store.saveEnvelope('draft-bytes', new Date(), 'draft')
    await seedSelectedRecord(
      store,
      { envelope: 'cache-bytes' },
      { pendingAccountSwitch: 'dbid:new' },
    )

    const provider = makeProvider(store)

    await expect(provider.load()).resolves.toBe('draft-bytes')
    await expect(provider.loadLocalEnvelope()).resolves.toBe('draft-bytes')
  })

  it('getRecentFiles counts the selected row as unsynced on a conflict-only signal', async () => {
    const store = new VaultStore(testDbName())

    await seedSelectedRecord(
      store,
      { envelope: 'cache', lastSyncedEnvelope: 'cache' },
      { remoteConflictRev: 'rev-drifted' },
    )

    const recents = await makeProvider(store).getRecentFiles()

    // The conflict signal lives on the sync record and belongs to the
    // selected file: the Unlink/Delete warnings must read strong for it.
    expect(recents.files[0]).toMatchObject({ key: 'id:vault', hasUnsyncedChanges: true })
  })
})
