import { chooseDropboxDestination, getDropboxState } from './App.dropboxMode.testkit'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import App from './App'
import { CryptoService, getEnvelopeSecretKeyMode } from './crypto/cryptoService'
import { generateSecretKeyString } from './crypto/secretKey'
import { DropboxProviderError } from './storage/dropboxProvider'
import { mockBlobUrls } from './test/appHarness'

const dropboxState = getDropboxState()

describe('App Dropbox mode', () => {
  it('shows the Link control and unlocks the draft through Edit draft', async () => {
    dropboxState.getSyncState.mockResolvedValue({
      accountLabel: 'dbid:test',
      authLost: false,
      hasPendingLocalEnvelope: true,
      hasRemoteConflictEnvelope: false,
      hasRetainedAuth: true,
      lastSyncAt: null,
      lastSyncStatus: 'pending-local',
      linked: false,
      pendingAccountSwitch: null,
      selectedFileId: 'id:notes',
      selectedName: 'notes.txt',
      selectedPathDisplay: '/Notes/notes.txt',
    })

    render(<App />)

    expect(await screen.findByRole('button', { name: 'Link' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Link' }))
    // Retained authorization prompts first; Continue reuses that grant.
    expect(
      await screen.findByText(
        /This app has authorization for dbid:test\. Continue with this account, or switch to a different one\./,
      ),
    ).not.toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    expect(dropboxState.beginLink).toHaveBeenCalledWith({
      forceReapprove: true,
    })

    // The home has no password form: the draft unlocks through the
    // Edit draft single-field dialog (SPEC §10).
    fireEvent.click(await screen.findByRole('button', { name: 'Edit draft' }))
    await screen.findByText('Unlock draft')

    const dialog = screen.getByRole('dialog')

    fireEvent.change(within(dialog).getByLabelText('Password'), {
      target: { value: 'correct horse battery staple' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))

    expect(await screen.findByTestId('editor')).toHaveProperty('value', 'opened dropbox text')
    // Toolbar status line 1 reads "Draft" in a draft session (SPEC §15).
    // The draft uses Dropbox-mode actions, but sync status appears only for
    // an actual Dropbox file session.
    expect(
      await screen.findByText('Draft', { selector: '.toolbar-file-name' }),
    ).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Save to Dropbox' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Export to Files' })).not.toBeNull()
    // No Save button in any session.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByText('Not linked', { selector: '.storage-inline-status' })).toBeNull()
  })

  it('forgets retained auth and forces Dropbox reauthentication on Switch', async () => {
    dropboxState.getSyncState.mockResolvedValue({
      accountLabel: 'dbid:test',
      authLost: false,
      hasPendingLocalEnvelope: true,
      hasRemoteConflictEnvelope: false,
      hasRetainedAuth: true,
      lastSyncAt: null,
      lastSyncStatus: 'pending-local',
      linked: false,
      pendingAccountSwitch: null,
      selectedFileId: 'id:notes',
      selectedName: 'notes.txt',
      selectedPathDisplay: '/Notes/notes.txt',
    })

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Link' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Switch' }))

    expect(dropboxState.beginLink).toHaveBeenCalledWith({
      forgetRetainedAuth: true,
      forceReapprove: true,
      forceReauthentication: true,
    })
  })

  it('surfaces a thrown OAuth completion at launch without crashing', async () => {
    // A redirect whose completion throws must tell the user their link attempt
    // failed, rather than silently dropping back to the generic "not linked" state.
    dropboxState.completeLinkFromRedirect.mockRejectedValueOnce(new Error('boom'))

    render(<App />)

    expect(
      await screen.findByText('Linking failed. Try again.'),
    ).not.toBeNull()
    // The app still finishes loading and offers the Link control.
    expect(screen.getByRole('button', { name: 'Link' })).not.toBeNull()
  })

  it('unlocks the selected Dropbox file, never the draft, when the two diverge', async () => {
    // The vault "primary" can hold a DRAFT whose
    // bytes differ from the selected Dropbox record's cache. The unlock-time
    // re-read must go through the provider (loadLocalEnvelope), never the
    // vault — otherwise the draft would be opened AS the Dropbox file. The
    // form may only touch the record while LINKED (the openability rule), so
    // this runs in the linked state.
    dropboxState.getSyncState.mockResolvedValue({
      accountLabel: 'dbid:test',
      authLost: false,
      hasPendingLocalEnvelope: false,
      hasRemoteConflictEnvelope: false,
      lastSyncAt: null,
      lastSyncStatus: 'synced',
      linked: true,
      pendingAccountSwitch: null,
      selectedFileId: 'id:notes',
      selectedName: 'notes.txt',
      selectedPathDisplay: '/Notes/notes.txt',
    })
    dropboxState.getRecentFiles.mockResolvedValue({
      files: [
        {
          key: 'id:notes',
          name: 'notes.txt',
          folderPath: '/Notes',
          syncedModifiedAt: null,
          localModifiedAt: null,
          hasCache: true,
          hasUnsyncedChanges: false,
        },
      ],
      selectedKey: 'id:notes',
    })
    dropboxState.vaultEnvelope = 'encrypted-draft-envelope'
    vi.mocked(CryptoService.decrypt).mockClear()

    render(<App />)

    // The file opens through the block's Open + the unlock dialog.
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }))
    await screen.findByText('Unlock Dropbox file')

    const dialog = screen.getByRole('dialog')

    fireEvent.change(within(dialog).getByLabelText('Password'), {
      target: { value: 'correct horse battery staple' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))

    expect(await screen.findByTestId('editor')).toHaveProperty('value', 'opened dropbox text')

    const decryptedEnvelopes = vi.mocked(CryptoService.decrypt).mock.calls.map((call) => call[0])

    expect(decryptedEnvelopes).toContain('encrypted-dropbox-envelope')
    expect(decryptedEnvelopes).not.toContain('encrypted-draft-envelope')
  })

  // There is no in-editor Save button. Conflict resolution and remote-change
  // surfacing go through the Resolve banner (see the "App home background check
  // + first-sync gate" describe, and the editor-toolbar tests in
  // App.localFileHome.test.tsx).

  it('shows Synced (and no Save button) when the Dropbox status is ready and the cache is clean', async () => {
    dropboxState.status.mockResolvedValue({
      detail: 'Dropbox synced to /Notes/notes.txt.',
      state: 'ready',
    })
    // A connected (linked) state triggers the home auto-sync; keep its result
    // 'ready' so the post-unlock status stays Synced.
    dropboxState.syncNow.mockResolvedValue({
      detail: 'Dropbox synced to /Notes/notes.txt.',
      state: 'ready',
    })
    dropboxState.getSyncState.mockResolvedValue({
      authLost: false,
      pendingAccountSwitch: null,
      accountLabel: 'dbid:test',
      hasPendingLocalEnvelope: false,
      hasRemoteConflictEnvelope: false,
      lastSyncAt: null,
      lastSyncStatus: 'synced',
      linked: true,
      selectedFileId: 'id:notes',
      selectedName: 'notes.txt',
      selectedPathDisplay: '/Notes/notes.txt',
    })

    dropboxState.getRecentFiles.mockResolvedValue({
      files: [
        {
          key: 'id:notes',
          name: 'notes.txt',
          folderPath: '/Notes',
          syncedModifiedAt: null,
          localModifiedAt: null,
          hasCache: true,
          hasUnsyncedChanges: false,
        },
      ],
      selectedKey: 'id:notes',
    })

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Open' }))
    await screen.findByText('Unlock Dropbox file')

    const unlockDialog = screen.getByRole('dialog')

    fireEvent.change(within(unlockDialog).getByLabelText('Password'), {
      target: { value: 'correct horse battery staple' },
    })
    fireEvent.click(within(unlockDialog).getByRole('button', { name: 'Unlock' }))
    await screen.findByTestId('editor')

    // `ready` + a settled save state is the only "Synced" case.
    expect(
      await screen.findByText('Synced', { selector: '.storage-inline-status' }),
    ).not.toBeNull()
    // The filename line shows the connected Dropbox file's name.
    expect(screen.getByText('notes.txt', { selector: '.toolbar-file-name' })).not.toBeNull()
    // No Save button exists in any session; a clean
    // Dropbox-file session shows Save to Dropbox + Export, no Resolve banner.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Save to Dropbox' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Export to Files' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Resolve…' })).toBeNull()
  })

  it('omits Dropbox status detail lines while keeping the actions', async () => {
    render(<App />)

    const detail = 'Dropbox is not linked. Encrypted local cache is available.'
    await screen.findByRole('button', { name: 'Link' })

    const dropboxCard = document.querySelector('.dropbox-status-card') as HTMLElement
    expect(within(dropboxCard).queryByText('/Notes/notes.txt')).toBeNull()
    expect(within(dropboxCard).queryByText(detail)).toBeNull()
    expect(document.querySelector('.storage-note')).toBeNull()
    expect(screen.getByRole('button', { name: 'Link' })).not.toBeNull()
  })

  it('shows a Dropbox status message inline next to the Dropbox label', async () => {
    dropboxState.getSyncState.mockResolvedValue({
      accountLabel: 'dbid:test',
      authLost: false,
      hasPendingLocalEnvelope: false,
      hasRemoteConflictEnvelope: false,
      lastSyncAt: null,
      lastSyncStatus: 'synced',
      linked: true,
      pendingAccountSwitch: null,
      selectedFileId: 'id:notes',
      selectedName: 'notes.txt',
      selectedPathDisplay: '/Notes/notes.txt',
    })
    dropboxState.getRecentFiles.mockResolvedValue({
      files: [
        {
          key: 'id:notes',
          name: 'notes.txt',
          folderPath: '/Notes',
          syncedModifiedAt: null,
          localModifiedAt: null,
          hasCache: true,
          hasUnsyncedChanges: false,
        },
      ],
      selectedKey: 'id:notes',
    })

    render(<App />)

    // Cancelling the unlock dialog after Open surfaces a transient Dropbox
    // status message, which renders inline next to the "Dropbox" label in the
    // block header (SPEC §9), not the dismissible bottom banner.
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }))
    await screen.findByText('Unlock Dropbox file')
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))

    const status = await screen.findByText(
      'File selected. Unlock it with its password.',
    )
    expect(status.className).toContain('dropbox-block-message')
    expect(status.closest('.dropbox-block-header')).not.toBeNull()
    // The inline status carries no dismiss button (info messages auto-dismiss).
    expect(screen.queryByRole('button', { name: 'Dismiss message' })).toBeNull()
  })
})

