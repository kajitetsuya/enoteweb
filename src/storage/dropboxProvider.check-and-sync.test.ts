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
import type { DropboxFileDraft, SyncRecordDraft } from './dropboxProvider.testkit'

describe('DropboxProvider checkRecentFile (background revision check, SPEC §9)', () => {
  const tokenResponse = () =>
    jsonResponse({ access_token: 'access-token', expires_in: 14400, token_type: 'bearer' })

  const probeMetadata = (overrides: Record<string, unknown> = {}) => ({
    '.tag': 'file',
    content_hash: 'hash-base',
    id: 'id:vault',
    name: 'vault.txt',
    path_display: '/Notes/vault.txt',
    path_lower: '/notes/vault.txt',
    rev: 'rev-base',
    ...overrides,
  })

  const makeProvider = (store: VaultStore, fetcher: ReturnType<typeof vi.fn>) =>
    new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as unknown as typeof fetch,
      store,
    })

  // A synced selected record at rev-base with a stored content hash — each
  // test overrides the fields its scenario needs.
  const seedCheckedRecord = (
    store: VaultStore,
    record: Partial<DropboxFileDraft> = {},
    sync: SyncRecordDraft = {},
  ) =>
    seedSelectedRecord(
      store,
      {
        key: 'id:vault',
        envelope: 'env-synced',
        baseRev: 'rev-base',
        lastSyncedEnvelope: 'env-synced',
        lastSyncedContentHash: 'hash-base',
        pendingLocalEnvelope: null,
        ...record,
      },
      sync,
    )

  const calledEndpoints = (fetcher: ReturnType<typeof vi.fn>) =>
    fetcher.mock.calls.map((call) => String(call[0]))

  const metadataRequestPath = (init: RequestInit | undefined) =>
    JSON.parse(String(init?.body ?? '{}'))?.path as string | undefined

  const downloadRequestPath = (init: RequestInit | undefined) => {
    const headers = init?.headers as Record<string, string> | undefined

    return JSON.parse(String(headers?.['Dropbox-API-Arg'] ?? '{}'))?.path as string | undefined
  }

  it('reports up-to-date when the remote revision matches the base and nothing is unsynced', async () => {
    const store = new VaultStore(testDbName())
    await seedCheckedRecord(store)

    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth2/token')) {
        return tokenResponse()
      }

      if (url.endsWith('/files/get_metadata')) {
        return jsonResponse(probeMetadata())
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    const outcome = await makeProvider(store, fetcher).checkRecentFile('id:vault')

    expect(outcome).toEqual({ kind: 'up-to-date' })
    expect(await store.getDropboxFile('id:vault')).toMatchObject({
      baseRev: 'rev-base',
      envelope: 'env-synced',
      pendingLocalEnvelope: null,
    })
    expect(calledEndpoints(fetcher).some((url) => url.endsWith('/files/download'))).toBe(false)
    expect(calledEndpoints(fetcher).some((url) => url.endsWith('/files/upload'))).toBe(false)
  })

  it('clears a stale recoverable error when the selected row is proven up to date', async () => {
    const store = new VaultStore(testDbName())
    await seedCheckedRecord(store, {}, { lastSyncStatus: 'error' })

    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth2/token')) {
        return tokenResponse()
      }

      if (url.endsWith('/files/get_metadata')) {
        return jsonResponse(probeMetadata())
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    const outcome = await makeProvider(store, fetcher).checkRecentFile('id:vault')

    expect(outcome).toEqual({ kind: 'up-to-date' })
    expect(await store.getDropboxSync()).toMatchObject({ lastSyncStatus: 'synced' })
    expect(calledEndpoints(fetcher).some((url) => url.endsWith('/files/download'))).toBe(false)
    expect(calledEndpoints(fetcher).some((url) => url.endsWith('/files/upload'))).toBe(false)
  })

  it('does not clear the selected file error when checking a different recent row', async () => {
    const store = new VaultStore(testDbName())
    await seedCheckedRecord(store, {}, { lastSyncStatus: 'error', selectedFileKey: 'id:other' })

    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth2/token')) {
        return tokenResponse()
      }

      if (url.endsWith('/files/get_metadata')) {
        return jsonResponse(probeMetadata())
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    const outcome = await makeProvider(store, fetcher).checkRecentFile('id:vault')

    expect(outcome).toEqual({ kind: 'up-to-date' })
    expect(await store.getDropboxSync()).toMatchObject({ lastSyncStatus: 'error' })
  })

  it('adopts a remote rename/move silently — the row updates, no indicator', async () => {
    const store = new VaultStore(testDbName())
    await seedCheckedRecord(store)

    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth2/token')) {
        return tokenResponse()
      }

      if (url.endsWith('/files/get_metadata')) {
        return jsonResponse(
          probeMetadata({
            name: 'renamed.txt',
            path_display: '/Archive/renamed.txt',
            path_lower: '/archive/renamed.txt',
          }),
        )
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    const outcome = await makeProvider(store, fetcher).checkRecentFile('id:vault')

    expect(outcome).toEqual({ kind: 'up-to-date' })
    expect(await store.getDropboxFile('id:vault')).toMatchObject({
      name: 'renamed.txt',
      pathDisplay: '/Archive/renamed.txt',
      pathLower: '/archive/renamed.txt',
    })
  })

  it('grays a rename outside .txt/.text export-only: no push, no refresh, real name adopted', async () => {
    const store = new VaultStore(testDbName())
    await seedCheckedRecord(store, { pendingLocalEnvelope: 'env-pending' })

    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth2/token')) {
        return tokenResponse()
      }

      if (url.endsWith('/files/get_metadata')) {
        return jsonResponse(
          probeMetadata({
            name: 'vault.md',
            path_display: '/Notes/vault.md',
            path_lower: '/notes/vault.md',
            rev: 'rev-renamed',
          }),
        )
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    const outcome = await makeProvider(store, fetcher).checkRecentFile('id:vault')

    expect(outcome).toEqual({ kind: 'ineligible' })
    expect(await store.getDropboxFile('id:vault')).toMatchObject({
      name: 'vault.md',
      pathDisplay: '/Notes/vault.md',
      // Sync state untouched: the pending push is blocked, not flushed.
      pendingLocalEnvelope: 'env-pending',
      baseRev: 'rev-base',
    })
    expect(calledEndpoints(fetcher).some((url) => url.endsWith('/files/download'))).toBe(false)
    expect(calledEndpoints(fetcher).some((url) => url.endsWith('/files/upload'))).toBe(false)
  })

  it('reports missing only when the id no longer resolves; the record and cache stay', async () => {
    const store = new VaultStore(testDbName())
    await seedCheckedRecord(store)

    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth2/token')) {
        return tokenResponse()
      }

      if (url.endsWith('/files/get_metadata')) {
        return jsonResponse({ error_summary: 'path/not_found/..' }, { status: 409 })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    const outcome = await makeProvider(store, fetcher).checkRecentFile('id:vault')

    expect(outcome).toEqual({ kind: 'missing' })
    expect(await store.getDropboxFile('id:vault')).toMatchObject({ envelope: 'env-synced' })
  })

  it('reports a replacement candidate when the old id is gone but the exact stored path has a different eligible file', async () => {
    const store = new VaultStore(testDbName())
    await seedCheckedRecord(store)

    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/oauth2/token')) {
        return tokenResponse()
      }

      if (url.endsWith('/files/get_metadata')) {
        const path = metadataRequestPath(init)

        if (path === 'id:vault') {
          return jsonResponse({ error_summary: 'path/not_found/..' }, { status: 409 })
        }

        if (path === '/notes/vault.txt') {
          return jsonResponse(probeMetadata({ id: 'id:replacement', rev: 'rev-replacement' }))
        }
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    const outcome = await makeProvider(store, fetcher).checkRecentFile('id:vault')

    expect(outcome).toEqual({ kind: 'replacement-candidate' })
    expect(await store.getDropboxFile('id:vault')).toMatchObject({
      key: 'id:vault',
      baseRev: 'rev-base',
      envelope: 'env-synced',
    })
    expect(await store.getDropboxFile('id:replacement')).toBeNull()
  })

  it('reports check-failed on a probe failure: no indicator change, nothing written', async () => {
    const store = new VaultStore(testDbName())
    await seedCheckedRecord(store)

    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth2/token')) {
        return tokenResponse()
      }

      return jsonResponse({ error_summary: 'internal_error' }, { status: 500 })
    })

    const outcome = await makeProvider(store, fetcher).checkRecentFile('id:vault')

    expect(outcome).toEqual({ kind: 'check-failed' })
  })

  it('reports check-failed offline without touching the network', async () => {
    Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: false })

    const store = new VaultStore(testDbName())
    await seedCheckedRecord(store)

    const fetcher = vi.fn()
    const outcome = await makeProvider(store, fetcher).checkRecentFile('id:vault')

    expect(outcome).toEqual({ kind: 'check-failed' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('refreshes a stale-but-clean record by download — never a conflict, never red', async () => {
    const store = new VaultStore(testDbName())
    const remoteEnvelope = await CryptoService.encrypt('newer remote text', 'password', fastKdf)
    await seedCheckedRecord(store)

    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth2/token')) {
        return tokenResponse()
      }

      if (url.endsWith('/files/get_metadata')) {
        return jsonResponse(probeMetadata({ rev: 'rev-remote', content_hash: 'hash-remote' }))
      }

      if (url.endsWith('/files/download')) {
        return new Response(remoteEnvelope, {
          headers: {
            'dropbox-api-result': JSON.stringify(
              probeMetadata({ rev: 'rev-remote', content_hash: 'hash-remote' }),
            ),
          },
          status: 200,
        })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    const outcome = await makeProvider(store, fetcher).checkRecentFile('id:vault')

    expect(outcome).toEqual({ kind: 'refreshed' })
    expect(await store.getDropboxFile('id:vault')).toMatchObject({
      baseRev: 'rev-remote',
      envelope: remoteEnvelope,
      lastSyncedEnvelope: remoteEnvelope,
      lastSyncedContentHash: 'hash-remote',
      pendingLocalEnvelope: null,
    })
    expect(await store.getDropboxSync()).toMatchObject({
      remoteConflictEnvelope: null,
      remoteConflictRev: null,
    })
  })

  it('reports stale without downloading when the cache refresh is disabled (open session probe)', async () => {
    const store = new VaultStore(testDbName())
    await seedCheckedRecord(store)

    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth2/token')) {
        return tokenResponse()
      }

      if (url.endsWith('/files/get_metadata')) {
        return jsonResponse(probeMetadata({ rev: 'rev-remote', content_hash: 'hash-remote' }))
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    const outcome = await makeProvider(store, fetcher).checkRecentFile('id:vault', {
      refreshStaleCache: false,
    })

    expect(outcome).toEqual({ kind: 'stale' })
    // The open session keeps its cache and base revision: a later push must
    // still be conditional on the OLD base, so it can never silently land on
    // top of the unseen remote change.
    expect(await store.getDropboxFile('id:vault')).toMatchObject({
      baseRev: 'rev-base',
      envelope: 'env-synced',
    })
    expect(calledEndpoints(fetcher).some((url) => url.endsWith('/files/download'))).toBe(false)
  })

  it('clears a stale divergence when Dropbox already has the pending ciphertext', async () => {
    const store = new VaultStore(testDbName())
    const pendingEnvelope = await CryptoService.encrypt('pending text', 'password', fastKdf)
    await seedCheckedRecord(
      store,
      { pendingLocalEnvelope: pendingEnvelope },
      { selectedFileKey: 'id:other' },
    )

    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth2/token')) {
        return tokenResponse()
      }

      if (url.endsWith('/files/get_metadata')) {
        return jsonResponse(probeMetadata({ rev: 'rev-remote', content_hash: 'hash-pending' }))
      }

      if (url.endsWith('/files/download')) {
        return new Response(pendingEnvelope, {
          headers: {
            'dropbox-api-result': JSON.stringify(
              probeMetadata({ rev: 'rev-remote', content_hash: 'hash-pending' }),
            ),
          },
          status: 200,
        })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    const outcome = await makeProvider(store, fetcher).checkRecentFile('id:vault')

    expect(outcome).toEqual({ kind: 'refreshed' })
    expect(await store.getDropboxFile('id:vault')).toMatchObject({
      baseRev: 'rev-remote',
      envelope: pendingEnvelope,
      lastSyncedEnvelope: pendingEnvelope,
      lastSyncedContentHash: 'hash-pending',
      pendingLocalEnvelope: null,
    })
    expect(await store.getDropboxSync()).toMatchObject({
      selectedFileKey: 'id:other',
      remoteConflictEnvelope: null,
      remoteConflictRev: null,
    })
  })

  it('reports diverged when the remote changed AND unsynced local changes exist — nothing persisted', async () => {
    const store = new VaultStore(testDbName())
    const pendingEnvelope = await CryptoService.encrypt('pending text', 'password', fastKdf)
    const remoteEnvelope = await CryptoService.encrypt('remote text', 'password', fastKdf)
    await seedCheckedRecord(store, { pendingLocalEnvelope: pendingEnvelope })

    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth2/token')) {
        return tokenResponse()
      }

      if (url.endsWith('/files/get_metadata')) {
        return jsonResponse(probeMetadata({ rev: 'rev-remote', content_hash: 'hash-remote' }))
      }

      if (url.endsWith('/files/download')) {
        return new Response(remoteEnvelope, {
          headers: {
            'dropbox-api-result': JSON.stringify(
              probeMetadata({ rev: 'rev-remote', content_hash: 'hash-remote' }),
            ),
          },
          status: 200,
        })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    const outcome = await makeProvider(store, fetcher).checkRecentFile('id:vault')

    expect(outcome).toEqual({ kind: 'diverged' })
    // Indicators are session memory: no conflict state is written, the
    // pending bytes stay for the user-initiated resolution. The download only
    // ruled out the self-healed "remote already has these bytes" case.
    expect(await store.getDropboxFile('id:vault')).toMatchObject({
      baseRev: 'rev-base',
      pendingLocalEnvelope: pendingEnvelope,
    })
    expect(await store.getDropboxSync()).toMatchObject({
      // Unchanged from the seeded default — the check wrote nothing.
      lastSyncStatus: 'never',
      remoteConflictEnvelope: null,
      remoteConflictRev: null,
    })
    expect(calledEndpoints(fetcher).some((url) => url.endsWith('/files/download'))).toBe(true)
  })

  it('flushes a pending envelope revision-conditionally from the check (pending push)', async () => {
    const store = new VaultStore(testDbName())
    await seedCheckedRecord(store, { pendingLocalEnvelope: 'env-pending' })

    let uploadArg = ''
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/oauth2/token')) {
        return tokenResponse()
      }

      if (url.endsWith('/files/get_metadata')) {
        return jsonResponse(probeMetadata())
      }

      if (url.endsWith('/files/upload')) {
        uploadArg = String(
          (init as { headers?: Record<string, string> } | undefined)?.headers?.[
            'Dropbox-API-Arg'
          ],
        )
        return jsonResponse(probeMetadata({ rev: 'rev-after-push', content_hash: 'hash-push' }))
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    const outcome = await makeProvider(store, fetcher).checkRecentFile('id:vault')

    expect(outcome).toEqual({ kind: 'pushed' })
    expect(uploadArg).toContain('"update":"rev-base"')
    expect(await store.getDropboxFile('id:vault')).toMatchObject({
      baseRev: 'rev-after-push',
      envelope: 'env-pending',
      lastSyncedEnvelope: 'env-pending',
      lastSyncedContentHash: 'hash-push',
      pendingLocalEnvelope: null,
    })
  })

  it('never stamps the account-level sync status when flushing a NON-selected record', async () => {
    const store = new VaultStore(testDbName())
    // The selected file (another record) is mid-conflict; flushing this row
    // must not clear that.
    await store.putDropboxFile({
      key: 'id:other',
      name: 'other.txt',
      pathDisplay: '/other.txt',
      pathLower: '/other.txt',
      envelope: 'env-o',
      baseRev: 'rev-base',
      lastSyncedEnvelope: 'env-synced-o',
      pendingLocalEnvelope: 'env-pending-o',
    })
    await store.saveDropboxSync({
      linked: true,
      refreshToken: 'refresh-token',
      selectedFileKey: 'id:selected',
      lastSyncStatus: 'conflict',
      remoteConflictEnvelope: 'env-remote-snapshot',
      remoteConflictRev: 'rev-conflict',
    })

    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth2/token')) {
        return tokenResponse()
      }

      if (url.endsWith('/files/get_metadata')) {
        return jsonResponse(
          probeMetadata({
            id: 'id:other',
            name: 'other.txt',
            path_display: '/other.txt',
            path_lower: '/other.txt',
          }),
        )
      }

      if (url.endsWith('/files/upload')) {
        return jsonResponse(
          probeMetadata({ id: 'id:other', name: 'other.txt', rev: 'rev-after-push' }),
        )
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    const outcome = await makeProvider(store, fetcher).checkRecentFile('id:other')

    expect(outcome).toEqual({ kind: 'pushed' })
    expect(await store.getDropboxFile('id:other')).toMatchObject({
      baseRev: 'rev-after-push',
      pendingLocalEnvelope: null,
    })
    // The selected file's conflict state survived the other row's flush.
    expect(await store.getDropboxSync()).toMatchObject({
      lastSyncStatus: 'conflict',
      remoteConflictEnvelope: 'env-remote-snapshot',
      remoteConflictRev: 'rev-conflict',
    })
  })

  it('reclassifies a conditional flush failure as diverged without persisting a conflict', async () => {
    const store = new VaultStore(testDbName())
    await seedCheckedRecord(store, { pendingLocalEnvelope: 'env-pending' })

    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth2/token')) {
        return tokenResponse()
      }

      if (url.endsWith('/files/get_metadata')) {
        return jsonResponse(probeMetadata())
      }

      if (url.endsWith('/files/upload')) {
        return jsonResponse({ error_summary: 'path/conflict/file/..' }, { status: 409 })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    const outcome = await makeProvider(store, fetcher).checkRecentFile('id:vault')

    expect(outcome).toEqual({ kind: 'diverged' })
    expect(await store.getDropboxFile('id:vault')).toMatchObject({
      pendingLocalEnvelope: 'env-pending',
    })
    expect(await store.getDropboxSync()).toMatchObject({
      remoteConflictEnvelope: null,
      remoteConflictRev: null,
    })
  })

  it('treats a revision bump with a matching content hash as metadata-only and still flushes', async () => {
    const store = new VaultStore(testDbName())
    await seedCheckedRecord(store, { pendingLocalEnvelope: 'env-pending' })

    let uploadArg = ''
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/oauth2/token')) {
        return tokenResponse()
      }

      if (url.endsWith('/files/get_metadata')) {
        // The rev moved (e.g. a pure move/rename) but the content hash still
        // matches the last-synced state.
        return jsonResponse(probeMetadata({ rev: 'rev-moved' }))
      }

      if (url.endsWith('/files/upload')) {
        uploadArg = String(
          (init as { headers?: Record<string, string> } | undefined)?.headers?.[
            'Dropbox-API-Arg'
          ],
        )
        return jsonResponse(probeMetadata({ rev: 'rev-after-push' }))
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    const outcome = await makeProvider(store, fetcher).checkRecentFile('id:vault')

    expect(outcome).toEqual({ kind: 'pushed' })
    // The flush was conditional on the ADOPTED revision, and no download was
    // needed to prove content equality.
    expect(uploadArg).toContain('"update":"rev-moved"')
    expect(calledEndpoints(fetcher).some((url) => url.endsWith('/files/download'))).toBe(false)
  })

  it('falls back to download-and-compare for an unsynced record with no stored hash', async () => {
    const store = new VaultStore(testDbName())
    const lastSynced = await CryptoService.encrypt('synced text', 'password', fastKdf)
    await seedCheckedRecord(store, {
      envelope: lastSynced,
      lastSyncedEnvelope: lastSynced,
      lastSyncedContentHash: null,
      pendingLocalEnvelope: 'env-pending',
    })

    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth2/token')) {
        return tokenResponse()
      }

      if (url.endsWith('/files/get_metadata')) {
        return jsonResponse(probeMetadata({ rev: 'rev-moved', content_hash: 'hash-unknown' }))
      }

      if (url.endsWith('/files/download')) {
        // The remote bytes are exactly the last-synced envelope: the rev
        // bump was metadata-only, NOT a divergence.
        return new Response(lastSynced, {
          headers: {
            'dropbox-api-result': JSON.stringify(
              probeMetadata({ rev: 'rev-moved', content_hash: 'hash-unknown' }),
            ),
          },
          status: 200,
        })
      }

      if (url.endsWith('/files/upload')) {
        return jsonResponse(probeMetadata({ rev: 'rev-after-push' }))
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    const outcome = await makeProvider(store, fetcher).checkRecentFile('id:vault')

    expect(outcome).toEqual({ kind: 'pushed' })
    expect(await store.getDropboxFile('id:vault')).toMatchObject({
      baseRev: 'rev-after-push',
      pendingLocalEnvelope: null,
    })
  })

  it('rekeys a path-keyed record to the probed id', async () => {
    const store = new VaultStore(testDbName())
    await seedSelectedRecord(
      store,
      {
        key: 'path:/notes/vault.txt',
        envelope: 'env-synced',
        baseRev: 'rev-base',
        lastSyncedEnvelope: 'env-synced',
        lastSyncedContentHash: 'hash-base',
      },
      {},
    )

    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth2/token')) {
        return tokenResponse()
      }

      if (url.endsWith('/files/get_metadata')) {
        return jsonResponse(probeMetadata())
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    const outcome = await makeProvider(store, fetcher).checkRecentFile('path:/notes/vault.txt')

    expect(outcome).toEqual({ kind: 'up-to-date' })
    expect(await store.getDropboxFile('path:/notes/vault.txt')).toBeNull()
    expect(await store.getDropboxFile('id:vault')).toMatchObject({ envelope: 'env-synced' })
    expect((await store.getDropboxSync())?.selectedFileKey).toBe('id:vault')
  })

  it('never bulk-downloads a cache-less record', async () => {
    const store = new VaultStore(testDbName())
    await seedCheckedRecord(store, {
      envelope: null,
      lastSyncedEnvelope: null,
      lastSyncedContentHash: null,
      baseRev: null,
    })

    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth2/token')) {
        return tokenResponse()
      }

      if (url.endsWith('/files/get_metadata')) {
        return jsonResponse(probeMetadata({ rev: 'rev-remote' }))
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    const outcome = await makeProvider(store, fetcher).checkRecentFile('id:vault')

    // Open re-downloads on demand (SPEC §8); proactive background
    // downloading is deferred by design.
    expect(outcome).toEqual({ kind: 'up-to-date' })
    expect(calledEndpoints(fetcher).some((url) => url.endsWith('/files/download'))).toBe(false)
  })

  it('adopts a confirmed replacement candidate as synced when the cached bytes match', async () => {
    const store = new VaultStore(testDbName())
    const envelope = await CryptoService.encrypt('same text', 'password', fastKdf)
    await seedCheckedRecord(store, {
      envelope,
      lastSyncedEnvelope: envelope,
    })

    const replacementMetadata = probeMetadata({
      id: 'id:replacement',
      rev: 'rev-replacement',
      content_hash: 'hash-replacement',
    })
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/oauth2/token')) {
        return tokenResponse()
      }

      if (url.endsWith('/files/get_metadata')) {
        const path = metadataRequestPath(init)

        if (path === 'id:vault') {
          return jsonResponse({ error_summary: 'path/not_found/..' }, { status: 409 })
        }

        if (path === '/notes/vault.txt') {
          return jsonResponse(replacementMetadata)
        }
      }

      if (url.endsWith('/files/download')) {
        expect(downloadRequestPath(init)).toBe('id:replacement')
        return new Response(envelope, {
          headers: {
            'dropbox-api-result': JSON.stringify(replacementMetadata),
          },
          status: 200,
        })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    const provider = makeProvider(store, fetcher)
    const outcome = await provider.adoptReplacementCandidate('id:vault')

    expect(outcome).toEqual({ kind: 'refreshed' })
    expect(await store.getDropboxFile('id:vault')).toBeNull()
    expect(await store.getDropboxFile('id:replacement')).toMatchObject({
      baseRev: 'rev-replacement',
      envelope,
      lastSyncedEnvelope: envelope,
      lastSyncedContentHash: 'hash-replacement',
      pendingLocalEnvelope: null,
    })
    expect(await store.getDropboxSync()).toMatchObject({
      lastSyncStatus: 'synced',
      remoteConflictEnvelope: null,
      remoteConflictRev: null,
      selectedFileKey: 'id:replacement',
    })
  })

  it('adopts a confirmed replacement candidate as a no-base conflict when cached bytes differ', async () => {
    const store = new VaultStore(testDbName())
    const localEnvelope = await CryptoService.encrypt('local deleted file text', 'password', fastKdf)
    const remoteEnvelope = await CryptoService.encrypt('replacement file text', 'password', fastKdf)
    await seedCheckedRecord(store, {
      envelope: localEnvelope,
      lastSyncedEnvelope: localEnvelope,
    })

    const replacementMetadata = probeMetadata({
      id: 'id:replacement',
      rev: 'rev-replacement',
      content_hash: 'hash-replacement',
    })
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/oauth2/token')) {
        return tokenResponse()
      }

      if (url.endsWith('/files/get_metadata')) {
        const path = metadataRequestPath(init)

        if (path === 'id:vault') {
          return jsonResponse({ error_summary: 'path/not_found/..' }, { status: 409 })
        }

        if (path === '/notes/vault.txt') {
          return jsonResponse(replacementMetadata)
        }
      }

      if (url.endsWith('/files/download')) {
        expect(downloadRequestPath(init)).toBe('id:replacement')
        return new Response(remoteEnvelope, {
          headers: {
            'dropbox-api-result': JSON.stringify(replacementMetadata),
          },
          status: 200,
        })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    const provider = makeProvider(store, fetcher)
    const outcome = await provider.adoptReplacementCandidate('id:vault')

    expect(outcome).toEqual({ kind: 'diverged' })
    expect(await store.getDropboxFile('id:vault')).toBeNull()
    expect(await store.getDropboxFile('id:replacement')).toMatchObject({
      baseRev: null,
      envelope: localEnvelope,
      lastSyncedEnvelope: null,
      lastSyncedContentHash: null,
      syncedModifiedAt: null,
      localModifiedAt: null,
      pendingLocalEnvelope: localEnvelope,
    })
    expect(await store.getDropboxSync()).toMatchObject({
      lastSyncStatus: 'conflict',
      remoteConflictEnvelope: remoteEnvelope,
      remoteConflictRev: 'rev-replacement',
      selectedFileKey: 'id:replacement',
    })
    await expect(provider.loadConflictEnvelopes()).resolves.toMatchObject({
      baseEnvelope: null,
      localEnvelope,
      remoteEnvelope,
      remoteConflictRev: 'rev-replacement',
    })
  })
})

