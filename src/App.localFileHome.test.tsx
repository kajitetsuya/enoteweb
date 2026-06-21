import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { getEnvelopeSecretKeyMode } from './crypto/cryptoService'

type MockLocalFileRecord = {
  active: boolean
  createdAt: string
  displayName: string
  displayPath: string | null
  handle: { kind: 'file'; name: string } | null
  key: string
  lastModifiedAt: string | null
  lastSavedEnvelope: string
  permissionState: 'granted'
  updatedAt: string
}

const localFileState = vi.hoisted(() => {
  const makeRecord = (
    key: string,
    displayName: string,
    active: boolean,
    index: number,
    displayPath: string | null = null,
  ): MockLocalFileRecord => ({
    active,
    createdAt: `2026-06-01T00:00:0${index}.000Z`,
    displayName,
    displayPath,
    handle: { kind: 'file', name: displayName },
    key,
    lastModifiedAt: `2026-06-01T00:00:1${index}.000Z`,
    lastSavedEnvelope: `${key}-envelope`,
    permissionState: 'granted',
    updatedAt: `2026-06-01T00:00:0${index}.000Z`,
  })

  const state = {
    activeKey: 'recent-1' as string | null,
    draftEnvelope: null as string | null,
    envelope: 'recent-1-envelope' as string | null,
    fileRecords: [] as MockLocalFileRecord[],
    makeRecord,
    getActiveRecord: () =>
      state.fileRecords.find((record) => record.key === state.activeKey) ??
      state.fileRecords.find((record) => record.active) ??
      state.fileRecords.at(-1) ??
      null,
    resetRecords: (records?: MockLocalFileRecord[]) => {
      state.fileRecords = records ?? [makeRecord('recent-1', 'recent-note.txt', true, 1)]
      state.activeKey =
        state.fileRecords.find((record) => record.active)?.key ??
        state.fileRecords.at(-1)?.key ??
        null
      state.envelope = state.getActiveRecord()?.lastSavedEnvelope ?? null
    },
    setActiveKey: (key: string) => {
      state.fileRecords = state.fileRecords.map((record) => ({
        ...record,
        active: record.key === key,
      }))
      state.activeKey = key
      state.envelope = state.getActiveRecord()?.lastSavedEnvelope ?? null
    },
    appendRecord: (displayName: string, envelope: string) => {
      const index = state.fileRecords.length + 1
      const record = makeRecord(`recent-${index}`, displayName, true, index)

      record.lastSavedEnvelope = envelope
      state.fileRecords = state.fileRecords
        .map((existingRecord) => ({ ...existingRecord, active: false }))
        .concat(record)
      state.activeKey = record.key
      state.envelope = envelope
      return record
    },
    // Destination-first creation (SPEC §10/§17): the picker resolves a target
    // first; the envelope is written through createAtTarget only after the
    // password dialog.
    pickCreateTarget: vi.fn(
      async (options?: { startIn?: { kind: string; name: string }; suggestedName?: string }) => ({
        handle: { name: options?.suggestedName ?? 'enote.txt' },
        permissionState: 'granted' as const,
      }),
    ),
    refreshRecentFileMetadata: vi.fn(async () => state.fileRecords),
    setPathRoot: vi.fn(async () => ({ name: 'Documents' })),
    saveDraft: vi.fn(async (envelope: string) => {
      state.draftEnvelope = envelope
    }),
    clearDraft: vi.fn(async () => {
      state.draftEnvelope = null
    }),
    createAtTarget: vi.fn(
      async (target: { handle: { name: string } }, envelope: string) => {
        state.appendRecord(target.handle.name, envelope)
        return envelope
      },
    ),
    forget: vi.fn(async (recordKey?: string) => {
      const keyToDelete = recordKey ?? state.activeKey

      state.fileRecords = state.fileRecords.filter((record) => record.key !== keyToDelete)

      if (state.activeKey === keyToDelete) {
        const nextActiveRecord = state.fileRecords.at(-1) ?? null

        state.activeKey = nextActiveRecord?.key ?? null
      }

      state.fileRecords = state.fileRecords.map((record) => ({
        ...record,
        active: record.key === state.activeKey,
      }))
      state.envelope = state.getActiveRecord()?.lastSavedEnvelope ?? null
      return state.getActiveRecord()
    }),
    LocalFileNotFoundError: class LocalFileNotFoundError extends Error {
      constructor() {
        super('The selected local file was not found at its saved location.')
        this.name = 'LocalFileNotFoundError'
      }
    },
    loadWithPermission: vi.fn(async () => state.getActiveRecord()?.lastSavedEnvelope ?? 'encrypted-envelope'),
    open: vi.fn(async () => {
      const envelope = 'browsed-envelope'

      state.appendRecord(`browsed-${state.fileRecords.length + 1}.txt`, envelope)
      return envelope
    }),
    select: vi.fn(async (recordKey: string) => {
      state.setActiveKey(recordKey)
      return state.getActiveRecord()
    }),
  }

  state.resetRecords()
  return state
})

