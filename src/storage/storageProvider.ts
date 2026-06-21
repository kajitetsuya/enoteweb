export type StorageModeKind = 'local-file' | 'dropbox'
export type StorageProviderKind = StorageModeKind | 'draft'

export type StorageStatus =
  | { state: 'ready'; detail: string }
  | { state: 'needs-user-action'; detail: string }
  | { state: 'pending-sync'; detail: string }
  | { state: 'conflict'; detail: string }
  | { state: 'offline'; detail: string }
  | { state: 'error'; detail: string }

export type StorageProvider = {
  kind: StorageProviderKind
  load: () => Promise<string>
  save: (envelope: string) => Promise<void>
  status: () => Promise<StorageStatus>
}

export type DropboxSyncStatus =
  | 'never'
  | 'synced'
  | 'pending-local'
  | 'conflict'
  | 'offline'
  | 'error'

export type DropboxSyncState = {
  accountLabel: string | null
  // The home Dropbox block's authorization-lost state (SPEC §9): true after
  // an involuntary token clear, so the block renders Relink + export-only
  // instead of the voluntary-unlink Link-only state.
  authLost: boolean
  hasPendingLocalEnvelope: boolean
  hasRemoteConflictEnvelope: boolean
  // True when the app is voluntarily unlinked but still has a retained Dropbox
  // grant for the remembered account. The UI uses it to offer Continue/Switch;
  // it never exposes token material.
  hasRetainedAuth: boolean
  // The working copy (pending envelope or current vault) differs from the
  // last-synced snapshot — i.e. Sync would push something. Valid in every
  // provider mode, unlike the active provider's status, which when no Dropbox
  // file is selected (the draft) describes the local copy and says nothing
  // about Dropbox.
  hasUnsyncedLocal: boolean
  // Internal: the selected record's synced VERSION date (its `client_modified`),
  // not a device clock and not surfaced in the recents columns (those read the
  // per-record `syncedModifiedAt`/`localModifiedAt`). Kept for the account-level
  // "has ever synced" status string. (SPEC §8)
  lastSyncAt: string | null
  lastSyncStatus: DropboxSyncStatus
  linked: boolean
  // Non-null while the account-switch guard is unresolved (the newly linked
  // account id); every Dropbox operation refuses until adopt/decline (SPEC §9).
  pendingAccountSwitch: string | null
  pendingAccountSwitchLabel?: string | null
  selectedFileId: string | null
  selectedName: string | null
  selectedPathDisplay: string | null
}

// The three encrypted sides of a Dropbox conflict, handed to the app layer so it
// can decrypt-and-merge in memory (SPEC §9). Every field is an encrypted envelope
// or a revision string — never plaintext.
export type ConflictEnvelopes = {
  // The last-synced base snapshot; null when there is no base envelope at all.
  // The app decides "no usable base" (passes base=null to the merge) from the
  // decrypt outcome, since base usability requires the password.
  baseEnvelope: string | null
  // The local unsynced envelope (pending, else the current vault envelope).
  localEnvelope: string
  // The downloaded remote snapshot; null when it could not be captured.
  remoteEnvelope: string | null
  // The revision a resolution must be committed against; null with no remote.
  remoteConflictRev: string | null
}

// One entry of a Dropbox folder listing for the file browser (SPEC §9). Held in
// memory only — listing metadata is never persisted.
export type DropboxFolderEntry = {
  kind: 'file' | 'folder' | 'other'
  name: string
  pathDisplay: string
  pathLower: string
  rev: string | null
  serverModified: string | null
  size: number | null
}

export type DropboxFolderListing = {
  entries: DropboxFolderEntry[]
  // True when the listing stopped at the entry cap (SPEC §9: "Showing the
  // first 10000 entries.").
  truncated: boolean
}

// Result of the existence probe behind the overwrite confirmation (SPEC §9):
// the returned revision is what the confirmed replace is conditional on. `id`
// is the Dropbox file id ("id:..."), threaded so the editor can tell whether a
// chosen overwrite destination is the CURRENT session's own bound Dropbox file
// (force-out-of-conflict is matched by id, not merely the same path). Null
// when Dropbox omitted it.
export type DropboxRemoteFileStat =
  | { exists: false }
  | {
      exists: true
      id: string | null
      name: string | null
      pathDisplay: string | null
      rev: string
      // ISO server-modified time, for the force-out-of-conflict consequence
      // confirmation ("remote last changed <when>"). Null when Dropbox omitted it.
      serverModified: string | null
    }

