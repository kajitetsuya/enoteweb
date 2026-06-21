import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import { CryptoService, getEnvelopeSecretKeyMode } from './crypto/cryptoService'

const dropboxState = vi.hoisted(() => ({
  adoptLinkedAccountDiscardingRecents: vi.fn(async () => undefined),
  adoptRemoteConflictEnvelope: vi.fn(async () => undefined),
  adoptReplacementCandidate: vi.fn(
    async (): Promise<
      | { kind: 'up-to-date' }
      | { kind: 'pushed' }
      | { kind: 'refreshed' }
      | { kind: 'stale' }
      | { kind: 'diverged' }
      | { kind: 'missing' }
      | { kind: 'replacement-candidate' }
      | { kind: 'ineligible' }
      | { kind: 'check-failed' }
    > => ({ kind: 'refreshed' }),
  ),
  beginLink: vi.fn(async () => undefined),
  completeLinkFromRedirect: vi.fn(
    async (): Promise<{
      accountMismatch: { newAccountId: string; previousAccountId: string } | null
      unverifiedOwnership: boolean
    } | null> => null,
  ),
  createRemoteFile: vi.fn(async () => undefined),
  declineLinkedAccount: vi.fn(async () => undefined),
  exportRecentFileCopy: vi.fn(async (): Promise<string | null> => dropboxState.envelope),
  getRecentFiles: vi.fn(
    async (): Promise<{
      files: {
        key: string
        name: string
        folderPath: string
        syncedModifiedAt: string | null
        localModifiedAt: string | null
        hasCache: boolean
        hasUnsyncedChanges: boolean
      }[]
      selectedKey: string | null
    }> => ({ files: [], selectedKey: null }),
  ),
  openRecentFile: vi.fn(async (): Promise<string | null> => dropboxState.envelope),
  removeRecentFile: vi.fn(async () => undefined),
  setSelectedRecentFile: vi.fn(async () => undefined),
  clearVault: vi.fn(async () => {
    dropboxState.vaultEnvelope = null
  }),
  // The background revision check: per-key outcome; tests override per
  // key/options to drive the indicators and the first-sync gate.
  checkRecentFile: vi.fn(
    async (
      key: string,
      options?: { refreshStaleCache?: boolean },
    ): Promise<{
      kind:
        | 'up-to-date'
        | 'pushed'
        | 'refreshed'
        | 'stale'
        | 'diverged'
        | 'missing'
        | 'replacement-candidate'
        | 'ineligible'
        | 'check-failed'
    }> => {
      void key
      void options
      return { kind: 'up-to-date' }
    },
  ),
  // Cache-only save for a paused session.
  saveLocalOnly: vi.fn(async (envelope: string) => {
    dropboxState.envelope = envelope
  }),
  loadConflictEnvelopes: vi.fn(
    async (): Promise<{
      baseEnvelope: string | null
      localEnvelope: string
      remoteEnvelope: string | null
      remoteConflictRev: string | null
    } | null> => null,
  ),
  commitMergedEnvelope: vi.fn(async () => undefined),
  disconnectRemoteFile: vi.fn(async () => undefined),
  listFolder: vi.fn(async () => ({ entries: [], truncated: false })),
  replaceRemoteFile: vi.fn(async () => undefined),
  // The existence probe behind the overwrite confirmation. The default is a
  // free path (Create probes before its password dialog); overwrite tests
  // override per-call with an existing file at rev-probe.
  statRemoteTxtFile: vi.fn(
    async (): Promise<
      | { exists: false }
      | {
          exists: true
          id: string | null
          name: string
          pathDisplay: string
          rev: string
          serverModified: string | null
        }
    > => ({ exists: false }),
  ),
  selectRemoteFile: vi.fn(async () => dropboxState.envelope),
  envelope: 'encrypted-dropbox-envelope',
  // The vault "primary" bytes — the DRAFT, a separate document
  // from the selected Dropbox record. Defaults equal to `envelope` (the
  // pre-flip shared-working-copy shape); the divergence regression sets it to
  // different bytes to prove unlock never reads the draft.
  vaultEnvelope: 'encrypted-dropbox-envelope' as string | null,
  getSyncState: vi.fn(async (): Promise<Record<string, unknown>> => ({
    accountLabel: 'dbid:test',
    authLost: false,
    hasPendingLocalEnvelope: true,
    hasRemoteConflictEnvelope: false,
    hasRetainedAuth: false,
    lastSyncAt: null,
    lastSyncStatus: 'pending-local',
    linked: false,
    pendingAccountSwitch: null as string | null,
    selectedFileId: 'id:notes' as string | null,
    selectedName: 'notes.txt' as string | null,
    selectedPathDisplay: '/Notes/notes.txt' as string | null,
  })),
  hasSelectedRemote: vi.fn(async () => true),
  hasUnsyncedLocalChanges: vi.fn(async () => false),
  load: vi.fn(async (): Promise<string | null> => 'encrypted-dropbox-envelope'),
  save: vi.fn(async (envelope: string) => {
    dropboxState.envelope = envelope
  }),
  status: vi.fn(async () => ({
    detail: 'Dropbox is not linked. Encrypted local cache is available.',
    state: 'needs-user-action',
  })),
  syncNow: vi.fn(async () => ({
    detail: 'Pending Dropbox sync to /Notes/notes.txt.',
    state: 'pending-sync',
  })),
  unlink: vi.fn(async () => undefined),
}))