describe('DropboxProvider saveLocalOnly (first-sync gate, SPEC §9)', () => {
  it('writes the cache and pending envelope without any network call', async () => {
    const store = new VaultStore(testDbName())
    const envelope = await CryptoService.encrypt('paused session text', 'password', fastKdf)
    const fetcher = vi.fn()
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      store,
    })

    await seedSelectedRecord(store, {
      key: 'id:vault',
      envelope: 'env-old',
      baseRev: 'rev-base',
      lastSyncedEnvelope: 'env-old',
    })

    await provider.saveLocalOnly(envelope)

    expect(fetcher).not.toHaveBeenCalled()
    expect(await store.getDropboxFile('id:vault')).toMatchObject({
      envelope,
      pendingLocalEnvelope: envelope,
      // The base revision is untouched: the eventual push/resolution is
      // still conditional on the revision the session was opened from.
      baseRev: 'rev-base',
    })
    expect((await store.getDropboxSync())?.lastSyncStatus).toBe('pending-local')
  })

  it('never regresses a recorded conflict status to pending-local', async () => {
    const store = new VaultStore(testDbName())
    const envelope = await CryptoService.encrypt('still conflicted', 'password', fastKdf)
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: vi.fn() as typeof fetch,
      store,
    })

    await seedSelectedRecord(
      store,
      { key: 'id:vault', envelope: 'env-old' },
      {
        lastSyncStatus: 'conflict',
        remoteConflictEnvelope: 'env-remote',
        remoteConflictRev: 'rev-conflict',
      },
    )

    await provider.saveLocalOnly(envelope)

    expect(await store.getDropboxSync()).toMatchObject({
      lastSyncStatus: 'conflict',
      remoteConflictEnvelope: 'env-remote',
    })
  })
})

