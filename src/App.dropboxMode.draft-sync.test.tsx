import { chooseDropboxDestination, getDropboxState } from './App.dropboxMode.testkit'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { CryptoService } from './crypto/cryptoService'

const dropboxState = getDropboxState()

describe('App draft actions', () => {
  // The linked create-vault path and the home Create file flow are gone:
  // creation is `New draft` (local-only), and the overwrite guard lives in
  // the promotion (covered by the Upload re-ask test above).

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('New draft: two-field dialog, empty local draft, editor — no destination step', async () => {
    dropboxState.vaultEnvelope = null
    dropboxState.load.mockResolvedValue(null)

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'New draft' }))

    await screen.findByText('Set a password for the new draft')

    const dialog = screen.getByRole('dialog')

    fireEvent.change(within(dialog).getByLabelText('Password'), {
      target: { value: 'draft password' },
    })
    fireEvent.change(within(dialog).getByLabelText('Confirm password'), {
      target: { value: 'draft password' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    await screen.findByTestId('editor')
    expect(vi.mocked(CryptoService.encrypt)).toHaveBeenCalledWith('', 'draft password')
    // Local by design (SPEC §10): nothing reaches Dropbox at creation.
    expect(dropboxState.createRemoteFile).not.toHaveBeenCalled()
    expect(dropboxState.replaceRemoteFile).not.toHaveBeenCalled()
  })

  it('a create-password mismatch blocks; Cancel creates nothing', async () => {
    dropboxState.vaultEnvelope = null
    dropboxState.load.mockResolvedValue(null)

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'New draft' }))

    await screen.findByText('Set a password for the new draft')

    const dialog = screen.getByRole('dialog')

    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'one' } })
    fireEvent.change(within(dialog).getByLabelText('Confirm password'), {
      target: { value: 'two' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    expect(await within(dialog).findByText('Passwords do not match.')).not.toBeNull()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('Set a password for the new draft')).toBeNull()
    expect(screen.queryByTestId('editor')).toBeNull()
  })

  it('with a draft: Edit draft label; Delete draft confirms and deletes', async () => {
    render(<App />)

    expect(await screen.findByRole('button', { name: 'Edit draft' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'New draft' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Delete draft' }))
    await screen.findByText('Delete the draft?')
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'OK' }))

    expect(await screen.findByText('Draft deleted.')).not.toBeNull()
  })

  it('without a draft, Delete draft, Export, and Dropbox are disabled; Import stays enabled', async () => {
    dropboxState.vaultEnvelope = null
    dropboxState.load.mockResolvedValue(null)

    render(<App />)

    await screen.findByRole('button', { name: 'New draft' })
    expect(screen.getByRole('button', { name: 'Delete draft' }).hasAttribute('disabled')).toBe(
      true,
    )
    expect(screen.getByRole('button', { name: 'Export draft' }).hasAttribute('disabled')).toBe(
      true,
    )
    expect(screen.getByRole('button', { name: 'Import draft' }).hasAttribute('disabled')).toBe(
      false,
    )
    expect(screen.getByRole('button', { name: 'Dropbox' }).hasAttribute('disabled')).toBe(true)
  })

  it('home Dropbox promotion uploads the locked draft envelope verbatim and clears after success', async () => {
    dropboxState.vaultEnvelope = 'stored-dropbox-draft-envelope'
    dropboxState.getSyncState.mockResolvedValue({
      accountLabel: 'dbid:test',
      authLost: false,
      hasPendingLocalEnvelope: false,
      hasRemoteConflictEnvelope: false,
      lastSyncAt: null,
      lastSyncStatus: 'synced',
      linked: true,
      pendingAccountSwitch: null,
      selectedFileId: null,
      selectedName: null,
      selectedPathDisplay: null,
    })
    vi.mocked(CryptoService.encrypt).mockClear()

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Dropbox' }))
    await chooseDropboxDestination('home-draft.txt')

    await waitFor(() =>
      expect(dropboxState.createRemoteFile).toHaveBeenCalledWith(
        '/home-draft.txt',
        'stored-dropbox-draft-envelope',
      ),
    )
    expect(vi.mocked(CryptoService.encrypt)).not.toHaveBeenCalled()
    expect(dropboxState.clearVault).toHaveBeenCalled()
    expect(dropboxState.createRemoteFile.mock.invocationCallOrder[0]!).toBeLessThan(
      dropboxState.clearVault.mock.invocationCallOrder[0]!,
    )
    expect(dropboxState.vaultEnvelope).toBeNull()
    expect(await screen.findByText('Draft uploaded to Dropbox.')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'New draft' })).not.toBeNull()
  })

  it('home Dropbox promotion preserves the draft when upload fails', async () => {
    dropboxState.vaultEnvelope = 'stored-dropbox-draft-envelope'
    dropboxState.getSyncState.mockResolvedValue({
      accountLabel: 'dbid:test',
      authLost: false,
      hasPendingLocalEnvelope: false,
      hasRemoteConflictEnvelope: false,
      lastSyncAt: null,
      lastSyncStatus: 'synced',
      linked: true,
      pendingAccountSwitch: null,
      selectedFileId: null,
      selectedName: null,
      selectedPathDisplay: null,
    })
    dropboxState.createRemoteFile.mockRejectedValueOnce(new Error('upload failed'))

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Dropbox' }))
    await chooseDropboxDestination('home-draft.txt')

    expect(await screen.findByText('Unable to upload that draft to Dropbox.')).not.toBeNull()
    expect(dropboxState.createRemoteFile).toHaveBeenCalledWith(
      '/home-draft.txt',
      'stored-dropbox-draft-envelope',
    )
    expect(dropboxState.clearVault).not.toHaveBeenCalled()
    expect(dropboxState.vaultEnvelope).toBe('stored-dropbox-draft-envelope')
    expect(screen.getByRole('button', { name: 'Edit draft' })).not.toBeNull()
  })

  it('home Dropbox promotion reports cleanup failure separately after upload succeeds', async () => {
    dropboxState.vaultEnvelope = 'stored-dropbox-draft-envelope'
    dropboxState.getSyncState.mockResolvedValue({
      accountLabel: 'dbid:test',
      authLost: false,
      hasPendingLocalEnvelope: false,
      hasRemoteConflictEnvelope: false,
      lastSyncAt: null,
      lastSyncStatus: 'synced',
      linked: true,
      pendingAccountSwitch: null,
      selectedFileId: null,
      selectedName: null,
      selectedPathDisplay: null,
    })
    dropboxState.clearVault.mockRejectedValueOnce(new Error('cleanup failed'))

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Dropbox' }))
    await chooseDropboxDestination('home-draft.txt')

    expect(
      await screen.findByText(
        'Draft uploaded to Dropbox, but the old draft could not be cleared.',
      ),
    ).not.toBeNull()
    expect(screen.queryByText('Unable to upload that draft to Dropbox.')).toBeNull()
    expect(dropboxState.createRemoteFile).toHaveBeenCalledWith(
      '/home-draft.txt',
      'stored-dropbox-draft-envelope',
    )
    expect(dropboxState.clearVault).toHaveBeenCalled()
    expect(dropboxState.vaultEnvelope).toBe('stored-dropbox-draft-envelope')
    expect(screen.getByRole('button', { name: 'Edit draft' })).not.toBeNull()
  })

  it('home Dropbox promotion is muted and inert while Dropbox is unlinked', async () => {
    render(<App />)

    const promote = await screen.findByRole('button', { name: 'Dropbox' })

    expect(promote.hasAttribute('disabled')).toBe(false)
    expect(promote.getAttribute('aria-disabled')).toBe('true')
    expect(promote.className).toContain('is-muted')

    fireEvent.click(promote)

    expect(await screen.findByText('Link Dropbox first.')).not.toBeNull()
    expect(dropboxState.createRemoteFile).not.toHaveBeenCalled()
    expect(screen.queryByText('File name')).toBeNull()
  })

  it('promotion: Upload from a draft session empties the draft slot', async () => {
    render(<App />)

    // Unlock the DRAFT session.
    fireEvent.click(await screen.findByRole('button', { name: 'Edit draft' }))
    await screen.findByText('Unlock draft')

    const dialog = screen.getByRole('dialog')

    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))
    await screen.findByTestId('editor')

    // Linked, so the promotion proceeds straight to the destination browser.
    dropboxState.getSyncState.mockResolvedValue({
      accountLabel: 'dbid:test',
      authLost: false,
      hasPendingLocalEnvelope: false,
      hasRemoteConflictEnvelope: false,
      lastSyncAt: null,
      lastSyncStatus: 'synced',
      linked: true,
      pendingAccountSwitch: null,
      selectedFileId: null,
      selectedName: null,
      selectedPathDisplay: null,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Save to Dropbox' }))
    await chooseDropboxDestination('draft.txt')

    await screen.findByText('Uploaded to Dropbox and connected.')
    expect(dropboxState.createRemoteFile).toHaveBeenCalledWith(
      '/draft.txt',
      expect.any(String),
    )
    // The draft slot emptied (SPEC §4/§10): the document now lives as the
    // cached Dropbox file.
    expect(dropboxState.vaultEnvelope).toBeNull()
  })

  it('promotes a draft to a recent file at the top of the list, selected', async () => {
    render(<App />)

    // Unlock the DRAFT session — the toolbar reads "Draft" while it is a draft.
    fireEvent.click(await screen.findByRole('button', { name: 'Edit draft' }))
    await screen.findByText('Unlock draft')

    const dialog = screen.getByRole('dialog')

    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))
    await screen.findByTestId('editor')
    expect(await screen.findByText('Draft', { selector: '.toolbar-file-name' })).not.toBeNull()

    // Linked + free destination: the add succeeds (default createRemoteFile),
    // no overwrite. Post-promotion the provider reports the new file selected
    // at the top of the recents and as the current Dropbox-file session.
    dropboxState.getSyncState.mockResolvedValue({
      accountLabel: 'dbid:test',
      authLost: false,
      hasPendingLocalEnvelope: false,
      hasRemoteConflictEnvelope: false,
      lastSyncAt: null,
      lastSyncStatus: 'synced',
      linked: true,
      pendingAccountSwitch: null,
      selectedFileId: 'id:promoted',
      selectedName: 'draft.txt',
      selectedPathDisplay: '/promoted/draft.txt',
    })
    dropboxState.getRecentFiles.mockResolvedValue({
      files: [
        {
          key: 'id:promoted',
          name: 'draft.txt',
          folderPath: '/promoted',
          syncedModifiedAt: null,
          localModifiedAt: null,
          hasCache: true,
          hasUnsyncedChanges: false,
        },
      ],
      selectedKey: 'id:promoted',
    })

    fireEvent.click(screen.getByRole('button', { name: 'Save to Dropbox' }))
    await chooseDropboxDestination('draft.txt')

    await screen.findByText('Uploaded to Dropbox and connected.')
    // A free destination: the add succeeds outright, so the overwrite probe and
    // the replace path never run.
    expect(dropboxState.createRemoteFile).toHaveBeenCalledWith(
      '/promoted/draft.txt',
      expect.any(String),
    )
    expect(dropboxState.replaceRemoteFile).not.toHaveBeenCalled()
    expect(dropboxState.statRemoteTxtFile).not.toHaveBeenCalled()

    // The draft slot emptied — beyond what :1164 proves, the session does NOT
    // re-lock: the editor stays mounted and the toolbar flips from "Draft" to
    // the promoted file's name (the Dropbox-file session that now owns it).
    expect(dropboxState.vaultEnvelope).toBeNull()
    expect(screen.getByTestId('editor')).not.toBeNull()
    expect(
      await screen.findByText('draft.txt', { selector: '.toolbar-file-name' }),
    ).not.toBeNull()
    expect(screen.queryByText('Draft', { selector: '.toolbar-file-name' })).toBeNull()

    // The promotion reused the unlocked draft's password — no new-password or
    // re-unlock dialog appeared at any point.
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('Unlock draft')).toBeNull()

    // "At the top of the list, selected" is the provider's post-promotion
    // contract (SPEC §4): the App refreshed the recents and the selected key is
    // the promoted file at index 0. The home table itself renders only on the
    // home screen — which this same test proves we did NOT return to (no
    // re-lock) — so the selection is asserted on the refreshed recents data.
    const lastRecents =
      await dropboxState.getRecentFiles.mock.results.at(-1)?.value
    expect(lastRecents?.selectedKey).toBe('id:promoted')
    expect(lastRecents?.files[0]?.key).toBe('id:promoted')
  })
})