// One row of the home recent-files table (SPEC §9), shaped for the UI: no
// envelope bytes, just identity, recency, and the flags the block needs.
export type DropboxRecentFile = {
  key: string
  name: string
  // The PARENT FOLDER path (SPEC §9): `name` already carries the filename,
  // so the Path column never duplicates it. "/" for a root file.
  folderPath: string
  // The `Last synced` column: the synced remote version's `client_modified`
  // (SPEC §8). Null until the record has synced at least once.
  syncedModifiedAt: string | null
  // The `Last modified` column: the working copy's own modified time (SPEC §8).
  localModifiedAt: string | null
  // False = the robustness case: listed but not cached (Open re-downloads).
  hasCache: boolean
  // Unsynced local changes exist — drives the Delete-from-list strong warning
  // and the Unlink warning.
  hasUnsyncedChanges: boolean
}

export type DropboxRecentFiles = {
  files: DropboxRecentFile[]
  // The persisted selection the home Open action acts on.
  selectedKey: string | null
}

// One record's background revision-check outcome (SPEC §9). The row indicators
// (`diverged` / `missing` / `replacement-candidate` / `ineligible`) are
// session memory derived from these outcomes — the app holds them in state,
// never in storage.
export type DropboxRecentFileCheck =
  // Remote revision matches the base and nothing is unsynced (covers a
  // silently adopted rename/move and a metadata-only revision bump).
  | { kind: 'up-to-date' }
  // Pending local changes were flushed with a revision-conditional upload.
  | { kind: 'pushed' }
  // Stale-but-clean: the cache adopted the newer remote envelope. Never a
  // conflict, never red (SPEC §9).
  | { kind: 'refreshed' }
  // Stale-but-clean detected but the cache was NOT refreshed — either the
  // caller disabled the refresh (an open editor session must never have its
  // cache swapped underneath it: the first-sync gate's probe) or the download
  // failed. The next online Open refreshes before the password dialog.
  | { kind: 'stale' }
  // Remote changed AND unsynced local changes exist — the conflict indicator.
  | { kind: 'diverged' }
  // The id no longer resolves: deleted remotely (or deleted-and-recreated,
  // with no exact same-path candidate).
  | { kind: 'missing' }
  // The id no longer resolves, but an eligible different file now exists at the
  // same stored lower path. Report-only until the user confirms adoption.
  | { kind: 'replacement-candidate' }
  // Renamed remotely outside `.txt`/`.text`: the record adopted the real
  // current name/path and the row renders export-only.
  | { kind: 'ineligible' }
  // Probe or network failure (or the check could not run): no indicator
  // change (SPEC §9 probe failure).
  | { kind: 'check-failed' }

// What a processed OAuth callback reports for the account-switch guard
// (SPEC §9). `accountMismatch` set = the linked account differs from the
// stored cache owner and recent files exist (the app must offer
// discard-and-continue / cancel before any sync). `unverifiedOwnership` =
// ownership was unknown (no stored account id) with recent files present; the id
// was adopted, and the app shows the one-time naming confirmation.
export type DropboxLinkCompletion = {
  accountMismatch: { newAccountId: string; previousAccountId: string } | null
  unverifiedOwnership: boolean
}

export type DropboxLinkOptions = {
  // Dropbox consent screen. This does not by itself switch accounts.
  forceReapprove?: boolean
  // Dropbox sign-in step. Use only when the user explicitly chooses to switch
  // away from the remembered account.
  forceReauthentication?: boolean
  // Forget the retained grant before starting OAuth. Used only for the explicit
  // Switch path; recent files and their owner remain until a different-account
  // callback is confirmed.
  forgetRetainedAuth?: boolean
}