describe('DropboxProvider syncNow stale-but-clean + selection conflict hygiene', () => {
  const tokenResponse = () =>
    jsonResponse({ access_token: 'access-token', expires_in: 14400, token_type: 'bearer' })

  const remoteMetadata = {
    '.tag': 'file',
    content_hash: 'hash-remote',
    id: 'id:vault',
    name: 'vault.txt',
    path_display: '/Notes/vault.txt',
    path_lower: '/notes/vault.txt',
    rev: 'rev-remote',
  }

  const makeProvider = (store: VaultStore, fetcher: ReturnType<typeof vi.fn>) =>
    new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as unknown as typeof fetch,
      store,
    })

  // Remote moved to rev-remote with new content; the local cache is whatever
  // the test seeds.
  const remoteChangedFetcher = (remoteEnvelope: string) =>
    vi.fn(async (url: string) => {
      if (url.endsWith('/oauth2/token')) {
        return tokenResponse()
      }

      if (url.endsWith('/files/get_metadata')) {
        return jsonResponse(remoteMetadata)
      }

      if (url.endsWith('/files/download')) {
        return new Response(remoteEnvelope, {
          headers: { 'dropbox-api-result': JSON.stringify(remoteMetadata) },
          status: 200,
        })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

  const calledEndpoints = (fetcher: ReturnType<typeof vi.fn>) =>
    fetcher.mock.calls.map((call) => String(call[0]))

  it('adopts a clean remote change with adoptCleanRemote (home context, SPEC §9 flow step 6)', async () => {
    const store = new VaultStore(testDbName())
    const remoteEnvelope = await CryptoService.encrypt('newer remote text', 'password', fastKdf)

    await seedSelectedRecord(store, {
      key: 'id:vault',
      envelope: 'env-synced',
      baseRev: 'rev-base',
      lastSyncedEnvelope: 'env-synced',
      pendingLocalEnvelope: null,
    })

    const fetcher = remoteChangedFetcher(remoteEnvelope)
    const status = await makeProvider(store, fetcher).syncNow({ adoptCleanRemote: true })

    // The stale-but-clean refresh: the remote is adopted wholesale, never a
    // conflict — the home background check then reads the row as up to date.
    expect(status).toMatchObject({ state: 'ready' })
    expect(await store.getDropboxFile('id:vault')).toMatchObject({
      baseRev: 'rev-remote',
      envelope: remoteEnvelope,
      lastSyncedEnvelope: remoteEnvelope,
      lastSyncedContentHash: 'hash-remote',
      pendingLocalEnvelope: null,
    })
    expect(await store.getDropboxSync()).toMatchObject({
      lastSyncStatus: 'synced',
      remoteConflictEnvelope: null,
      remoteConflictRev: null,
    })
    expect(calledEndpoints(fetcher).some((url) => url.endsWith('/files/upload'))).toBe(false)
  })

  it('leaves a stale-but-clean record untouched by default — no conflict, no pending stamp', async () => {
    const store = new VaultStore(testDbName())
    const remoteEnvelope = await CryptoService.encrypt('newer remote text', 'password', fastKdf)

    await seedSelectedRecord(store, {
      key: 'id:vault',
      envelope: 'env-synced',
      baseRev: 'rev-base',
      lastSyncedEnvelope: 'env-synced',
      pendingLocalEnvelope: null,
    })

    const fetcher = remoteChangedFetcher(remoteEnvelope)
    const status = await makeProvider(store, fetcher).syncNow()

    // The in-session (default) sync must neither swap the cache/baseRev
    // underneath the open editor NOR record a conflict — and crucially must
    // not stamp the clean cache as pendingLocalEnvelope, which made the row
    // read diverged forever (the original P1).
    expect(status).toMatchObject({ state: 'ready' })
    expect(await store.getDropboxFile('id:vault')).toMatchObject({
      baseRev: 'rev-base',
      envelope: 'env-synced',
      lastSyncedEnvelope: 'env-synced',
      pendingLocalEnvelope: null,
    })
    expect(await store.getDropboxSync()).toMatchObject({
      // Unchanged from the seeded default — syncNow wrote nothing.
      lastSyncStatus: 'never',
      remoteConflictEnvelope: null,
      remoteConflictRev: null,
    })
    expect(calledEndpoints(fetcher).some((url) => url.endsWith('/files/upload'))).toBe(false)
  })

  it('clears a stale recoverable error when syncNow proves the selected file is clean', async () => {
    const store = new VaultStore(testDbName())

    await seedSelectedRecord(
      store,
      {
        key: 'id:vault',
        envelope: 'env-synced',
        baseRev: 'rev-base',
        lastSyncedEnvelope: 'env-synced',
        pendingLocalEnvelope: null,
      },
      { lastSyncStatus: 'error' },
    )

    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth2/token')) {
        return tokenResponse()
      }

      if (url.endsWith('/files/get_metadata')) {
        return jsonResponse({ ...remoteMetadata, content_hash: 'hash-base', rev: 'rev-base' })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    const status = await makeProvider(store, fetcher).syncNow()

    expect(status).toMatchObject({ state: 'ready' })
    expect(await store.getDropboxSync()).toMatchObject({
      lastSyncStatus: 'synced',
      remoteConflictEnvelope: null,
      remoteConflictRev: null,
    })
    expect(calledEndpoints(fetcher).some((url) => url.endsWith('/files/download'))).toBe(false)
    expect(calledEndpoints(fetcher).some((url) => url.endsWith('/files/upload'))).toBe(false)
  })

  it('still captures a conflict for a genuinely diverged cache even with adoptCleanRemote', async () => {
    const store = new VaultStore(testDbName())
    const remoteEnvelope = await CryptoService.encrypt('newer remote text', 'password', fastKdf)

    await seedSelectedRecord(store, {
      key: 'id:vault',
      // The cache differs from the last-synced snapshot: NOT clean.
      envelope: 'env-dirty',
      baseRev: 'rev-base',
      lastSyncedEnvelope: 'env-synced',
      pendingLocalEnvelope: null,
    })

    const status = await makeProvider(store, remoteChangedFetcher(remoteEnvelope)).syncNow({
      adoptCleanRemote: true,
    })

    expect(status).toMatchObject({ state: 'conflict' })
    expect(await store.getDropboxFile('id:vault')).toMatchObject({
      // The local side is preserved as pending for the merge; the base is
      // untouched so the merge still has the true common ancestor.
      baseRev: 'rev-base',
      pendingLocalEnvelope: 'env-dirty',
    })
    expect(await store.getDropboxSync()).toMatchObject({
      lastSyncStatus: 'conflict',
      remoteConflictEnvelope: remoteEnvelope,
      remoteConflictRev: 'rev-remote',
    })
  })

  it('setSelectedRecentFile clears the transitional conflict fields when the selection changes rows', async () => {
    const store = new VaultStore(testDbName())
    const fetcher = vi.fn()

    await seedSelectedRecord(
      store,
      { key: 'id:a', pendingLocalEnvelope: 'env-pending-a' },
      {
        lastSyncStatus: 'conflict',
        remoteConflictEnvelope: 'env-remote-a',
        remoteConflictRev: 'rev-a',
      },
    )
    await store.putDropboxFile({
      key: 'id:b',
      name: 'other.txt',
      pathDisplay: '/Notes/other.txt',
      pathLower: '/notes/other.txt',
    })

    await makeProvider(store, fetcher).setSelectedRecentFile('id:b')

    // The account-level conflict snapshot described id:a (SPEC §8): row id:b
    // must not inherit it — loadConflictEnvelopes would otherwise merge
    // id:a's remote against id:b's local/base.
    expect(await store.getDropboxSync()).toMatchObject({
      selectedFileKey: 'id:b',
      lastSyncStatus: 'never',
      remoteConflictEnvelope: null,
      remoteConflictRev: null,
    })
    // Nothing about id:a's own unsynced work is lost: its local side stays on
    // the record, and the remote side is re-downloadable on a later Resolve.
    expect(await store.getDropboxFile('id:a')).toMatchObject({
      pendingLocalEnvelope: 'env-pending-a',
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('setSelectedRecentFile keeps the captured conflict when re-selecting the same row', async () => {
    const store = new VaultStore(testDbName())

    await seedSelectedRecord(
      store,
      { key: 'id:a' },
      {
        lastSyncStatus: 'conflict',
        remoteConflictEnvelope: 'env-remote-a',
        remoteConflictRev: 'rev-a',
      },
    )

    await makeProvider(store, vi.fn()).setSelectedRecentFile('id:a')

    expect(await store.getDropboxSync()).toMatchObject({
      selectedFileKey: 'id:a',
      lastSyncStatus: 'conflict',
      remoteConflictEnvelope: 'env-remote-a',
      remoteConflictRev: 'rev-a',
    })
  })

  it('openRecentFile of a different row clears the previous selection conflict fields', async () => {
    const store = new VaultStore(testDbName())
    const fetcher = vi.fn()

    await seedSelectedRecord(
      store,
      { key: 'id:a' },
      {
        lastSyncStatus: 'conflict',
        remoteConflictEnvelope: 'env-remote-a',
        remoteConflictRev: 'rev-a',
      },
    )
    await store.putDropboxFile({
      key: 'id:b',
      name: 'other.txt',
      pathDisplay: '/Notes/other.txt',
      pathLower: '/notes/other.txt',
      envelope: 'env-b',
    })

    const envelope = await makeProvider(store, fetcher).openRecentFile('id:b')

    // The opened session must not inherit a conflict banner (and remote
    // snapshot) that belongs to another file.
    expect(envelope).toBe('env-b')
    expect(await store.getDropboxSync()).toMatchObject({
      selectedFileKey: 'id:b',
      lastSyncStatus: 'never',
      remoteConflictEnvelope: null,
      remoteConflictRev: null,
    })
    expect(fetcher).not.toHaveBeenCalled()
  })
})