export const getDropboxState = () => dropboxState

vi.mock('./crypto/cryptoService', () => ({
  CryptoService: {
    decrypt: vi.fn(async () => 'opened dropbox text'),
    encrypt: vi.fn(async () => 'new encrypted dropbox envelope'),
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
  getStorageProvider: () => ({
    kind: 'dropbox',
    adoptLinkedAccountDiscardingRecents: dropboxState.adoptLinkedAccountDiscardingRecents,
    adoptRemoteConflictEnvelope: dropboxState.adoptRemoteConflictEnvelope,
    adoptReplacementCandidate: dropboxState.adoptReplacementCandidate,
    beginLink: dropboxState.beginLink,
    completeLinkFromRedirect: dropboxState.completeLinkFromRedirect,
    createRemoteFile: dropboxState.createRemoteFile,
    declineLinkedAccount: dropboxState.declineLinkedAccount,
    exportRecentFileCopy: dropboxState.exportRecentFileCopy,
    getRecentFiles: dropboxState.getRecentFiles,
    openRecentFile: dropboxState.openRecentFile,
    removeRecentFile: dropboxState.removeRecentFile,
    setSelectedRecentFile: dropboxState.setSelectedRecentFile,
    checkRecentFile: dropboxState.checkRecentFile,
    saveLocalOnly: dropboxState.saveLocalOnly,
    loadConflictEnvelopes: dropboxState.loadConflictEnvelopes,
    commitMergedEnvelope: dropboxState.commitMergedEnvelope,
    listFolder: dropboxState.listFolder,
    replaceRemoteFile: dropboxState.replaceRemoteFile,
    statRemoteTxtFile: dropboxState.statRemoteTxtFile,
    disconnectRemoteFile: dropboxState.disconnectRemoteFile,
    exportLocalConflictCopy: async () => dropboxState.envelope,
    // The no-network current-document read returns the same bytes as the
    // mocked vaultStore.getVault(), so unlock flows use the vault envelope.
    loadLocalEnvelope: async () => dropboxState.envelope,
    getSyncState: dropboxState.getSyncState,
    hasSelectedRemote: dropboxState.hasSelectedRemote,
    hasUnsyncedLocalChanges: dropboxState.hasUnsyncedLocalChanges,
    load: dropboxState.load,
    save: dropboxState.save,
    status: dropboxState.status,
    selectRemoteFile: dropboxState.selectRemoteFile,
    syncNow: dropboxState.syncNow,
    unlink: dropboxState.unlink,
  }),
}))

vi.mock('./storage/vaultStore', () => ({
  vaultStore: {
    getSetting: async () => null,
    saveSetting: async () => undefined,
    getVault: async () =>
      dropboxState.vaultEnvelope === null ? null : { envelope: dropboxState.vaultEnvelope },
    saveEnvelope: async () => undefined,
    // The draft slot: Delete draft and the promotion clear it.
    clearVault: dropboxState.clearVault,
  },
}))

vi.mock('./editor/CodeMirrorEditor', async () => {
  const React = await import('react')

  return {
    CodeMirrorEditor: React.forwardRef(
      (
        {
          value,
        }: {
          value: string
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
          readOnly: true,
          value,
        })
      },
    ),
  }
})