export type SyncStorageProvider = StorageProvider & {
  kind: 'dropbox'
  // The account-switch guard's two resolutions (SPEC §9).
  adoptLinkedAccountDiscardingRecents: (newAccountId: string) => Promise<void>
  // Ciphertext-only non-mergeable escape: when the captured remote conflict
  // copy cannot be decrypted with the current password, the user may still
  // keep that Dropbox copy by making it the local cache/base and clearing the
  // local pending conflict. No upload, decrypt, or re-encryption occurs.
  adoptRemoteConflictEnvelope: (envelope: string, remoteConflictRev: string) => Promise<void>
  declineLinkedAccount: () => Promise<void>
  // Link starts Dropbox OAuth. `forceReapprove` shows consent again;
  // `forceReauthentication` forces Dropbox sign-in/account switching.
  beginLink: (options?: DropboxLinkOptions) => Promise<void>
  commitMergedEnvelope: (envelope: string, expectedRemoteRev: string) => Promise<void>
  // Null when the URL carried no OAuth callback; otherwise the completion
  // report for the account-switch guard.
  completeLinkFromRedirect: (href?: string) => Promise<DropboxLinkCompletion | null>
  createRemoteFile: (path: string, envelope: string) => Promise<void>
  // Home `Open`: selects the record, refreshes recency, and returns its local
  // bytes (downloading first for a cache-less record). Null = unknown key.
  openRecentFile: (key: string) => Promise<string | null>
  // The recent-files table data (SPEC §9), newest-opened first.
  getRecentFiles: () => Promise<DropboxRecentFiles>
  // Persist the table's row selection (no network, no open). A selection
  // CHANGE clears the account-level transitional conflict fields — they
  // describe the previously selected file (SPEC §8), and a lingering remote
  // snapshot must never be merged against another row's local/base.
  setSelectedRecentFile: (key: string | null) => Promise<void>
  // Row-menu `Delete from list`: removes the record AND its cache; never the
  // Dropbox file. Clears the persisted selection if it pointed there.
  removeRecentFile: (key: string) => Promise<void>
  // Per-row Export (auth-lost / missing states): the row's stored envelope
  // (pending else cache), with no password step. Null = nothing cached.
  exportRecentFileCopy: (key: string) => Promise<string | null>
  // User-confirmed adoption of a same-path replacement candidate: re-probes the
  // exact stored path, rewrites the record to the candidate's file id, and then
  // reports the resulting row state (synced/refreshed or diverged).
  adoptReplacementCandidate: (key: string) => Promise<DropboxRecentFileCheck>
  // One record's background revision check (SPEC §9): by-id metadata probe,
  // fixed-order outcome processing (missing → metadata adoption/eligibility →
  // content equality → revision/pending classification). Mutates the record
  // only for safe adoptions (rename/move, metadata-only rev, the
  // stale-but-clean refresh, a pending-push flush) — divergence and missing
  // are reported, never persisted. `refreshStaleCache: false` makes the
  // stale-but-clean case report `stale` instead of downloading (the open
  // session's probe must never swap the cache underneath the editor).
  checkRecentFile: (
    key: string,
    options?: { refreshStaleCache?: boolean },
  ) => Promise<DropboxRecentFileCheck>
  // Disconnects the selected Dropbox file (clears the selection + all sync state)
  // while keeping the OAuth link/refresh token, so re-connecting needs no re-auth.
  disconnectRemoteFile: () => Promise<void>
  exportLocalConflictCopy: () => Promise<string | null>
  exportRemoteConflictCopy: () => Promise<string | null>
  getSyncState: () => Promise<DropboxSyncState>
  // No-network check: are there local changes not known to be on Dropbox?
  // Used by the "Create file" discard guard. True for a pending local envelope,
  // any conflict signal, or a local cache that differs from the last-synced one.
  hasUnsyncedLocalChanges: () => Promise<boolean>
  // No-network check: is a remote Dropbox file currently selected? Uses the same
  // locator as sync (file id, lower path, or display path), so path-only records
  // are recognized.
  hasSelectedRemote: () => Promise<boolean>
  // Lists one Dropbox folder for the file browser (SPEC §9): complete listing
  // (all pages) capped at the entry limit; results live in memory only.
  listFolder: (path: string) => Promise<DropboxFolderListing>
  // No-network read of the current Dropbox document's freshest local bytes
  // (the selected record's pending envelope, else its cache; the account-level
  // fallback when nothing is selected). Unlock-time re-reads and pre-upload
  // reads use this instead of the vault, which holds the draft (SPEC §4/§8).
  loadLocalEnvelope: () => Promise<string | null>
  // `refreshRemote` re-downloads the remote conflict side (when online) so the
  // merge targets the freshest Dropbox copy rather than a possibly-stale
  // captured snapshot. Offline or on failure it falls back to the snapshot.
  loadConflictEnvelopes: (options?: {
    refreshRemote?: boolean
  }) => Promise<ConflictEnvelopes | null>
  // Cache-only save for a paused Dropbox file session (SPEC §9 first-sync
  // gate): writes the cache and the pending envelope, never uploads. The
  // pending envelope reaches Dropbox later through sync/resolution.
  saveLocalOnly: (envelope: string) => Promise<void>
  // Push-only "replace existing file" branch of Upload to Dropbox: replace an
  // existing path with the current vault and connect to it. Never pulls.
  // `expectedRev` is the revision observed by `statRemoteTxtFile` when the
  // overwrite confirmation was shown; the upload is conditional on it, so an
  // intervening remote change fails with 'conflict' instead of overwriting.
  replaceRemoteFile: (path: string, envelope: string, expectedRev: string) => Promise<void>
  selectRemoteFile: (path: string) => Promise<string>
  // Existence probe for the overwrite confirmation (SPEC §9). Only a missing
  // path reports exists: false; any other failure throws.
  statRemoteTxtFile: (path: string) => Promise<DropboxRemoteFileStat>
  // The fuller sync cycle (push + remote-revision check, SPEC §9 flow). A
  // stale-but-clean record (remote changed, local cache equals the
  // last-synced snapshot) is NEVER a conflict: with `adoptCleanRemote` the
  // remote is downloaded and adopted (home contexts — flow step 6); without
  // it the record is left untouched, because an open editor session's
  // cache/baseRev must never be swapped underneath the session — a later
  // push against the adopted revision would silently overwrite the remote
  // change the user never saw.
  syncNow: (options?: { adoptCleanRemote?: boolean }) => Promise<StorageStatus>
  unlink: () => Promise<void>
}