vi.mock('./crypto/cryptoService', () => ({
  CryptoService: {
    decrypt: vi.fn(async () => 'opened local text'),
    encrypt: vi.fn(async () => 'new encrypted envelope'),
  },
  DEFAULT_KDF_PARAMS: {
    opslimit: 3,
    memlimit: 67_108_864,
  },
  MAX_KDF_PARAMS: {
    opslimit: 10,
    memlimit: 268_435_456,
  },
  SECRET_KEY_MODE_REQUIRED: 'required-v1',
  SecretKeyRequiredError: class SecretKeyRequiredError extends Error {},
  getEnvelopeSecretKeyMode: vi.fn(() => 'none'),
  isEnvelopeReadOnly: vi.fn(() => false),
  parseEnvelope: vi.fn(() => ({
    opslimit: 3,
    memlimit: 67_108_864,
  })),
}))

vi.mock('./storage/providerRegistry', () => ({
  getStorageProvider: (kind?: string) => {
    if (kind === 'draft') {
      return {
        kind: 'draft',
        load: async () => localFileState.draftEnvelope ?? 'draft-envelope',
        save: localFileState.saveDraft,
        status: async () => ({
          detail: localFileState.draftEnvelope
            ? 'Draft is ready.'
            : 'No draft yet. Create one with New draft.',
          state: localFileState.draftEnvelope ? 'ready' : 'needs-user-action',
        }),
      }
    }

    return {
      kind: 'local-file',
      load: async () => {
        const activeRecord = localFileState.getActiveRecord()

        if (!activeRecord) {
          throw new Error('No local file')
        }

        return activeRecord.lastSavedEnvelope
      },
      save: async (envelope: string) => {
        localFileState.envelope = envelope
      },
      status: async () => ({
        detail:
          localFileState.fileRecords.length > 0
            ? 'Local encrypted text file is ready.'
            : 'Choose or create an encrypted text file.',
        state: localFileState.fileRecords.length > 0 ? 'ready' : 'needs-user-action',
      }),
    }
  },
}))

vi.mock('./storage/localFileProvider', () => ({
  LOCAL_FILE_PATH_UNAVAILABLE: 'Full path unavailable',
  LocalFileNotFoundError: localFileState.LocalFileNotFoundError,
  localFileProvider: {
    createAtTarget: localFileState.createAtTarget,
    forget: localFileState.forget,
    loadWithPermission: localFileState.loadWithPermission,
    open: localFileState.open,
    pickCreateTarget: localFileState.pickCreateTarget,
    refreshRecentFileMetadata: localFileState.refreshRecentFileMetadata,
    select: localFileState.select,
    setPathRoot: localFileState.setPathRoot,
  },
  publishLocalFileUnlockDiagnostic: vi.fn(),
}))

vi.mock('./storage/vaultStore', () => ({
  vaultStore: {
    clearVault: localFileState.clearDraft,
    getLocalFile: async () => localFileState.getActiveRecord(),
    getLocalFiles: async () => localFileState.fileRecords,
    getSetting: async (key: string) =>
      key === 'storageProvider' ? { key, value: 'local-file' } : null,
    saveSetting: async () => undefined,
    saveEnvelope: localFileState.saveDraft,
    // The unified home polls the draft slot in every mode.
    getVault: async () =>
      localFileState.draftEnvelope
        ? {
            envelope: localFileState.draftEnvelope,
          }
        : undefined,
  },
}))