// Secret-key Dropbox coverage. The whole suite mocks the
// envelope as `none`; these tests flip getEnvelopeSecretKeyMode to
// 'required-v1' for one block so the required-key open/autosave paths actually
// run. The beforeEach reset restores 'none', so the override never leaks.

describe('App Dropbox secret-key (required-v1)', () => {
  const requiredV1Linked = {
    accountLabel: 'dbid:test',
    authLost: false,
    hasPendingLocalEnvelope: false,
    hasRemoteConflictEnvelope: false,
    lastSyncAt: null,
    lastSyncStatus: 'synced',
    linked: true,
    pendingAccountSwitch: null as string | null,
    selectedFileId: 'id:notes',
    selectedName: 'notes.txt',
    selectedPathDisplay: '/Notes/notes.txt',
  }

  const requiredV1Recents = {
    files: [
      {
        key: 'id:notes',
        name: 'notes.txt',
        folderPath: '/Notes',
        syncedModifiedAt: null,
        localModifiedAt: null,
        hasCache: true,
        hasUnsyncedChanges: false,
      },
    ],
    selectedKey: 'id:notes',
  }

  const seedRequiredV1Linked = () => {
    // The selected file's envelope is `required-v1`; the unlock dialog must show
    // the inline Secret-key field and refuse to open without a key.
    vi.mocked(getEnvelopeSecretKeyMode).mockReturnValue('required-v1')
    dropboxState.getSyncState.mockResolvedValue(requiredV1Linked)
    dropboxState.getRecentFiles.mockResolvedValue(requiredV1Recents)
    dropboxState.syncNow.mockResolvedValue({ detail: 'Dropbox synced.', state: 'ready' })
  }

  it('a required-v1 Dropbox open shows the inline Secret-key field and refuses a blank key', async () => {
    seedRequiredV1Linked()

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }))
    await screen.findByText('Unlock Dropbox file')

    const dialog = screen.getByRole('dialog')

    // required-v1 + no Settings key → the inline field is expanded and empty.
    const keyField = within(dialog).getByLabelText('Secret key') as HTMLInputElement
    expect(keyField.value).toBe('')

    // Submitting with a password but no key surfaces the required-key prompt and
    // never opens the editor.
    fireEvent.change(within(dialog).getByLabelText('Password'), {
      target: { value: 'correct horse battery staple' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))

    expect(
      await within(dialog).findByText("Enter this file's Secret key, or add it in Settings."),
    ).not.toBeNull()
    expect(screen.queryByTestId('editor')).toBeNull()
  })

  it('opens a required-v1 Dropbox file with a correct key and keeps the mode on autosave', async () => {
    seedRequiredV1Linked()
    const secretKey = await generateSecretKeyString()

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }))
    await screen.findByText('Unlock Dropbox file')

    const dialog = screen.getByRole('dialog')

    fireEvent.change(within(dialog).getByLabelText('Password'), {
      target: { value: 'correct horse battery staple' },
    })
    fireEvent.change(within(dialog).getByLabelText('Secret key'), {
      target: { value: secretKey },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))

    expect(await screen.findByTestId('editor')).toHaveProperty('value', 'opened dropbox text')

    vi.mocked(CryptoService.encrypt).mockClear()

    // A real save (the read-only toggle saves immediately) must encrypt WITH the
    // session's Secret-key bytes — never write a `none` (unprotected) envelope to
    // the cloud. This is the core protection-drop guard.
    fireEvent.click(screen.getByRole('button', { name: 'Read-only' }))

    await waitFor(() => expect(vi.mocked(CryptoService.encrypt)).toHaveBeenCalled())

    const encryptOptions = vi.mocked(CryptoService.encrypt).mock.calls.at(-1)?.[2] as
      | { secretKeyBytes?: Uint8Array }
      | undefined
    expect(encryptOptions?.secretKeyBytes).toBeInstanceOf(Uint8Array)
    expect(encryptOptions?.secretKeyBytes).toHaveLength(32)
  })

  it('after an account switch, opening a required-v1 file re-prompts for the Secret key', async () => {
    // Land on the home with a staged account switch over a required-v1 selected
    // file. Continuing adopts the new account; the subsequent open must show the
    // inline Secret-key field again, as any required-v1 open does on a device
    // with no configured key. (This pins the post-switch open prompt; it does
    // not exercise clearing a *live* session key — no keyed file is opened
    // before the switch.)
    vi.mocked(getEnvelopeSecretKeyMode).mockReturnValue('required-v1')
    dropboxState.getSyncState.mockResolvedValue({
      ...requiredV1Linked,
      pendingAccountSwitch: 'dbid:new',
    })
    dropboxState.getRecentFiles.mockResolvedValue(requiredV1Recents)

    render(<App />)

    await screen.findByText('Different Dropbox account')

    // After Continue the guard clears (no pending switch).
    dropboxState.getSyncState.mockResolvedValue(requiredV1Linked)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() =>
      expect(dropboxState.adoptLinkedAccountDiscardingRecents).toHaveBeenCalledWith('dbid:new'),
    )

    // Opening the file now prompts again: the required-v1 unlock dialog appears
    // with the inline Secret-key field, the expected prompt for a required-v1
    // open on a device that holds no configured key.
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }))
    await screen.findByText('Unlock Dropbox file')

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByLabelText('Secret key')).not.toBeNull()
  })
})