// Drives the Dropbox file browser's destination mode: type a file name into
// the field and click Save. The mock listFolder lists an empty root, so the
// chosen destination is `/${name}` — the downstream gates (overwrite confirm,
// revision re-probe) run the same regardless of folder (manual path entry was
// removed; the browser is the single destination picker).
export const chooseDropboxDestination = async (name: string) => {
  fireEvent.change(await screen.findByLabelText('File name'), { target: { value: name } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
}

// The create-password dialog driver left with the removed home Create file
// flow; New draft tests reintroduce a two-field dialog helper.

beforeEach(() => {
  dropboxState.envelope = 'encrypted-dropbox-envelope'
  dropboxState.vaultEnvelope = 'encrypted-dropbox-envelope'
  dropboxState.adoptLinkedAccountDiscardingRecents.mockClear()
  dropboxState.adoptRemoteConflictEnvelope.mockClear()
  dropboxState.adoptReplacementCandidate.mockReset()
  dropboxState.adoptReplacementCandidate.mockResolvedValue({ kind: 'refreshed' })
  dropboxState.beginLink.mockClear()
  dropboxState.declineLinkedAccount.mockClear()
  // Reset (not just clear): per-test completion overrides (the guard cases)
  // must not leak.
  dropboxState.completeLinkFromRedirect.mockReset()
  dropboxState.completeLinkFromRedirect.mockResolvedValue(null)
  dropboxState.exportRecentFileCopy.mockClear()
  // Reset (not just clear): per-test recents overrides must not leak.
  dropboxState.getRecentFiles.mockReset()
  dropboxState.getRecentFiles.mockResolvedValue({ files: [], selectedKey: null })
  dropboxState.openRecentFile.mockClear()
  dropboxState.removeRecentFile.mockClear()
  dropboxState.setSelectedRecentFile.mockClear()
  dropboxState.clearVault.mockClear()
  dropboxState.completeLinkFromRedirect.mockClear()
  dropboxState.createRemoteFile.mockClear()
  // Reset (not just clear): per-test `load` overrides (the no-vault state)
  // must not leak — vi.restoreAllMocks does not touch plain vi.fn mocks.
  dropboxState.load.mockReset()
  dropboxState.load.mockResolvedValue('encrypted-dropbox-envelope')
  dropboxState.listFolder.mockClear()
  dropboxState.replaceRemoteFile.mockClear()
  dropboxState.statRemoteTxtFile.mockClear()
  dropboxState.disconnectRemoteFile.mockClear()
  dropboxState.selectRemoteFile.mockClear()
  // Reset (not just clear): the per-test linked-state overrides below must not
  // leak into the next test, mirroring how `status` is handled.
  dropboxState.getSyncState.mockReset()
  dropboxState.getSyncState.mockResolvedValue({
    accountLabel: 'dbid:test',
    authLost: false,
    hasPendingLocalEnvelope: true,
    hasRemoteConflictEnvelope: false,
    lastSyncAt: null,
    lastSyncStatus: 'pending-local',
    linked: false,
    pendingAccountSwitch: null,
    selectedFileId: 'id:notes',
    selectedName: 'notes.txt',
    selectedPathDisplay: '/Notes/notes.txt',
  })
  dropboxState.hasSelectedRemote.mockClear()
  dropboxState.hasSelectedRemote.mockResolvedValue(true)
  dropboxState.hasUnsyncedLocalChanges.mockClear()
  dropboxState.hasUnsyncedLocalChanges.mockResolvedValue(false)
  // Reset (not just clear): a per-test mockRejectedValueOnce (e.g. the failed-flush
  // case) must not leak its queued rejection into a later test, since mockClear
  // leaves the once-queue intact.
  vi.mocked(CryptoService.encrypt).mockReset()
  vi.mocked(CryptoService.encrypt).mockResolvedValue('new encrypted dropbox envelope')
  // Reset (not just clear): the secret-key×Dropbox block overrides the envelope
  // mode to 'required-v1'; restore the suite-wide 'none' default so no later
  // test sees an inline Secret-key field or the required-key unlock path.
  vi.mocked(CryptoService.decrypt).mockReset()
  vi.mocked(CryptoService.decrypt).mockResolvedValue('opened dropbox text')
  vi.mocked(getEnvelopeSecretKeyMode).mockReset()
  vi.mocked(getEnvelopeSecretKeyMode).mockReturnValue('none')
  dropboxState.load.mockClear()
  dropboxState.save.mockClear()
  // Reset (not just clear) so a per-test status override — e.g. the 'ready'
  // case — cannot leak into the next test.
  dropboxState.status.mockReset()
  dropboxState.status.mockResolvedValue({
    detail: 'Dropbox is not linked. Encrypted local cache is available.',
    state: 'needs-user-action',
  })
  dropboxState.syncNow.mockReset()
  dropboxState.syncNow.mockResolvedValue({
    detail: 'Pending Dropbox sync to /Notes/notes.txt.',
    state: 'pending-sync',
  })
  dropboxState.unlink.mockClear()
  // Reset (not just clear): per-test outcome overrides (diverged/missing/
  // stale) must not leak into later tests' home check passes.
  dropboxState.checkRecentFile.mockReset()
  dropboxState.checkRecentFile.mockResolvedValue({ kind: 'up-to-date' })
  dropboxState.saveLocalOnly.mockClear()
  dropboxState.loadConflictEnvelopes.mockReset()
  dropboxState.loadConflictEnvelopes.mockResolvedValue(null)
  dropboxState.commitMergedEnvelope.mockClear()
})

afterEach(() => {
  cleanup()
})