describe('App Dropbox home-screen auto-sync', () => {
  beforeEach(() => {
    dropboxState.getSyncState.mockResolvedValue({
      authLost: false,
      pendingAccountSwitch: null,
      accountLabel: 'dbid:test',
      hasPendingLocalEnvelope: true,
      hasRemoteConflictEnvelope: false,
      hasRetainedAuth: false,
      lastSyncAt: null,
      lastSyncStatus: 'pending-local',
      linked: true,
      selectedFileId: 'id:notes',
      selectedName: 'notes.txt',
      selectedPathDisplay: '/Notes/notes.txt',
    })
  })

  it('auto-syncs when the Dropbox home/locked screen is shown', async () => {
    render(<App />)

    await waitFor(() => expect(dropboxState.syncNow).toHaveBeenCalled())
    // Home context, no open session: a stale-but-clean selected file is
    // refreshed by adopting the remote — never turned into a conflict the
    // background check would read as diverged.
    expect(dropboxState.syncNow).toHaveBeenCalledWith({ adoptCleanRemote: true })
  })

  it('does not auto-sync when Dropbox is not linked', async () => {
    dropboxState.getSyncState.mockResolvedValue({
      authLost: false,
      pendingAccountSwitch: null,
      accountLabel: 'dbid:test',
      hasPendingLocalEnvelope: false,
      hasRemoteConflictEnvelope: false,
      lastSyncAt: null,
      lastSyncStatus: 'never',
      linked: false,
      selectedFileId: 'id:notes',
      selectedName: 'notes.txt',
      selectedPathDisplay: '/Notes/notes.txt',
    })
    render(<App />)

    // Wait for the load to settle (the unlinked state shows "Link Dropbox"),
    // by which point the auto-sync effect has had its chance to run.
    await screen.findByRole('button', { name: 'Link' })
    expect(dropboxState.syncNow).not.toHaveBeenCalled()
  })
})

// The home password form and its submit-label states are gone: the
// block's Open and the Edit draft dialog replaced them (SPEC §10).