vi.mock('./editor/CodeMirrorEditor', async () => {
  const React = await import('react')

  return {
    CodeMirrorEditor: React.forwardRef(
      (
        {
          value,
          onChange,
        }: {
          value: string
          onChange?: (next: string) => void
        },
        ref,
      ) => {
        React.useImperativeHandle(ref, () => ({
          findNext: async () => ({ currentIndex: -1, error: null, matchCount: 0, message: '', ok: false }),
          findPrevious: async () => ({
            currentIndex: -1,
            error: null,
            matchCount: 0,
            message: '',
            ok: false,
          }),
          focus: () => undefined,
          redo: () => false,
          replaceAll: async () => ({ count: 0, error: null, message: '', ok: false }),
          replaceCurrent: async () => ({ count: 0, error: null, message: '', ok: false }),
          replaceNext: async () => ({ count: 0, error: null, message: '', ok: false }),
          replacePrevious: async () => ({ count: 0, error: null, message: '', ok: false }),
          setSearchHighlights: () => undefined,
          undo: () => false,
        }))

        return React.createElement('textarea', {
          'data-testid': 'editor',
          value,
          onChange: (event: { target: { value: string } }) => onChange?.(event.target.value),
        })
      },
    ),
  }
})

beforeEach(() => {
  globalThis.showOpenFilePicker = vi.fn()
  globalThis.showSaveFilePicker = vi.fn()
  // vitest has no clearMocks/mockReset, so re-establish the default Secret-key
  // mode per-test and clear call history (mirrors the Dropbox-mode App tests) so a
  // required-v1 override in one test cannot leak into the next.
  vi.mocked(getEnvelopeSecretKeyMode).mockReset()
  vi.mocked(getEnvelopeSecretKeyMode).mockReturnValue('none')
  localFileState.draftEnvelope = null
  localFileState.clearDraft.mockClear()
  localFileState.resetRecords()
  localFileState.createAtTarget.mockClear()
  localFileState.forget.mockClear()
  localFileState.loadWithPermission.mockClear()
  localFileState.open.mockClear()
  localFileState.pickCreateTarget.mockClear()
  localFileState.refreshRecentFileMetadata.mockClear()
  localFileState.saveDraft.mockClear()
  localFileState.select.mockClear()
  localFileState.setPathRoot.mockClear()
})

afterEach(() => {
  cleanup()
})

// The home `Open` flow shared by most tests: tap Open, then unlock through
// the password dialog (SPEC §2 — no password field on the home).
const openSelectedThroughDialog = async (password = 'correct horse battery staple') => {
  fireEvent.click(screen.getByRole('button', { name: 'Open' }))

  await screen.findByText('Unlock local file')
  const dialog = screen.getByRole('dialog')

  fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: password } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))
  await screen.findByTestId('editor')
}

