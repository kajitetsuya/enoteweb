import { getDropboxState } from './App.dropboxMode.testkit'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { CryptoService } from './crypto/cryptoService'
import { mockBlobUrls } from './test/appHarness'

const dropboxState = getDropboxState()

describe('App home Dropbox block', () => {
  const linkedBlockSync = {
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

  const sampleRecents = () => ({
    files: [
      {
        key: 'id:notes',
        name: 'notes.txt',
        folderPath: '/Notes',
        syncedModifiedAt: '2026-06-12T09:00:00.000Z',
        localModifiedAt: '2026-06-12T09:00:00.000Z',
        hasCache: true,
        hasUnsyncedChanges: false,
      },
      {
        key: 'id:ideas',
        name: 'ideas.txt',
        folderPath: '/',
        syncedModifiedAt: null,
        localModifiedAt: null,
        hasCache: false,
        hasUnsyncedChanges: true,
      },
    ],
    selectedKey: 'id:notes',
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('linked: recents table with Browse/Open and the corner Sync; Unlink in Settings', async () => {
    dropboxState.getSyncState.mockResolvedValue({
      ...linkedBlockSync,
      accountLabel: 'user@example.com',
    })
    dropboxState.getRecentFiles.mockResolvedValue(sampleRecents())

    render(<App />)

    // The block corner now holds Sync (Unlink moved into Home Settings).
    expect(await screen.findByRole('button', { name: 'Sync' })).not.toBeNull()
    expect(await screen.findByText('notes.txt', { selector: 'td' })).not.toBeNull()
    expect(screen.getByText('/Notes')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Browse' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Open' }).hasAttribute('disabled')).toBe(false)
    // Creation happens only by promoting a draft.
    expect(screen.queryByRole('button', { name: 'Create file' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Choose file' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Relink Dropbox' })).toBeNull()
    // Unlink lives in Home Settings now, with the account email above it.
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    const unlink = await screen.findByRole('button', { name: 'Unlink Dropbox' })
    expect(unlink).not.toBeNull()
    expect(screen.getByText('user@example.com')).not.toBeNull()
  })

  it('Settings shows Link without the remembered email after Dropbox is unlinked with retained auth', async () => {
    dropboxState.getSyncState.mockResolvedValue({
      ...linkedBlockSync,
      accountLabel: 'remembered@example.com',
      authLost: false,
      hasRetainedAuth: true,
      linked: false,
    })
    dropboxState.getRecentFiles.mockResolvedValue(sampleRecents())

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))

    const dialog = screen.getByRole('dialog', { name: 'Settings' })
    const linkButton = within(dialog).getByRole('button', { name: 'Link' })
    expect(linkButton).not.toBeNull()
    expect(within(dialog).queryByText('remembered@example.com')).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Unlink Dropbox' })).toBeNull()

    const advancedSummary = screen.getByText('Advanced Settings').closest('summary')
    expect(advancedSummary).not.toBeNull()
    expect(
      linkButton.compareDocumentPosition(advancedSummary!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    fireEvent.click(linkButton)

    expect(await screen.findByText('Continue with this account?')).not.toBeNull()
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull()
    expect(dropboxState.beginLink).not.toHaveBeenCalled()
  })

  it('Settings shows Link for remembered ownership after token material is cleared', async () => {
    dropboxState.getSyncState.mockResolvedValue({
      ...linkedBlockSync,
      accountLabel: 'remembered@example.com',
      authLost: false,
      hasRetainedAuth: false,
      linked: false,
    })
    dropboxState.getRecentFiles.mockResolvedValue(sampleRecents())

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))

    const dialog = screen.getByRole('dialog', { name: 'Settings' })
    const linkButton = within(dialog).getByRole('button', { name: 'Link' })
    expect(within(dialog).queryByText('remembered@example.com')).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Unlink Dropbox' })).toBeNull()

    fireEvent.click(linkButton)

    await waitFor(() => expect(dropboxState.beginLink).toHaveBeenCalledWith({}))
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull()
  })

  it('manual Sync says Up to date when every recent file is already current', async () => {
    dropboxState.getSyncState.mockResolvedValue(linkedBlockSync)
    dropboxState.getRecentFiles.mockResolvedValue(sampleRecents())

    render(<App />)

    await waitFor(() => expect(dropboxState.checkRecentFile).toHaveBeenCalledWith('id:ideas'))
    dropboxState.checkRecentFile.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Sync' }))

    expect(await screen.findByText('Up to date.')).not.toBeNull()
  })

  it('manual Sync clears a stale conflict indicator and reports Sync complete', async () => {
    dropboxState.getSyncState.mockResolvedValue(linkedBlockSync)
    dropboxState.getRecentFiles.mockResolvedValue(sampleRecents())
    dropboxState.checkRecentFile.mockImplementation(async (key: string) =>
      key === 'id:notes' ? { kind: 'diverged' } : { kind: 'up-to-date' },
    )

    render(<App />)

    expect(await screen.findByRole('button', { name: 'Resolve' })).not.toBeNull()

    dropboxState.checkRecentFile.mockImplementation(async () => ({ kind: 'up-to-date' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sync' }))

    expect(await screen.findByText('Sync complete.')).not.toBeNull()
    expect(await screen.findByRole('button', { name: 'Open' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Resolve' })).toBeNull()
  })

  it('Open: openRecentFile, then the unlock password dialog, then the editor', async () => {
    dropboxState.getSyncState.mockResolvedValue(linkedBlockSync)
    dropboxState.getRecentFiles.mockResolvedValue(sampleRecents())

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }))

    await waitFor(() => expect(dropboxState.openRecentFile).toHaveBeenCalledWith('id:notes'))

    await screen.findByText('Unlock Dropbox file')
    const dialog = screen.getByRole('dialog')

    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))

    expect(await screen.findByTestId('editor')).toHaveProperty('value', 'opened dropbox text')
  })

  it('Delete from list uses the strong warning for an unsynced cache and removes the record', async () => {
    dropboxState.getSyncState.mockResolvedValue(linkedBlockSync)
    dropboxState.getRecentFiles.mockResolvedValue(sampleRecents())
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<App />)
    // The unsynced row carries a leading `•` and is bold-wrapped in a span, so
    // match by substring without the `td` selector (the td's direct text is
    // empty when the name lives in a child span).
    fireEvent.contextMenu(await screen.findByText(/ideas\.txt/))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete from list' }))

    await waitFor(() => expect(dropboxState.removeRecentFile).toHaveBeenCalledWith('id:ideas'))
    expect(String(confirmSpy.mock.calls[0]?.[0])).toContain('Remove anyway?')
  })

  // Unlink now lives in Home Settings. It asks via an in-app modal only when
  // unsynced cached changes need naming.
  const openHomeUnlinkConfirm = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Unlink Dropbox' }))
    return screen.findByRole('alertdialog')
  }

  it('Unlink confirmation names the unsynced-cache caveat; Cancel aborts', async () => {
    dropboxState.getSyncState.mockResolvedValue(linkedBlockSync)
    dropboxState.getRecentFiles.mockResolvedValue(sampleRecents())

    render(<App />)
    const dialog = await openHomeUnlinkConfirm()

    expect(within(dialog).getByText(/will not sync until Dropbox is linked again/)).not.toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(dropboxState.unlink).not.toHaveBeenCalled()
  })

  it('Unlink proceeds without a warning when every cache is synced', async () => {
    dropboxState.getSyncState.mockResolvedValue(linkedBlockSync)
    dropboxState.getRecentFiles.mockResolvedValue({
      files: sampleRecents().files.map((file) => ({ ...file, hasUnsyncedChanges: false })),
      selectedKey: 'id:notes',
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Unlink Dropbox' }))

    await waitFor(() => expect(dropboxState.unlink).toHaveBeenCalled())
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('surfaces a failed unlink (unlink rejects) without crashing', async () => {
    dropboxState.getSyncState.mockResolvedValue(linkedBlockSync)
    dropboxState.getRecentFiles.mockResolvedValue(sampleRecents())
    dropboxState.unlink.mockRejectedValueOnce(new Error('boom'))

    render(<App />)
    const dialog = await openHomeUnlinkConfirm()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlink' }))

    expect(await screen.findByText('Could not unlink Dropbox. Try again.')).not.toBeNull()
    // The app stays mounted: re-opening Settings still offers Unlink.
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(await screen.findByRole('button', { name: 'Unlink Dropbox' })).not.toBeNull()
  })

  it('does not report an unlink failure when unlink succeeds but a refresh rejects', async () => {
    dropboxState.getSyncState.mockResolvedValue(linkedBlockSync)
    dropboxState.getRecentFiles.mockResolvedValue(sampleRecents())

    render(<App />)
    // Open the confirmation (the launch getRecentFiles has settled), then queue
    // the rejection so it lands on the post-unlink refresh, not the initial load.
    const dialog = await openHomeUnlinkConfirm()
    dropboxState.getRecentFiles.mockRejectedValueOnce(new Error('boom'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlink' }))

    await waitFor(() => expect(dropboxState.unlink).toHaveBeenCalled())
    // The success message still shows...
    expect(
      await screen.findByText('Dropbox unlinked.'),
    ).not.toBeNull()
    // ...and the "could not unlink" error never appears.
    expect(screen.queryByText('Could not unlink Dropbox. Try again.')).toBeNull()
  })

  it('authorization lost: Relink, disabled Browse, and Open becomes Export', async () => {
    dropboxState.getSyncState.mockResolvedValue({
      ...linkedBlockSync,
      authLost: true,
      linked: false,
    })
    dropboxState.getRecentFiles.mockResolvedValue(sampleRecents())
    // Draft export is a distinct "Export draft" action; the block's per-row
    // Export remains the enabled recovery action.
    dropboxState.vaultEnvelope = null
    dropboxState.load.mockResolvedValue(null)
    const restoreBlobUrls = mockBlobUrls()

    render(<App />)

    expect(await screen.findByRole('button', { name: 'Relink' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Browse' }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()

    const exportButton = screen
      .getAllByRole('button', { name: 'Export' })
      .find((button) => !button.hasAttribute('disabled'))

    expect(exportButton).toBeDefined()
    fireEvent.click(exportButton as HTMLElement)
    await waitFor(() =>
      expect(dropboxState.exportRecentFileCopy).toHaveBeenCalledWith('id:notes'),
    )

    restoreBlobUrls()
  })

  it('unlinked: cached recents stay visible and open read-only', async () => {
    dropboxState.getRecentFiles.mockResolvedValue(sampleRecents())

    render(<App />)

    expect(await screen.findByRole('button', { name: 'Link' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Browse' }).hasAttribute('disabled')).toBe(true)
    expect(await screen.findByText(/notes\.txt/)).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Open' }))

    await waitFor(() => expect(dropboxState.openRecentFile).toHaveBeenCalledWith('id:notes'))
    await screen.findByText('Unlock Dropbox file')

    const dialog = screen.getByRole('dialog')

    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))

    expect(await screen.findByTestId('editor')).toHaveProperty('value', 'opened dropbox text')
    expect(screen.getByRole('button', { name: 'Read-only' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Change password' }).hasAttribute('disabled')).toBe(
      true,
    )
    expect(dropboxState.checkRecentFile).not.toHaveBeenCalledWith('id:notes', {
      refreshStaleCache: false,
    })
    // SPEC §9: an unlinked cached file is read-only — opening it must write
    // nothing back (browser storage is not a second vault).
    await Promise.resolve()
    expect(dropboxState.save).not.toHaveBeenCalled()
    expect(dropboxState.saveLocalOnly).not.toHaveBeenCalled()
  })

  it('the account-switch guard offers Continue, resolving through the provider', async () => {
    dropboxState.getSyncState.mockResolvedValue({
      ...linkedBlockSync,
      pendingAccountSwitch: 'dbid:new',
    })

    render(<App />)

    await screen.findByText('Different Dropbox account')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() =>
      expect(dropboxState.adoptLinkedAccountDiscardingRecents).toHaveBeenCalledWith('dbid:new'),
    )
  })

  it('the account-switch guard Cancel declines, keeping the previous account data', async () => {
    dropboxState.getSyncState.mockResolvedValue({
      ...linkedBlockSync,
      pendingAccountSwitch: 'dbid:new',
    })

    render(<App />)

    await screen.findByText('Different Dropbox account')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(dropboxState.declineLinkedAccount).toHaveBeenCalled())
  })

  it('auth-lost: Edit draft unlocks the DRAFT, never the cached Dropbox file', async () => {
    // SPEC §9: cached files cannot be opened for editing while authorization
    // is lost. The draft remains editable through Edit draft, which decrypts
    // the vault bytes and fixes the session's document identity.
    dropboxState.getSyncState.mockResolvedValue({
      ...linkedBlockSync,
      authLost: true,
      linked: false,
    })
    dropboxState.getRecentFiles.mockResolvedValue(sampleRecents())
    dropboxState.vaultEnvelope = 'encrypted-draft-envelope'
    vi.mocked(CryptoService.decrypt).mockClear()

    render(<App />)
    await screen.findByRole('button', { name: 'Relink' })

    fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }))
    await screen.findByText('Unlock draft')

    const dialog = screen.getByRole('dialog')

    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))

    expect(await screen.findByTestId('editor')).toHaveProperty('value', 'opened dropbox text')

    const decrypted = vi.mocked(CryptoService.decrypt).mock.calls.map((call) => call[0])

    expect(decrypted).toContain('encrypted-draft-envelope')
    expect(decrypted).not.toContain('encrypted-dropbox-envelope')
  })
})

describe('App home background check + first-sync gate', () => {
  const linkedCheckSync = {
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

  const checkRecents = () => ({
    files: [
      {
        key: 'id:notes',
        name: 'notes.txt',
        folderPath: '/Notes',
        syncedModifiedAt: '2026-06-12T09:00:00.000Z',
        localModifiedAt: '2026-06-12T09:00:00.000Z',
        hasCache: true,
        hasUnsyncedChanges: false,
      },
      {
        key: 'id:ideas',
        name: 'ideas.txt',
        folderPath: '/',
        syncedModifiedAt: null,
        localModifiedAt: null,
        hasCache: true,
        hasUnsyncedChanges: false,
      },
    ],
    selectedKey: 'id:notes',
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('runs the check over every recent row and leaves clean rows unmarked', async () => {
    dropboxState.getSyncState.mockResolvedValue(linkedCheckSync)
    dropboxState.getRecentFiles.mockResolvedValue(checkRecents())

    render(<App />)

    await waitFor(() => expect(dropboxState.checkRecentFile).toHaveBeenCalledWith('id:notes'))
    await waitFor(() => expect(dropboxState.checkRecentFile).toHaveBeenCalledWith('id:ideas'))

    // All outcomes are up-to-date: no indicator classes, normal labels.
    const row = (await screen.findByText('notes.txt', { selector: 'td' })).closest('tr')

    expect(row?.className ?? '').not.toContain('is-diverged')
    expect(screen.getByRole('button', { name: 'Open' })).not.toBeNull()
  })

  it('background check reports Sync complete when a recent row changes', async () => {
    dropboxState.getSyncState.mockResolvedValue(linkedCheckSync)
    dropboxState.getRecentFiles.mockResolvedValue(checkRecents())
    dropboxState.checkRecentFile.mockImplementation(async (key: string) =>
      key === 'id:ideas' ? { kind: 'refreshed' } : { kind: 'up-to-date' },
    )

    render(<App />)

    expect(await screen.findByText('Sync complete.')).not.toBeNull()
  })

  it('marks a diverged row red with the • prefix; the selected action reads Resolve', async () => {
    dropboxState.getSyncState.mockResolvedValue(linkedCheckSync)
    dropboxState.getRecentFiles.mockResolvedValue(checkRecents())
    dropboxState.checkRecentFile.mockImplementation(async (key: string) =>
      key === 'id:notes' ? { kind: 'diverged' } : { kind: 'up-to-date' },
    )

    render(<App />)

    // The dot is attached with no space and lives in a bold span inside the td.
    const marked = await screen.findByText('•notes.txt')

    expect(marked.closest('tr')?.className).toContain('is-diverged')
    expect(await screen.findByRole('button', { name: 'Resolve' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
    // The other row is untouched.
    expect(screen.getByText('ideas.txt', { selector: 'td' }).closest('tr')?.className ?? '')
      .not.toContain('is-diverged')
  })

  it('marks a replacement candidate like a conflict and opens the cached copy read-only when adoption is declined', async () => {
    dropboxState.getSyncState.mockResolvedValue(linkedCheckSync)
    dropboxState.getRecentFiles.mockResolvedValue(checkRecents())
    dropboxState.checkRecentFile.mockImplementation(async (key: string) =>
      key === 'id:notes' ? { kind: 'replacement-candidate' } : { kind: 'up-to-date' },
    )
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<App />)

    await waitFor(() =>
      expect(screen.getByText(/notes\.txt/).closest('tr')?.className).toContain(
        'is-replacement-candidate',
      ),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Resolve' }))

    expect(confirmSpy).toHaveBeenCalledWith(
      'A different file exists under the same name at this path. Do you want to adopt it?',
    )
    expect(dropboxState.adoptReplacementCandidate).not.toHaveBeenCalled()
    await screen.findByText('Unlock Dropbox file')

    const dialog = screen.getByRole('dialog')

    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))

    expect(await screen.findByTestId('editor')).toHaveProperty('value', 'opened dropbox text')
    expect(dropboxState.exportRecentFileCopy).toHaveBeenCalledWith('id:notes')
    expect(dropboxState.openRecentFile).not.toHaveBeenCalledWith('id:notes')
    expect(screen.getByRole('button', { name: 'Read-only' }).hasAttribute('disabled')).toBe(true)
    // SPEC §9: an unlinked cached file is read-only — opening it must write
    // nothing back (browser storage is not a second vault).
    await Promise.resolve()
    expect(dropboxState.save).not.toHaveBeenCalled()
    expect(dropboxState.saveLocalOnly).not.toHaveBeenCalled()
  })

  it('adopts a replacement candidate and enters the merge flow when adoption records a conflict', async () => {
    const replacementRecent = checkRecents().files[0]

    if (!replacementRecent) {
      throw new Error('Expected a recent file fixture.')
    }

    dropboxState.getSyncState
      .mockResolvedValueOnce(linkedCheckSync)
      .mockResolvedValueOnce(linkedCheckSync)
      .mockResolvedValue({
        ...linkedCheckSync,
        hasRemoteConflictEnvelope: true,
        lastSyncStatus: 'conflict',
        selectedFileId: 'id:replacement',
      })
    let adopted = false
    dropboxState.getRecentFiles.mockImplementation(async () =>
      adopted
        ? {
            files: [
              {
                ...replacementRecent,
                key: 'id:replacement',
              },
            ],
            selectedKey: 'id:replacement',
          }
        : checkRecents(),
    )
    dropboxState.checkRecentFile.mockImplementation(async (key: string) =>
      key === 'id:notes' ? { kind: 'replacement-candidate' } : { kind: 'up-to-date' },
    )
    dropboxState.adoptReplacementCandidate.mockImplementation(async () => {
      adopted = true
      return { kind: 'diverged' }
    })
    dropboxState.loadConflictEnvelopes.mockResolvedValue({
      baseEnvelope: null,
      localEnvelope: 'env-local',
      remoteEnvelope: 'env-remote',
      remoteConflictRev: 'rev-remote',
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<App />)
    await waitFor(() =>
      expect(screen.getByText(/notes\.txt/).closest('tr')?.className).toContain(
        'is-replacement-candidate',
      ),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Resolve' }))

    await waitFor(() =>
      expect(dropboxState.adoptReplacementCandidate).toHaveBeenCalledWith('id:notes'),
    )
    expect(confirmSpy).toHaveBeenCalled()
    await screen.findByText('Unlock Dropbox file')

    const dialog = screen.getByRole('dialog')

    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))

    await waitFor(() => expect(dropboxState.loadConflictEnvelopes).toHaveBeenCalled())
    expect(dropboxState.openRecentFile).toHaveBeenCalledWith('id:replacement')
  })

  it('grays a missing row with Not found in Last synced; the selected action reads Export', async () => {
    dropboxState.getSyncState.mockResolvedValue(linkedCheckSync)
    dropboxState.getRecentFiles.mockResolvedValue(checkRecents())
    dropboxState.checkRecentFile.mockImplementation(async (key: string) =>
      key === 'id:notes' ? { kind: 'missing' } : { kind: 'up-to-date' },
    )
    const restoreBlobUrls = mockBlobUrls()

    render(<App />)

    expect(await screen.findByText('Not found')).not.toBeNull()

    const row = screen.getByText('notes.txt', { selector: 'td' }).closest('tr')

    expect(row?.className).toContain('is-missing')

    const cells = within(row as HTMLElement).getAllByRole('gridcell')

    expect(cells[1]?.textContent).toBe('/Notes')
    expect(cells[2]?.textContent).toBe('Not found')

    // Open is replaced by Export for the missing selected row; the cached
    // ciphertext still exports.
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()

    const exportButtons = await screen.findAllByRole('button', { name: 'Export' })
    const blockExport = exportButtons.find((button) => !button.hasAttribute('disabled'))

    expect(blockExport).toBeDefined()
    fireEvent.click(blockExport as HTMLElement)
    await waitFor(() =>
      expect(dropboxState.exportRecentFileCopy).toHaveBeenCalledWith('id:notes'),
    )

    restoreBlobUrls()
  })

  it('grays an ineligible-name row export-only, showing its real current name', async () => {
    dropboxState.getSyncState.mockResolvedValue(linkedCheckSync)
    dropboxState.getRecentFiles.mockResolvedValue({
      files: [
        {
          key: 'id:notes',
          name: 'notes.md',
          folderPath: '/Notes',
          syncedModifiedAt: null,
          localModifiedAt: null,
          hasCache: true,
          hasUnsyncedChanges: false,
        },
      ],
      selectedKey: 'id:notes',
    })
    dropboxState.checkRecentFile.mockResolvedValue({ kind: 'ineligible' })

    render(<App />)

    const row = (await screen.findByText('notes.md', { selector: 'td' })).closest('tr')

    await waitFor(() => expect(row?.className).toContain('is-ineligible'))
    // The block action replaced Open; draft export is named "Export draft".
    expect(await screen.findByRole('button', { name: 'Export' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
  })

  it('home Resolve: conflict capture, unlock password dialog, then the merge flow', async () => {
    dropboxState.getSyncState.mockResolvedValue({
      ...linkedCheckSync,
      hasRemoteConflictEnvelope: true,
      lastSyncStatus: 'conflict',
    })
    dropboxState.getRecentFiles.mockResolvedValue(checkRecents())
    dropboxState.checkRecentFile.mockImplementation(async (key: string) =>
      key === 'id:notes' ? { kind: 'diverged' } : { kind: 'up-to-date' },
    )
    dropboxState.syncNow.mockResolvedValue({
      detail: 'Dropbox has a diverging version of /Notes/notes.txt. Open Resolve to review it.',
      state: 'conflict',
    })
    dropboxState.loadConflictEnvelopes.mockResolvedValue({
      baseEnvelope: 'env-base',
      localEnvelope: 'env-local',
      remoteEnvelope: 'env-remote',
      remoteConflictRev: 'rev-remote',
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Resolve' }))

    // The capture step runs before the password is asked for — and it is
    // captured for THIS row: the selection is persisted (awaited, inside the
    // same queued op) before syncNow, so an account-level conflict snapshot
    // left by a previously selected file can never be merged against this
    // row's local/base. The home auto-sync may have called
    // syncNow earlier, so compare against the LAST calls.
    await waitFor(() => {
      expect(dropboxState.setSelectedRecentFile).toHaveBeenCalledWith('id:notes')

      const selectionOrder =
        dropboxState.setSelectedRecentFile.mock.invocationCallOrder.at(-1) ??
        Number.POSITIVE_INFINITY
      const captureOrder =
        dropboxState.syncNow.mock.invocationCallOrder.at(-1) ?? Number.NEGATIVE_INFINITY

      expect(captureOrder).toBeGreaterThan(selectionOrder)
    })
    expect(dropboxState.syncNow).toHaveBeenLastCalledWith({ adoptCleanRemote: true })

    await screen.findByText('Unlock Dropbox file')
    const dialog = screen.getByRole('dialog')

    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))

    // The merge flow was entered directly — no extra tap on the editor's
    // Resolve control (SPEC §9: home Resolve collects the password first).
    await waitFor(() => expect(dropboxState.loadConflictEnvelopes).toHaveBeenCalled())
  })

  it('first-sync gate: a stale open shows the paused message and saves cache-only', async () => {
    dropboxState.getSyncState.mockResolvedValue(linkedCheckSync)
    dropboxState.getRecentFiles.mockResolvedValue(checkRecents())
    // The home pass finds everything clean; the open session's probe (the
    // refresh-disabled call) discovers the remote change.
    dropboxState.checkRecentFile.mockImplementation(
      async (_key: string, options?: { refreshStaleCache?: boolean }) =>
        options?.refreshStaleCache === false ? { kind: 'stale' } : { kind: 'up-to-date' },
    )

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }))

    await screen.findByText('Unlock Dropbox file')
    const dialog = screen.getByRole('dialog')

    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))
    await screen.findByTestId('editor')

    // The first-sync-gate pause surfaces the Resolve banner (the in-editor
    // resolution entry). It stays until the state changes (SPEC §16), and
    // Export stays reachable for an offline copy.
    expect(await screen.findByText('File changed on Dropbox.')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Resolve…' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Export to Files' })).not.toBeNull()

    // A forced save (the read-only toggle saves immediately) goes cache-only:
    // pushing stopped, autosave to the cache continues.
    fireEvent.click(screen.getByRole('button', { name: 'Read-only' }))
    await waitFor(() => expect(dropboxState.saveLocalOnly).toHaveBeenCalled())
    expect(dropboxState.save).not.toHaveBeenCalled()
  })

  it('a clean session open never shows the paused message and pushes normally', async () => {
    dropboxState.getSyncState.mockResolvedValue(linkedCheckSync)
    dropboxState.getRecentFiles.mockResolvedValue(checkRecents())

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }))

    await screen.findByText('Unlock Dropbox file')
    const dialog = screen.getByRole('dialog')

    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))
    await screen.findByTestId('editor')

    await waitFor(() =>
      expect(dropboxState.checkRecentFile).toHaveBeenCalledWith('id:notes', {
        refreshStaleCache: false,
      }),
    )
    expect(screen.queryByText('File changed on Dropbox.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Resolve…' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Read-only' }))
    await waitFor(() => expect(dropboxState.save).toHaveBeenCalled())
    expect(dropboxState.saveLocalOnly).not.toHaveBeenCalled()
  })

  // Opens a diverged (paused) Dropbox-file session: the open-session probe
  // reports `diverged`, so the first-sync gate pauses and the Resolve banner
  // appears. Shared by the banner tests below.
  const openDivergedSession = async () => {
    dropboxState.getSyncState.mockResolvedValue(linkedCheckSync)
    dropboxState.getRecentFiles.mockResolvedValue(checkRecents())
    dropboxState.checkRecentFile.mockImplementation(
      async (_key: string, options?: { refreshStaleCache?: boolean }) =>
        options?.refreshStaleCache === false ? { kind: 'diverged' } : { kind: 'up-to-date' },
    )

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }))
    await screen.findByText('Unlock Dropbox file')

    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))
    await screen.findByTestId('editor')
    await screen.findByText('File changed on Dropbox.')
  }

  it('Resolve banner: captures the conflict (syncNow) first, then opens the merge flow', async () => {
    // The capture's syncNow records the remote snapshot and reports conflict;
    // the merge then loads the captured envelopes.
    dropboxState.syncNow.mockResolvedValue({
      detail: 'Dropbox has a diverging version of /Notes/notes.txt.',
      state: 'conflict',
    })
    dropboxState.loadConflictEnvelopes.mockResolvedValue({
      baseEnvelope: 'env-base',
      localEnvelope: 'env-local',
      remoteEnvelope: 'env-remote',
      remoteConflictRev: 'rev-remote',
    })

    await openDivergedSession()

    // Clear the launch/auto-sync calls so the order check below is about the
    // banner's own capture.
    dropboxState.syncNow.mockClear()
    dropboxState.loadConflictEnvelopes.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Resolve…' }))

    // The capture (syncNow) runs BEFORE the merge loads the envelopes — the
    // banner cannot merge a conflict it has not captured.
    await waitFor(() => expect(dropboxState.syncNow).toHaveBeenCalled())
    await waitFor(() => expect(dropboxState.loadConflictEnvelopes).toHaveBeenCalled())

    const captureOrder = dropboxState.syncNow.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    const mergeOrder =
      dropboxState.loadConflictEnvelopes.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY

    expect(mergeOrder).toBeGreaterThan(captureOrder)
    // No adoptCleanRemote for the OPEN session (must not swap cache underneath).
    expect(dropboxState.syncNow).toHaveBeenLastCalledWith()
  })

  it('Resolve banner: offline explains resolution needs a connection and keeps Export reachable', async () => {
    const onLineSpy = vi.spyOn(navigator, 'onLine', 'get')

    try {
      // Open online (the probe needs a connection), so the banner appears.
      await openDivergedSession()
      expect(screen.getByRole('button', { name: 'Export to Files' })).not.toBeNull()

      // Now go offline; the 'offline' event bumps connectivity and re-renders
      // the banner with its offline explanation.
      onLineSpy.mockReturnValue(false)
      fireEvent(window, new Event('offline'))

      expect(await screen.findByText(/Resolving needs a connection/)).not.toBeNull()
      // Export stays reachable while offline.
      expect(screen.getByRole('button', { name: 'Export to Files' })).not.toBeNull()

      // Tapping Resolve while offline must not start a capture (syncNow).
      dropboxState.syncNow.mockClear()
      fireEvent.click(screen.getByRole('button', { name: 'Resolve…' }))

      expect(
        await screen.findByText(
          'Resolving needs a connection. Your changes are saved locally and Export still works.',
        ),
      ).not.toBeNull()
      expect(dropboxState.syncNow).not.toHaveBeenCalled()
    } finally {
      onLineSpy.mockRestore()
    }
  })

  it('Resolve banner: a stale-but-clean session stays paused (no false "back in sync") and directs to reopen', async () => {
    dropboxState.getSyncState.mockResolvedValue(linkedCheckSync)
    dropboxState.getRecentFiles.mockResolvedValue(checkRecents())
    // The open-session probe AND the re-probe after the capture report stale:
    // the remote changed but the local cache is clean (last-synced) — never a
    // conflict.
    dropboxState.checkRecentFile.mockImplementation(
      async (_key: string, options?: { refreshStaleCache?: boolean }) =>
        options?.refreshStaleCache === false ? { kind: 'stale' } : { kind: 'up-to-date' },
    )
    // syncNow on a stale-but-clean open session leaves the record untouched (it
    // must not adopt the remote under the open editor) and returns a NON-conflict
    // status.
    dropboxState.syncNow.mockResolvedValue({ detail: 'Synced.', state: 'ready' })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }))
    await screen.findByText('Unlock Dropbox file')
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))
    await screen.findByTestId('editor')
    await screen.findByText('File changed on Dropbox.')

    dropboxState.loadConflictEnvelopes.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Resolve…' }))

    // Resolve captured (syncNow), found no conflict, re-probed, saw it is STILL
    // stale, and kept the pause — directing the user to reopen rather than
    // silently clearing the banner over stale content.
    expect(
      await screen.findByText(
        'This file changed on Dropbox. Exit and reopen to load the newer version.',
      ),
    ).not.toBeNull()
    // No merge opened — a clean session has nothing to merge.
    expect(dropboxState.loadConflictEnvelopes).not.toHaveBeenCalled()
    // The banner remains (still paused); it is NOT replaced by "back in sync".
    expect(screen.getByText('File changed on Dropbox.')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Resolve…' })).not.toBeNull()
    expect(screen.queryByText('Dropbox is back in sync.')).toBeNull()
  })

  it('focus regain runs a background remote check that flips a clean session to diverged', async () => {
    dropboxState.getSyncState.mockResolvedValue(linkedCheckSync)
    dropboxState.getRecentFiles.mockResolvedValue(checkRecents())
    // The open-session probe is clean at open, then diverged once the user
    // returns focus (a remote change landed while backgrounded).
    let remoteChanged = false
    dropboxState.checkRecentFile.mockImplementation(
      async (_key: string, options?: { refreshStaleCache?: boolean }) => {
        if (options?.refreshStaleCache === false) {
          return remoteChanged ? { kind: 'diverged' } : { kind: 'up-to-date' }
        }
        return { kind: 'up-to-date' }
      },
    )

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }))
    await screen.findByText('Unlock Dropbox file')

    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))
    await screen.findByTestId('editor')

    // Clean at open: no banner.
    expect(screen.queryByText('File changed on Dropbox.')).toBeNull()

    // findByTestId resolves on the editor render; the post-unlock effect that
    // installs the focus listener (App.tsx ~:2526/2592) is a PASSIVE effect that
    // can flush a tick later. Flush it (real timers) before firing focus, or the
    // event is dropped and the probe never runs (0 checkRecentFile calls).
    await act(async () => {})

    // A remote change lands; regaining focus runs the debounced background check.
    remoteChanged = true
    // The open already fired one refreshStaleCache:false probe (the "clean at
    // open" assertion above); clear the call history so the assertion below
    // confirms the FOCUS probe specifically.
    dropboxState.checkRecentFile.mockClear()

    // Drive the 400ms focus-regain debounce with fake timers: under full-suite
    // CPU starvation the real setTimeout fires arbitrarily late (it lost even a
    // 10s wait on the probe call), because the worker's event loop is parked.
    // Fake ONLY setTimeout/clearTimeout (Date, microtasks, React's scheduler
    // stay real) and scope it AFTER the real-Argon2id unlock above. Advancing
    // inside act() flushes the probe's .then() chain
    // (checkRecentFile -> setDropboxSessionPaused(true)) and the re-render, so
    // the banner is present synchronously regardless of load.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      fireEvent(window, new Event('focus'))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })
    } finally {
      vi.useRealTimers()
    }

    expect(dropboxState.checkRecentFile).toHaveBeenCalledWith('id:notes', {
      refreshStaleCache: false,
    })
    expect(screen.getByText('File changed on Dropbox.')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Resolve…' })).not.toBeNull()
  })

  it('a known-stale row refreshes before the password dialog on Open', async () => {
    dropboxState.getSyncState.mockResolvedValue(linkedCheckSync)
    dropboxState.getRecentFiles.mockResolvedValue(checkRecents())
    // The home pass classifies the selected row stale (its refresh failed);
    // the Open then re-checks (refresh allowed) before reading the bytes.
    dropboxState.checkRecentFile.mockImplementation(
      async (key: string, options?: { refreshStaleCache?: boolean }) =>
        key === 'id:notes' && options?.refreshStaleCache !== false
          ? { kind: 'stale' }
          : { kind: 'up-to-date' },
    )

    render(<App />)

    // Wait for the home pass to mark the row stale.
    await waitFor(() =>
      expect(dropboxState.checkRecentFile).toHaveBeenCalledWith('id:notes'),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await screen.findByText('Unlock Dropbox file')

    // The refresh ran again at open time, BEFORE openRecentFile read the
    // bytes (SPEC §9: at the latest on the next online Open, before the
    // password dialog): two id:notes checks precede the read.
    const openOrder = dropboxState.openRecentFile.mock.invocationCallOrder[0] ?? 0
    const notesChecksBeforeOpen = dropboxState.checkRecentFile.mock.calls
      .map((call, index) => ({
        key: call[0],
        order: dropboxState.checkRecentFile.mock.invocationCallOrder[index] ?? 0,
      }))
      .filter((call) => call.key === 'id:notes' && call.order < openOrder)

    expect(notesChecksBeforeOpen.length).toBeGreaterThanOrEqual(2)
  })

  // Mutating Dropbox ops are serialized across tabs by an exclusive
  // Web Lock named 'enoteweb-dropbox', so the `online` auto-sync firing in
  // every window can't race the same remote file. jsdom does not provide
  // navigator.locks, so the two cases below install/remove the stub
  // explicitly. The shared linked + recents fixture both cases need:
  const setLinkedSelectedFixture = () => {
    dropboxState.getSyncState.mockResolvedValue({
      authLost: false,
      pendingAccountSwitch: null,
      accountLabel: 'dbid:test',
      hasPendingLocalEnvelope: true,
      hasRemoteConflictEnvelope: false,
      lastSyncAt: null,
      lastSyncStatus: 'pending-local',
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
    // The open session's probe finds the remote diverged → the first-sync gate
    // pauses and the Resolve banner appears. Tapping Resolve drives a syncNow
    // (the conflict-capture) through the exclusive Dropbox op queue — the
    // post-Save-button way the editor reaches the lock.
    dropboxState.checkRecentFile.mockImplementation(
      async (_key: string, options?: { refreshStaleCache?: boolean }) =>
        options?.refreshStaleCache === false ? { kind: 'diverged' } : { kind: 'up-to-date' },
    )
  }

  const openUnlockAndSync = async () => {
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Open' }))
    await screen.findByText('Unlock Dropbox file')

    const unlockDialog = screen.getByRole('dialog')

    fireEvent.change(within(unlockDialog).getByLabelText('Password'), {
      target: { value: 'correct horse battery staple' },
    })
    fireEvent.click(within(unlockDialog).getByRole('button', { name: 'Unlock' }))
    await screen.findByTestId('editor')

    // The diverged open session shows the Resolve banner; tapping it captures
    // the conflict via syncNow (inside the exclusive Dropbox op).
    fireEvent.click(await screen.findByRole('button', { name: 'Resolve…' }))
  }

  describe('cross-tab Dropbox op lock', () => {
    afterEach(() => {
      // jsdom has no navigator.locks by default; remove any stub a test added
      // so it can't leak into other tests.
      if ('locks' in navigator) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (navigator as any).locks
      }
    })

    it('runs a Dropbox op under the enoteweb-dropbox lock when navigator.locks is available', async () => {
      const request = vi.fn(
        (_name: string, _opts: unknown, cb: (lock: unknown) => unknown) =>
          Promise.resolve(cb({})),
      )
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: { request },
      })

      setLinkedSelectedFixture()
      await openUnlockAndSync()

      // The op still completes (syncNow ran)...
      await waitFor(() => expect(dropboxState.syncNow).toHaveBeenCalled())
      // ...and it ran inside the named exclusive lock.
      expect(request).toHaveBeenCalledWith(
        'enoteweb-dropbox',
        { mode: 'exclusive' },
        expect.any(Function),
      )
    })

    it('still runs the Dropbox op when navigator.locks is absent (fallback)', async () => {
      // Default jsdom state: navigator.locks is undefined. The op must run
      // directly through the in-tab chain without throwing.
      expect('locks' in navigator).toBe(false)

      setLinkedSelectedFixture()
      await openUnlockAndSync()

      await waitFor(() => expect(dropboxState.syncNow).toHaveBeenCalled())
      // The toolbar still reaches a queued/pending-sync state — no crash.
      expect(
        await screen.findByText('Unsynced', { selector: '.storage-inline-status' }),
      ).not.toBeNull()
    })
  })
})
