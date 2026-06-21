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
import type { SyncRecordDraft } from './dropboxProvider.testkit'

describe('DropboxProvider file browser support (SPEC §9)', () => {
  const tokenResponse = () =>
    jsonResponse({ access_token: 'access-token', expires_in: 14400, token_type: 'bearer' })

  const makeProvider = (store: VaultStore, fetcher: ReturnType<typeof vi.fn>) =>
    new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      store,
    })

  const linkedStore = async () => {
    const store = new VaultStore(testDbName())
    await store.saveDropboxSync({ linked: true, refreshToken: 'refresh-token' })
    return store
  }

  it('listFolder fetches every page before returning and maps entries', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          cursor: 'cursor-1',
          entries: [
            { '.tag': 'folder', name: 'Notes', path_display: '/Notes', path_lower: '/notes' },
            {
              '.tag': 'file',
              name: 'enote.txt',
              path_display: '/enote.txt',
              path_lower: '/enote.txt',
              rev: 'rev-1',
              server_modified: '2026-06-10T12:00:00Z',
              size: 48_000,
            },
          ],
          has_more: true,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          cursor: 'cursor-2',
          entries: [
            { '.tag': 'file', name: 'thesis.pdf', path_display: '/thesis.pdf', path_lower: '/thesis.pdf', size: 2_100_000 },
          ],
          has_more: false,
        }),
      )
    const provider = makeProvider(await linkedStore(), fetcher)

    const listing = await provider.listFolder('/')

    // Root is '' on the wire, and the second page goes through /continue.
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({ path: '' })
    expect(String(fetcher.mock.calls[2]?.[0])).toContain('/files/list_folder/continue')
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({ cursor: 'cursor-1' })
    expect(listing.truncated).toBe(false)
    expect(listing.entries).toEqual([
      {
        kind: 'folder',
        name: 'Notes',
        pathDisplay: '/Notes',
        pathLower: '/notes',
        rev: null,
        serverModified: null,
        size: null,
      },
      {
        kind: 'file',
        name: 'enote.txt',
        pathDisplay: '/enote.txt',
        pathLower: '/enote.txt',
        rev: 'rev-1',
        serverModified: '2026-06-10T12:00:00Z',
        size: 48_000,
      },
      {
        kind: 'file',
        name: 'thesis.pdf',
        pathDisplay: '/thesis.pdf',
        pathLower: '/thesis.pdf',
        rev: null,
        serverModified: null,
        size: 2_100_000,
      },
    ])
  })

  it('listFolder stops at the entry cap and reports truncation', async () => {
    const bigPage = Array.from({ length: 10_000 }, (_, index) => ({
      '.tag': 'file',
      name: `file-${index}.txt`,
      path_display: `/big/file-${index}.txt`,
      path_lower: `/big/file-${index}.txt`,
    }))
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ cursor: 'cursor-1', entries: bigPage, has_more: true }))
    const provider = makeProvider(await linkedStore(), fetcher)

    const listing = await provider.listFolder('/big')

    // The cap was reached with more remaining: no /continue call is made.
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(listing.entries).toHaveLength(10_000)
    expect(listing.truncated).toBe(true)
  })

  it('listFolder rejects a relative folder path', async () => {
    const provider = makeProvider(await linkedStore(), vi.fn())

    await expect(provider.listFolder('Notes')).rejects.toMatchObject({ code: 'invalid-path' })
  })

  it('maps a persistent missing_scope failure to an auth error and clears token material', async () => {
    const store = await linkedStore()
    await store.saveDropboxSync({ selectedPathDisplay: '/Notes/doc.txt' })
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ error_summary: 'missing_scope/..' }, { status: 409 }))
      // The auth retry refreshes once; the grant exists but still lacks the
      // scope, so the retry fails the same way and token material is cleared.
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ error_summary: 'missing_scope/..' }, { status: 409 }))
    const provider = makeProvider(store, fetcher)

    await expect(provider.listFolder('/')).rejects.toMatchObject({ code: 'auth' })
    // Involuntary unlink with the selection retained (SPEC §9).
    expect(await store.getDropboxSync()).toMatchObject({
      linked: false,
      refreshToken: null,
      selectedPathDisplay: '/Notes/doc.txt',
    })
  })

  it('recovers transparently when only the cached access token expired early', async () => {
    const store = await linkedStore()
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      // The API rejects a token getAccessToken considered fresh...
      .mockResolvedValueOnce(
        jsonResponse({ error_summary: 'expired_access_token/..' }, { status: 401 }),
      )
      // ...but the grant is alive: refresh succeeds and the retry goes through.
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ cursor: 'c', entries: [], has_more: false }))
    const provider = makeProvider(store, fetcher)

    expect(await provider.listFolder('/')).toEqual({ entries: [], truncated: false })
    // Not a relink event: the grant stays linked.
    expect(await store.getDropboxSync()).toMatchObject({
      linked: true,
      refreshToken: 'refresh-token',
    })
  })

  it('an API auth rejection with a dead grant clears token material via the refresh path', async () => {
    const store = await linkedStore()
    await store.saveDropboxSync({ pendingLocalEnvelope: 'env-pending' })
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      // Revoked mid-session: the still-cached access token is rejected...
      .mockResolvedValueOnce(
        jsonResponse({ error_summary: 'invalid_access_token/..' }, { status: 401 }),
      )
      // ...and the refresh attempt reports the grant dead.
      .mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, { status: 400 }))
    const provider = makeProvider(store, fetcher)

    await expect(provider.listFolder('/')).rejects.toMatchObject({ code: 'auth' })
    expect(await store.getDropboxSync()).toMatchObject({
      linked: false,
      pendingLocalEnvelope: 'env-pending',
      refreshToken: null,
    })
  })

  it('a revoked refresh token clears token material only — selection and pending state survive', async () => {
    const store = new VaultStore(testDbName())
    // A linked session with a selected file, sync snapshots, and an unsynced edit.
    await store.saveDropboxSync({
      accountLabel: 'dbid:test',
      baseRev: 'rev-base',
      lastSyncedEnvelope: 'env-synced',
      lastSyncStatus: 'synced',
      linked: true,
      pendingLocalEnvelope: 'env-pending',
      refreshToken: 'refresh-token',
      selectedFileId: 'id:doc',
      selectedName: 'doc.txt',
      selectedPathDisplay: '/Notes/doc.txt',
      selectedPathLower: '/notes/doc.txt',
    })
    // The token endpoint reports the grant revoked (e.g. from another device).
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, { status: 400 }))
    const provider = makeProvider(store, fetcher)

    await expect(provider.listFolder('/')).rejects.toMatchObject({ code: 'auth' })

    // Involuntary unlink: tokens gone, everything else retained (SPEC §9).
    // authLost distinguishes this from a voluntary Unlink at the home block.
    expect(await store.getDropboxSync()).toMatchObject({
      accountLabel: 'dbid:test',
      authLost: true,
      baseRev: 'rev-base',
      lastSyncedEnvelope: 'env-synced',
      linked: false,
      pendingLocalEnvelope: 'env-pending',
      refreshToken: null,
      selectedFileId: 'id:doc',
      selectedPathDisplay: '/Notes/doc.txt',
    })
  })
})