describe('App Dropbox three-button toolbar (Upload / Download / Open from Files)', () => {
  const linkedState = {
    accountLabel: 'dbid:test',
    authLost: false,
    hasPendingLocalEnvelope: false,
    hasRemoteConflictEnvelope: false,
    lastSyncAt: null,
    lastSyncStatus: 'synced',
    linked: true,
    pendingAccountSwitch: null,
    selectedFileId: 'id:notes',
    selectedName: 'notes.txt',
    selectedPathDisplay: '/Notes/notes.txt',
  }

  const unlockConnectedEditor = async () => {
    dropboxState.getSyncState.mockResolvedValue(linkedState)
    dropboxState.getRecentFiles.mockResolvedValue({
      files: [
        {
          key: 'id:notes',
          name: 'notes.txt',
          folderPath: '/Notes',
          syncedModifiedAt: null,
          localModifiedAt: null,
          hasCache: true,
          hasUnsyncedChanges: false,
        },
      ],
      selectedKey: 'id:notes',
    })
    dropboxState.syncNow.mockResolvedValue({ detail: 'Dropbox synced.', state: 'ready' })
    render(<App />)
    // The home has no password form: the selected recent file opens
    // through the block's Open, then the unlock password dialog.
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }))
    await screen.findByText('Unlock Dropbox file')

    const dialog = screen.getByRole('dialog')

    fireEvent.change(within(dialog).getByLabelText('Password'), {
      target: { value: 'correct horse battery staple' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))
    await screen.findByTestId('editor')
  }

  // A LINKED draft session: the promotion's starting point (SPEC §4 — Upload
  // to Dropbox renders only in draft sessions). Linked, so Upload opens the
  // destination step instead of starting OAuth.
  const unlockLinkedDraftEditor = async () => {
    dropboxState.getSyncState.mockResolvedValue(linkedState)
    dropboxState.getRecentFiles.mockResolvedValue({
      files: [
        {
          key: 'id:notes',
          name: 'notes.txt',
          folderPath: '/Notes',
          syncedModifiedAt: null,
          localModifiedAt: null,
          hasCache: true,
          hasUnsyncedChanges: false,
        },
      ],
      selectedKey: 'id:notes',
    })
    dropboxState.syncNow.mockResolvedValue({ detail: 'Dropbox synced.', state: 'ready' })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit draft' }))
    await screen.findByText('Unlock draft')

    const dialog = screen.getByRole('dialog')

    fireEvent.change(within(dialog).getByLabelText('Password'), {
      target: { value: 'correct horse battery staple' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))
    await screen.findByTestId('editor')
  }

  it('Save to Dropbox creates a new file and connects (no overwrite)', async () => {
    await unlockLinkedDraftEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Save to Dropbox' }))
    await chooseDropboxDestination('upload.txt')

    await waitFor(() =>
      expect(dropboxState.createRemoteFile).toHaveBeenCalledWith(
        '/Notes/upload.txt',
        expect.any(String),
      ),
    )
    expect(dropboxState.replaceRemoteFile).not.toHaveBeenCalled()
    expect(await screen.findByText('Uploaded to Dropbox and connected.')).not.toBeNull()
  })

  it('Save to Dropbox connects after upload when old draft cleanup fails', async () => {
    await unlockLinkedDraftEditor()
    dropboxState.clearVault.mockRejectedValueOnce(new Error('cleanup failed'))

    fireEvent.click(screen.getByRole('button', { name: 'Save to Dropbox' }))
    await chooseDropboxDestination('upload.txt')

    expect(
      await screen.findByText(
        'Uploaded to Dropbox and connected, but the old draft could not be cleared.',
      ),
    ).not.toBeNull()
    expect(screen.queryByText('Unable to upload to that Dropbox .txt file.')).toBeNull()
    expect(dropboxState.createRemoteFile).toHaveBeenCalledWith(
      '/Notes/upload.txt',
      expect.any(String),
    )
    expect(dropboxState.clearVault).toHaveBeenCalled()
    expect(dropboxState.vaultEnvelope).toBe('encrypted-dropbox-envelope')
    expect(screen.getByTestId('editor')).not.toBeNull()
  })

  it('Export to Files names the export after the connected Dropbox file', async () => {
    const restoreBlobUrls = mockBlobUrls()
    let clickedDownload = ''
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        clickedDownload = this.download
      })

    try {
      await unlockConnectedEditor()
      fireEvent.click(screen.getByRole('button', { name: 'Export to Files' }))

      await waitFor(() => expect(clickedDownload).toBe('notes.txt'))
    } finally {
      anchorClick.mockRestore()
      restoreBlobUrls()
    }
  })

  it('Save to Dropbox overwrites an existing path only after confirmation', async () => {
    // The add attempt fails because the path exists; only then is overwrite offered.
    dropboxState.createRemoteFile.mockRejectedValueOnce(
      new DropboxProviderError('conflict', 'path exists'),
    )
    dropboxState.statRemoteTxtFile.mockResolvedValueOnce({
      exists: true,
      id: 'id:existing',
      name: 'existing.txt',
      pathDisplay: '/Notes/existing.txt',
      rev: 'rev-probe',
      serverModified: '2026-06-12T09:00:00.000Z',
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    await unlockLinkedDraftEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Save to Dropbox' }))
    await chooseDropboxDestination('existing.txt')

    await waitFor(() =>
      // The confirmed replace consumes the revision the probe returned — the
      // upload is conditional on what the confirmation was shown.
      expect(dropboxState.replaceRemoteFile).toHaveBeenCalledWith(
        '/Notes/existing.txt',
        expect.any(String),
        'rev-probe',
      ),
    )
    expect(confirmSpy).toHaveBeenCalled()
    expect(dropboxState.statRemoteTxtFile).toHaveBeenCalledWith('/Notes/existing.txt')

    confirmSpy.mockRestore()
  })

  it('Save to Dropbox does not overwrite when the user declines the confirmation', async () => {
    dropboxState.createRemoteFile.mockRejectedValueOnce(
      new DropboxProviderError('conflict', 'path exists'),
    )
    dropboxState.statRemoteTxtFile.mockResolvedValueOnce({
      exists: true,
      id: 'id:existing',
      name: 'existing.txt',
      pathDisplay: '/Notes/existing.txt',
      rev: 'rev-probe',
      serverModified: '2026-06-12T09:00:00.000Z',
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    await unlockLinkedDraftEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Save to Dropbox' }))
    await chooseDropboxDestination('existing.txt')

    expect(await screen.findByText('Upload canceled. Dropbox was not changed.')).not.toBeNull()
    expect(dropboxState.replaceRemoteFile).not.toHaveBeenCalled()
    expect(screen.queryByText(/Autosaved/)).toBeNull()

    confirmSpy.mockRestore()
  })

  it('Save to Dropbox re-asks with a fresh revision when the target changes mid-confirmation', async () => {
    dropboxState.createRemoteFile.mockRejectedValueOnce(
      new DropboxProviderError('conflict', 'path exists'),
    )
    // The first confirmed replace hits a 409 — the file moved past rev-probe
    // while the confirmation was open. The app must re-probe and re-confirm,
    // then replace against the fresh revision; never overwrite blindly.
    dropboxState.replaceRemoteFile.mockRejectedValueOnce(
      new DropboxProviderError('conflict', 'revision moved'),
    )
    dropboxState.statRemoteTxtFile
      .mockResolvedValueOnce({
        exists: true,
        id: 'id:existing',
        name: 'existing.txt',
        pathDisplay: '/Notes/existing.txt',
        rev: 'rev-probe',
        serverModified: '2026-06-12T09:00:00.000Z',
      })
      .mockResolvedValueOnce({
        exists: true,
        id: 'id:existing',
        name: 'existing.txt',
        pathDisplay: '/Notes/existing.txt',
        rev: 'rev-fresh',
        serverModified: '2026-06-12T10:00:00.000Z',
      })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    await unlockLinkedDraftEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Save to Dropbox' }))
    await chooseDropboxDestination('existing.txt')

    await waitFor(() =>
      expect(dropboxState.replaceRemoteFile).toHaveBeenLastCalledWith(
        '/Notes/existing.txt',
        expect.any(String),
        'rev-fresh',
      ),
    )
    expect(dropboxState.replaceRemoteFile).toHaveBeenCalledTimes(2)
    expect(confirmSpy).toHaveBeenCalledTimes(2)
    // The re-confirmation must say the file changed — not read as a duplicate.
    expect(String(confirmSpy.mock.calls[1]?.[0])).toContain('changed while you were confirming')

    confirmSpy.mockRestore()
  })

  it('falls back to create when the overwrite target vanished mid-confirmation', async () => {
    // Distinct from the revision-changed case (target *changes*, probe still returns exists:true):
    // here the target *vanishes*. The confirmed replace 409s, the re-probe now
    // reports the file is gone, and the flow must fall back to a plain add
    // (createRemoteFile) — never a blind overwrite, and never a fresh password
    // prompt (the draft password is already in hand).
    dropboxState.createRemoteFile.mockRejectedValueOnce(
      new DropboxProviderError('conflict', 'path exists'),
    )
    // The confirmed replace against rev-probe 409s — the file moved under us.
    dropboxState.replaceRemoteFile.mockRejectedValueOnce(
      new DropboxProviderError('conflict', 'revision moved'),
    )
    dropboxState.statRemoteTxtFile
      .mockResolvedValueOnce({
        exists: true,
        id: 'id:existing',
        name: 'existing.txt',
        pathDisplay: '/Notes/existing.txt',
        rev: 'rev-probe',
        serverModified: '2026-06-12T09:00:00.000Z',
      })
      // The re-probe after the 409 finds the target deleted remotely.
      .mockResolvedValueOnce({ exists: false })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    await unlockLinkedDraftEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Save to Dropbox' }))
    await chooseDropboxDestination('existing.txt')

    await screen.findByText('Uploaded to Dropbox and connected.')

    // The vanish fallback creates the file rather than replacing it. The first
    // createRemoteFile call is the initial add that 409'd; the last is the
    // fallback after the target disappeared.
    expect(dropboxState.createRemoteFile).toHaveBeenLastCalledWith(
      '/Notes/existing.txt',
      expect.any(String),
    )
    // The single confirmed replace 409'd; the flow must NOT replace again
    // against a vanished target.
    expect(dropboxState.replaceRemoteFile).toHaveBeenCalledTimes(1)
    // Only the first overwrite confirmation appeared; the vanish path adds
    // without re-confirming.
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    // No new password dialog opened — the promotion reuses the unlocked
    // draft's password.
    expect(screen.queryByRole('dialog')).toBeNull()

    confirmSpy.mockRestore()
  })

  it('Save to Dropbox while unlinked is inert and points the user to the Home screen', async () => {
    // Default getSyncState is unlinked; the session is a DRAFT session,
    // unlocked through Edit draft (SPEC §10). The editor never starts linking
    // (that redirect would drop the unlocked draft) — linking is Home-only.
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit draft' }))
    await screen.findByText('Unlock draft')

    const unlockDialog = screen.getByRole('dialog')

    fireEvent.change(within(unlockDialog).getByLabelText('Password'), {
      target: { value: 'correct horse battery staple' },
    })
    fireEvent.click(within(unlockDialog).getByRole('button', { name: 'Unlock' }))
    await screen.findByTestId('editor')

    // The control is muted (aria-disabled), not red, while unlinked.
    const upload = screen.getByRole('button', { name: 'Save to Dropbox' })
    expect(upload.getAttribute('aria-disabled')).toBe('true')

    fireEvent.click(upload)

    expect(
      await screen.findByText('Link Dropbox from the Home screen to upload.'),
    ).not.toBeNull()
    expect(dropboxState.beginLink).not.toHaveBeenCalled()
    expect(dropboxState.createRemoteFile).not.toHaveBeenCalled()
    // No destination browser or OAuth dialog opens.
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Import replaces only the draft: no upload, Dropbox untouched', async () => {
    // Importing over an existing draft asks AFTER the file is picked
    // (`Replace the draft?`, SPEC §10).
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<App />)
    await screen.findByRole('button', { name: 'Edit draft' })

    const file = new File(
      ['-----BEGIN ENOTEWEB ENCRYPTED TEXT-----\n{}\n-----END ENOTEWEB ENCRYPTED TEXT-----'],
      'note.txt',
      { type: 'text/plain' },
    )
    const input = document.getElementById('encrypted-file-import') as HTMLInputElement
    fireEvent.change(input, { target: { files: [file] } })

    // SPEC §10 import step 5: the unlock dialog for the imported draft opens
    // directly — no toast-then-Edit-draft detour.
    expect(await screen.findByText('Unlock draft')).not.toBeNull()
    // Import writes via the vault, never the active provider's save() (no
    // upload) — and it never touches Dropbox state at all.
    expect(String(confirmSpy.mock.calls[0]?.[0])).toBe('Replace the draft?')
    expect(dropboxState.save).not.toHaveBeenCalled()
    expect(dropboxState.disconnectRemoteFile).not.toHaveBeenCalled()

    // Cancelling keeps the imported draft locked for a later Edit draft.
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('editor')).toBeNull()

    confirmSpy.mockRestore()
  })

  it('Open from Files cancels cleanly when the replace confirmation is declined', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<App />)
    await screen.findByRole('button', { name: 'Edit draft' })

    const file = new File(
      ['-----BEGIN ENOTEWEB ENCRYPTED TEXT-----\n{}\n-----END ENOTEWEB ENCRYPTED TEXT-----'],
      'note.txt',
      { type: 'text/plain' },
    )
    const input = document.getElementById('encrypted-file-import') as HTMLInputElement
    fireEvent.change(input, { target: { files: [file] } })

    // Declined `Replace the draft?` ⇒ no import and no message (a non-event).
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled())
    expect(String(confirmSpy.mock.calls[0]?.[0])).toBe('Replace the draft?')
    expect(screen.queryByText('Import canceled. Nothing was changed.')).toBeNull()
    expect(screen.queryByTestId('editor')).toBeNull()
    expect(dropboxState.disconnectRemoteFile).not.toHaveBeenCalled()

    confirmSpy.mockRestore()
  })

  it('Open from Files refuses to replace the vault while another window holds it unlocked', async () => {
    // Simulate the cross-tab Web Lock being held by another (unlocked) window:
    // request({ ifAvailable: true }) invokes the callback with a null lock.
    const originalLocks = (navigator as unknown as { locks?: unknown }).locks
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: (_name: string, _options: unknown, callback: (lock: unknown) => unknown) =>
          Promise.resolve(callback(null)),
      },
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    try {
      render(<App />)
      await screen.findByRole('button', { name: 'Edit draft' })

      const file = new File(
        ['-----BEGIN ENOTEWEB ENCRYPTED TEXT-----\n{}\n-----END ENOTEWEB ENCRYPTED TEXT-----'],
        'note.txt',
        { type: 'text/plain' },
      )
      const input = document.getElementById('encrypted-file-import') as HTMLInputElement
      fireEvent.change(input, { target: { files: [file] } })

      expect(
        await screen.findByText(
          'This vault is already open in another window. Close it there and try again.',
        ),
      ).not.toBeNull()
      // Blocked ⇒ the imported envelope is never written and nothing disconnects.
      expect(dropboxState.disconnectRemoteFile).not.toHaveBeenCalled()
    } finally {
      if (originalLocks === undefined) {
        delete (navigator as unknown as { locks?: unknown }).locks
      } else {
        Object.defineProperty(navigator, 'locks', {
          configurable: true,
          value: originalLocks,
        })
      }
      confirmSpy.mockRestore()
    }
  })

  // A Dropbox-file session can "Save to Dropbox" too:
  // upload as a NEW Dropbox file and rebind (not only a draft promotion). The
  // session document kind stays dropbox-file; the draft slot is never touched
  // (no clearVault for a non-draft session).
  it('Save to Dropbox from a Dropbox-file session uploads as a new file and rebinds', async () => {
    await unlockConnectedEditor()

    // Choose a NEW path (different from the bound file): an ordinary add. The
    // browser opens in the selected file's parent folder (/Notes).
    fireEvent.click(screen.getByRole('button', { name: 'Save to Dropbox' }))
    expect((await screen.findByLabelText('File name') as HTMLInputElement).value).toBe(
      'notes.txt',
    )
    await chooseDropboxDestination('copy.txt')

    await waitFor(() =>
      expect(dropboxState.createRemoteFile).toHaveBeenCalledWith(
        '/Notes/copy.txt',
        expect.any(String),
      ),
    )
    expect(dropboxState.replaceRemoteFile).not.toHaveBeenCalled()
    expect(await screen.findByText('Uploaded to Dropbox and connected.')).not.toBeNull()
    // A file-session upload is NOT a draft promotion: the draft slot is intact.
    expect(dropboxState.vaultEnvelope).not.toBeNull()
  })

  // The force-out-of-conflict exception: choosing the current
  // session's OWN Dropbox file (matched by id) while diverged shows the
  // consequence confirmation, then replaces revision-conditionally against the
  // FRESH probe rev — overriding only the stale session base, never the guard.
  it('Save to Dropbox to the session own file force-replaces against the fresh rev after a consequence confirm', async () => {
    // Open a session whose first-sync-gate probe finds it diverged → paused.
    dropboxState.getSyncState.mockResolvedValue({
      ...linkedState,
      hasPendingLocalEnvelope: true,
      lastSyncStatus: 'pending-local',
    })
    dropboxState.getRecentFiles.mockResolvedValue({
      files: [
        {
          key: 'id:notes',
          name: 'notes.txt',
          folderPath: '/Notes',
          syncedModifiedAt: null,
          localModifiedAt: null,
          hasCache: true,
          hasUnsyncedChanges: false,
        },
      ],
      selectedKey: 'id:notes',
    })
    dropboxState.checkRecentFile.mockImplementation(
      async (_key: string, options?: { refreshStaleCache?: boolean }) =>
        options?.refreshStaleCache === false ? { kind: 'diverged' } : { kind: 'up-to-date' },
    )

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }))
    await screen.findByText('Unlock Dropbox file')

    const unlockDialog = screen.getByRole('dialog')
    fireEvent.change(within(unlockDialog).getByLabelText('Password'), {
      target: { value: 'correct horse battery staple' },
    })
    fireEvent.click(within(unlockDialog).getByRole('button', { name: 'Unlock' }))
    await screen.findByTestId('editor')

    // The session is paused/diverged (the Resolve banner is shown).
    await screen.findByText('File changed on Dropbox.')

    // The add attempt 409s (the path exists); the probe returns the SAME id as
    // the bound session file (id:notes) and a fresh rev — the force case.
    dropboxState.createRemoteFile.mockRejectedValueOnce(
      new DropboxProviderError('conflict', 'path exists'),
    )
    dropboxState.statRemoteTxtFile.mockResolvedValueOnce({
      exists: true,
      id: 'id:notes',
      name: 'notes.txt',
      pathDisplay: '/Notes/notes.txt',
      rev: 'rev-fresh',
      serverModified: '2026-06-13T08:00:00.000Z',
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    fireEvent.click(screen.getByRole('button', { name: 'Save to Dropbox' }))
    await chooseDropboxDestination('notes.txt')

    await waitFor(() =>
      // Revision-conditional against the FRESH probe rev — never unconditional.
      expect(dropboxState.replaceRemoteFile).toHaveBeenCalledWith(
        '/Notes/notes.txt',
        expect.any(String),
        'rev-fresh',
      ),
    )
    // The consequence text names the other-device changes, not a plain overwrite.
    expect(String(confirmSpy.mock.calls[0]?.[0])).toContain('changes made on other devices')

    confirmSpy.mockRestore()
  })

  // The "uploading discards the current file's unsynced changes" guard is
  // gone by design: under the per-file model every recent file keeps its own
  // cache and pending state, so uploading to a different path discards nothing.

  // The "importing discards unsynced Dropbox changes" warning is gone by
  // design: importing touches only the draft and never Dropbox state.
})