export const isSyncStorageProvider = (
  provider: StorageProvider,
): provider is SyncStorageProvider => provider.kind === 'dropbox'

export type StorageCapabilities = {
  hasFileSystemAccess: boolean
  isAndroid: boolean
  isDesktopChromium: boolean
  isIOS: boolean
}

const getNavigator = () => globalThis.navigator

export const detectStorageCapabilities = (): StorageCapabilities => {
  const navigator = getNavigator()
  const userAgent = navigator?.userAgent ?? ''
  const platform = navigator?.platform ?? ''
  const hasTouchMacPlatform =
    platform === 'MacIntel' && Number(navigator?.maxTouchPoints ?? 0) > 1
  const isIOS = /iPad|iPhone|iPod/.test(userAgent) || hasTouchMacPlatform
  const isAndroid = /Android/.test(userAgent)
  const isChromium = /Chrome|Chromium|Edg\//.test(userAgent)
  const isDesktopChromium = isChromium && !isIOS && !isAndroid
  const hasFileSystemAccess =
    typeof globalThis.showOpenFilePicker === 'function' &&
    typeof globalThis.showSaveFilePicker === 'function'

  return {
    hasFileSystemAccess,
    isAndroid,
    isDesktopChromium,
    isIOS,
  }
}

export const selectDefaultProviderKind = (
  capabilities = detectStorageCapabilities(),
): StorageModeKind => {
  if (capabilities.isDesktopChromium && capabilities.hasFileSystemAccess) {
    return 'local-file'
  }

  if (capabilities.isIOS || capabilities.isAndroid) {
    return 'dropbox'
  }

  // Desktop without the File System Access API (for example Firefox):
  // Dropbox Mode as well — its home carries the draft, so there is no
  // third mode (SPEC §2).
  return 'dropbox'
}