describe('DropboxProvider by-locator probe and download (recents background check)', () => {
  const linkStore = async (store: VaultStore) => {
    await store.saveDropboxSync({ linked: true, refreshToken: 'refresh-token' })
  }

  const makeProvider = (store: VaultStore, fetcher: ReturnType<typeof vi.fn>) =>
    new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      getHref: () => 'https://example.test/',
      navigate: () => undefined,
      store,
    })

  it('statRemoteFile probes by raw file id and reports identity, rev, and content hash', async () => {
    const store = new VaultStore(testDbName())
    await linkStore(store)

    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'access-token', expires_in: 14400, token_type: 'bearer' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          '.tag': 'file',
          content_hash: 'hash-1',
          id: 'id:abc123',
          name: 'notes.txt',
          path_display: '/Renamed/notes.txt',
          path_lower: '/renamed/notes.txt',
          rev: 'rev-9',
        }),
      )

    const probe = await makeProvider(store, fetcher).statRemoteFile('id:abc123')

    expect(probe).toEqual({
      exists: true,
      contentHash: 'hash-1',
      id: 'id:abc123',
      isSyncEligible: true,
      kind: 'file',
      name: 'notes.txt',
      pathDisplay: '/Renamed/notes.txt',
      pathLower: '/renamed/notes.txt',
      rev: 'rev-9',
    })

    const metadataBody = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body ?? '{}')) as {
      path?: string
    }

    expect(metadataBody.path).toBe('id:abc123')
  })

  it('statRemoteFile reports an ineligible rename as data, never as an error', async () => {
    const store = new VaultStore(testDbName())
    await linkStore(store)

    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'access-token', expires_in: 14400, token_type: 'bearer' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          '.tag': 'file',
          id: 'id:abc123',
          name: 'notes.md',
          path_display: '/Notes/notes.md',
          path_lower: '/notes/notes.md',
          rev: 'rev-10',
        }),
      )

    const probe = await makeProvider(store, fetcher).statRemoteFile('id:abc123')

    expect(probe).toMatchObject({ exists: true, isSyncEligible: false, name: 'notes.md' })
  })

  it('statRemoteFile never marks a folder sync-eligible, even one named *.txt', async () => {
    const store = new VaultStore(testDbName())
    await linkStore(store)

    // A path-keyed recent can resolve to a FOLDER whose name happens to
    // end in .txt; eligibility must require an actual file with a revision.
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'access-token', expires_in: 14400, token_type: 'bearer' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          '.tag': 'folder',
          id: 'id:folder1',
          name: 'foo.txt',
          path_display: '/Notes/foo.txt',
          path_lower: '/notes/foo.txt',
        }),
      )

    const probe = await makeProvider(store, fetcher).statRemoteFile('/notes/foo.txt')

    expect(probe).toMatchObject({
      exists: true,
      isSyncEligible: false,
      kind: 'folder',
      name: 'foo.txt',
    })
  })

  it('statRemoteFile reports a deleted id as exists: false', async () => {
    const store = new VaultStore(testDbName())
    await linkStore(store)

    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'access-token', expires_in: 14400, token_type: 'bearer' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ error_summary: 'path/not_found/..' }, { status: 409 }),
      )

    await expect(makeProvider(store, fetcher).statRemoteFile('id:gone')).resolves.toEqual({
      exists: false,
    })
  })

  it('statRemoteFile rejects a malformed locator without any network call', async () => {
    const store = new VaultStore(testDbName())
    await linkStore(store)
    const fetcher = vi.fn()

    await expect(makeProvider(store, fetcher).statRemoteFile('notes.txt')).rejects.toMatchObject({
      code: 'invalid-path',
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('downloadRemoteFile returns the envelope plus the current (possibly renamed) identity', async () => {
    const store = new VaultStore(testDbName())
    await linkStore(store)
    const envelope = await CryptoService.encrypt('cached text', 'password', fastKdf)

    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'access-token', expires_in: 14400, token_type: 'bearer' }),
      )
      .mockResolvedValueOnce(
        new Response(envelope, {
          headers: {
            'dropbox-api-result': JSON.stringify({
              content_hash: 'hash-2',
              id: 'id:abc123',
              name: 'moved.txt',
              path_display: '/Elsewhere/moved.txt',
              path_lower: '/elsewhere/moved.txt',
              rev: 'rev-11',
            }),
          },
          status: 200,
        }),
      )

    await expect(makeProvider(store, fetcher).downloadRemoteFile('id:abc123')).resolves.toEqual({
      contentHash: 'hash-2',
      envelope,
      id: 'id:abc123',
      name: 'moved.txt',
      pathDisplay: '/Elsewhere/moved.txt',
      pathLower: '/elsewhere/moved.txt',
      rev: 'rev-11',
    })
  })
})