describe('account-switch guard (SPEC §16)', () => {
  // The guard dialog renders from the persisted pendingAccountSwitch state; the
  // mismatch returned by completeLinkFromRedirect is what makes getSyncState
  // report it. No existing test drives a non-null pendingAccountSwitch.
  const mismatchSyncState = (
    pendingAccountSwitch: string | null,
    pendingAccountSwitchLabel: string | null = null,
    accountLabel = 'old-user@example.com',
    linked = false,
  ) => ({
    accountLabel,
    authLost: false,
    hasPendingLocalEnvelope: false,
    hasRemoteConflictEnvelope: false,
    hasRetainedAuth: false,
    lastSyncAt: null,
    lastSyncStatus: 'synced',
    linked,
    pendingAccountSwitch,
    pendingAccountSwitchLabel,
    selectedFileId: null as string | null,
    selectedName: null as string | null,
    selectedPathDisplay: null as string | null,
  })

  const previousRecents = {
    files: [
      {
        key: 'id:old',
        name: 'previous-account.txt',
        folderPath: '/Old',
        syncedModifiedAt: null,
        localModifiedAt: null,
        hasCache: true,
        hasUnsyncedChanges: false,
      },
    ],
    selectedKey: null,
  }

  it('mismatch then Continue discards the previous account recents', async () => {
    dropboxState.completeLinkFromRedirect.mockResolvedValue({
      accountMismatch: { newAccountId: 'dbid:B', previousAccountId: 'dbid:A' },
      unverifiedOwnership: false,
    })
    dropboxState.getSyncState.mockResolvedValue(
      mismatchSyncState('dbid:B', 'new-user@example.com'),
    )
    dropboxState.getRecentFiles.mockResolvedValue(previousRecents)

    render(<App />)

    // The guard dialog appears with the SPEC §16 message and names cached
    // file loss only because this fixture actually has cached bytes.
    expect(
      await screen.findByText(/This is a different Dropbox account\./),
    ).not.toBeNull()
    expect(screen.getByText(/Continue with new-user@example\.com\?/)).not.toBeNull()
    expect(screen.getByText(/Cached files from the previous account will be lost\./)).not.toBeNull()

    // Continuing adopts the new account and discards the prior recents. After
    // resolution the dialog dismisses (no pending switch) and the table is empty.
    dropboxState.getSyncState.mockResolvedValue(mismatchSyncState(null, null, 'new-user@example.com', true))
    dropboxState.getRecentFiles.mockResolvedValue({ files: [], selectedKey: null })

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() =>
      expect(dropboxState.adoptLinkedAccountDiscardingRecents).toHaveBeenCalledWith('dbid:B'),
    )
    // Observable consequence, not just the provider call: the table now shows
    // the empty state.
    expect(await screen.findByText('No recent files yet.')).not.toBeNull()
    expect(
      screen.queryByText(/This is a different Dropbox account\./),
    ).toBeNull()
  })

  it('mismatch guard omits the cached-loss sentence when no cached bytes exist', async () => {
    dropboxState.getSyncState.mockResolvedValue(
      mismatchSyncState('dbid:B', 'new-user@example.com'),
    )
    dropboxState.getRecentFiles.mockResolvedValue({
      files: [
        {
          key: 'id:old',
          name: 'previous-account.txt',
          folderPath: '/Old',
          syncedModifiedAt: null,
          localModifiedAt: null,
          hasCache: false,
          hasUnsyncedChanges: false,
        },
      ],
      selectedKey: null,
    })

    render(<App />)

    expect(await screen.findByText(/This is a different Dropbox account\./)).not.toBeNull()
    expect(screen.getByText(/Continue with new-user@example\.com\?/)).not.toBeNull()
    expect(
      screen.queryByText(/Cached files from the previous account will be lost\./),
    ).toBeNull()
  })

  it('mismatch then Cancel keeps the previous account recents', async () => {
    dropboxState.completeLinkFromRedirect.mockResolvedValue({
      accountMismatch: { newAccountId: 'dbid:B', previousAccountId: 'dbid:A' },
      unverifiedOwnership: false,
    })
    dropboxState.getSyncState.mockResolvedValue(
      mismatchSyncState('dbid:B', 'new-user@example.com'),
    )
    dropboxState.getRecentFiles.mockResolvedValue(previousRecents)

    render(<App />)

    expect(
      await screen.findByText(/This is a different Dropbox account\./),
    ).not.toBeNull()

    // Cancelling unlinks again but keeps the previous account's data. The
    // dialog dismisses (no pending switch); the recents stay visible and the
    // cached selected row can open read-only.
    dropboxState.getSyncState.mockResolvedValue(
      mismatchSyncState(null, null, 'old-user@example.com', false),
    )
    // getRecentFiles unchanged: the prior recents are kept.

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(dropboxState.declineLinkedAccount).toHaveBeenCalled())
    // The discard path must NOT have run.
    expect(dropboxState.adoptLinkedAccountDiscardingRecents).not.toHaveBeenCalled()
    expect(
      screen.queryByText(/This is a different Dropbox account\./),
    ).toBeNull()

    expect(await screen.findByText(/previous-account\.txt/)).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Link' }))

    await waitFor(() => expect(dropboxState.beginLink).toHaveBeenLastCalledWith({}))
  })
})