describe('App local file home screen', () => {
  it('uses Open to unlock the selected recent file through the unlock dialog', async () => {
    render(<App />)

    expect(await screen.findByText('recent-note.txt')).not.toBeNull()
    expect(screen.getByText('Local files')).not.toBeNull()
    expect(screen.getByRole('columnheader', { name: 'Last modified' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Set path root' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'New' })).toBeNull()
    expect(screen.getByRole('button', { name: 'New draft' })).not.toBeNull()
    expect((screen.getByRole('button', { name: 'Delete draft' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((screen.getByRole('button', { name: 'Save As' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect(screen.queryByRole('button', { name: 'Import draft' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Export draft' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Dropbox' })).toBeNull()
    expect((screen.getByRole('button', { name: 'Open' }) as HTMLButtonElement).disabled).toBe(
      false,
    )
    expect(screen.getByRole('button', { name: 'Browse' })).not.toBeNull()
    // No always-visible password field on the home (SPEC §10/§17).
    expect(screen.queryByLabelText('Password')).toBeNull()

    await openSelectedThroughDialog()

    expect(screen.getByTestId('editor')).toHaveProperty('value', 'opened local text')
    // The toolbar filename line shows the bound file's name (SPEC §15).
    expect(screen.getByText('recent-note.txt', { selector: '.toolbar-file-name' })).not.toBeNull()
    expect(localFileState.loadWithPermission).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'recent-1' }),
    )
  })

  // A required-v1 local file opened through the home `Open` path must render the
  // inline Secret-key field — pinning a DIFFERENT migrated openUnlockDialog call
  // site (and a different dialog title, `Unlock local file`) than the Dropbox
  // tests cover, so no entry point can silently dead-end a keyless-device open.
  it('a required-v1 local file Open shows the inline Secret-key field', async () => {
    vi.mocked(getEnvelopeSecretKeyMode).mockReturnValue('required-v1')

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }))
    await screen.findByText('Unlock local file')

    const dialog = screen.getByRole('dialog')
    const keyField = within(dialog).getByLabelText('Secret key') as HTMLInputElement
    expect(keyField).not.toBeNull()
    // Keyless device (no Settings key): the inline field is present and empty.
    expect(keyField.value).toBe('')
  })

  it('home Save As writes the locked draft envelope verbatim and clears after success', async () => {
    const { CryptoService } = await import('./crypto/cryptoService')

    localFileState.draftEnvelope = 'stored-local-draft-envelope'
    vi.mocked(CryptoService.encrypt).mockClear()

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Save As' }))

    await waitFor(() =>
      expect(localFileState.createAtTarget).toHaveBeenCalledWith(
        expect.objectContaining({ handle: expect.objectContaining({ name: 'enote.txt' }) }),
        'stored-local-draft-envelope',
      ),
    )
    expect(vi.mocked(CryptoService.encrypt)).not.toHaveBeenCalled()
    expect(localFileState.clearDraft).toHaveBeenCalled()
    expect(
      localFileState.createAtTarget.mock.invocationCallOrder[0]!,
    ).toBeLessThan(localFileState.clearDraft.mock.invocationCallOrder[0]!)
    expect(localFileState.draftEnvelope).toBeNull()
    expect(await screen.findByText('Draft saved as a local file.')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'New draft' })).not.toBeNull()
  })

  it('home Save As lists a draft promoted after editing the draft session', async () => {
    render(<App />)

    await screen.findByText('recent-note.txt')
    fireEvent.click(screen.getByRole('button', { name: 'New draft' }))

    await screen.findByText('Set a password for the new draft')
    const createDialog = screen.getByRole('dialog')

    fireEvent.change(within(createDialog).getByLabelText('Password'), {
      target: { value: 'draft password' },
    })
    fireEvent.change(within(createDialog).getByLabelText('Confirm password'), {
      target: { value: 'draft password' },
    })
    fireEvent.click(within(createDialog).getByRole('button', { name: 'Create' }))
    await screen.findByTestId('editor')

    fireEvent.click(screen.getByRole('button', { name: 'Home' }))
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }))
    await screen.findByRole('button', { name: 'Edit draft' })

    fireEvent.click(screen.getByRole('button', { name: 'Save As' }))

    expect(await screen.findByText('Draft saved as a local file.')).not.toBeNull()
    expect(screen.getByText('enote.txt')).not.toBeNull()
    expect(localFileState.refreshRecentFileMetadata).toHaveBeenCalled()
    expect(localFileState.clearDraft).toHaveBeenCalled()
  })

  it('home Save As preserves the draft when the local write fails', async () => {
    localFileState.draftEnvelope = 'stored-local-draft-envelope'
    localFileState.createAtTarget.mockRejectedValueOnce(new Error('write failed'))

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Save As' }))

    expect(await screen.findByText('Unable to save to that file.')).not.toBeNull()
    expect(localFileState.createAtTarget).toHaveBeenCalledWith(
      expect.objectContaining({ handle: expect.objectContaining({ name: 'enote.txt' }) }),
      'stored-local-draft-envelope',
    )
    expect(localFileState.clearDraft).not.toHaveBeenCalled()
    expect(localFileState.draftEnvelope).toBe('stored-local-draft-envelope')
    expect(screen.getByRole('button', { name: 'Edit draft' })).not.toBeNull()
  })

  it('home Save As reports cleanup failure separately after a successful local write', async () => {
    localFileState.draftEnvelope = 'stored-local-draft-envelope'
    localFileState.clearDraft.mockRejectedValueOnce(new Error('cleanup failed'))

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Save As' }))

    expect(
      await screen.findByText(
        'Draft saved as a local file, but the old draft could not be cleared.',
      ),
    ).not.toBeNull()
    expect(screen.queryByText('Unable to save to that file.')).toBeNull()
    expect(localFileState.createAtTarget).toHaveBeenCalledWith(
      expect.objectContaining({ handle: expect.objectContaining({ name: 'enote.txt' }) }),
      'stored-local-draft-envelope',
    )
    expect(localFileState.clearDraft).toHaveBeenCalled()
    expect(localFileState.draftEnvelope).toBe('stored-local-draft-envelope')
    expect(screen.getByRole('button', { name: 'Edit draft' })).not.toBeNull()
  })

  it('keeps the unlock dialog open with the failure inside on a wrong password', async () => {
    const { CryptoService } = await import('./crypto/cryptoService')

    vi.mocked(CryptoService.decrypt).mockRejectedValueOnce(new Error('bad password'))

    render(<App />)

    expect(await screen.findByText('recent-note.txt')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))

    await screen.findByText('Unlock local file')
    const dialog = screen.getByRole('dialog')

    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'wrong' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))

    expect(
      await within(dialog).findByText('Could not unlock. Check the password or file.'),
    ).not.toBeNull()
    expect(screen.queryByTestId('editor')).toBeNull()
  })

  it('reports a missing file specifically when the recent file no longer exists', async () => {
    localFileState.loadWithPermission.mockRejectedValueOnce(
      new localFileState.LocalFileNotFoundError(),
    )

    render(<App />)

    expect(await screen.findByText('recent-note.txt')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))

    expect(await screen.findByText('File not found.')).not.toBeNull()
    // The failure surfaced on the home — the unlock dialog never opened.
    expect(screen.queryByText('Unlock local file')).toBeNull()

    // The recent-file entry must survive so the user can Browse to relocate it.
    expect(screen.getByText('recent-note.txt')).not.toBeNull()
  })

  it('renders a stored full path when one is available', async () => {
    localFileState.resetRecords([
      localFileState.makeRecord(
        'recent-1',
        'recent-note.txt',
        true,
        1,
        'C:\\Users\\username\\Documents\\recent-note.txt',
      ),
    ])

    render(<App />)

    expect(
      await screen.findByText('C:\\Users\\username\\Documents\\recent-note.txt'),
    ).not.toBeNull()
    expect(screen.queryByText('Full path unavailable')).toBeNull()
  })

  it('sets the local path root without opening a file', async () => {
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Set path root' }))

    await waitFor(() => expect(localFileState.setPathRoot).toHaveBeenCalled())
    expect(localFileState.open).not.toHaveBeenCalled()
    expect(await screen.findByText('Path root set.')).not.toBeNull()
  })

  it('renders multiple recent files and opens the clicked row', async () => {
    localFileState.resetRecords([
      localFileState.makeRecord('recent-1', 'first-note.txt', true, 1),
      localFileState.makeRecord('recent-2', 'second-note.txt', false, 2),
    ])

    render(<App />)

    fireEvent.click(await screen.findByText('second-note.txt'))
    await openSelectedThroughDialog()

    expect(screen.getByTestId('editor')).toHaveProperty('value', 'opened local text')
    expect(localFileState.select).toHaveBeenCalledWith('recent-2')
    expect(localFileState.loadWithPermission).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'recent-2' }),
    )
  })

  it('removes only the right-clicked recent file from the list', async () => {
    localFileState.resetRecords([
      localFileState.makeRecord('recent-1', 'first-note.txt', true, 1),
      localFileState.makeRecord('recent-2', 'second-note.txt', false, 2),
    ])

    render(<App />)

    const row = (await screen.findByText('first-note.txt')).closest('tr')

    if (!row) {
      throw new Error('Recent file row was not rendered.')
    }

    fireEvent.contextMenu(row, { clientX: 40, clientY: 50 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete from list' }))

    expect(localFileState.forget).toHaveBeenCalledWith('recent-1')
    await waitFor(() => expect(screen.queryByText('first-note.txt')).toBeNull())
    expect(await screen.findByText('second-note.txt')).not.toBeNull()
    expect(await screen.findByText('Removed from recent files.')).not.toBeNull()
  })

  it('New draft creates the shared draft without using the local file picker', async () => {
    render(<App />)

    await screen.findByText('recent-note.txt')
    fireEvent.click(screen.getByRole('button', { name: 'New draft' }))

    await screen.findByText('Set a password for the new draft')
    expect(localFileState.pickCreateTarget).not.toHaveBeenCalled()
    expect(localFileState.createAtTarget).not.toHaveBeenCalled()

    const dialog = screen.getByRole('dialog')

    fireEvent.change(within(dialog).getByLabelText('Password'), {
      target: { value: 'new file password' },
    })
    fireEvent.change(within(dialog).getByLabelText('Confirm password'), {
      target: { value: 'new file password' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    expect(await screen.findByTestId('editor')).toHaveProperty('value', '')
    // Local sessions show only Save As: no Save
    // button anywhere, no Dropbox button, and no Export (Save As is the offline
    // savior in Local mode).
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Save As…' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Save to Dropbox' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Export to Files' })).toBeNull()
    expect(localFileState.saveDraft).toHaveBeenCalledWith('new encrypted envelope')
    expect(localFileState.createAtTarget).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Home' }))
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }))

    expect(await screen.findByText('Local files')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Edit draft' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'New' })).toBeNull()
  })

  it('Save As from a Local files draft writes a local file, rebinds the session, and clears the draft', async () => {
    render(<App />)

    await screen.findByText('recent-note.txt')
    fireEvent.click(screen.getByRole('button', { name: 'New draft' }))

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

    fireEvent.click(screen.getByRole('button', { name: 'Save As…' }))

    // A draft promotion reuses the current document password (like Upload to
    // Dropbox), so no create-password dialog appears.
    expect(
      await screen.findByText('Saved As. Edits now save to the selected file.'),
    ).not.toBeNull()
    expect(screen.queryByText('Set a password for the file')).toBeNull()
    expect(localFileState.pickCreateTarget).toHaveBeenCalledWith({ suggestedName: 'enote.txt' })
    expect(localFileState.createAtTarget).toHaveBeenCalledWith(
      expect.objectContaining({ handle: expect.objectContaining({ name: 'enote.txt' }) }),
      'new encrypted envelope',
    )
    expect(screen.getByText('enote.txt', { selector: '.toolbar-file-name' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Save As…' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Save to Dropbox' })).toBeNull()
    // The promotion empties the draft slot, mirroring Upload to Dropbox: the
    // document now lives as the written local file, so the home would read
    // `New draft` again rather than `Edit draft`.
    expect(localFileState.clearDraft).toHaveBeenCalled()
  })

  it('Save As from a Local files draft rebinds even when old draft cleanup fails', async () => {
    render(<App />)

    await screen.findByText('recent-note.txt')
    fireEvent.click(screen.getByRole('button', { name: 'New draft' }))

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

    localFileState.clearDraft.mockRejectedValueOnce(new Error('cleanup failed'))
    fireEvent.click(screen.getByRole('button', { name: /Save As/ }))

    expect(
      await screen.findByText(
        'Saved As. Edits now save to the selected file, but the old draft could not be cleared.',
      ),
    ).not.toBeNull()
    expect(screen.queryByText('Unable to save to that file.')).toBeNull()
    expect(localFileState.createAtTarget).toHaveBeenCalledWith(
      expect.objectContaining({ handle: expect.objectContaining({ name: 'enote.txt' }) }),
      'new encrypted envelope',
    )
    expect(localFileState.clearDraft).toHaveBeenCalled()
    expect(screen.getByText('enote.txt', { selector: '.toolbar-file-name' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.getByRole('button', { name: /Save As/ })).not.toBeNull()
    expect(localFileState.draftEnvelope).toBe('new encrypted envelope')
  })

  it('Save As resolves the destination first and writes under the current password (no dialog)', async () => {
    const { CryptoService } = await import('./crypto/cryptoService')

    render(<App />)

    await screen.findByText('recent-note.txt')
    await openSelectedThroughDialog()

    vi.mocked(CryptoService.encrypt).mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Save As…' }))

    // No password dialog: Save As reuses the current session password.
    expect(
      await screen.findByText('Saved As. Edits now save to the selected file.'),
    ).not.toBeNull()
    expect(screen.queryByText('Set a password for the file')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(localFileState.pickCreateTarget).toHaveBeenCalledWith({
      startIn: expect.objectContaining({ kind: 'file', name: 'recent-note.txt' }),
      suggestedName: 'recent-note.txt',
    })
    expect(localFileState.createAtTarget).toHaveBeenCalledWith(
      expect.objectContaining({ permissionState: 'granted' }),
      'new encrypted envelope',
    )
    // The rebound copy was encrypted under the CURRENT password, not a new one.
    expect(
      vi.mocked(CryptoService.encrypt).mock.calls.some(
        ([, password]) => password === 'correct horse battery staple',
      ),
    ).toBe(true)
  })

  it('Save As opens the picker before flushing a DIRTY document (user-activation order)', async () => {
    const { CryptoService } = await import('./crypto/cryptoService')

    render(<App />)

    await screen.findByText('recent-note.txt')
    await openSelectedThroughDialog()

    // Dirty the document, then Save As immediately (before the autosave
    // debounce). The picker must open BEFORE any encryption, or a slow
    // Argon2id flush of the dirty content would spend the click's transient
    // user activation and the native picker could fail to open
    // (SPEC §10/§17 — destination first).
    fireEvent.change(screen.getByTestId('editor'), {
      target: { value: 'opened local text plus a dirty edit' },
    })

    vi.mocked(CryptoService.encrypt).mockClear()
    localFileState.pickCreateTarget.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Save As…' }))

    // Save As reuses the current password (no dialog), so the whole flow runs
    // to completion on one click.
    await screen.findByText('Saved As. Edits now save to the selected file.')
    expect(localFileState.pickCreateTarget).toHaveBeenCalled()

    // Fallbacks chosen so a MISSING call still fails the ordering assertion.
    const pickerOrder =
      localFileState.pickCreateTarget.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    const firstEncryptOrder = vi.mocked(CryptoService.encrypt).mock.invocationCallOrder[0] ?? -1

    // The dirty flush DID encrypt (so the old file keeps its final content)...
    expect(firstEncryptOrder).toBeGreaterThan(0)
    // ...but only AFTER the picker opened.
    expect(pickerOrder).toBeLessThan(firstEncryptOrder)
  })

  it('Save As flushes a dirty edit even when clicked before save-status render catches up', async () => {
    const { CryptoService } = await import('./crypto/cryptoService')

    render(<App />)

    await screen.findByText('recent-note.txt')
    await openSelectedThroughDialog()

    vi.mocked(CryptoService.encrypt).mockClear()
    localFileState.pickCreateTarget.mockClear()

    await act(async () => {
      fireEvent.change(screen.getByTestId('editor'), {
        target: { value: 'opened local text plus a very quick edit' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Save As…' }))
    })

    await screen.findByText('Saved As. Edits now save to the selected file.')
    expect(localFileState.pickCreateTarget).toHaveBeenCalled()

    const dirtyEncryptCalls = vi
      .mocked(CryptoService.encrypt)
      .mock.calls.filter(([text]) => text === 'opened local text plus a very quick edit')

    // One encryption flushes the still-bound file; the second writes the Save
    // As copy. The old saveStatus-state check skipped the first call when the
    // toolbar click arrived before React rendered "dirty".
    expect(dirtyEncryptCalls.length).toBeGreaterThanOrEqual(2)
  })

  it('autosaves under the current password after a Save As (no rotation)', async () => {
    const { CryptoService } = await import('./crypto/cryptoService')

    render(<App />)

    await screen.findByText('recent-note.txt')
    await openSelectedThroughDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Save As…' }))
    await screen.findByText('Saved As. Edits now save to the selected file.')

    vi.mocked(CryptoService.encrypt).mockClear()
    fireEvent.change(screen.getByTestId('editor'), {
      target: { value: 'opened local text plus an edit' },
    })

    // Save As did not change the password: the post-Save-As autosave still
    // encrypts under the ORIGINAL session password.
    await waitFor(
      () => {
        const calls = vi.mocked(CryptoService.encrypt).mock.calls

        expect(
          calls.some(
            ([text, password]) =>
              text === 'opened local text plus an edit' &&
              password === 'correct horse battery staple',
          ),
        ).toBe(true)
      },
      { timeout: 4000 },
    )
  })

  it('Change Password re-encrypts in place under the new password and shows "Password changed"', async () => {
    const { CryptoService } = await import('./crypto/cryptoService')

    render(<App />)

    await screen.findByText('recent-note.txt')
    await openSelectedThroughDialog()

    vi.mocked(CryptoService.encrypt).mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))

    // A two-field "new password" dialog with OK / Cancel.
    await screen.findByText('Set a new password')
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Password'), {
      target: { value: 'rotated password' },
    })
    fireEvent.change(within(dialog).getByLabelText('Confirm password'), {
      target: { value: 'rotated password' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }))

    // Success notice in the save-status line (where "Autosaved" shows).
    await screen.findByText('Password changed')

    // Rotated IN PLACE: the current document re-encrypted under the NEW
    // password, with no Save As / new file (createAtTarget never called).
    expect(
      vi.mocked(CryptoService.encrypt).mock.calls.some(
        ([text, password]) => text === 'opened local text' && password === 'rotated password',
      ),
    ).toBe(true)
    expect(localFileState.createAtTarget).not.toHaveBeenCalled()

    // The session continues under the new password: a later autosave uses it.
    vi.mocked(CryptoService.encrypt).mockClear()
    fireEvent.change(screen.getByTestId('editor'), {
      target: { value: 'opened local text plus an edit' },
    })
    await waitFor(
      () => {
        expect(
          vi.mocked(CryptoService.encrypt).mock.calls.some(
            ([text, password]) =>
              text === 'opened local text plus an edit' && password === 'rotated password',
          ),
        ).toBe(true)
      },
      { timeout: 4000 },
    )
  })

  it('a cancelled Save As picker aborts silently before any password dialog', async () => {
    localFileState.pickCreateTarget.mockRejectedValueOnce(
      new DOMException('The user aborted a request.', 'AbortError'),
    )

    render(<App />)

    await screen.findByText('recent-note.txt')
    await openSelectedThroughDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Save As…' }))

    await waitFor(() => expect(localFileState.pickCreateTarget).toHaveBeenCalled())
    expect(screen.queryByText('Set a password for the file')).toBeNull()
    expect(localFileState.createAtTarget).not.toHaveBeenCalled()
    expect(screen.queryByText('Unable to save to that file.')).toBeNull()
    // The session is unchanged.
    expect(screen.getByTestId('editor')).toHaveProperty('value', 'opened local text')
  })

  it('cancelling the Change Password dialog leaves the password unchanged', async () => {
    const { CryptoService } = await import('./crypto/cryptoService')

    render(<App />)

    await screen.findByText('recent-note.txt')
    await openSelectedThroughDialog()

    vi.mocked(CryptoService.encrypt).mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
    await screen.findByText('Set a new password')
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByText('Password changed')).toBeNull()
    expect(vi.mocked(CryptoService.encrypt)).not.toHaveBeenCalled()

    // A later autosave still uses the ORIGINAL password.
    fireEvent.change(screen.getByTestId('editor'), {
      target: { value: 'opened local text plus an edit' },
    })
    await waitFor(
      () => {
        expect(
          vi.mocked(CryptoService.encrypt).mock.calls.some(
            ([, password]) => password === 'correct horse battery staple',
          ),
        ).toBe(true)
      },
      { timeout: 4000 },
    )
  })

  it('Browse opens the picker first, then the unlock dialog for the chosen file', async () => {
    render(<App />)

    await screen.findByText('recent-note.txt')
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }))

    // File first, password second (SPEC §2).
    await screen.findByText('Unlock local file')
    expect(localFileState.open).toHaveBeenCalled()

    const dialog = screen.getByRole('dialog')

    fireEvent.change(within(dialog).getByLabelText('Password'), {
      target: { value: 'correct horse battery staple' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))

    expect(await screen.findByTestId('editor')).toHaveProperty('value', 'opened local text')
  })

  it('cancelling the Browse unlock dialog keeps the file listed with a hint', async () => {
    render(<App />)

    await screen.findByText('recent-note.txt')
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }))

    await screen.findByText('Unlock local file')
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))

    expect(await screen.findByText('File selected. Unlock it with its password.')).not.toBeNull()
    // The browsed file joined the recent list (selected) for a later Open.
    expect(await screen.findByText('browsed-2.txt')).not.toBeNull()
    expect(screen.queryByTestId('editor')).toBeNull()
  })
})