describe('DropboxProvider account-switch guard and recents open', () => {
  const oauthSetup = async (store: VaultStore, extra: SyncRecordDraft = {}) => {
    await store.saveDropboxSync({ codeVerifier: 'verifier', oauthState: 'state', ...extra })
  }

  const tokenPayload = (accountId: string, refreshToken = 'refresh-token') => ({
    access_token: 'short-lived-access-token',
    account_id: accountId,
    expires_in: 14400,
    refresh_token: refreshToken,
    token_type: 'bearer',
  })

  const tokenFetcher = (accountId: string) =>
    vi.fn(async () =>
      jsonResponse(tokenPayload(accountId)),
    )

  const makeProvider = (store: VaultStore, fetcher: ReturnType<typeof vi.fn>) =>
    new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      replaceHref: () => undefined,
      store,
    })

  it('reports no guard case when the linked account matches the stored owner', async () => {
    const store = new VaultStore(testDbName())
    await seedSelectedRecord(store, {}, { linked: false, refreshToken: null })
    await oauthSetup(store, { accountId: 'dbid:same' })

    const provider = makeProvider(store, tokenFetcher('dbid:same'))

    await expect(
      provider.completeLinkFromRedirect('https://example.test/app?code=abc&state=state'),
    ).resolves.toEqual({ accountMismatch: null, unverifiedOwnership: false })
    expect(await store.getDropboxSync()).toMatchObject({
      accountId: 'dbid:same',
      authLost: false,
      linked: true,
    })
  })

  it('reports a mismatch and stages the new token without adopting it', async () => {
    const store = new VaultStore(testDbName())
    await seedSelectedRecord(
      store,
      { pendingLocalEnvelope: 'unsynced-edit' },
      { linked: false, refreshToken: null },
    )
    await oauthSetup(store, { accountId: 'dbid:old', accountLabel: 'old@example.com' })

    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(tokenPayload('dbid:new', 'refresh-token-new')))
      .mockResolvedValueOnce(
        jsonResponse({
          account_id: 'dbid:new',
          email: 'new@example.com',
          name: { display_name: 'New User' },
        }),
      )
    const provider = makeProvider(store, fetcher)

    await expect(
      provider.completeLinkFromRedirect('https://example.test/app?code=abc&state=state'),
    ).resolves.toEqual({
      accountMismatch: { newAccountId: 'dbid:new', previousAccountId: 'dbid:old' },
      unverifiedOwnership: false,
    })
    // Neither the ownership id nor the LABEL may silently flip — the retained
    // data must never be labeled with the unresolved new account — and the
    // pending switch is persisted so every operation blocks. The new refresh
    // token is the only token slot now, but it remains unusable until the user
    // explicitly chooses Continue.
    expect(await store.getDropboxSync()).toMatchObject({
      accountId: 'dbid:old',
      accountLabel: 'old@example.com',
      linked: false,
      pendingAccountSwitch: 'dbid:new',
      pendingAccountSwitchLabel: 'new@example.com',
      refreshToken: 'refresh-token-new',
    })
  })

  it('blocks every Dropbox operation while the account switch is unresolved', async () => {
    const store = new VaultStore(testDbName())
    await seedSelectedRecord(
      store,
      { envelope: 'cached-bytes', lastSyncedEnvelope: 'older-synced' },
      { pendingAccountSwitch: 'dbid:new' },
    )

    const fetcher = vi.fn()
    const provider = makeProvider(store, fetcher)

    // API-level operations refuse outright...
    await expect(provider.listFolder('/')).rejects.toMatchObject({
      code: 'account-switch-pending',
    })
    // ...sync short-circuits to a needs-user-action status...
    expect(await provider.syncNow()).toMatchObject({ state: 'needs-user-action' })
    // ...load refuses the record too (not openable while blocked — it falls
    // back to the draft, absent here)...
    await expect(provider.load()).rejects.toThrow('No Dropbox local cache')
    // ...and save lands locally as pending, never uploading.
    const envelope = await CryptoService.encrypt('blocked edit', 'password', fastKdf)

    await provider.save(envelope)
    expect((await store.getDropboxFile('id:vault'))?.pendingLocalEnvelope).toBe(envelope)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('adopts an unknown ownership but reports it for the one-time confirmation', async () => {
    const store = new VaultStore(testDbName())
    await seedSelectedRecord(store, {}, { linked: false, refreshToken: null })
    await oauthSetup(store, { accountId: null })

    const provider = makeProvider(store, tokenFetcher('dbid:first'))

    await expect(
      provider.completeLinkFromRedirect('https://example.test/app?code=abc&state=state'),
    ).resolves.toEqual({ accountMismatch: null, unverifiedOwnership: true })
    expect(await store.getDropboxSync()).toMatchObject({ accountId: 'dbid:first' })
  })

  it('declineLinkedAccount unlinks again, keeping records, ownership, and a non-auth-lost state', async () => {
    const store = new VaultStore(testDbName())
    await seedSelectedRecord(
      store,
      { pendingLocalEnvelope: 'unsynced-edit' },
      { accountId: 'dbid:old', authLost: true, pendingAccountSwitch: 'dbid:new' },
    )
    await store.saveDropboxSync({
      pendingAccountSwitchLabel: 'new@example.com',
      refreshToken: 'refresh-token-new',
    })

    const provider = makeProvider(store, vi.fn())

    await provider.declineLinkedAccount()

    expect(await store.getDropboxSync()).toMatchObject({
      accountId: 'dbid:old',
      authLost: false,
      linked: false,
      pendingAccountSwitch: null,
      pendingAccountSwitchLabel: null,
      refreshToken: null,
      selectedFileKey: 'id:vault',
    })
    expect((await store.getDropboxFile('id:vault'))?.pendingLocalEnvelope).toBe('unsynced-edit')
  })

  it('Cancel after an account mismatch keeps the old owner so a later wrong-account callback guards again', async () => {
    const store = new VaultStore(testDbName())
    await seedSelectedRecord(
      store,
      { pendingLocalEnvelope: 'unsynced-edit' },
      { accountId: 'dbid:old', accountLabel: 'old@example.com', linked: false },
    )

    const firstFetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(tokenPayload('dbid:new', 'refresh-token-new-1')))
      .mockResolvedValueOnce(jsonResponse({ account_id: 'dbid:new', email: 'new@example.com' }))
    const firstProvider = makeProvider(store, firstFetcher)

    await oauthSetup(store)
    await firstProvider.completeLinkFromRedirect('https://example.test/app?code=abc&state=state')
    await firstProvider.declineLinkedAccount()

    expect(await store.getDropboxSync()).toMatchObject({
      accountId: 'dbid:old',
      accountLabel: 'old@example.com',
      linked: false,
      pendingAccountSwitch: null,
      refreshToken: null,
    })
    expect(await store.getDropboxFiles()).toHaveLength(1)

    const secondFetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(tokenPayload('dbid:new', 'refresh-token-new-2')))
      .mockResolvedValueOnce(jsonResponse({ account_id: 'dbid:new', email: 'new@example.com' }))
    const secondProvider = makeProvider(store, secondFetcher)

    await oauthSetup(store)

    await expect(
      secondProvider.completeLinkFromRedirect('https://example.test/app?code=def&state=state'),
    ).resolves.toEqual({
      accountMismatch: { newAccountId: 'dbid:new', previousAccountId: 'dbid:old' },
      unverifiedOwnership: false,
    })

    expect(await store.getDropboxFiles()).toHaveLength(1)
    expect(await store.getDropboxSync()).toMatchObject({
      accountId: 'dbid:old',
      accountLabel: 'old@example.com',
      linked: false,
      pendingAccountSwitch: 'dbid:new',
      pendingAccountSwitchLabel: 'new@example.com',
      refreshToken: 'refresh-token-new-2',
    })
  })

  it('adoptLinkedAccountDiscardingRecents wipes records, selection, and stale sync state', async () => {
    const store = new VaultStore(testDbName())
    await seedSelectedRecord(
      store,
      {},
      {
        accountId: 'dbid:old',
        accountLabel: 'old-label',
        lastSyncStatus: 'conflict',
        pendingAccountSwitch: 'dbid:new',
        pendingAccountSwitchLabel: 'new@example.com',
        refreshToken: 'refresh-token-new',
        remoteConflictEnvelope: 'old-remote',
        remoteConflictRev: 'old-rev',
      },
    )

    const provider = makeProvider(store, vi.fn())

    await provider.adoptLinkedAccountDiscardingRecents('dbid:new')

    expect(await store.getDropboxFiles()).toEqual([])
    // The old account's transitional state (conflict snapshot, status) must
    // not survive the recents it referred to.
    expect(await store.getDropboxSync()).toMatchObject({
      accountId: 'dbid:new',
      accountLabel: 'new@example.com',
      lastSyncStatus: 'never',
      pendingAccountSwitch: null,
      pendingAccountSwitchLabel: null,
      refreshToken: 'refresh-token-new',
      remoteConflictEnvelope: null,
      remoteConflictRev: null,
      selectedFileKey: null,
    })
  })

  it('openRecentFile serves the cached bytes, selects the record, and touches recency without network', async () => {
    const store = new VaultStore(testDbName())
    const fetcher = vi.fn()
    await store.putDropboxFile(
      {
        key: 'id:other',
        name: 'other.txt',
        pathDisplay: '/other.txt',
        pathLower: '/other.txt',
        envelope: 'other-cache',
      },
      new Date('2026-06-12T10:00:00.000Z'),
    )
    await store.putDropboxFile(
      {
        key: 'id:target',
        name: 'target.txt',
        pathDisplay: '/target.txt',
        pathLower: '/target.txt',
        envelope: 'target-cache',
        pendingLocalEnvelope: 'target-pending',
      },
      new Date('2026-06-12T09:00:00.000Z'),
    )
    await store.saveDropboxSync({ linked: true, refreshToken: 'refresh-token' })

    const provider = makeProvider(store, fetcher)

    // The pending envelope is the freshest local bytes.
    await expect(provider.openRecentFile('id:target')).resolves.toBe('target-pending')
    expect(fetcher).not.toHaveBeenCalled()
    expect((await store.getDropboxSync())?.selectedFileKey).toBe('id:target')
    expect((await store.getDropboxFiles()).map((record) => record.key)).toEqual([
      'id:target',
      'id:other',
    ])
  })

  it('openRecentFile downloads and caches a cache-less record before returning', async () => {
    const store = new VaultStore(testDbName())
    const envelope = await CryptoService.encrypt('downloaded text', 'password', fastKdf)
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'access-token', expires_in: 14400, token_type: 'bearer' }),
      )
      .mockResolvedValueOnce(
        new Response(envelope, {
          headers: {
            'dropbox-api-result': JSON.stringify({
              '.tag': 'file',
              id: 'id:bare',
              name: 'bare.txt',
              path_display: '/bare.txt',
              path_lower: '/bare.txt',
              rev: 'rev-1',
              client_modified: '2026-06-10T08:00:00Z',
            }),
          },
          status: 200,
        }),
      )
    await store.putDropboxFile({
      key: 'id:bare',
      name: 'bare.txt',
      pathDisplay: '/bare.txt',
      pathLower: '/bare.txt',
      envelope: null,
    })
    await store.saveDropboxSync({ linked: true, refreshToken: 'refresh-token' })

    const provider = makeProvider(store, fetcher)

    await expect(provider.openRecentFile('id:bare')).resolves.toBe(envelope)
    // A clean adopt: both columns take the remote version's client_modified.
    expect(await store.getDropboxFile('id:bare')).toMatchObject({
      baseRev: 'rev-1',
      envelope,
      lastSyncedEnvelope: envelope,
      syncedModifiedAt: '2026-06-10T08:00:00Z',
      localModifiedAt: '2026-06-10T08:00:00Z',
    })
  })

  it('openRecentFile on a cached record returns local bytes without re-stamping the timestamps', async () => {
    const store = new VaultStore(testDbName())
    const fetcher = vi.fn()
    await store.putDropboxFile({
      key: 'id:cached',
      name: 'cached.txt',
      pathDisplay: '/cached.txt',
      pathLower: '/cached.txt',
      envelope: 'cached-bytes',
      lastSyncedEnvelope: 'cached-bytes',
      baseRev: 'rev-1',
      syncedModifiedAt: '2026-06-10T08:00:00Z',
      localModifiedAt: '2026-06-10T08:00:00Z',
    })
    await store.saveDropboxSync({ linked: true, refreshToken: 'refresh-token' })

    const provider = makeProvider(store, fetcher)

    // Opening without editing must NOT touch Dropbox or move the timestamps
    // (it must not re-stamp a device clock — SPEC §8).
    await expect(provider.openRecentFile('id:cached')).resolves.toBe('cached-bytes')
    expect(fetcher).not.toHaveBeenCalled()
    expect(await store.getDropboxFile('id:cached')).toMatchObject({
      syncedModifiedAt: '2026-06-10T08:00:00Z',
      localModifiedAt: '2026-06-10T08:00:00Z',
    })
  })

  it('openRecentFile refuses to download a cache-less row while unlinked', async () => {
    const store = new VaultStore(testDbName())
    const fetcher = vi.fn()

    await store.putDropboxFile({
      key: 'id:bare',
      name: 'bare.txt',
      pathDisplay: '/bare.txt',
      pathLower: '/bare.txt',
      envelope: null,
    })
    await store.saveDropboxSync({ linked: false, refreshToken: null })

    const provider = makeProvider(store, fetcher)

    await expect(provider.openRecentFile('id:bare')).rejects.toMatchObject({
      code: 'unlinked',
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('openRecentFile returns null for an unknown key', async () => {
    const store = new VaultStore(testDbName())
    const provider = makeProvider(store, vi.fn())

    await expect(provider.openRecentFile('id:missing')).resolves.toBeNull()
  })
})

describe('DropboxProvider recent-files table surface', () => {
  const makeProvider = (store: VaultStore) =>
    new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: vi.fn() as typeof fetch,
      store,
    })

  it('getRecentFiles maps records UI-shaped, newest first, with the selection', async () => {
    const store = new VaultStore(testDbName())

    await store.putDropboxFile(
      {
        key: 'id:clean',
        name: 'clean.txt',
        pathDisplay: '/Notes/clean.txt',
        pathLower: '/notes/clean.txt',
        envelope: 'cache',
        lastSyncedEnvelope: 'cache',
        syncedModifiedAt: '2026-06-12T09:00:00Z',
        localModifiedAt: '2026-06-12T09:00:00Z',
      },
      new Date('2026-06-12T09:00:00.000Z'),
    )
    await store.putDropboxFile(
      {
        key: 'id:dirty',
        name: 'dirty.txt',
        pathDisplay: '/Notes/dirty.txt',
        pathLower: '/notes/dirty.txt',
        envelope: 'cache-2',
        lastSyncedEnvelope: 'older',
      },
      new Date('2026-06-12T10:00:00.000Z'),
    )
    await store.putDropboxFile(
      {
        key: 'id:bare',
        name: 'bare.txt',
        pathDisplay: '/bare.txt',
        pathLower: '/bare.txt',
        envelope: null,
      },
      new Date('2026-06-12T08:00:00.000Z'),
    )
    await store.setSelectedDropboxFileKey('id:dirty')

    await expect(makeProvider(store).getRecentFiles()).resolves.toEqual({
      files: [
        {
          key: 'id:dirty',
          name: 'dirty.txt',
          // The Path column carries the FOLDER (SPEC §9) — Name already has
          // the filename.
          folderPath: '/Notes',
          syncedModifiedAt: null,
          localModifiedAt: null,
          hasCache: true,
          hasUnsyncedChanges: true,
        },
        {
          key: 'id:clean',
          name: 'clean.txt',
          folderPath: '/Notes',
          syncedModifiedAt: '2026-06-12T09:00:00Z',
          localModifiedAt: '2026-06-12T09:00:00Z',
          hasCache: true,
          hasUnsyncedChanges: false,
        },
        {
          key: 'id:bare',
          name: 'bare.txt',
          folderPath: '/',
          syncedModifiedAt: null,
          localModifiedAt: null,
          hasCache: false,
          hasUnsyncedChanges: false,
        },
      ],
      selectedKey: 'id:dirty',
    })
  })

  it('a cached access token cannot bypass the account-switch guard (cross-tab)', async () => {
    const store = new VaultStore(testDbName())
    await seedSelectedRecord(store)

    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'access-token', expires_in: 14400, token_type: 'bearer' }),
      )
      .mockResolvedValueOnce(jsonResponse({ cursor: 'c', entries: [], has_more: false }))
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      store,
    })

    // First call caches an access token in THIS instance...
    await provider.listFolder('/')
    expect(fetcher).toHaveBeenCalledTimes(2)

    // ...then ANOTHER tab records a mismatch. The persisted guard must stop
    // this instance too — its cached token is no defense.
    await store.saveDropboxSync({ pendingAccountSwitch: 'dbid:new' })

    await expect(provider.listFolder('/')).rejects.toMatchObject({
      code: 'account-switch-pending',
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('openRecentFile refuses while the account switch is unresolved, mutating nothing', async () => {
    const store = new VaultStore(testDbName())

    await store.putDropboxFile(
      {
        key: 'id:other',
        name: 'other.txt',
        pathDisplay: '/other.txt',
        pathLower: '/other.txt',
        envelope: 'other-cache',
      },
      new Date('2026-06-12T10:00:00.000Z'),
    )
    await store.putDropboxFile(
      {
        key: 'id:target',
        name: 'target.txt',
        pathDisplay: '/target.txt',
        pathLower: '/target.txt',
        envelope: 'target-cache',
      },
      new Date('2026-06-12T09:00:00.000Z'),
    )
    await store.saveDropboxSync({
      linked: true,
      pendingAccountSwitch: 'dbid:new',
      refreshToken: 'refresh-token',
      selectedFileKey: 'id:other',
    })

    const provider = makeProvider(store)

    await expect(provider.openRecentFile('id:target')).rejects.toMatchObject({
      code: 'account-switch-pending',
    })
    // Selection and recency are untouched: the guard fired before any mutation.
    expect((await store.getDropboxSync())?.selectedFileKey).toBe('id:other')
    expect((await store.getDropboxFiles()).map((record) => record.key)).toEqual([
      'id:other',
      'id:target',
    ])
  })

  it('removeRecentFile deletes the record and cache, never touching Dropbox', async () => {
    const store = new VaultStore(testDbName())

    await seedSelectedRecord(store, { envelope: 'cache' })

    const provider = makeProvider(store)

    await provider.removeRecentFile('id:vault')

    expect(await store.getDropboxFile('id:vault')).toBeNull()
    expect((await store.getDropboxSync())?.selectedFileKey).toBeNull()
  })

  it('exportRecentFileCopy returns pending over cache, and null when nothing is stored', async () => {
    const store = new VaultStore(testDbName())

    await store.putDropboxFile({
      key: 'id:a',
      name: 'a.txt',
      pathDisplay: '/a.txt',
      pathLower: '/a.txt',
      envelope: 'cache-bytes',
      pendingLocalEnvelope: 'pending-bytes',
    })
    await store.putDropboxFile({
      key: 'id:bare',
      name: 'bare.txt',
      pathDisplay: '/bare.txt',
      pathLower: '/bare.txt',
      envelope: null,
    })

    const provider = makeProvider(store)

    await expect(provider.exportRecentFileCopy('id:a')).resolves.toBe('pending-bytes')
    await expect(provider.exportRecentFileCopy('id:bare')).resolves.toBeNull()
    await expect(provider.exportRecentFileCopy('id:missing')).resolves.toBeNull()
  })
})
