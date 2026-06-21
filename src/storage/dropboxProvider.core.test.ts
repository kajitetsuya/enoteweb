import {
  describe,
  expect,
  it,
  vi,
  CryptoService,
  createPkceChallenge,
  DropboxProvider,
  VaultStore,
  fastKdf,
  testDbName,
  jsonResponse,
  seedSelectedRecord,
} from './dropboxProvider.testkit'

describe('DropboxProvider', () => {
  it('creates a deterministic base64url PKCE challenge', async () => {
    const challenge = await createPkceChallenge('test-verifier')

    expect(challenge).toBe(await createPkceChallenge('test-verifier'))
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(challenge).not.toContain('=')
  })

  it('starts OAuth with PKCE and stores transient verifier state', async () => {
    const store = new VaultStore(testDbName())
    const navigate = vi.fn()
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      getHref: () => 'https://example.test/app?old=1',
      navigate,
      store,
    })

    await provider.beginLink()

    const sync = await store.getDropboxSync()
    const authUrl = new URL(navigate.mock.calls[0]?.[0] ?? '')

    expect(sync?.codeVerifier).toBeTruthy()
    expect(sync?.oauthState).toBeTruthy()
    expect(authUrl.origin).toBe('https://www.dropbox.com')
    expect(authUrl.searchParams.get('client_id')).toBe('dropbox-app-key')
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authUrl.searchParams.get('redirect_uri')).toBe('https://example.test/app')
    expect(authUrl.searchParams.get('scope')).toBe(
      'account_info.read files.content.read files.content.write files.metadata.read',
    )
    expect(authUrl.searchParams.get('token_access_type')).toBe('offline')
    expect(authUrl.searchParams.has('force_reapprove')).toBe(false)
    expect(authUrl.searchParams.has('force_reauthentication')).toBe(false)
  })

  it('can force Dropbox reapproval and reauthentication for account switching', async () => {
    const store = new VaultStore(testDbName())
    const navigate = vi.fn()
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      getHref: () => 'https://example.test/app?old=1',
      navigate,
      store,
    })

    await provider.beginLink({ forceReapprove: true, forceReauthentication: true })

    const authUrl = new URL(navigate.mock.calls[0]?.[0] ?? '')

    expect(authUrl.searchParams.get('force_reapprove')).toBe('true')
    expect(authUrl.searchParams.get('force_reauthentication')).toBe('true')
  })

  it('completes OAuth callback, stores only the refresh token, and scrubs the URL', async () => {
    const store = new VaultStore(testDbName())
    const fetcher = vi.fn(async () =>
      jsonResponse({
        access_token: 'short-lived-access-token',
        account_id: 'dbid:test',
        expires_in: 14400,
        refresh_token: 'refresh-token',
        token_type: 'bearer',
      }),
    )
    const replaceHref = vi.fn()
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      replaceHref,
      store,
    })

    await store.saveDropboxSync({
      codeVerifier: 'verifier',
      oauthState: 'state',
    })

    await expect(
      provider.completeLinkFromRedirect('https://example.test/app?code=abc&state=state'),
    ).resolves.toEqual({ accountMismatch: null, unverifiedOwnership: false })

    const sync = await store.getDropboxSync()

    expect(fetcher).toHaveBeenCalledWith(
      'https://api.dropboxapi.com/oauth2/token',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(sync).toMatchObject({
      // The cache-ownership identity for the account-switch guard (SPEC §9).
      accountId: 'dbid:test',
      accountLabel: 'dbid:test',
      authLost: false,
      codeVerifier: null,
      linked: true,
      oauthState: null,
      refreshToken: 'refresh-token',
    })
    expect(JSON.stringify(sync)).not.toContain('short-lived-access-token')
    expect(replaceHref).toHaveBeenCalledWith('https://example.test/app')
  })

  it('stores the account email as accountLabel from users/get_current_account', async () => {
    const store = new VaultStore(testDbName())
    const fetcher = vi
      .fn()
      // 1) token exchange
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'short-lived-access-token',
          account_id: 'dbid:test',
          expires_in: 14400,
          refresh_token: 'refresh-token',
          token_type: 'bearer',
        }),
      )
      // 2) users/get_current_account — the email wins over the display name
      .mockResolvedValueOnce(
        jsonResponse({
          account_id: 'dbid:test',
          email: 'user@example.com',
          name: { display_name: 'User Example' },
        }),
      )
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      replaceHref: vi.fn(),
      store,
    })

    await store.saveDropboxSync({ codeVerifier: 'verifier', oauthState: 'state' })
    await provider.completeLinkFromRedirect('https://example.test/app?code=abc&state=state')

    expect((await store.getDropboxSync())?.accountLabel).toBe('user@example.com')
  })

  it('saves an encrypted envelope locally and marks it pending when Dropbox is unlinked', async () => {
    const store = new VaultStore(testDbName())
    const envelope = await CryptoService.encrypt('pending text', 'password', fastKdf)
    const fetcher = vi.fn()
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      store,
    })

    await provider.save(envelope)

    const vault = await store.getVault()
    const sync = await store.getDropboxSync()

    expect(vault?.envelope).toBe(envelope)
    expect(vault?.activeProvider).toBe('dropbox')
    expect(sync?.pendingLocalEnvelope).toBe(envelope)
    expect(sync?.lastSyncStatus).toBe('pending-local')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('selects an existing Dropbox text file and caches its encrypted envelope', async () => {
    const store = new VaultStore(testDbName())
    const envelope = await CryptoService.encrypt('remote text', 'password', fastKdf)
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'access-token',
          expires_in: 14400,
          token_type: 'bearer',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          '.tag': 'file',
          id: 'id:remote',
          name: 'remote.txt',
          path_display: '/Notes/remote.txt',
          path_lower: '/notes/remote.txt',
          rev: 'rev-remote',
        }),
      )
      .mockResolvedValueOnce(
        new Response(envelope, {
          headers: {
            'dropbox-api-result': JSON.stringify({
              '.tag': 'file',
              id: 'id:remote',
              name: 'remote.txt',
              path_display: '/Notes/remote.txt',
              path_lower: '/notes/remote.txt',
              rev: 'rev-remote',
            }),
          },
          status: 200,
        }),
      )
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      store,
    })

    await store.saveDropboxSync({
      linked: true,
      refreshToken: 'refresh-token',
    })

    await expect(provider.selectRemoteFile('/Notes/remote.txt')).resolves.toBe(envelope)

    // The cache lives on the file's record, not the vault.
    expect(await store.getVault()).toBeNull()
    expect(await store.getDropboxFile('id:remote')).toMatchObject({
      baseRev: 'rev-remote',
      envelope,
      lastSyncedEnvelope: envelope,
      name: 'remote.txt',
      pathDisplay: '/Notes/remote.txt',
      pathLower: '/notes/remote.txt',
      pendingLocalEnvelope: null,
    })
    expect(await store.getDropboxSync()).toMatchObject({
      lastSyncStatus: 'synced',
      selectedFileKey: 'id:remote',
    })
  })

  it('selectRemoteFile preserves an unsynced edit when re-selecting a file that already has pending local changes', async () => {
    const store = new VaultStore(testDbName())
    // The remote returns this envelope
    const remoteEnvelope = await CryptoService.encrypt('remote text', 'password', fastKdf)
    // The local edit the user already has (differs from remote)
    const pendingEnvelope = await CryptoService.encrypt('local unsynced text', 'password', fastKdf)

    // Seed the store with an existing record for 'id:remote' that has a pending local edit.
    // baseRev and lastSyncedEnvelope are intentionally DISTINCT from the remote rev/envelope
    // so the test can assert the merge-base invariant: the diverged branch must not clobber them.
    const seedBaseRev = 'rev-base-before-diverge'
    const seedLastSyncedEnvelope = 'env-base-before-diverge'
    await store.putDropboxFile({
      key: 'id:remote',
      name: 'remote.txt',
      pathDisplay: '/Notes/remote.txt',
      pathLower: '/notes/remote.txt',
      envelope: 'env-old',
      baseRev: seedBaseRev,
      lastSyncedEnvelope: seedLastSyncedEnvelope,
      pendingLocalEnvelope: pendingEnvelope,
    })
    await store.saveDropboxSync({
      linked: true,
      refreshToken: 'refresh-token',
    })

    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'access-token',
          expires_in: 14400,
          token_type: 'bearer',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          '.tag': 'file',
          id: 'id:remote',
          name: 'remote.txt',
          path_display: '/Notes/remote.txt',
          path_lower: '/notes/remote.txt',
          rev: 'rev-remote',
        }),
      )
      .mockResolvedValueOnce(
        new Response(remoteEnvelope, {
          headers: {
            'dropbox-api-result': JSON.stringify({
              '.tag': 'file',
              id: 'id:remote',
              name: 'remote.txt',
              path_display: '/Notes/remote.txt',
              path_lower: '/notes/remote.txt',
              rev: 'rev-remote',
            }),
          },
          status: 200,
        }),
      )
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      store,
    })

    // Should return the PENDING envelope (local edit), not the remote
    await expect(provider.selectRemoteFile('/Notes/remote.txt')).resolves.toBe(pendingEnvelope)

    // The stored record must still have the user's unsynced edit
    const fileRecord = await store.getDropboxFile('id:remote')
    expect(fileRecord?.pendingLocalEnvelope).toBe(pendingEnvelope)

    // Merge-base invariant: baseRev and lastSyncedEnvelope must be UNCHANGED —
    // the diverged branch must never promote the remote rev/envelope into the
    // base, or conflict resolution would see base == remote (no remote changes)
    // and silently overwrite the remote with the local pending.
    expect(fileRecord?.baseRev).toBe(seedBaseRev)
    expect(fileRecord?.lastSyncedEnvelope).toBe(seedLastSyncedEnvelope)

    // The sync record must reflect a conflict, not synced
    expect(await store.getDropboxSync()).toMatchObject({
      lastSyncStatus: 'conflict',
      remoteConflictEnvelope: remoteEnvelope,
      selectedFileKey: 'id:remote',
    })
  })

  it('selectRemoteFile rescues an unsynced edit held under a path-keyed record', async () => {
    const store = new VaultStore(testDbName())
    const remoteEnvelope = await CryptoService.encrypt('remote text', 'password', fastKdf)
    const pendingEnvelope = await CryptoService.encrypt('local unsynced text', 'password', fastKdf)

    // A record can be keyed by `path:<pathLower>` while its Dropbox id is not
    // yet known and carry a pending offline edit. selectRemoteFile resolves the
    // file by its Dropbox id, so without the path-key rekey it would look under
    // `id:remote`, miss this record, and silently orphan the edit (clean-adopt
    // the remote). The rekey rescues it.
    const pathKey = 'path:/notes/remote.txt'
    const seedBaseRev = 'rev-base-before-diverge'
    const seedLastSyncedEnvelope = 'env-base-before-diverge'
    await store.putDropboxFile({
      key: pathKey,
      name: 'remote.txt',
      pathDisplay: '/Notes/remote.txt',
      pathLower: '/notes/remote.txt',
      envelope: 'env-old',
      baseRev: seedBaseRev,
      lastSyncedEnvelope: seedLastSyncedEnvelope,
      pendingLocalEnvelope: pendingEnvelope,
    })
    await store.saveDropboxSync({
      linked: true,
      refreshToken: 'refresh-token',
    })

    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'access-token',
          expires_in: 14400,
          token_type: 'bearer',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          '.tag': 'file',
          id: 'id:remote',
          name: 'remote.txt',
          path_display: '/Notes/remote.txt',
          path_lower: '/notes/remote.txt',
          rev: 'rev-remote',
        }),
      )
      .mockResolvedValueOnce(
        new Response(remoteEnvelope, {
          headers: {
            'dropbox-api-result': JSON.stringify({
              '.tag': 'file',
              id: 'id:remote',
              name: 'remote.txt',
              path_display: '/Notes/remote.txt',
              path_lower: '/notes/remote.txt',
              rev: 'rev-remote',
            }),
          },
          status: 200,
        }),
      )
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      store,
    })

    // The pending edit is rescued: returned to the session, not the remote.
    await expect(provider.selectRemoteFile('/Notes/remote.txt')).resolves.toBe(pendingEnvelope)

    // The record now lives under the id key with its pending + base preserved...
    const idRecord = await store.getDropboxFile('id:remote')
    expect(idRecord?.pendingLocalEnvelope).toBe(pendingEnvelope)
    expect(idRecord?.baseRev).toBe(seedBaseRev)
    expect(idRecord?.lastSyncedEnvelope).toBe(seedLastSyncedEnvelope)
    // ...and the path-keyed record is gone (rekeyed, not duplicated).
    expect((await store.getDropboxFile(pathKey)) ?? null).toBeNull()

    expect(await store.getDropboxSync()).toMatchObject({
      lastSyncStatus: 'conflict',
      remoteConflictEnvelope: remoteEnvelope,
      selectedFileKey: 'id:remote',
    })
  })

  it('selectRemoteFile adopts remote cleanly when there is no pending edit (or pending equals remote)', async () => {
    const store = new VaultStore(testDbName())
    const remoteEnvelope = await CryptoService.encrypt('remote text v2', 'password', fastKdf)

    // Seed a record with no pending edit (clean state)
    await store.putDropboxFile({
      key: 'id:remote',
      name: 'remote.txt',
      pathDisplay: '/Notes/remote.txt',
      pathLower: '/notes/remote.txt',
      envelope: 'env-old',
      baseRev: 'rev-old',
      lastSyncedEnvelope: 'env-old',
      pendingLocalEnvelope: null,
    })
    await store.saveDropboxSync({
      linked: true,
      refreshToken: 'refresh-token',
    })

    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'access-token',
          expires_in: 14400,
          token_type: 'bearer',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          '.tag': 'file',
          id: 'id:remote',
          name: 'remote.txt',
          path_display: '/Notes/remote.txt',
          path_lower: '/notes/remote.txt',
          rev: 'rev-remote',
        }),
      )
      .mockResolvedValueOnce(
        new Response(remoteEnvelope, {
          headers: {
            'dropbox-api-result': JSON.stringify({
              '.tag': 'file',
              id: 'id:remote',
              name: 'remote.txt',
              path_display: '/Notes/remote.txt',
              path_lower: '/notes/remote.txt',
              rev: 'rev-remote',
            }),
          },
          status: 200,
        }),
      )
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      store,
    })

    // Should return the remote envelope (clean adopt)
    await expect(provider.selectRemoteFile('/Notes/remote.txt')).resolves.toBe(remoteEnvelope)

    // The stored record should have pendingLocalEnvelope cleared
    expect(await store.getDropboxFile('id:remote')).toMatchObject({
      pendingLocalEnvelope: null,
      envelope: remoteEnvelope,
      baseRev: 'rev-remote',
    })

    // Sync record should be clean (no conflict)
    expect(await store.getDropboxSync()).toMatchObject({
      lastSyncStatus: 'synced',
      remoteConflictEnvelope: null,
      selectedFileKey: 'id:remote',
    })
  })

  it('creates a selected Dropbox text file at the requested path', async () => {
    const store = new VaultStore(testDbName())
    const envelope = await CryptoService.encrypt('new remote text', 'password', fastKdf)
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'access-token',
          expires_in: 14400,
          token_type: 'bearer',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          '.tag': 'file',
          id: 'id:new',
          name: 'new.txt',
          path_display: '/Notes/new.txt',
          path_lower: '/notes/new.txt',
          rev: 'rev-new',
        }),
      )
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      store,
    })

    await store.saveDropboxSync({
      linked: true,
      refreshToken: 'refresh-token',
    })
    await provider.createRemoteFile('/Notes/new.txt', envelope)

    const uploadCall = fetcher.mock.calls[1]
    const uploadArg = JSON.parse(String(uploadCall?.[1]?.headers?.['Dropbox-API-Arg']))

    expect(uploadArg).toMatchObject({
      mode: { '.tag': 'add' },
      path: '/Notes/new.txt',
    })
    expect(await store.getDropboxFile('id:new')).toMatchObject({
      baseRev: 'rev-new',
      envelope,
      lastSyncedEnvelope: envelope,
      pathDisplay: '/Notes/new.txt',
      pendingLocalEnvelope: null,
    })
    expect(await store.getDropboxSync()).toMatchObject({
      lastSyncStatus: 'synced',
      selectedFileKey: 'id:new',
    })
  })

  it('replaceRemoteFile replaces revision-conditionally, connects, and clears prior conflict/pending', async () => {
    const store = new VaultStore(testDbName())
    const envelope = await CryptoService.encrypt('replacement text', 'password', fastKdf)
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'access-token', expires_in: 14400, token_type: 'bearer' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          '.tag': 'file',
          id: 'id:existing',
          name: 'existing.txt',
          path_display: '/Notes/existing.txt',
          path_lower: '/notes/existing.txt',
          rev: 'rev-overwritten',
        }),
      )
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      store,
    })

    // A prior connection carrying an unresolved conflict + pending local edit.
    await seedSelectedRecord(
      store,
      {
        key: 'id:old',
        baseRev: 'rev-old',
        name: 'old.txt',
        pathDisplay: '/Notes/old.txt',
        pathLower: '/notes/old.txt',
        pendingLocalEnvelope: 'pending-old',
      },
      {
        lastSyncStatus: 'conflict',
        remoteConflictEnvelope: 'remote-old',
        remoteConflictRev: 'rev-remote-old',
      },
    )

    await provider.replaceRemoteFile('/Notes/existing.txt', envelope, 'rev-probe')

    const uploadArg = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.headers?.['Dropbox-API-Arg']))

    // Never an unconditional overwrite: the replace is gated on the revision
    // the existence probe showed with the confirmation (SPEC §9).
    expect(uploadArg).toMatchObject({
      mode: { '.tag': 'update', update: 'rev-probe' },
      path: '/Notes/existing.txt',
      strict_conflict: true,
    })
    expect(await store.getDropboxFile('id:existing')).toMatchObject({
      baseRev: 'rev-overwritten',
      envelope,
      lastSyncedEnvelope: envelope,
      pathDisplay: '/Notes/existing.txt',
      pendingLocalEnvelope: null,
    })
    expect(await store.getDropboxSync()).toMatchObject({
      lastSyncStatus: 'synced',
      remoteConflictEnvelope: null,
      remoteConflictRev: null,
      selectedFileKey: 'id:existing',
    })
    // Nothing is discarded under the per-file model: the previously selected
    // file's record (migrated from the v1 setup) keeps its pending edit.
    expect(await store.getDropboxFile('id:old')).toMatchObject({
      pendingLocalEnvelope: 'pending-old',
    })
  })

  it('createRemoteFile fails with a conflict when the path already exists (add-only)', async () => {
    const store = new VaultStore(testDbName())
    const envelope = await CryptoService.encrypt('would-be new text', 'password', fastKdf)
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'access-token', expires_in: 14400, token_type: 'bearer' }),
      )
      .mockResolvedValueOnce(jsonResponse({ error_summary: 'path/conflict/file/..' }, { status: 409 }))
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      store,
    })

    await store.saveDropboxSync({ linked: true, refreshToken: 'refresh-token' })

    await expect(provider.createRemoteFile('/Notes/taken.txt', envelope)).rejects.toMatchObject({
      code: 'conflict',
    })
    // The rejected add never connected: no selection or vault write is left behind.
    expect(await store.getDropboxSync()).toMatchObject({ selectedFileId: null })
    expect(await store.getVault()).toBeNull()
  })

  it('replaceRemoteFile surfaces a conflict when the target moved past the probed revision', async () => {
    const store = new VaultStore(testDbName())
    const envelope = await CryptoService.encrypt('replacement text', 'password', fastKdf)
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'access-token', expires_in: 14400, token_type: 'bearer' }),
      )
      .mockResolvedValueOnce(jsonResponse({ error_summary: 'path/conflict/file/..' }, { status: 409 }))
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      store,
    })

    await store.saveDropboxSync({ linked: true, refreshToken: 'refresh-token' })

    // Another device rewrote the file after the probe: the conditional update
    // must fail as 'conflict' (re-confirm upstream), never silently overwrite.
    await expect(
      provider.replaceRemoteFile('/Notes/existing.txt', envelope, 'rev-stale'),
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(await store.getVault()).toBeNull()
  })

  it('statRemoteTxtFile returns the revision for an existing file and exists:false for a missing one', async () => {
    const store = new VaultStore(testDbName())
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'access-token', expires_in: 14400, token_type: 'bearer' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          '.tag': 'file',
          id: 'id:existing',
          name: 'existing.txt',
          path_display: '/Notes/existing.txt',
          path_lower: '/notes/existing.txt',
          rev: 'rev-7',
          server_modified: '2026-06-12T09:00:00Z',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ error_summary: 'path/not_found/..' }, { status: 409 }),
      )
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      store,
    })

    await store.saveDropboxSync({ linked: true, refreshToken: 'refresh-token' })

    // The stat now threads the file id (for force-out-of-conflict id matching)
    // and the server-modified time (for the consequence confirmation).
    expect(await provider.statRemoteTxtFile('/Notes/existing.txt')).toEqual({
      exists: true,
      id: 'id:existing',
      name: 'existing.txt',
      pathDisplay: '/Notes/existing.txt',
      rev: 'rev-7',
      serverModified: '2026-06-12T09:00:00Z',
    })
    expect(await provider.statRemoteTxtFile('/Notes/missing.txt')).toEqual({ exists: false })
  })

  it('disconnectRemoteFile clears the selected file and sync state but keeps the OAuth link', async () => {
    const store = new VaultStore(testDbName())
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      getHref: () => 'https://example.test/',
      navigate: () => undefined,
      store,
    })

    await store.saveDropboxSync({
      accountLabel: 'dbid:test',
      baseRev: 'rev-base',
      lastSyncAt: '2026-01-01T00:00:00.000Z',
      lastSyncStatus: 'synced',
      lastSyncedEnvelope: 'env-1',
      linked: true,
      pendingLocalEnvelope: 'pending',
      refreshToken: 'refresh-token',
      remoteConflictEnvelope: 'remote',
      remoteConflictRev: 'rev-remote',
      selectedFileId: 'id:vault',
      selectedName: 'vault.txt',
      selectedPathDisplay: '/Notes/vault.txt',
      selectedPathLower: '/notes/vault.txt',
    })

    await provider.disconnectRemoteFile()

    expect(await store.getDropboxSync()).toMatchObject({
      // Auth preserved.
      accountLabel: 'dbid:test',
      linked: true,
      refreshToken: 'refresh-token',
      // Selection + sync state cleared.
      baseRev: null,
      lastSyncAt: null,
      lastSyncStatus: 'never',
      lastSyncedEnvelope: null,
      pendingLocalEnvelope: null,
      remoteConflictEnvelope: null,
      remoteConflictRev: null,
      selectedFileId: null,
      selectedName: null,
      selectedPathDisplay: null,
      selectedPathLower: null,
    })
  })

  it('uploads a pending encrypted envelope to the selected file and records the returned Dropbox revision', async () => {
    const store = new VaultStore(testDbName())
    const envelope = await CryptoService.encrypt('synced text', 'password', fastKdf)
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'access-token',
          expires_in: 14400,
          token_type: 'bearer',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          '.tag': 'file',
          id: 'id:vault',
          name: 'vault.txt',
          path_display: '/Notes/vault.txt',
          path_lower: '/notes/vault.txt',
          rev: 'rev-base',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          '.tag': 'file',
          id: 'id:vault',
          name: 'vault.txt',
          path_display: '/Notes/vault.txt',
          path_lower: '/notes/vault.txt',
          rev: 'rev-a',
        }),
      )
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      store,
    })

    await seedSelectedRecord(store, {
      key: 'id:vault',
      baseRev: 'rev-base',
      lastSyncedEnvelope: 'env-old',
    })
    await provider.save(envelope)

    const sync = await store.getDropboxSync()
    const uploadCall = fetcher.mock.calls[2]
    const uploadArg = JSON.parse(String(uploadCall?.[1]?.headers?.['Dropbox-API-Arg']))

    expect(uploadCall?.[0]).toBe('https://content.dropboxapi.com/2/files/upload')
    expect(uploadArg).toMatchObject({
      path: '/notes/vault.txt',
      mode: { '.tag': 'update', update: 'rev-base' },
    })
    expect(sync).toMatchObject({ lastSyncStatus: 'synced' })
    expect(await store.getDropboxFile('id:vault')).toMatchObject({
      baseRev: 'rev-a',
      envelope,
      lastSyncedEnvelope: envelope,
      pathDisplay: '/Notes/vault.txt',
      pendingLocalEnvelope: null,
    })
  })

  it('save uploads client_modified from the stored localModifiedAt and the two columns converge', async () => {
    const store = new VaultStore(testDbName())
    const envelope = await CryptoService.encrypt('edited text', 'password', fastKdf)
    let uploadedClientModified: string | undefined

    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/oauth2/token')) {
        return jsonResponse({ access_token: 'access-token', expires_in: 14400, token_type: 'bearer' })
      }

      if (url.endsWith('/files/get_metadata')) {
        return jsonResponse({
          '.tag': 'file',
          id: 'id:vault',
          name: 'vault.txt',
          path_display: '/Notes/vault.txt',
          path_lower: '/notes/vault.txt',
          rev: 'rev-base',
        })
      }

      if (url.endsWith('/files/upload')) {
        const arg = JSON.parse(
          String((init?.headers as Record<string, string> | undefined)?.['Dropbox-API-Arg']),
        )
        uploadedClientModified = arg.client_modified as string
        // Dropbox echoes the client_modified it stored back in the metadata.
        return jsonResponse({
          '.tag': 'file',
          id: 'id:vault',
          name: 'vault.txt',
          path_display: '/Notes/vault.txt',
          path_lower: '/notes/vault.txt',
          rev: 'rev-next',
          client_modified: arg.client_modified,
        })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    await seedSelectedRecord(
      store,
      { key: 'id:vault', baseRev: 'rev-base', envelope: 'old', lastSyncedEnvelope: 'old' },
      { baseRev: 'rev-base' },
    )
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      store,
    })

    await provider.save(envelope)

    // The upload carries a whole-second-UTC client_modified (Dropbox rejects
    // sub-second precision — SPEC §8).
    expect(uploadedClientModified).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)

    const record = await store.getDropboxFile('id:vault')
    // It equals the working copy's stored edit time, and after success both
    // columns read the same value.
    expect(record?.localModifiedAt).toBe(uploadedClientModified)
    expect(record?.syncedModifiedAt).toBe(uploadedClientModified)
    expect(record?.pendingLocalEnvelope).toBeNull()
  })

  it('stores remote conflict envelopes without overwriting either side', async () => {
    const store = new VaultStore(testDbName())
    const localEnvelope = await CryptoService.encrypt('local text', 'password', fastKdf)
    const remoteEnvelope = await CryptoService.encrypt('remote text', 'password', fastKdf)
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'access-token',
          expires_in: 14400,
          token_type: 'bearer',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          '.tag': 'file',
          id: 'id:vault',
          name: 'vault.txt',
          path_display: '/Notes/vault.txt',
          path_lower: '/notes/vault.txt',
          rev: 'rev-local',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ error_summary: 'path/conflict/file/' }, { status: 409 }))
      .mockResolvedValueOnce(
        new Response(remoteEnvelope, {
          headers: {
            'dropbox-api-result': JSON.stringify({
              '.tag': 'file',
              id: 'id:vault',
              name: 'vault.txt',
              path_display: '/Notes/vault.txt',
              path_lower: '/notes/vault.txt',
              rev: 'rev-remote',
            }),
          },
          status: 200,
        }),
      )
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      store,
    })

    await seedSelectedRecord(store, {
      key: 'id:vault',
      baseRev: 'rev-local',
      lastSyncedEnvelope: 'env-old',
    })
    await provider.save(localEnvelope)

    const sync = await store.getDropboxSync()

    expect(sync).toMatchObject({
      lastSyncStatus: 'conflict',
      remoteConflictEnvelope: remoteEnvelope,
      remoteConflictRev: 'rev-remote',
    })
    // The last-synced base is preserved on the record; the remote's rev is
    // recorded only as the conflict rev, never promoted to baseRev (otherwise
    // a later upload could fast-forward over the unmerged remote).
    expect(await store.getDropboxFile('id:vault')).toMatchObject({
      baseRev: 'rev-local',
      envelope: localEnvelope,
      pendingLocalEnvelope: localEnvelope,
    })
    expect(await provider.status()).toMatchObject({ state: 'conflict' })
  })

  it('does not upload while a conflict is unresolved; it only updates the pending local envelope', async () => {
    const store = new VaultStore(testDbName())
    const oldLocal = await CryptoService.encrypt('old local', 'password', fastKdf)
    const newLocal = await CryptoService.encrypt('newer local edit', 'password', fastKdf)
    const remoteEnvelope = await CryptoService.encrypt('remote text', 'password', fastKdf)
    const fetcher = vi.fn()
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      store,
    })

    await seedSelectedRecord(
      store,
      { baseRev: 'rev-base', pendingLocalEnvelope: oldLocal },
      {
        lastSyncStatus: 'conflict',
        remoteConflictEnvelope: remoteEnvelope,
        remoteConflictRev: 'rev-remote',
      },
    )

    await provider.save(newLocal)

    expect(fetcher).not.toHaveBeenCalled()
    expect(await store.getDropboxSync()).toMatchObject({
      lastSyncStatus: 'conflict',
      remoteConflictEnvelope: remoteEnvelope,
      remoteConflictRev: 'rev-remote',
    })
    expect(await store.getDropboxFile('id:vault')).toMatchObject({
      baseRev: 'rev-base',
      envelope: newLocal,
      pendingLocalEnvelope: newLocal,
    })
  })

  it('reports a conflict state even when the remote snapshot is unavailable (degraded conflict)', async () => {
    const store = new VaultStore(testDbName())
    const localEnvelope = await CryptoService.encrypt('local only', 'password', fastKdf)
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: vi.fn() as typeof fetch,
      store,
    })

    await store.saveDropboxSync({
      baseRev: 'rev-base',
      lastSyncStatus: 'conflict',
      linked: true,
      pendingLocalEnvelope: localEnvelope,
      remoteConflictEnvelope: null,
      remoteConflictRev: null,
      selectedFileId: 'id:vault',
      selectedName: 'vault.txt',
      selectedPathDisplay: '/Notes/vault.txt',
      selectedPathLower: '/notes/vault.txt',
      refreshToken: 'refresh-token',
    })

    // Must read as a conflict (sync is paused), never as pending-sync.
    expect(await provider.status()).toMatchObject({ state: 'conflict' })
  })

  it('blocks autosave upload on a stale remote-conflict signal even if the status drifted', async () => {
    const store = new VaultStore(testDbName())
    const remoteEnvelope = await CryptoService.encrypt('remote text', 'password', fastKdf)
    const newLocal = await CryptoService.encrypt('newer local', 'password', fastKdf)
    const fetcher = vi.fn()
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      store,
    })

    await seedSelectedRecord(
      store,
      { baseRev: 'rev-base' },
      {
        // Status drifted away from 'conflict', but a remote-conflict signal remains.
        lastSyncStatus: 'pending-local',
        remoteConflictEnvelope: remoteEnvelope,
        remoteConflictRev: 'rev-remote',
      },
    )

    await provider.save(newLocal)

    expect(fetcher).not.toHaveBeenCalled()
    expect(await store.getDropboxSync()).toMatchObject({
      remoteConflictEnvelope: remoteEnvelope,
      remoteConflictRev: 'rev-remote',
    })
    expect(await store.getDropboxFile('id:vault')).toMatchObject({
      pendingLocalEnvelope: newLocal,
    })
  })

  it('loadConflictEnvelopes returns the three encrypted sides in a normal conflict', async () => {
    const store = new VaultStore(testDbName())
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: vi.fn() as typeof fetch,
      store,
    })

    await seedSelectedRecord(
      store,
      { baseRev: 'rev-base', lastSyncedEnvelope: 'base-env', pendingLocalEnvelope: 'local-env' },
      {
        lastSyncStatus: 'conflict',
        remoteConflictEnvelope: 'remote-env',
        remoteConflictRev: 'rev-remote',
      },
    )

    expect(await provider.loadConflictEnvelopes()).toEqual({
      baseEnvelope: 'base-env',
      localEnvelope: 'local-env',
      remoteEnvelope: 'remote-env',
      remoteConflictRev: 'rev-remote',
    })
  })

  it('loadConflictEnvelopes returns null when there is no conflict signal', async () => {
    const store = new VaultStore(testDbName())
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: vi.fn() as typeof fetch,
      store,
    })

    await store.saveDropboxSync({
      baseRev: 'rev-base',
      lastSyncStatus: 'synced',
      lastSyncedEnvelope: 'base-env',
      linked: true,
      selectedFileId: 'id:vault',
      selectedName: 'vault.txt',
      selectedPathDisplay: '/Notes/vault.txt',
      selectedPathLower: '/notes/vault.txt',
      refreshToken: 'refresh-token',
    })

    expect(await provider.loadConflictEnvelopes()).toBeNull()
  })

  it('loadConflictEnvelopes treats a drifted record (remote signal, non-conflict status) as a conflict', async () => {
    const store = new VaultStore(testDbName())
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: vi.fn() as typeof fetch,
      store,
    })

    await seedSelectedRecord(
      store,
      { baseRev: 'rev-base', lastSyncedEnvelope: 'base-env', pendingLocalEnvelope: 'local-env' },
      {
        lastSyncStatus: 'pending-local',
        remoteConflictEnvelope: 'remote-env',
        remoteConflictRev: 'rev-remote',
      },
    )

    expect(await provider.loadConflictEnvelopes()).toMatchObject({
      remoteEnvelope: 'remote-env',
      remoteConflictRev: 'rev-remote',
    })
  })

  it('loadConflictEnvelopes captures a missing remote snapshot on demand (and persists it, base preserved)', async () => {
    const store = new VaultStore(testDbName())
    const remoteEnvelope = await CryptoService.encrypt('remote text', 'password', fastKdf)
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'access-token', expires_in: 14400, token_type: 'bearer' }),
      )
      .mockResolvedValueOnce(
        new Response(remoteEnvelope, {
          headers: {
            'dropbox-api-result': JSON.stringify({
              '.tag': 'file',
              id: 'id:vault',
              name: 'vault.txt',
              path_display: '/Notes/vault.txt',
              path_lower: '/notes/vault.txt',
              rev: 'rev-remote',
            }),
          },
          status: 200,
        }),
      )
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      store,
    })

    await seedSelectedRecord(
      store,
      { baseRev: 'rev-base', lastSyncedEnvelope: 'base-env', pendingLocalEnvelope: 'local-env' },
      { lastSyncStatus: 'conflict', remoteConflictEnvelope: null, remoteConflictRev: null },
    )

    expect(await provider.loadConflictEnvelopes()).toMatchObject({
      remoteEnvelope,
      remoteConflictRev: 'rev-remote',
    })
    expect(await store.getDropboxSync()).toMatchObject({
      remoteConflictEnvelope: remoteEnvelope,
      remoteConflictRev: 'rev-remote',
    })
    // The on-demand capture must not promote the remote rev into the base.
    expect(await store.getDropboxFile('id:vault')).toMatchObject({ baseRev: 'rev-base' })
  })

  it('loadConflictEnvelopes reports no remote when the capture fails (degraded conflict)', async () => {
    const store = new VaultStore(testDbName())
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'access-token', expires_in: 14400, token_type: 'bearer' }),
      )
      .mockResolvedValueOnce(jsonResponse({ error_summary: 'too_many_requests/' }, { status: 503 }))
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      store,
    })

    await seedSelectedRecord(
      store,
      { baseRev: 'rev-base', lastSyncedEnvelope: 'base-env', pendingLocalEnvelope: 'local-env' },
      { lastSyncStatus: 'conflict', remoteConflictEnvelope: null, remoteConflictRev: null },
    )

    expect(await provider.loadConflictEnvelopes()).toMatchObject({
      baseEnvelope: 'base-env',
      localEnvelope: 'local-env',
      remoteEnvelope: null,
      remoteConflictRev: null,
    })
  })

  it('exportRemoteConflictCopy returns the remote envelope, or null when absent', async () => {
    const store = new VaultStore(testDbName())
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: vi.fn() as typeof fetch,
      store,
    })

    expect(await provider.exportRemoteConflictCopy()).toBeNull()

    await store.saveDropboxSync({ remoteConflictEnvelope: 'remote-env' })

    expect(await provider.exportRemoteConflictCopy()).toBe('remote-env')
  })

  it('commitMergedEnvelope uploads the resolved envelope conditionally and marks it synced', async () => {
    const store = new VaultStore(testDbName())
    const mergedEnvelope = await CryptoService.encrypt('merged text', 'password', fastKdf)
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'access-token', expires_in: 14400, token_type: 'bearer' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          '.tag': 'file',
          id: 'id:vault',
          name: 'vault.txt',
          path_display: '/Notes/vault.txt',
          path_lower: '/notes/vault.txt',
          rev: 'rev-remote',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          '.tag': 'file',
          id: 'id:vault',
          name: 'vault.txt',
          path_display: '/Notes/vault.txt',
          path_lower: '/notes/vault.txt',
          rev: 'rev-merged',
        }),
      )
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      store,
    })

    await seedSelectedRecord(
      store,
      { baseRev: 'rev-base', lastSyncedEnvelope: 'base-env', pendingLocalEnvelope: 'local-env' },
      {
        lastSyncStatus: 'conflict',
        remoteConflictEnvelope: 'remote-env',
        remoteConflictRev: 'rev-remote',
      },
    )

    await provider.commitMergedEnvelope(mergedEnvelope, 'rev-remote')

    const uploadCall = fetcher.mock.calls.find(
      (call) => call[0] === 'https://content.dropboxapi.com/2/files/upload',
    )
    const uploadArg = JSON.parse(String(uploadCall?.[1]?.headers?.['Dropbox-API-Arg']))

    expect(uploadArg.mode).toEqual({ '.tag': 'update', update: 'rev-remote' })
    expect(await store.getDropboxSync()).toMatchObject({
      lastSyncStatus: 'synced',
      remoteConflictEnvelope: null,
      remoteConflictRev: null,
    })
    expect(await store.getDropboxFile('id:vault')).toMatchObject({
      baseRev: 'rev-merged',
      envelope: mergedEnvelope,
      lastSyncedEnvelope: mergedEnvelope,
      pendingLocalEnvelope: null,
    })
  })

  it('adoptRemoteConflictEnvelope marks the captured remote copy synced without upload', async () => {
    const store = new VaultStore(testDbName())
    const remoteEnvelope = await CryptoService.encrypt('remote text', 'remote password', fastKdf)
    const fetcher = vi.fn()
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      store,
    })

    await seedSelectedRecord(
      store,
      {
        baseRev: 'rev-base',
        envelope: 'local-cache',
        lastSyncedEnvelope: 'base-env',
        pendingLocalEnvelope: 'local-env',
      },
      {
        lastSyncStatus: 'conflict',
        remoteConflictEnvelope: remoteEnvelope,
        remoteConflictRev: 'rev-remote',
        // The captured remote snapshot's modified time (SPEC §8).
        remoteConflictClientModified: '2026-06-14T07:00:00Z',
      },
    )

    await provider.adoptRemoteConflictEnvelope(remoteEnvelope, 'rev-remote')

    expect(fetcher).not.toHaveBeenCalled()
    expect(await store.getDropboxSync()).toMatchObject({
      lastSyncStatus: 'synced',
      remoteConflictEnvelope: null,
      remoteConflictRev: null,
    })
    expect(await store.getDropboxFile('id:vault')).toMatchObject({
      baseRev: 'rev-remote',
      envelope: remoteEnvelope,
      lastSyncedEnvelope: remoteEnvelope,
      pendingLocalEnvelope: null,
      // Adopting the remote copy stamps the snapshot's client_modified onto
      // both columns rather than leaving the stale local edit time (P2 fix).
      syncedModifiedAt: '2026-06-14T07:00:00Z',
      localModifiedAt: '2026-06-14T07:00:00Z',
    })
  })

  it('commitMergedEnvelope refuses a stale commit whose expectedRemoteRev no longer matches', async () => {
    const store = new VaultStore(testDbName())
    const mergedEnvelope = await CryptoService.encrypt('merged text', 'password', fastKdf)
    const fetcher = vi.fn()
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      store,
    })

    await seedSelectedRecord(
      store,
      { baseRev: 'rev-base', lastSyncedEnvelope: 'base-env', pendingLocalEnvelope: 'local-env' },
      {
        lastSyncStatus: 'conflict',
        remoteConflictEnvelope: 'remote-env',
        remoteConflictRev: 'rev-remote',
      },
    )

    await expect(provider.commitMergedEnvelope(mergedEnvelope, 'rev-stale')).rejects.toThrow()

    expect(fetcher).not.toHaveBeenCalled()
    // Nothing was written: the conflict stands and the record is untouched.
    expect(await store.getDropboxSync()).toMatchObject({
      lastSyncStatus: 'conflict',
      remoteConflictRev: 'rev-remote',
    })
    expect(await store.getDropboxFile('id:vault')).toMatchObject({
      pendingLocalEnvelope: 'local-env',
    })
  })

  it('commitMergedEnvelope re-enters conflict on a 409 and preserves the base even if file metadata changed', async () => {
    const store = new VaultStore(testDbName())
    const mergedEnvelope = await CryptoService.encrypt('merged text', 'password', fastKdf)
    const remoteEnvelope2 = await CryptoService.encrypt('remote v2', 'password', fastKdf)
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'access-token', expires_in: 14400, token_type: 'bearer' }),
      )
      // resolveSelectedWritePath metadata: the file was renamed, which triggers the
      // identity refresh that must NOT promote the remote rev into baseRev.
      .mockResolvedValueOnce(
        jsonResponse({
          '.tag': 'file',
          id: 'id:vault',
          name: 'renamed.txt',
          path_display: '/Notes/renamed.txt',
          path_lower: '/notes/renamed.txt',
          rev: 'rev-remote',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ error_summary: 'path/conflict/file/' }, { status: 409 }),
      )
      .mockResolvedValueOnce(
        new Response(remoteEnvelope2, {
          headers: {
            'dropbox-api-result': JSON.stringify({
              '.tag': 'file',
              id: 'id:vault',
              name: 'renamed.txt',
              path_display: '/Notes/renamed.txt',
              path_lower: '/notes/renamed.txt',
              rev: 'rev-remote-2',
            }),
          },
          status: 200,
        }),
      )
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      store,
    })

    await seedSelectedRecord(
      store,
      { baseRev: 'rev-base', lastSyncedEnvelope: 'base-env', pendingLocalEnvelope: 'local-env' },
      {
        lastSyncStatus: 'conflict',
        remoteConflictEnvelope: 'remote-env',
        remoteConflictRev: 'rev-remote',
      },
    )

    await expect(provider.commitMergedEnvelope(mergedEnvelope, 'rev-remote')).rejects.toThrow()

    expect(await store.getDropboxSync()).toMatchObject({
      lastSyncStatus: 'conflict',
      remoteConflictEnvelope: remoteEnvelope2,
      remoteConflictRev: 'rev-remote-2',
    })
    expect(await store.getDropboxFile('id:vault')).toMatchObject({
      // The renamed-file metadata refresh must not have clobbered the base —
      // and the record adopted the file's current (renamed) identity.
      baseRev: 'rev-base',
      name: 'renamed.txt',
      pendingLocalEnvelope: mergedEnvelope,
    })
  })

  it('commitMergedEnvelope keeps the resolved envelope as the pending local side after a non-409 upload failure', async () => {
    const store = new VaultStore(testDbName())
    const mergedEnvelope = await CryptoService.encrypt('merged text', 'password', fastKdf)
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'access-token', expires_in: 14400, token_type: 'bearer' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          '.tag': 'file',
          id: 'id:vault',
          name: 'vault.txt',
          path_display: '/Notes/vault.txt',
          path_lower: '/notes/vault.txt',
          rev: 'rev-remote',
        }),
      )
      // Upload fails with a server error (not a 409): the resolution is not lost.
      .mockResolvedValueOnce(jsonResponse({ error_summary: 'too_many_requests/' }, { status: 503 }))
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      store,
    })

    await seedSelectedRecord(
      store,
      { baseRev: 'rev-base', lastSyncedEnvelope: 'base-env', pendingLocalEnvelope: 'local-env' },
      {
        lastSyncStatus: 'conflict',
        remoteConflictEnvelope: 'remote-env',
        remoteConflictRev: 'rev-remote',
      },
    )

    await expect(provider.commitMergedEnvelope(mergedEnvelope, 'rev-remote')).rejects.toThrow()

    // The resolved envelope is durable in both the cache and the pending local
    // side, the conflict still stands, and base/remote-conflict state is intact.
    expect(await store.getDropboxFile('id:vault')).toMatchObject({
      baseRev: 'rev-base',
      envelope: mergedEnvelope,
      pendingLocalEnvelope: mergedEnvelope,
    })
    expect(await store.getDropboxSync()).toMatchObject({
      lastSyncStatus: 'conflict',
      remoteConflictEnvelope: 'remote-env',
      remoteConflictRev: 'rev-remote',
    })
  })

  it('does not upload (and reports conflict) for a drifted record carrying only remoteConflictRev', async () => {
    const store = new VaultStore(testDbName())
    const fetcher = vi.fn()
    const provider = new DropboxProvider({
      appKey: 'dropbox-app-key',
      fetch: fetcher as typeof fetch,
      store,
    })

    await seedSelectedRecord(
      store,
      { baseRev: 'rev-base', pendingLocalEnvelope: 'local-env' },
      {
        // Drifted: status is not 'conflict' and the remote snapshot is absent, but a
        // remote-conflict rev remains. hasConflictSignal must still treat this as a
        // conflict in both syncNow() and status().
        lastSyncStatus: 'pending-local',
        remoteConflictEnvelope: null,
        remoteConflictRev: 'rev-remote',
      },
    )

    expect(await provider.syncNow()).toMatchObject({ state: 'conflict' })
    expect(await provider.status()).toMatchObject({ state: 'conflict' })
    expect(fetcher).not.toHaveBeenCalled()
  })
})
