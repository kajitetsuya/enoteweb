import { parseEnvelope } from '../crypto/cryptoService'
import { isEncryptedTextFileName } from '../exportFileNames'
import type {
  ConflictEnvelopes,
  DropboxFolderEntry,
  DropboxFolderListing,
  DropboxLinkOptions,
  DropboxRecentFileCheck,
  DropboxRemoteFileStat,
  DropboxSyncState,
  StorageStatus,
  SyncStorageProvider,
} from './storageProvider'
import {
  createDefaultDropboxSyncRecord,
  createPathDropboxFileKey,
  vaultStore,
  type DropboxFileRecord,
  type SyncRecord,
  type SyncRecordDraft,
  type VaultStore,
} from './vaultStore'

const DROPBOX_AUTH_URL = 'https://www.dropbox.com/oauth2/authorize'
const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token'
const DROPBOX_API_URL = 'https://api.dropboxapi.com/2'
const DROPBOX_CONTENT_URL = 'https://content.dropboxapi.com/2'
// `account_info.read` lets us resolve the human-readable account name/email
// (users/get_current_account) for the "Continue with <account>?" link prompt.
// Adding it changes the consent set, so already-linked users must re-link once.
const DROPBOX_SCOPES =
  'account_info.read files.content.read files.content.write files.metadata.read'
const TOKEN_EXPIRY_SKEW_MS = 60_000

type DropboxErrorCode =
  | 'account-switch-pending'
  | 'auth'
  | 'conflict'
  | 'corrupt'
  | 'invalid-path'
  | 'not-found'
  | 'offline'
  | 'rate-limited'
  | 'unconfigured'
  | 'unlinked'
  | 'unknown'

type DropboxTokenResponse = {
  access_token: string
  account_id?: string
  expires_in?: number
  refresh_token?: string
  scope?: string
  token_type: string
}

type DropboxFileMetadata = {
  '.tag'?: string
  client_modified?: string
  content_hash?: string
  id?: string
  name?: string
  path_display?: string
  path_lower?: string
  rev?: string
  server_modified?: string
}

// By-locator probe result for the recents background check (SPEC §9). Unlike
// DropboxRemoteFileStat this never hides an ineligible name behind an error —
// a remote rename outside .txt/.text must be DETECTED, so eligibility is
// reported as data. `isSyncEligible` requires an actual FILE (a path
// locator can resolve to a folder that merely ends in .txt) with a usable
// revision, plus the .txt/.text name.
export type DropboxRemoteFileProbe =
  | { exists: false }
  | {
      exists: true
      contentHash: string | null
      id: string | null
      isSyncEligible: boolean
      kind: 'file' | 'folder' | 'other'
      name: string | null
      pathDisplay: string | null
      pathLower: string | null
      rev: string | null
    }

type DropboxExistingRemoteFileProbe = Extract<DropboxRemoteFileProbe, { exists: true }>

export type DropboxRemoteDownload = {
  contentHash: string | null
  envelope: string
  id: string | null
  name: string | null
  pathDisplay: string | null
  pathLower: string | null
  rev: string
}

type DropboxDownloadResult = {
  envelope: string
  metadata: DropboxFileMetadata
  rev: string
}

type DropboxRawListEntry = {
  '.tag'?: string
  name?: string
  path_display?: string
  path_lower?: string
  rev?: string
  server_modified?: string
  size?: number
}

type DropboxListFolderResponse = {
  cursor?: string
  entries?: DropboxRawListEntry[]
  has_more?: boolean
}

// SPEC §9: paginated listings are fetched to exhaustion but capped, with a
// visible truncation notice; manual path entry covers anything beyond it.
export const LIST_FOLDER_ENTRY_CAP = 10_000

type DropboxProviderOptions = {
  appKey?: string
  fetch?: typeof fetch
  getHref?: () => string
  navigate?: (url: string) => void
  replaceHref?: (url: string) => void
  store?: VaultStore
}

export class DropboxProviderError extends Error {
  readonly code: DropboxErrorCode

  constructor(code: DropboxErrorCode, message: string) {
    super(message)
    this.name = 'DropboxProviderError'
    this.code = code
  }
}

const getConfiguredAppKey = () => import.meta.env.VITE_DROPBOX_APP_KEY?.trim() ?? ''

const isOnline = () => globalThis.navigator?.onLine !== false

const getDefaultHref = () => globalThis.location?.href ?? 'http://localhost/'

const getRedirectUri = (href = getDefaultHref()) => {
  const url = new URL(href)

  url.search = ''
  url.hash = ''
  return url.toString()
}

// Dropbox's list_folder uses '' (not '/') for the root; any other folder is a
// /-prefixed path, trailing slash stripped.
export const normalizeDropboxFolderPath = (pathInput: string) => {
  const trimmed = pathInput.trim()

  if (trimmed === '' || trimmed === '/') {
    return ''
  }

  if (!trimmed.startsWith('/')) {
    throw new DropboxProviderError('invalid-path', 'Dropbox folder path must start with /.')
  }

  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
}

const toFolderEntry = (raw: DropboxRawListEntry): DropboxFolderEntry | null => {
  const pathLower = raw.path_lower ?? null
  const pathDisplay = raw.path_display ?? pathLower
  const name = raw.name ?? pathDisplay?.split('/').filter(Boolean).at(-1) ?? null

  if (!name || !pathLower || !pathDisplay) {
    return null
  }

  return {
    kind: raw['.tag'] === 'folder' ? 'folder' : raw['.tag'] === 'file' ? 'file' : 'other',
    name,
    pathDisplay,
    pathLower,
    rev: raw.rev ?? null,
    serverModified: raw.server_modified ?? null,
    size: typeof raw.size === 'number' ? raw.size : null,
  }
}

export const normalizeDropboxTxtPath = (pathInput: string) => {
  const path = pathInput.trim()

  if (!path || !path.startsWith('/') || path.endsWith('/')) {
    throw new DropboxProviderError(
      'invalid-path',
      'Dropbox path must start with / and end in .txt or .text.',
    )
  }

  if (!isEncryptedTextFileName(path)) {
    throw new DropboxProviderError('invalid-path', 'Dropbox path must end in .txt or .text.')
  }

  return path
}

const getMetadataDisplayPath = (metadata: DropboxFileMetadata, fallbackPath: string | null = null) =>
  metadata.path_display ?? fallbackPath

const getMetadataName = (metadata: DropboxFileMetadata, displayPath: string | null) =>
  metadata.name ?? displayPath?.split('/').filter(Boolean).at(-1) ?? null

const assertTxtFileMetadata = (metadata: DropboxFileMetadata, fallbackPath: string | null = null) => {
  const displayPath = getMetadataDisplayPath(metadata, fallbackPath)
  const fileName = getMetadataName(metadata, displayPath)

  if (metadata['.tag'] && metadata['.tag'] !== 'file') {
    throw new DropboxProviderError('invalid-path', 'Dropbox path must point to a file.')
  }

  if (!fileName || !isEncryptedTextFileName(fileName)) {
    throw new DropboxProviderError('invalid-path', 'Dropbox file must end in .txt or .text.')
  }
}

const getSelectedRemoteLocator = (record: SyncRecord | null) =>
  record?.selectedFileId ?? record?.selectedPathLower ?? record?.selectedPathDisplay ?? null

const getSelectedRemoteDisplayPath = (record: SyncRecord | null) =>
  record?.selectedPathDisplay ?? record?.selectedPathLower ?? record?.selectedName ?? null

// The single source of truth for "an unresolved conflict exists". Treats every
// conflict signal as authoritative so a drifted record (status says one thing but
// a remote-conflict snapshot/rev is still present, or vice versa) is always
// handled as a conflict rather than letting an upload slip through.
const hasConflictSignal = (record: SyncRecord | null): boolean =>
  record?.lastSyncStatus === 'conflict' ||
  Boolean(record?.remoteConflictEnvelope) ||
  Boolean(record?.remoteConflictRev)

const base64UrlEncode = (bytes: Uint8Array) => {
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

const randomBase64Url = (byteLength: number) => {
  const bytes = new Uint8Array(byteLength)

  globalThis.crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

export const createPkceChallenge = async (verifier: string) => {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  )

  return base64UrlEncode(new Uint8Array(digest))
}

const parseDropboxResponseBody = async (response: Response) => {
  const text = await response.text().catch(() => '')

  if (!text) {
    return null
  }

  try {
    return JSON.parse(text) as { error?: unknown; error_summary?: string }
  } catch {
    return null
  }
}

const getDropboxErrorCode = (response: Response, errorSummary = ''): DropboxErrorCode => {
  const summary = errorSummary.toLowerCase()

  // `invalid_grant` is the OAuth token endpoint reporting a dead refresh token
  // (revoked from dropbox.com, expired); `missing_scope` is the token
  // lacking a now-required permission. Both mean "relink", same as a plain 401.
  if (
    response.status === 401 ||
    summary.includes('expired_access_token') ||
    summary.includes('invalid_access_token') ||
    summary.includes('invalid_grant') ||
    summary.includes('missing_scope')
  ) {
    return 'auth'
  }

  if (response.status === 429 || summary.includes('too_many')) {
    return 'rate-limited'
  }

  if (summary.includes('not_found') || summary.includes('not found')) {
    return 'not-found'
  }

  // Dropbox returns HTTP 409 for ALL route errors (insufficient_space,
  // disallowed_name, restricted_content, ...), so a bare 409 is not a revision
  // conflict. Only the error summary identifies one (`path/conflict/...` —
  // guaranteed by strict_conflict uploads). The bare-status fallback remains
  // only for a 409 whose body and status text yielded no summary at all.
  if (summary.includes('conflict') || (response.status === 409 && summary === '')) {
    return 'conflict'
  }

  return 'unknown'
}

// Dropbox-API-Arg is an HTTP header (a WebIDL ByteString): code points above
// U+00FF make fetch throw a TypeError, and U+0080–U+00FF would be sent as raw
// Latin-1 bytes, which Dropbox rejects. Escape every non-ASCII character as
// \uXXXX ("HTTP header safe JSON", mirroring the official SDK helper) so
// non-ASCII paths — e.g. Japanese filenames — work.
const httpHeaderSafeJson = (value: unknown) =>
  JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )

const throwDropboxResponseError = async (response: Response) => {
  const body = await parseDropboxResponseBody(response)
  // The OAuth token endpoint reports errors as `error: "invalid_grant"` (a
  // string), not `error_summary`; fold both shapes into one summary so the
  // code mapping sees them uniformly.
  const summary =
    body?.error_summary ??
    (typeof body?.error === 'string' ? body.error : null) ??
    response.statusText
  const code = getDropboxErrorCode(response, summary)

  throw new DropboxProviderError(code, `Dropbox request failed: ${summary}`)
}

const handleNetworkError = (error: unknown): never => {
  if (error instanceof DropboxProviderError) {
    throw error
  }

  throw new DropboxProviderError(
    isOnline() ? 'unknown' : 'offline',
    isOnline() ? 'Dropbox request failed.' : 'Device is offline.',
  )
}

// THE "anything to sync?" rule, shared by `hasUnsyncedLocalChanges()` (the
// Create-file discard guard) and `getSyncState().hasUnsyncedLocal` (the app's
// Save/sync availability) so the two can never disagree: unsynced when any
// conflict signal is present, a pending local envelope exists, or the vault
// envelope is not the last-synced snapshot. The vault comparison is what
// catches saves made while Dropbox is NOT the active provider (every save
// re-encrypts, so a Draft autosave diverges the vault from
// `lastSyncedEnvelope` without touching the sync record) — the active
// provider's status says nothing about Dropbox there and falsely read as
// synced before.
const computeHasUnsyncedLocal = (
  record: SyncRecord | null,
  vaultEnvelope: string | null,
): boolean =>
  hasConflictSignal(record) ||
  Boolean(record?.pendingLocalEnvelope) ||
  (vaultEnvelope ?? null) !== (record?.lastSyncedEnvelope ?? null)

const getSyncState = (
  record: SyncRecord | null,
  vaultEnvelope: string | null,
): DropboxSyncState => {
  const normalized = record ?? createDefaultDropboxSyncRecord()

  return {
    accountLabel: normalized.accountLabel,
    authLost: normalized.authLost,
    hasPendingLocalEnvelope: Boolean(normalized.pendingLocalEnvelope),
    hasRemoteConflictEnvelope: Boolean(normalized.remoteConflictEnvelope),
    hasRetainedAuth: Boolean(!normalized.linked && normalized.refreshToken),
    hasUnsyncedLocal: computeHasUnsyncedLocal(record, vaultEnvelope),
    lastSyncAt: normalized.lastSyncAt,
    lastSyncStatus: normalized.lastSyncStatus,
    linked: normalized.linked,
    pendingAccountSwitch: normalized.pendingAccountSwitch,
    pendingAccountSwitchLabel: normalized.pendingAccountSwitchLabel,
    selectedFileId: normalized.selectedFileId,
    selectedName: normalized.selectedName,
    selectedPathDisplay: normalized.selectedPathDisplay,
  }
}

// ---- Per-file record helpers (SPEC §8/§9) ----

// The API locator for a record: the raw id when the key is id-form, else the
// real path (a provisional "path:<pathLower>" key is NOT a valid API path).
const getRecordRemoteLocator = (record: DropboxFileRecord) =>
  record.key.startsWith('id:') ? record.key : record.pathLower

const getRecordFileId = (record: DropboxFileRecord) =>
  record.key.startsWith('id:') ? record.key : null

// The file's parent folder for the recents table's Path column (SPEC §9):
// "/Notes/notes.txt" → "/Notes", a root file → "/".
const getParentFolderPath = (pathDisplay: string) => {
  const index = pathDisplay.lastIndexOf('/')

  return index <= 0 ? '/' : pathDisplay.slice(0, index)
}

// The single source of truth for the modified-timestamp format (SPEC §8): whole
// seconds, UTC ("YYYY-MM-DDTHH:MM:SSZ"). Dropbox rejects sub-second
// `client_modified`, so we both store and upload in this truncated form — the
// value we persist, the value we send, and the value Dropbox echoes back are
// then byte-identical (`Last modified` == `Last synced` when clean).
const toDropboxTimestamp = (value: Date | string): string =>
  `${(typeof value === 'string' ? new Date(value) : value).toISOString().slice(0, 19)}Z`

// The three "remote conflict" fields cleared together (SPEC §8/§9). Spread into
// a saveDropboxSync draft alongside lastSyncStatus/selectedFileKey.
const clearedRemoteConflictFields = () => ({
  remoteConflictEnvelope: null,
  remoteConflictRev: null,
  remoteConflictClientModified: null,
})

// The three "remote conflict" fields set from an observed remote version.
const remoteConflictFields = (
  envelope: string,
  rev: string,
  clientModified: string | null | undefined,
) => ({
  remoteConflictEnvelope: envelope,
  remoteConflictRev: rev,
  remoteConflictClientModified: clientModified ? toDropboxTimestamp(clientModified) : null,
})

// Per-record "anything to sync?": conflict signal (still tracked on the sync
// record for the selected file), a pending envelope, or a cache that differs
// from the last-synced snapshot. The draft (vault "primary") is a SEPARATE
// document and deliberately does not count.
const computeRecordHasUnsynced = (
  syncRecord: SyncRecord | null,
  record: DropboxFileRecord,
): boolean =>
  hasConflictSignal(syncRecord) ||
  Boolean(record.pendingLocalEnvelope) ||
  (record.envelope ?? null) !== (record.lastSyncedEnvelope ?? null)

const getSyncStateFromRecord = (
  syncRecord: SyncRecord | null,
  record: DropboxFileRecord,
): DropboxSyncState => {
  const normalized = syncRecord ?? createDefaultDropboxSyncRecord()

  return {
    accountLabel: normalized.accountLabel,
    authLost: normalized.authLost,
    hasPendingLocalEnvelope: Boolean(record.pendingLocalEnvelope),
    hasRemoteConflictEnvelope: Boolean(normalized.remoteConflictEnvelope),
    hasRetainedAuth: Boolean(!normalized.linked && normalized.refreshToken),
    hasUnsyncedLocal: computeRecordHasUnsynced(syncRecord, record),
    // The status object's `lastSyncAt` now carries the selected record's synced
    // VERSION date (its `client_modified`), not a device clock; it is internal
    // (the recents columns read the per-record fields, not this).
    lastSyncAt: record.syncedModifiedAt,
    lastSyncStatus: normalized.lastSyncStatus,
    linked: normalized.linked,
    pendingAccountSwitch: normalized.pendingAccountSwitch,
    pendingAccountSwitchLabel: normalized.pendingAccountSwitchLabel,
    selectedFileId: getRecordFileId(record),
    selectedName: record.name,
    selectedPathDisplay: record.pathDisplay,
  }
}

export class DropboxProvider implements SyncStorageProvider {
  readonly kind = 'dropbox'

  private accessToken: string | null = null

  private accessTokenExpiresAt = 0

  private readonly appKey: string

  private readonly fetcher: typeof fetch

  private readonly getHref: () => string

  private readonly navigate: (url: string) => void

  private readonly replaceHref: (url: string) => void

  private readonly store: VaultStore

  constructor(options: DropboxProviderOptions = {}) {
    this.appKey = options.appKey ?? getConfiguredAppKey()
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.getHref = options.getHref ?? getDefaultHref
    this.navigate =
      options.navigate ??
      ((url) => {
        globalThis.location.assign(url)
      })
    this.replaceHref =
      options.replaceHref ??
      ((url) => {
        globalThis.history.replaceState(null, '', url)
      })
    this.store = options.store ?? vaultStore
  }

  // ---- Per-file state access ----

  // The provider's working state: the sync record plus the SELECTED file
  // record. A selected record means per-file (record-based) operation; null
  // means the unconnected vault-primary cache.
  private async getActiveState() {
    const syncRecord = await this.store.getDropboxSync()
    const fileRecord = syncRecord?.selectedFileKey
      ? await this.store.getDropboxFile(syncRecord.selectedFileKey)
      : null

    return { fileRecord, syncRecord }
  }

  // Rekey a provisional "path:<pathLower>" record to the raw file id once
  // metadata supplies one. Called only AFTER the flow's final write under the
  // old key (rekeying first would let a later put resurrect the old key). A
  // refused rekey (distinct pending envelopes) is tolerated — the path-keyed
  // record keeps working by path until one side flushes.
  private async maybeRekeyRecord(record: DropboxFileRecord, metadata: DropboxFileMetadata) {
    if (metadata.id && !record.key.startsWith('id:') && record.key !== metadata.id) {
      await this.store.rekeyDropboxFile(record.key, metadata.id).catch(() => null)
    }
  }

  private async findReplacementCandidate(record: DropboxFileRecord) {
    // Replacement adoption is defined only for id-keyed records whose stable id
    // no longer resolves. A path-keyed record has no old id to prove it is a
    // different file; if its path resolves, the normal path rekey flow handles
    // it.
    if (!record.key.startsWith('id:')) {
      return null
    }

    const candidate = await this.statRemoteFile(record.pathLower)

    if (
      !candidate.exists ||
      !candidate.id ||
      candidate.id === record.key ||
      !candidate.isSyncEligible ||
      !candidate.rev ||
      candidate.pathLower !== record.pathLower
    ) {
      return null
    }

    return candidate
  }

  // Marks a record synced to `metadata`/`envelope`: cache, base revision,
  // last-synced snapshot/content hash, and the modified timestamps move
  // together, identity adopts any rename/move the metadata reports, and the
  // sync record's status/conflict fields clear. Both `syncedModifiedAt` and
  // `localModifiedAt` take the metadata's `client_modified` (SPEC §8): on an
  // upload that echoes the `client_modified` we sent (= the working copy's
  // edit time), so `localModifiedAt` is unchanged; on a download/adopt it is
  // the remote version's modified time, so a file edited only elsewhere shows
  // that. `touchSyncRecord: false` skips the account-level status write — the
  // background check syncing a NON-selected record must never stamp fields that
  // describe the selected file.
  private async markRecordSynced(
    record: DropboxFileRecord,
    metadata: DropboxFileMetadata,
    envelope: string,
    options: { touchSyncRecord?: boolean } = {},
  ) {
    const pathDisplay = metadata.path_display ?? record.pathDisplay
    // Always present on real Dropbox file metadata; if somehow absent we keep
    // whatever the record already had rather than blanking the columns.
    const modifiedAt = metadata.client_modified
      ? toDropboxTimestamp(metadata.client_modified)
      : null

    await this.store.putDropboxFile({
      key: record.key,
      name: metadata.name ?? record.name,
      pathDisplay,
      pathLower: metadata.path_lower ?? record.pathLower,
      envelope,
      baseRev: metadata.rev ?? record.baseRev,
      lastSyncedEnvelope: envelope,
      lastSyncedContentHash: metadata.content_hash ?? null,
      pendingLocalEnvelope: null,
      syncedModifiedAt: modifiedAt ?? record.syncedModifiedAt,
      localModifiedAt: modifiedAt ?? record.localModifiedAt,
    })
    await this.maybeRekeyRecord(record, metadata)

    if (options.touchSyncRecord ?? true) {
      await this.store.saveDropboxSync({
        lastSyncStatus: 'synced',
        ...clearedRemoteConflictFields(),
      })
    }
  }

  private async clearSelectedRecoverableSyncError(
    syncRecord: SyncRecord | null,
    selectedKey: string,
  ) {
    if (
      syncRecord?.selectedFileKey === selectedKey &&
      syncRecord.lastSyncStatus === 'error' &&
      !syncRecord.pendingLocalEnvelope &&
      !hasConflictSignal(syncRecord)
    ) {
      await this.store.saveDropboxSync({ lastSyncStatus: 'synced' })
    }
  }

  async beginLink(options: DropboxLinkOptions = {}) {
    if (!this.appKey) {
      throw new DropboxProviderError('unconfigured', 'Dropbox app key is not configured.')
    }

    if (options.forgetRetainedAuth) {
      this.accessToken = null
      this.accessTokenExpiresAt = 0
      await this.store.clearDropboxAuth()
    }

    const state = randomBase64Url(18)
    const codeVerifier = randomBase64Url(48)
    const codeChallenge = await createPkceChallenge(codeVerifier)
    const redirectUri = getRedirectUri(this.getHref())
    const authorizeUrl = new URL(DROPBOX_AUTH_URL)

    authorizeUrl.searchParams.set('client_id', this.appKey)
    authorizeUrl.searchParams.set('code_challenge', codeChallenge)
    authorizeUrl.searchParams.set('code_challenge_method', 'S256')
    authorizeUrl.searchParams.set('redirect_uri', redirectUri)
    authorizeUrl.searchParams.set('response_type', 'code')
    authorizeUrl.searchParams.set('scope', DROPBOX_SCOPES)
    authorizeUrl.searchParams.set('state', state)
    authorizeUrl.searchParams.set('token_access_type', 'offline')
    if (options.forceReapprove) {
      authorizeUrl.searchParams.set('force_reapprove', 'true')
    }
    if (options.forceReauthentication) {
      authorizeUrl.searchParams.set('force_reauthentication', 'true')
    }

    await this.store.saveDropboxSync({
      codeVerifier,
      oauthState: state,
    })
    this.navigate(authorizeUrl.toString())
  }

  // Best-effort account label for the Settings display and the link prompt:
  // the account email, falling back to the display name, then
  // null. Needs the `account_info.read` scope; on any failure (missing scope on
  // a pre-upgrade token, network) returns null and the caller falls back to the
  // account id. Deliberately a direct fetch, NOT `rpc`: rpc's auth-retry would
  // clear the tokens on a 401, which must never happen as a side effect of
  // resolving a label right after a successful link.
  private async fetchAccountLabel(): Promise<string | null> {
    try {
      const accessToken = await this.getAccessToken()
      const response = await this.fetcher(`${DROPBOX_API_URL}/users/get_current_account`, {
        body: 'null',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })

      if (!response.ok) {
        return null
      }

      const account = (await response.json()) as {
        email?: string
        name?: { display_name?: string }
      }

      return account?.email ?? account?.name?.display_name ?? null
    } catch {
      return null
    }
  }

  async completeLinkFromRedirect(href = this.getHref()) {
    const url = new URL(href)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const error = url.searchParams.get('error')

    if (!code && !state && !error) {
      return null
    }

    if (error) {
      await this.store.saveDropboxSync({ codeVerifier: null, oauthState: null })
      this.clearOAuthQuery(url)
      throw new DropboxProviderError('auth', 'Dropbox authorization was not completed.')
    }

    const oauthRecord = await this.store.getDropboxSync()

    if (!code || !state || oauthRecord?.oauthState !== state || !oauthRecord.codeVerifier) {
      await this.store.saveDropboxSync({ codeVerifier: null, oauthState: null })
      this.clearOAuthQuery(url)
      throw new DropboxProviderError('auth', 'Dropbox authorization state did not match.')
    }

    const token = await this.exchangeAuthorizationCode(code, oauthRecord.codeVerifier, href)
    const refreshToken = token.refresh_token ?? oauthRecord.refreshToken

    if (!refreshToken) {
      // Terminal failure: the callback has been processed, so the PKCE/CSRF
      // material and the callback query parameters must not survive (SPEC §9).
      // (The network-failure path above deliberately keeps them so a fresh PWA
      // launch can retry the exchange.)
      await this.store.saveDropboxSync({ codeVerifier: null, oauthState: null })
      this.clearOAuthQuery(url)
      throw new DropboxProviderError('auth', 'Dropbox did not return a refresh token.')
    }

    this.rememberAccessToken(token)

    // The account-switch guard (SPEC §9): compare the OAuth-returned account
    // against the stored cache owner. A DIFFERENT owner with recent files
    // present must not be adopted silently — paths must never cross accounts —
    // so the id is left unchanged and the mismatch is reported for the app's
    // blocking choice (discard-and-continue / cancel). An UNKNOWN owner with
    // recent files adopts the id but reports it for the one-time naming
    // confirmation.
    //
    // Re-read after token exchange: the earlier sync record is authoritative
    // for the PKCE verifier, while ownership, labels, and retained recents must
    // be compared against the latest saved state.
    const syncRecord = (await this.store.getDropboxSync()) ?? createDefaultDropboxSyncRecord()

    const records = await this.store.getDropboxFiles()
    const hasRecords = records.length > 0
    const storedAccountId = syncRecord.accountId ?? null
    const newAccountId = token.account_id ?? null
    const accountMismatch =
      hasRecords && storedAccountId && newAccountId && storedAccountId !== newAccountId
        ? { newAccountId, previousAccountId: storedAccountId }
        : null
    const unverifiedOwnership = hasRecords && !storedAccountId && Boolean(newAccountId)

    // Resolve the account email now, while the new account's access token is
    // still in memory (the mismatch branch nulls it just below). On a mismatch
    // it is stored ONLY as the pending account's label; the retained data keeps
    // the previous account's label until the user explicitly adopts the switch.
    const accountLabel = await this.fetchAccountLabel()
    const nextAccountLabel = accountLabel ?? token.account_id ?? null

    await this.store.saveDropboxSync({
      accessTokenExpiresAt: new Date(this.accessTokenExpiresAt).toISOString(),
      // The cache-ownership identity (SPEC §8/§9): adopted only when it does
      // not conflict with existing recent files. On a mismatch the LABEL is
      // preserved too — the retained data must never be labeled with the
      // canceled account.
      accountId: accountMismatch ? storedAccountId : (newAccountId ?? syncRecord.accountId),
      accountLabel: accountMismatch
        ? syncRecord.accountLabel
        : (nextAccountLabel ?? syncRecord.accountLabel),
      authLost: false,
      codeVerifier: null,
      lastSyncStatus: syncRecord.pendingLocalEnvelope ? 'pending-local' : syncRecord.lastSyncStatus,
      linked: !accountMismatch,
      oauthState: null,
      pendingAccountSwitch: accountMismatch ? accountMismatch.newAccountId : null,
      pendingAccountSwitchLabel: accountMismatch ? nextAccountLabel : null,
      refreshToken,
    })
    this.clearOAuthQuery(url)
    return { accountMismatch, unverifiedOwnership }
  }

  // The account-switch guard's "discard and continue" (SPEC §9): wipe the
  // previous account's recent files and caches (the draft is untouched),
  // clear every transitional sync field the old account's state may have left
  // (conflict snapshot, pending, status), and adopt the newly linked account
  // as the owner — unblocking operations.
  async adoptLinkedAccountDiscardingRecents(newAccountId: string) {
    const syncRecord = await this.store.getDropboxSync()

    if (syncRecord?.pendingAccountSwitch !== newAccountId || !syncRecord.refreshToken) {
      throw new DropboxProviderError(
        'auth',
        'The pending Dropbox account link is no longer available.',
      )
    }

    await this.store.clearDropboxFiles()
    await this.store.clearDropboxFileSelection()
    await this.store.saveDropboxSync({
      accessTokenExpiresAt: null,
      accountId: newAccountId,
      accountLabel: syncRecord?.pendingAccountSwitchLabel ?? newAccountId,
      authLost: false,
      linked: true,
      pendingAccountSwitch: null,
      pendingAccountSwitchLabel: null,
      refreshToken: syncRecord.refreshToken,
    })
  }

  // The account-switch guard's "cancel": unlink again, leaving the previous
  // account's recent files, caches, and ownership intact for a later relink.
  // A user choice, so the block reads unlinked — not authorization-lost.
  async declineLinkedAccount() {
    this.accessToken = null
    this.accessTokenExpiresAt = 0
    await this.store.clearDropboxTokens({ authLost: false })
  }

  // The recent-files table data (SPEC §9): newest-opened first, with the
  // persisted selection. UI-shaped — no envelope bytes leave the provider.
  async getRecentFiles() {
    const [records, syncRecord] = await Promise.all([
      this.store.getDropboxFiles(),
      this.store.getDropboxSync(),
    ])

    // The sync record's conflict signal (status / captured remote snapshot)
    // belongs to the SELECTED file in the transitional model, so it counts as
    // unsynced for that row only — the Unlink/Delete warnings must not read
    // weak for a conflict-only state.
    const selectedHasConflict = hasConflictSignal(syncRecord)

    return {
      files: records.map((record) => ({
        key: record.key,
        name: record.name,
        // The table's Path column shows the FOLDER (SPEC §9) — Name already
        // carries the filename, so the full path would duplicate it.
        folderPath: getParentFolderPath(record.pathDisplay),
        syncedModifiedAt: record.syncedModifiedAt,
        localModifiedAt: record.localModifiedAt,
        hasCache: record.envelope !== null || record.pendingLocalEnvelope !== null,
        hasUnsyncedChanges:
          Boolean(record.pendingLocalEnvelope) ||
          (record.envelope ?? null) !== (record.lastSyncedEnvelope ?? null) ||
          (selectedHasConflict && record.key === syncRecord?.selectedFileKey),
      })),
      selectedKey: syncRecord?.selectedFileKey ?? null,
    }
  }

  // Writes the persisted row selection, clearing the account-level
  // transitional conflict fields when the selection actually CHANGES: those
  // fields describe the previously selected file (SPEC §8), and a lingering
  // `remoteConflictEnvelope` from another row must never be combined with
  // the new selection's local/base envelopes by `loadConflictEnvelopes`.
  // Nothing is lost by the clear — the old row's local side stays on its
  // record (`pendingLocalEnvelope`/cache), and the remote side is
  // re-downloadable, so its conflict is re-capturable any time.
  private async persistSelection(syncRecord: SyncRecord | null, key: string | null) {
    if ((syncRecord?.selectedFileKey ?? null) !== key && hasConflictSignal(syncRecord)) {
      await this.store.saveDropboxSync({
        lastSyncStatus: 'never',
        ...clearedRemoteConflictFields(),
      })
    }

    await this.store.setSelectedDropboxFileKey(key)
  }

  // Persist the recents-table row selection (SPEC §9 — "memorized like a
  // settings value"). Selection alone never touches the network.
  async setSelectedRecentFile(key: string | null) {
    await this.persistSelection(await this.store.getDropboxSync(), key)
  }

  // Row-menu `Delete from list` (SPEC §9): removes the record AND its cache —
  // never the Dropbox file. The store clears the selection atomically.
  async removeRecentFile(key: string) {
    await this.store.deleteDropboxFile(key)
  }

  // Per-row Export for the auth-lost and missing states (SPEC §9): the row's
  // stored ciphertext (pending else cache), no password step, no network.
  async exportRecentFileCopy(key: string) {
    const record = await this.store.getDropboxFile(key)

    return record ? (record.pendingLocalEnvelope ?? record.envelope ?? null) : null
  }

  // User-confirmed replacement adoption (SPEC §9): the background check only
  // reports that the old id is gone and a different eligible file now exists at
  // the same stored lower path. This method re-probes that exact path, rewrites
  // the record to the candidate's id, and then either marks the row clean (same
  // ciphertext / no cache) or records a normal conflict against the replacement.
  async adoptReplacementCandidate(key: string): Promise<DropboxRecentFileCheck> {
    const syncRecord = await this.store.getDropboxSync()

    if (
      !this.appKey ||
      !syncRecord?.linked ||
      !syncRecord.refreshToken ||
      Boolean(syncRecord.pendingAccountSwitch) ||
      !isOnline()
    ) {
      return { kind: 'check-failed' }
    }

    const record = await this.store.getDropboxFile(key)

    if (!record) {
      return { kind: 'check-failed' }
    }

    try {
      const oldFileProbe = await this.statRemoteFile(getRecordRemoteLocator(record))

      if (oldFileProbe.exists) {
        return this.checkRecentFile(key)
      }
    } catch {
      return { kind: 'check-failed' }
    }

    let candidate: DropboxExistingRemoteFileProbe | null

    try {
      candidate = await this.findReplacementCandidate(record)
    } catch {
      return { kind: 'check-failed' }
    }

    if (!candidate) {
      return { kind: 'missing' }
    }

    const candidateId = candidate.id

    if (!candidateId) {
      return { kind: 'check-failed' }
    }

    let remote: DropboxDownloadResult

    try {
      remote = await this.downloadRemote(candidateId)
    } catch {
      return { kind: 'check-failed' }
    }

    const replacementContentHash = remote.metadata.content_hash ?? candidate.contentHash ?? null
    const replacementMetadata: DropboxFileMetadata = {
      ...remote.metadata,
      id: remote.metadata.id ?? candidateId,
      name: remote.metadata.name ?? candidate.name ?? record.name,
      path_display: remote.metadata.path_display ?? candidate.pathDisplay ?? record.pathDisplay,
      path_lower: remote.metadata.path_lower ?? candidate.pathLower ?? record.pathLower,
      rev: remote.rev,
    }

    if (replacementContentHash) {
      replacementMetadata.content_hash = replacementContentHash
    }

    try {
      assertTxtFileMetadata(replacementMetadata, record.pathDisplay)
    } catch {
      return { kind: 'check-failed' }
    }

    const replacementKey = replacementMetadata.id ?? candidate.id
    const replacementPathLower = replacementMetadata.path_lower ?? null

    // The confirmation was for "same name at this path". If the replacement was
    // moved between the path probe and the download, do not silently adopt it.
    if (!replacementKey || !replacementPathLower || replacementPathLower !== record.pathLower) {
      return { kind: 'check-failed' }
    }

    const replacementPathDisplay = replacementMetadata.path_display ?? record.pathDisplay
    const replacementName =
      replacementMetadata.name ??
      replacementPathDisplay.split('/').filter(Boolean).at(-1) ??
      record.name
    const localEnvelope = record.pendingLocalEnvelope ?? record.envelope ?? null

    const target =
      replacementKey === record.key ? null : await this.store.getDropboxFile(replacementKey)
    const targetPending = target?.pendingLocalEnvelope ?? null

    // A pre-existing record for the replacement id may have its own unsynced
    // edit. Do not merge two independent local edits here; leave both records so
    // the user can resolve/delete explicitly.
    if (targetPending && targetPending !== localEnvelope) {
      return { kind: 'check-failed' }
    }

    const now = new Date()

    if (!localEnvelope || localEnvelope === remote.envelope) {
      await this.store.putDropboxFile(
        {
          key: replacementKey,
          name: replacementName,
          pathDisplay: replacementPathDisplay,
          pathLower: replacementPathLower,
          envelope: remote.envelope,
          baseRev: remote.rev,
          lastSyncedEnvelope: remote.envelope,
          lastSyncedContentHash: replacementContentHash,
          pendingLocalEnvelope: null,
          syncedModifiedAt: remote.metadata.client_modified
            ? toDropboxTimestamp(remote.metadata.client_modified)
            : null,
          localModifiedAt: remote.metadata.client_modified
            ? toDropboxTimestamp(remote.metadata.client_modified)
            : null,
          lastOpenedAt: record.lastOpenedAt,
        },
        now,
      )
      await this.persistSelection(await this.store.getDropboxSync(), replacementKey)

      if (replacementKey !== record.key) {
        await this.store.deleteDropboxFile(record.key)
      }

      await this.store.saveDropboxSync({
        lastSyncStatus: 'synced',
        ...clearedRemoteConflictFields(),
      })
      return { kind: 'refreshed' }
    }

    await this.store.putDropboxFile(
      {
        key: replacementKey,
        name: replacementName,
        pathDisplay: replacementPathDisplay,
        pathLower: replacementPathLower,
        // This cache belongs to the deleted file, not the replacement, so there
        // is no trustworthy common base for the merge. Preserve it as the local
        // side and record the replacement as the remote side.
        envelope: localEnvelope,
        baseRev: null,
        lastSyncedEnvelope: null,
        lastSyncedContentHash: null,
        pendingLocalEnvelope: localEnvelope,
        // No trustworthy synced version here (the deleted file is not the
        // candidate's ancestor); keep the working copy's own edit time.
        syncedModifiedAt: null,
        localModifiedAt: record.localModifiedAt,
        lastOpenedAt: record.lastOpenedAt,
      },
      now,
    )
    await this.persistSelection(await this.store.getDropboxSync(), replacementKey)

    if (replacementKey !== record.key) {
      await this.store.deleteDropboxFile(record.key)
    }

    await this.store.saveDropboxSync({
      lastSyncStatus: 'conflict',
      ...remoteConflictFields(remote.envelope, remote.rev, remote.metadata.client_modified),
    })
    return { kind: 'diverged' }
  }

  // One record's background revision check (SPEC §9): a by-locator metadata
  // probe whose outcomes are processed in a fixed order — missing first, then
  // metadata adoption and eligibility, then content equality, and only then
  // the revision/pending classification — so they cannot race each other.
  // Safe adoptions (rename/move, a metadata-only revision bump, the
  // stale-but-clean refresh, a pending-push flush) are persisted; divergence
  // and missing are REPORTED only, never persisted — the row indicators are
  // session memory (SPEC §8/§9). With `refreshStaleCache: false` the
  // stale-but-clean case reports `stale` without downloading: an open editor
  // session's probe must never swap the cache (and `baseRev`) underneath the
  // session, or a later push against the adopted revision would silently
  // overwrite the remote change the user never saw.
  async checkRecentFile(
    key: string,
    options: { refreshStaleCache?: boolean } = {},
  ): Promise<DropboxRecentFileCheck> {
    const refreshStaleCache = options.refreshStaleCache ?? true

    const syncRecord = await this.store.getDropboxSync()

    if (
      !this.appKey ||
      !syncRecord?.linked ||
      !syncRecord.refreshToken ||
      Boolean(syncRecord.pendingAccountSwitch) ||
      !isOnline()
    ) {
      return { kind: 'check-failed' }
    }

    const record = await this.store.getDropboxFile(key)

    if (!record) {
      return { kind: 'check-failed' }
    }

    const isSelected = syncRecord.selectedFileKey === key

    let probe: DropboxRemoteFileProbe

    try {
      probe = await this.statRemoteFile(getRecordRemoteLocator(record))
    } catch {
      // Probe failure (network/server/auth): no indicator change (SPEC §9).
      return { kind: 'check-failed' }
    }

    if (!probe.exists) {
      // A no-longer-resolving id normally reads as missing. One explicit
      // exception is user-mediated replacement adoption: if an eligible file
      // with a DIFFERENT id now exists at the exact stored lower path, report a
      // conflict-like candidate without mutating the record. The id is rewritten
      // only after the user confirms.
      try {
        if (await this.findReplacementCandidate(record)) {
          return { kind: 'replacement-candidate' }
        }
      } catch {
        return { kind: 'check-failed' }
      }

      // Otherwise the record and its exportable cache stay untouched.
      return { kind: 'missing' }
    }

    // Metadata adoption: a remote rename/move updates the record silently —
    // ids are stable, so the row simply shows the current name and path.
    const currentName = probe.name ?? record.name
    const currentPathDisplay = probe.pathDisplay ?? record.pathDisplay
    const currentPathLower = probe.pathLower ?? record.pathLower

    if (
      currentName !== record.name ||
      currentPathDisplay !== record.pathDisplay ||
      currentPathLower !== record.pathLower
    ) {
      await this.store.putDropboxFile({
        key: record.key,
        name: currentName,
        pathDisplay: currentPathDisplay,
        pathLower: currentPathLower,
      })
    }

    const identity = {
      key: record.key,
      name: currentName,
      pathDisplay: currentPathDisplay,
      pathLower: currentPathLower,
    }
    // A "path:" record rekeys to the probed id only after the
    // outcome's final write under the old key (see maybeRekeyRecord); every
    // return below funnels through this. (The pushed/refreshed paths rekey
    // inside markRecordSynced instead.)
    const finish = async (outcome: DropboxRecentFileCheck) => {
      if (probe.exists && probe.id) {
        await this.maybeRekeyRecord(record, { id: probe.id })
      }

      return outcome
    }

    if (!probe.isSyncEligible) {
      // Renamed remotely outside .txt/.text (or the locator resolved to a
      // non-file): every sync action is blocked — no pending push, no
      // refresh — and the row renders export-only with its real current
      // name and path (SPEC §7/§9). A rename back restores it next check.
      return finish({ kind: 'ineligible' })
    }

    if (!record.envelope && !record.pendingLocalEnvelope) {
      // A cache-less record (SPEC §8): Open re-downloads on demand; the
      // check must not bulk-download it (proactive background downloading
      // is deferred by design). Missing/ineligible/rename were already
      // handled above, so the row stays normal.
      return finish({ kind: 'up-to-date' })
    }

    const hasUnsyncedLocal =
      Boolean(record.pendingLocalEnvelope) ||
      (record.envelope ?? null) !== (record.lastSyncedEnvelope ?? null) ||
      // The transitional conflict signal lives on the sync record and
      // belongs to the selected file: an unresolved conflict is by
      // definition diverged and must never be flushed by the check.
      (isSelected && hasConflictSignal(syncRecord))

    let baseRevMatches = Boolean(probe.rev) && probe.rev === record.baseRev

    // Content equality: a revision bump whose content is unchanged (a pure
    // move/rename can bump `rev`) is metadata-only — adopt the new revision
    // as the base WITHOUT touching cache or pending state, and let a pending
    // push proceed against it (SPEC §9). The stored content hash decides
    // without a download; an unsynced record from before the hash existed
    // falls back to download-and-compare (a false `diverged` would send the
    // user into a needless merge), while a clean one reaches the same
    // adoption through the stale-but-clean refresh below.
    if (!baseRevMatches && probe.rev && !(isSelected && hasConflictSignal(syncRecord))) {
      let metadataOnly =
        Boolean(probe.contentHash) &&
        probe.contentHash === (record.lastSyncedContentHash ?? null)

      if (
        !metadataOnly &&
        hasUnsyncedLocal &&
        !record.lastSyncedContentHash &&
        record.lastSyncedEnvelope
      ) {
        try {
          const remote = await this.downloadRemote(getRecordRemoteLocator(record))

          metadataOnly = remote.envelope === record.lastSyncedEnvelope
        } catch {
          return finish({ kind: 'check-failed' })
        }
      }

      if (metadataOnly) {
        await this.store.putDropboxFile({
          ...identity,
          baseRev: probe.rev,
          lastSyncedContentHash: probe.contentHash ?? record.lastSyncedContentHash ?? null,
        })
        baseRevMatches = true
      }
    }

    if (baseRevMatches) {
      if (!hasUnsyncedLocal) {
        await this.clearSelectedRecoverableSyncError(syncRecord, key)
        return finish({ kind: 'up-to-date' })
      }

      if (isSelected && hasConflictSignal(syncRecord)) {
        // An unresolved recorded conflict: resolution is explicit (SPEC §9).
        return finish({ kind: 'diverged' })
      }

      // Pending push: offline edits to files that are not currently open
      // reach Dropbox from the home check, revision-conditionally against
      // exactly the revision the probe showed.
      const envelope = record.pendingLocalEnvelope ?? record.envelope

      if (!envelope) {
        return finish({ kind: 'up-to-date' })
      }

      try {
        const metadata = await this.uploadSelectedEnvelope(
          envelope,
          { ...record, ...identity },
          probe.rev,
        )

        await this.markRecordSynced({ ...record, ...identity }, metadata, envelope, {
          touchSyncRecord: isSelected,
        })
        return { kind: 'pushed' }
      } catch (error) {
        if (error instanceof DropboxProviderError && error.code === 'conflict') {
          // A conditional failure reclassifies the record as diverged
          // (SPEC §9) — reported, never persisted; resolution captures the
          // fresh remote when the user enters it.
          return finish({ kind: 'diverged' })
        }

        return finish({ kind: 'check-failed' })
      }
    }

    // Remote changed.
    if (hasUnsyncedLocal) {
      const pendingEnvelope = record.pendingLocalEnvelope ?? record.envelope ?? null

      if (pendingEnvelope) {
        try {
          const remote = await this.downloadRemote(
            getRecordRemoteLocator({ ...record, ...identity }),
          )

          // The row is no longer genuinely diverged: the pending ciphertext is
          // already what Dropbox has (for example, a previous conditional write
          // landed but the local bookkeeping did not clear). Adopt Dropbox's
          // current revision and clear the stale pending/indicator state without
          // opening the merge flow or decrypting.
          if (remote.envelope === pendingEnvelope) {
            await this.markRecordSynced(
              { ...record, ...identity },
              remote.metadata,
              remote.envelope,
              {
                touchSyncRecord: isSelected,
              },
            )
            return { kind: 'refreshed' }
          }
        } catch {
          // If the comparison cannot be made, keep the conservative diverged
          // indicator. The next check or explicit Resolve can retry.
        }
      }

      return finish({ kind: 'diverged' })
    }

    // Stale-but-clean: never a conflict, never red (SPEC §9).
    if (!refreshStaleCache) {
      return finish({ kind: 'stale' })
    }

    try {
      const remote = await this.downloadRemote(getRecordRemoteLocator(record))
      // Re-read before adopting: an editor session or another tab may have
      // written local bytes while the download was in flight — refreshing
      // over them would lose work (and a later push against the adopted
      // revision would silently overwrite the remote change).
      const fresh = await this.store.getDropboxFile(record.key)

      if (
        !fresh ||
        fresh.pendingLocalEnvelope ||
        (fresh.envelope ?? null) !== (record.envelope ?? null)
      ) {
        return finish({ kind: 'stale' })
      }

      await this.markRecordSynced(
        { ...record, ...identity },
        remote.metadata,
        remote.envelope,
        { touchSyncRecord: isSelected },
      )
      return { kind: 'refreshed' }
    } catch {
      // Known stale, refresh failed: the next online Open refreshes before
      // the password dialog instead (SPEC §9).
      return finish({ kind: 'stale' })
    }
  }

  // Home `Open` (SPEC §9): select the record, refresh its recency, and return
  // the local bytes — downloading (and caching) first when the record has no
  // cache, which requires being online (the download error surfaces offline).
  async openRecentFile(key: string): Promise<string | null> {
    // Provider-enforced guard (SPEC §9): refuse BEFORE any mutation —
    // selection and recency must not move while the account switch is
    // unresolved, and an uncached row must not reach the download path.
    const syncRecord = await this.store.getDropboxSync()

    if (syncRecord?.pendingAccountSwitch) {
      throw new DropboxProviderError(
        'account-switch-pending',
        'Resolve the Dropbox account switch first.',
      )
    }

    const record = await this.store.getDropboxFile(key)

    if (!record) {
      return null
    }

    const now = new Date()

    // Through persistSelection: opening a DIFFERENT row must clear the
    // previous selection's transitional conflict fields, or the new session
    // would inherit a conflict banner (and remote snapshot) that belongs to
    // another file.
    await this.persistSelection(syncRecord ?? null, key)
    await this.store.touchDropboxFileOpened(key, now)

    const local = record.pendingLocalEnvelope ?? record.envelope

    if (local) {
      return local
    }

    if (!syncRecord?.linked || !syncRecord.refreshToken) {
      throw new DropboxProviderError('unlinked', 'Dropbox is not linked.')
    }

    const remote = await this.downloadRemote(getRecordRemoteLocator(record))

    await this.markRecordSynced(record, remote.metadata, remote.envelope)
    return remote.envelope
  }

  async load() {
    const { fileRecord, syncRecord } = await this.getActiveState()

    // Provider-level load() is for editable sessions, so a selected record is
    // loadable here only while linked with no unresolved account switch. The
    // voluntary-unlinked read-only open path goes through openRecentFile() and
    // loadLocalEnvelope() instead.
    if (
      !fileRecord ||
      !syncRecord?.linked ||
      !syncRecord.refreshToken ||
      Boolean(syncRecord.pendingAccountSwitch)
    ) {
      // The vault "primary" envelope (the draft — the local working copy while
      // no Dropbox file is connected).
      const localVault = await this.store.getVault()

      if (localVault) {
        return localVault.envelope
      }

      throw new Error('No Dropbox local cache is saved.')
    }

    const cached = fileRecord.envelope

    if (
      !this.appKey ||
      !syncRecord?.linked ||
      !syncRecord.refreshToken ||
      // An unresolved account switch blocks every network operation (SPEC §9).
      Boolean(syncRecord.pendingAccountSwitch) ||
      !isOnline() ||
      Boolean(fileRecord.pendingLocalEnvelope) ||
      // Any conflict signal — status, captured remote snapshot, or a drifted
      // rev-only record — serves the local cache; resolution is explicit.
      hasConflictSignal(syncRecord) ||
      // The cache differs from the last-synced envelope: local-only changes
      // exist (e.g. a save whose upload was killed mid-flight before the
      // record was updated). Never pull the remote over them.
      Boolean(cached && cached !== fileRecord.lastSyncedEnvelope)
    ) {
      if (cached) {
        return cached
      }

      throw new Error('No Dropbox local cache is saved.')
    }

    try {
      const remote = await this.downloadRemote(getRecordRemoteLocator(fileRecord))

      await this.markRecordSynced(fileRecord, remote.metadata, remote.envelope)

      return remote.envelope
    } catch (error) {
      if (error instanceof DropboxProviderError) {
        await this.recordRecoverableSyncError(error)
      }

      if (cached) {
        return cached
      }

      throw error
    }
  }

  async save(envelope: string) {
    parseEnvelope(envelope)

    const { fileRecord, syncRecord } = await this.getActiveState()

    if (!fileRecord) {
      // No selected Dropbox file: write the draft (the vault "primary" working
      // copy).
      await this.store.saveEnvelope(envelope, new Date(), this.kind)
      await this.store.saveDropboxSync({
        lastSyncStatus:
          !this.appKey || !syncRecord?.linked || !syncRecord.refreshToken
            ? syncRecord?.linked
              ? 'error'
              : 'pending-local'
            : 'pending-local',
        pendingLocalEnvelope: envelope,
      })
      return
    }

    // The working copy's modified time (SPEC §8): stamped here — after the
    // envelope is encrypted (it arrives encrypted) and as part of the durable
    // cache write below — so a deferred or retried upload reuses THIS edit
    // moment as `client_modified`, never the retry time.
    const localModifiedAt = toDropboxTimestamp(new Date())

    // Durability first: the file's cache is the working copy (SPEC §8), and
    // the pending envelope is set BEFORE any network upload, so a process kill
    // mid-upload can never leave a 'synced' record pointing at the older
    // remote. The upload's success path clears it.
    const writeCache = (pendingLocalEnvelope: string | null) =>
      this.store.putDropboxFile({
        key: fileRecord.key,
        name: fileRecord.name,
        pathDisplay: fileRecord.pathDisplay,
        pathLower: fileRecord.pathLower,
        envelope,
        pendingLocalEnvelope,
        localModifiedAt,
      })

    // While a conflict is unresolved, never upload: that would clobber the remote
    // revision the user has not merged yet. Keep the newest local bytes in
    // `pendingLocalEnvelope` for the eventual merge, and leave the recorded
    // base/remote-conflict state untouched (SPEC §9).
    if (hasConflictSignal(syncRecord)) {
      await writeCache(envelope)
      return
    }

    // An unresolved account switch: save locally, never upload (SPEC §9).
    if (syncRecord?.pendingAccountSwitch) {
      await writeCache(envelope)
      await this.store.saveDropboxSync({ lastSyncStatus: 'pending-local' })
      return
    }

    if (!this.appKey || !syncRecord?.linked || !syncRecord.refreshToken) {
      await writeCache(envelope)
      await this.store.saveDropboxSync({
        lastSyncStatus: syncRecord?.linked ? 'error' : 'pending-local',
      })
      return
    }

    if (!isOnline()) {
      await writeCache(envelope)
      await this.store.saveDropboxSync({ lastSyncStatus: 'offline' })
      return
    }

    await writeCache(envelope)
    await this.uploadPendingEnvelope(envelope, fileRecord, localModifiedAt)
  }

  // Cache-only save for a paused Dropbox file session (SPEC §9 first-sync
  // gate): the cache and pending envelope are written exactly like save(),
  // but nothing is uploaded — the editor stops pushing while the session is
  // stale, and the pending envelope reaches Dropbox through a later
  // sync/resolution instead.
  async saveLocalOnly(envelope: string) {
    parseEnvelope(envelope)

    const { fileRecord, syncRecord } = await this.getActiveState()

    if (!fileRecord) {
      // No selected Dropbox file — the same write as save()'s no-file branch
      // (the draft).
      await this.store.saveEnvelope(envelope, new Date(), this.kind)
      await this.store.saveDropboxSync({
        lastSyncStatus: 'pending-local',
        pendingLocalEnvelope: envelope,
      })
      return
    }

    await this.store.putDropboxFile({
      key: fileRecord.key,
      name: fileRecord.name,
      pathDisplay: fileRecord.pathDisplay,
      pathLower: fileRecord.pathLower,
      envelope,
      pendingLocalEnvelope: envelope,
      localModifiedAt: toDropboxTimestamp(new Date()),
    })

    // While a conflict is recorded the status already reads conflict — never
    // regress it to pending-local.
    if (!hasConflictSignal(syncRecord)) {
      await this.store.saveDropboxSync({ lastSyncStatus: 'pending-local' })
    }
  }

  async selectRemoteFile(pathInput: string) {
    const path = normalizeDropboxTxtPath(pathInput)
    const metadata = await this.getRemoteMetadata(path)

    assertTxtFileMetadata(metadata, path)

    const remote = await this.downloadRemote(metadata.id ?? metadata.path_lower ?? path)
    const now = new Date()
    const merged = { ...metadata, ...remote.metadata }
    const pathDisplay = merged.path_display ?? path
    const pathLower = merged.path_lower ?? pathDisplay.toLowerCase()
    const key = merged.id ?? createPathDropboxFileKey(pathLower)

    // A pre-existing record for this file may still be under the provisional
    // `path:<pathLower>` key. When the remote has an id, canonicalize any such
    // record to the id key FIRST — a clean no-op when none exists — so the
    // divergence check below sees its pending edit instead of selecting the
    // remote and orphaning a still-path-keyed unsynced edit. Mirrors
    // `maybeRekeyRecord`; Browse-reselect is exactly the kind of "final write
    // under the old key" flow that rekeys.
    if (merged.id) {
      const pathKey = createPathDropboxFileKey(pathLower)

      if (pathKey !== key) {
        await this.store.rekeyDropboxFile(pathKey, key).catch(() => null)
      }
    }

    // Detect a genuine divergence: a pending local edit on the *same* record
    // that differs from the freshly downloaded remote. This happens when the
    // user re-selects (via Browse) a file they already edited offline or that
    // has landed in the Resolve ("conflict") state. Blanking `pendingLocalEnvelope`
    // here would silently discard their unsynced work (SPEC §9: a divergence must
    // be recorded as a conflict, never silently overwritten).
    const existingRecord = await this.store.getDropboxFile(key)
    const pending = existingRecord?.pendingLocalEnvelope ?? null
    const diverged = pending !== null && pending !== remote.envelope

    if (diverged) {
      // Mirrors `recordConflict`: update identity/recency only; preserve the
      // last-synced base (`baseRev`, `lastSyncedEnvelope`, `lastSyncedContentHash`,
      // `syncedModifiedAt`, `envelope`, and `pendingLocalEnvelope` are all
      // intentionally omitted so `putDropboxFile`'s merge keeps existing values).
      // Setting `lastSyncedEnvelope = remote.envelope` here would make base ==
      // remote, so conflict resolution would treat the remote as unchanged and
      // silently overwrite it — the same data loss one layer down.
      await this.store.putDropboxFile(
        {
          key,
          name: merged.name ?? pathDisplay.split('/').filter(Boolean).at(-1) ?? path,
          pathDisplay,
          pathLower,
          lastOpenedAt: now.toISOString(),
        },
        now,
      )
      await this.store.saveDropboxSync({
        lastSyncStatus: 'conflict',
        ...remoteConflictFields(remote.envelope, remote.rev, merged.client_modified),
        selectedFileKey: key,
      })
      // Return the pending (local) envelope so the session opens what the user
      // had; the Resolve banner then lets them reconcile with the remote.
      return pending
    }

    // The opened file becomes (or refreshes) its own recent-list record with
    // its own cache, and the persisted selection moves to it (SPEC §8/§9).
    await this.store.putDropboxFile(
      {
        key,
        name: merged.name ?? pathDisplay.split('/').filter(Boolean).at(-1) ?? path,
        pathDisplay,
        pathLower,
        envelope: remote.envelope,
        baseRev: remote.rev,
        lastSyncedEnvelope: remote.envelope,
        lastSyncedContentHash: merged.content_hash ?? null,
        pendingLocalEnvelope: null,
        // A clean adopt of the remote: both columns show the synced version's
        // own modified time (SPEC §8).
        syncedModifiedAt: merged.client_modified
          ? toDropboxTimestamp(merged.client_modified)
          : null,
        localModifiedAt: merged.client_modified
          ? toDropboxTimestamp(merged.client_modified)
          : null,
        lastOpenedAt: now.toISOString(),
      },
      now,
    )
    await this.store.saveDropboxSync({
      lastSyncStatus: 'synced',
      ...clearedRemoteConflictFields(),
      selectedFileKey: key,
    })

    return remote.envelope
  }

  async createRemoteFile(pathInput: string, envelope: string) {
    // Add semantics: with no rev this sends `{ '.tag': 'add' }`, so an
    // existing path fails with a 409 'conflict'. Upload to Dropbox catches that
    // to confirm an overwrite via replaceRemoteFile (it never overwrites blindly).
    await this.pushNewSelectedEnvelope(pathInput, envelope, null)
  }

  // The confirmed "replace existing file" branch of Upload to Dropbox: push the
  // current vault over an existing path and connect to it. Push-only — never
  // pulls the remote. `expectedRev` is the revision the existence probe showed
  // alongside the confirmation: the upload is conditional on exactly that
  // revision, so a target rewritten between probe and confirm fails with
  // 'conflict' (and the app re-asks) instead of destroying the newer revision.
  async replaceRemoteFile(pathInput: string, envelope: string, expectedRev: string) {
    await this.pushNewSelectedEnvelope(pathInput, envelope, expectedRev)
  }

  // Existence probe for the overwrite confirmation (SPEC §9): returns the
  // target's current revision so the confirmed replace can be conditional on
  // what the user was shown. Only a missing path reports exists: false; any
  // other failure (offline, auth, a folder at the path) throws.
  async statRemoteTxtFile(pathInput: string): Promise<DropboxRemoteFileStat> {
    const path = normalizeDropboxTxtPath(pathInput)

    try {
      const metadata = await this.getRemoteMetadata(path)

      assertTxtFileMetadata(metadata, path)

      if (!metadata.rev) {
        throw new DropboxProviderError('unknown', 'Dropbox metadata did not include a revision.')
      }

      const displayPath = getMetadataDisplayPath(metadata, path)

      return {
        exists: true,
        // Threaded so the editor's force-out-of-conflict can match the chosen
        // overwrite target against the current session's bound file by id.
        id: metadata.id ?? null,
        name: getMetadataName(metadata, displayPath),
        pathDisplay: displayPath,
        rev: metadata.rev,
        serverModified: metadata.server_modified ?? null,
      }
    } catch (error) {
      if (error instanceof DropboxProviderError && error.code === 'not-found') {
        return { exists: false }
      }

      throw error
    }
  }

  // By-locator metadata probe for the recents background check (SPEC §9). The
  // locator is a raw Dropbox file id ("id:..." — stable across renames and
  // moves, so the probe finds the file wherever it now lives) or a "/"-path
  // (path-keyed records, which a remote rename correctly strands until
  // rekeying). Unlike statRemoteTxtFile this never throws on an ineligible
  // name — a rename outside .txt/.text must be DETECTED, not errored — so
  // eligibility is reported as data. Only not-found reports exists: false;
  // any other failure throws.
  async statRemoteFile(locator: string): Promise<DropboxRemoteFileProbe> {
    const path = this.normalizeRemoteLocator(locator)

    try {
      const metadata = await this.getRemoteMetadata(path)
      const pathDisplay = getMetadataDisplayPath(metadata)
      const name = getMetadataName(metadata, pathDisplay)
      const kind =
        metadata['.tag'] === 'folder' ? 'folder' : metadata['.tag'] === 'file' ? 'file' : 'other'

      return {
        exists: true,
        contentHash: metadata.content_hash ?? null,
        id: metadata.id ?? null,
        isSyncEligible:
          kind === 'file' && Boolean(metadata.rev) && Boolean(name && isEncryptedTextFileName(name)),
        kind,
        name,
        pathDisplay,
        pathLower: metadata.path_lower ?? pathDisplay?.toLowerCase() ?? null,
        rev: metadata.rev ?? null,
      }
    } catch (error) {
      if (error instanceof DropboxProviderError && error.code === 'not-found') {
        return { exists: false }
      }

      throw error
    }
  }

  // By-locator envelope download for the per-file cache layer (SPEC §8/§9):
  // the stale-but-clean refresh and the on-Open download of an uncached
  // record. Returns the envelope plus the file's current identity metadata so
  // the record can adopt a rename/move in the same step.
  async downloadRemoteFile(locator: string): Promise<DropboxRemoteDownload> {
    const result = await this.downloadRemote(this.normalizeRemoteLocator(locator))
    const pathDisplay = getMetadataDisplayPath(result.metadata)

    return {
      contentHash: result.metadata.content_hash ?? null,
      envelope: result.envelope,
      id: result.metadata.id ?? null,
      name: getMetadataName(result.metadata, pathDisplay),
      pathDisplay,
      pathLower: result.metadata.path_lower ?? pathDisplay?.toLowerCase() ?? null,
      rev: result.rev,
    }
  }

  private normalizeRemoteLocator(locator: string) {
    const trimmed = locator.trim()

    if (trimmed.startsWith('id:') && trimmed.length > 'id:'.length) {
      return trimmed
    }

    if (trimmed.startsWith('/') && trimmed.length > 1) {
      return trimmed
    }

    throw new DropboxProviderError(
      'invalid-path',
      'Dropbox locator must be a file id or a /-path.',
    )
  }

  // Lists one Dropbox folder for the file browser (SPEC §9). The complete
  // listing (all pages, capped) is fetched before returning so the UI renders
  // grouped/sorted rows exactly once — never reordering under the user's
  // finger. Results are returned to the caller only; nothing is persisted.
  async listFolder(pathInput: string): Promise<DropboxFolderListing> {
    const path = normalizeDropboxFolderPath(pathInput)
    const entries: DropboxFolderEntry[] = []
    let response = await this.rpc<DropboxListFolderResponse>('/files/list_folder', {
      include_deleted: false,
      include_non_downloadable_files: true,
      path,
      recursive: false,
    })

    for (;;) {
      for (const raw of response.entries ?? []) {
        const entry = toFolderEntry(raw)

        if (entry) {
          entries.push(entry)
        }
      }

      if (entries.length >= LIST_FOLDER_ENTRY_CAP) {
        return {
          entries: entries.slice(0, LIST_FOLDER_ENTRY_CAP),
          truncated: entries.length > LIST_FOLDER_ENTRY_CAP || response.has_more === true,
        }
      }

      if (!response.has_more || !response.cursor) {
        return { entries, truncated: false }
      }

      response = await this.rpc<DropboxListFolderResponse>('/files/list_folder/continue', {
        cursor: response.cursor,
      })
    }
  }

  // No-network discard guard for "Create file": is the current local cache
  // known to be safely on Dropbox? Reports unsynced when a pending local
  // envelope exists, any conflict signal is present (incl. a drifted
  // `remoteConflictRev`, via `hasConflictSignal`), or the local vault envelope
  // differs from the last envelope we know was synced. Offline-but-equal counts
  // as synced — matching the rule that a locally-recorded "synced" is safe even
  // when the device is offline and unaware of remote changes elsewhere.
  async hasUnsyncedLocalChanges(): Promise<boolean> {
    const { fileRecord, syncRecord } = await this.getActiveState()

    if (fileRecord) {
      return computeRecordHasUnsynced(syncRecord, fileRecord)
    }

    const localVault = await this.store.getVault()

    return computeHasUnsyncedLocal(syncRecord, localVault?.envelope ?? null)
  }

  // No-network: is a remote Dropbox file currently selected? The selection is
  // the record key; the account-level locator survives as a fallback.
  async hasSelectedRemote(): Promise<boolean> {
    const { fileRecord, syncRecord } = await this.getActiveState()
    return fileRecord !== null || getSelectedRemoteLocator(syncRecord) !== null
  }

  async status(): Promise<StorageStatus> {
    const { fileRecord, syncRecord } = await this.getActiveState()
    const localEnvelope = fileRecord
      ? fileRecord.envelope
      : ((await this.store.getVault())?.envelope ?? null)
    const localVault = localEnvelope !== null

    if (!this.appKey) {
      return {
        detail: 'Dropbox app key is not configured. Encrypted local cache is available.',
        state: localVault ? 'error' : 'needs-user-action',
      }
    }

    const selectedPath = fileRecord?.pathDisplay ?? getSelectedRemoteDisplayPath(syncRecord)

    if (syncRecord?.remoteConflictEnvelope) {
      return {
        detail: `Dropbox has a diverging version of ${selectedPath ?? 'the selected file'}. Open Resolve to review it.`,
        state: 'conflict',
      }
    }

    // Degraded conflict: a conflict signal is present but the remote snapshot is
    // not (download failed, or a drifted record carries only `remoteConflictRev`).
    // Sync is intentionally paused, so this must read as a conflict (not
    // pending-sync), with a message that points at the missing remote.
    if (hasConflictSignal(syncRecord)) {
      return {
        detail: `Dropbox sync is paused for ${selectedPath ?? 'the selected file'}: the remote version could not be downloaded. Retry when online, or export the encrypted local copy.`,
        state: 'conflict',
      }
    }

    if (!syncRecord?.linked) {
      return {
        detail: localVault
          ? 'Dropbox is not linked. Encrypted local cache is available.'
          : 'Link Dropbox or continue with encrypted local cache.',
        state: 'needs-user-action',
      }
    }

    if (syncRecord.pendingAccountSwitch) {
      return {
        detail:
          'Dropbox was linked to a different account. Resolve the account switch to continue.',
        state: 'needs-user-action',
      }
    }

    if (!fileRecord && !getSelectedRemoteLocator(syncRecord)) {
      return {
        detail: localVault
          ? 'Choose or create a Dropbox .txt file for encrypted sync.'
          : 'Choose or create a Dropbox .txt file, or continue with encrypted local cache.',
        state: 'needs-user-action',
      }
    }

    if (!isOnline() || syncRecord.lastSyncStatus === 'offline') {
      return {
        detail: 'Offline. Encrypted edits are saved locally and will sync later.',
        state: 'offline',
      }
    }

    if (
      fileRecord?.pendingLocalEnvelope ||
      syncRecord.pendingLocalEnvelope ||
      syncRecord.lastSyncStatus === 'pending-local'
    ) {
      return {
        detail: `Pending Dropbox sync to ${selectedPath ?? 'the selected file'}.`,
        state: 'pending-sync',
      }
    }

    if (syncRecord.lastSyncStatus === 'error') {
      return {
        detail: selectedPath
          ? `Check Dropbox for ${selectedPath}. Encrypted local cache is still saved.`
          : 'Check Dropbox. Choose or create a Dropbox .txt file.',
        state: 'error',
      }
    }

    return {
      // "Has the selected file ever synced?" — derived from the durable sync
      // state, not the display timestamp (`syncedModifiedAt` can be null on a
      // record that has in fact synced). Either a base revision or a
      // last-synced snapshot proves it. The account-level field remains only
      // for the unconnected path.
      detail: (
        fileRecord
          ? Boolean(fileRecord.baseRev) || Boolean(fileRecord.lastSyncedEnvelope)
          : syncRecord.lastSyncAt
      )
        ? `Dropbox synced to ${selectedPath ?? 'the selected file'}.`
        : `Dropbox linked for ${selectedPath ?? 'the selected file'}.`,
      state: 'ready',
    }
  }

  async syncNow(options: { adoptCleanRemote?: boolean } = {}) {
    const { fileRecord, syncRecord } = await this.getActiveState()

    if (!this.appKey) {
      await this.store.saveDropboxSync({ lastSyncStatus: 'error' })
      return this.status()
    }

    if (!syncRecord?.linked || !syncRecord.refreshToken) {
      return this.status()
    }

    // An unresolved account switch blocks sync outright (SPEC §9).
    if (syncRecord.pendingAccountSwitch) {
      return this.status()
    }

    if (!fileRecord) {
      return this.status()
    }

    // An unresolved conflict is resolved explicitly by the user, never by an
    // implicit Sync upload. Uses the shared conflict predicate so every signal
    // (status, captured remote, or a drifted `remoteConflictRev`-only record)
    // pauses the upload path.
    if (hasConflictSignal(syncRecord)) {
      return this.status()
    }

    if (!isOnline()) {
      await this.store.saveDropboxSync({ lastSyncStatus: 'offline' })
      return this.status()
    }

    const envelope = fileRecord.pendingLocalEnvelope ?? fileRecord.envelope ?? null

    if (!envelope) {
      // A cache-less record (SPEC §8): adopt the remote.
      try {
        const remote = await this.downloadRemote(getRecordRemoteLocator(fileRecord))

        await this.markRecordSynced(fileRecord, remote.metadata, remote.envelope)
      } catch (error) {
        if (error instanceof DropboxProviderError) {
          await this.recordRecoverableSyncError(error)
        }
      }

      return this.status()
    }

    if (!fileRecord.pendingLocalEnvelope) {
      try {
        const metadata = await this.getRemoteMetadata(getRecordRemoteLocator(fileRecord))

        if (metadata.rev && metadata.rev !== fileRecord.baseRev) {
          const remote = await this.downloadRemote(getRecordRemoteLocator(fileRecord))

          if (remote.envelope === envelope) {
            await this.markRecordSynced(fileRecord, remote.metadata, remote.envelope)
          } else if (envelope === (fileRecord.lastSyncedEnvelope ?? null)) {
            // Stale-but-clean (SPEC §9 flow step 6): the remote changed but
            // the local cache equals the last-synced snapshot — NEVER a
            // conflict. Adopt the remote only when the caller allows it
            // (home contexts): an open session's cache/baseRev must not be
            // swapped underneath the editor, so the in-session sync leaves
            // the record untouched and the next home pass refreshes it.
            if (options.adoptCleanRemote) {
              await this.markRecordSynced(fileRecord, remote.metadata, remote.envelope)
            }
          } else {
            await this.store.putDropboxFile({
              key: fileRecord.key,
              name: remote.metadata.name ?? fileRecord.name,
              pathDisplay: remote.metadata.path_display ?? fileRecord.pathDisplay,
              pathLower: remote.metadata.path_lower ?? fileRecord.pathLower,
              // Preserve the last-synced base (`baseRev` untouched); the merge
              // needs it. The remote's revision is recorded only as the
              // conflict rev, never as the base.
              pendingLocalEnvelope: envelope,
            })
            await this.store.saveDropboxSync({
              lastSyncStatus: 'conflict',
              ...remoteConflictFields(remote.envelope, remote.rev, remote.metadata.client_modified),
            })
          }

          return this.status()
        }
      } catch (error) {
        // A missing remote ('not-found') is recorded like other errors: the
        // upload path would only re-fetch the same metadata and fail again,
        // and the user must reselect or recreate the file (SPEC §9 step 6).
        if (error instanceof DropboxProviderError) {
          await this.recordRecoverableSyncError(error)
        }

        return this.status()
      }

      // Remote matches the base and the cache equals the last-synced snapshot:
      // nothing to upload. A check must never create a needless Dropbox
      // revision (SPEC §9 sync flow step 5).
      if (envelope === (fileRecord.lastSyncedEnvelope ?? null)) {
        await this.clearSelectedRecoverableSyncError(syncRecord, fileRecord.key)
        return this.status()
      }
    }

    await this.uploadPendingEnvelope(envelope, fileRecord)
    return this.status()
  }

  async unlink() {
    this.accessToken = null
    this.accessTokenExpiresAt = 0
    await this.store.pauseDropboxLink()
  }

  // Disconnects the selected Dropbox file but keeps the OAuth link: clears the
  // selection + all sync/conflict state, leaving `linked`/`refreshToken` intact
  // so re-connecting needs no re-auth. Used by an explicit Disconnect and by
  // Open-from-Files (which switches the working copy to a non-Dropbox document).
  async disconnectRemoteFile() {
    await this.store.clearDropboxFileSelection()
  }

  async getSyncState() {
    const { fileRecord, syncRecord } = await this.getActiveState()

    if (fileRecord) {
      return getSyncStateFromRecord(syncRecord, fileRecord)
    }

    const vault = await this.store.getVault()

    return getSyncState(syncRecord, vault?.envelope ?? null)
  }

  // No-network read of the current Dropbox document's freshest local bytes:
  // the selected record's pending envelope, else its cache; with no selected
  // record, the account-level sync pending, else the vault "primary" envelope.
  // The app's unlock-time re-read and pre-upload read go through this so they
  // can never see the draft while a Dropbox file is selected — the draft is a
  // separate document (SPEC §4/§8).
  async loadLocalEnvelope(): Promise<string | null> {
    const { fileRecord, syncRecord } = await this.getActiveState()

    // No-network record read. Linked sessions and voluntary-unlinked cached
    // sessions both use the selected record's bytes; the latter is opened under
    // an app-imposed read-only lock. An unresolved account switch still blocks.
    if (fileRecord && !syncRecord?.pendingAccountSwitch && !syncRecord?.authLost) {
      return fileRecord.pendingLocalEnvelope ?? fileRecord.envelope ?? null
    }

    const localVault = await this.store.getVault()

    return syncRecord?.pendingLocalEnvelope ?? localVault?.envelope ?? null
  }

  async exportLocalConflictCopy() {
    // Deliberately NOT the openability-gated loadLocalEnvelope: a conflict
    // export must return the conflicted record's local bytes even if
    // authorization was lost mid-session (the export is the escape hatch).
    const { fileRecord, syncRecord } = await this.getActiveState()

    if (fileRecord) {
      return fileRecord.pendingLocalEnvelope ?? fileRecord.envelope ?? null
    }

    const localVault = await this.store.getVault()

    return syncRecord?.pendingLocalEnvelope ?? localVault?.envelope ?? null
  }

  async exportRemoteConflictCopy() {
    const syncRecord = await this.store.getDropboxSync()

    return syncRecord?.remoteConflictEnvelope ?? null
  }

  // Hands the app the three encrypted sides of the conflict so it can
  // decrypt-and-merge in memory (SPEC §9). Ciphertext-only: this never decrypts.
  // Returns null when there is no resolvable conflict (or no local envelope).
  async loadConflictEnvelopes(
    options: { refreshRemote?: boolean } = {},
  ): Promise<ConflictEnvelopes | null> {
    const { fileRecord, syncRecord } = await this.getActiveState()

    if (!syncRecord || !hasConflictSignal(syncRecord)) {
      return null
    }

    const localEnvelope = fileRecord
      ? (fileRecord.pendingLocalEnvelope ?? fileRecord.envelope ?? null)
      : (syncRecord.pendingLocalEnvelope ?? (await this.store.getVault())?.envelope ?? null)

    if (!localEnvelope) {
      return null
    }

    let remoteEnvelope = syncRecord.remoteConflictEnvelope ?? null
    let remoteConflictRev = syncRecord.remoteConflictRev ?? null

    // Re-download the remote side so the merge is built against the freshest
    // Dropbox copy. Two cases trigger it: a degraded conflict where the remote
    // snapshot was never captured (the merge needs all three sides), and an
    // explicit `refreshRemote` (the conflict editor opening — the captured
    // snapshot can be stale if the remote changed again since the conflict was
    // recorded). Online-only; on any failure keep whatever snapshot exists
    // (degraded → report no remote, which surfaces a non-mergeable state). A
    // retry is simply calling this method again.
    if ((!remoteEnvelope || options.refreshRemote) && fileRecord && isOnline()) {
      try {
        const remote = await this.downloadRemote(getRecordRemoteLocator(fileRecord))

        await this.store.saveDropboxSync({
          ...remoteConflictFields(remote.envelope, remote.rev, remote.metadata.client_modified),
        })
        remoteEnvelope = remote.envelope
        remoteConflictRev = remote.rev
      } catch {
        if (!remoteEnvelope) {
          remoteEnvelope = null
          remoteConflictRev = null
        }
        // A refresh failure with a snapshot in hand keeps the snapshot.
      }
    }

    return {
      baseEnvelope: fileRecord
        ? (fileRecord.lastSyncedEnvelope ?? null)
        : (syncRecord.lastSyncedEnvelope ?? null),
      localEnvelope,
      remoteEnvelope,
      remoteConflictRev,
    }
  }

  async adoptRemoteConflictEnvelope(
    envelope: string,
    remoteConflictRev: string,
  ): Promise<void> {
    parseEnvelope(envelope)

    const { fileRecord, syncRecord } = await this.getActiveState()

    if (
      !fileRecord ||
      !syncRecord ||
      !hasConflictSignal(syncRecord) ||
      syncRecord.remoteConflictEnvelope !== envelope ||
      !remoteConflictRev ||
      remoteConflictRev !== syncRecord.remoteConflictRev
    ) {
      throw new DropboxProviderError(
        'conflict',
        'The Dropbox conflict state changed. Reload the conflict before committing.',
      )
    }

    // Adopting the remote copy must stamp the synced VERSION's modified time
    // (SPEC §8), so carry the snapshot's captured `client_modified` into the
    // synthetic metadata. Absent it (a degraded snapshot), markRecordSynced
    // keeps the record's current timestamps rather than blanking them.
    const metadata: DropboxFileMetadata = {
      name: fileRecord.name,
      path_display: fileRecord.pathDisplay,
      path_lower: fileRecord.pathLower,
      rev: remoteConflictRev,
    }

    if (syncRecord.remoteConflictClientModified) {
      metadata.client_modified = syncRecord.remoteConflictClientModified
    }

    await this.markRecordSynced(fileRecord, metadata, envelope)
  }

  // Uploads the resolved (or clean-merged) encrypted envelope for the conflict the
  // merge was built against. Always revision-conditional against `expectedRemoteRev`
  // (no overwrite mode), and refuses on a drifted/stale conflict state so it can
  // never commit against an outdated remote.
  async commitMergedEnvelope(envelope: string, expectedRemoteRev: string): Promise<void> {
    parseEnvelope(envelope)

    const { fileRecord, syncRecord } = await this.getActiveState()

    if (
      !syncRecord ||
      !fileRecord ||
      !hasConflictSignal(syncRecord) ||
      !expectedRemoteRev ||
      expectedRemoteRev !== syncRecord.remoteConflictRev
    ) {
      throw new DropboxProviderError(
        'conflict',
        'The Dropbox conflict state changed. Reload the conflict before committing.',
      )
    }

    // Durability first: the resolved text becomes the file's cache AND the
    // pending local side regardless of the upload outcome. Setting
    // `pendingLocalEnvelope` here matters for non-409 failures (offline/server):
    // it ensures a later resolution reads the user's resolved envelope, not the
    // stale pre-merge local. (On success it is cleared; on 409 `recordConflict`
    // sets it again.)
    // Resolving is a fresh local modification: stamp the resolution moment and
    // upload it as `client_modified` (SPEC §8). markRecordSynced reads it back
    // onto both columns on success.
    const resolvedAt = toDropboxTimestamp(new Date())

    await this.store.putDropboxFile({
      key: fileRecord.key,
      name: fileRecord.name,
      pathDisplay: fileRecord.pathDisplay,
      pathLower: fileRecord.pathLower,
      envelope,
      pendingLocalEnvelope: envelope,
      localModifiedAt: resolvedAt,
    })

    try {
      const uploaded = await this.uploadSelectedEnvelope(
        envelope,
        fileRecord,
        expectedRemoteRev,
        resolvedAt,
      )

      await this.markRecordSynced(fileRecord, uploaded, envelope)
    } catch (error) {
      // Remote moved again since the merge: re-record against the fresh remote
      // (base preserved, pendingLocal = the resolved text) and re-throw so the app
      // re-resolves instead of clobbering the newer remote.
      if (error instanceof DropboxProviderError && error.code === 'conflict') {
        await this.recordConflict(envelope, fileRecord)
      }

      throw error
    }
  }

  private clearOAuthQuery(url: URL) {
    for (const key of ['code', 'state', 'error', 'error_description']) {
      url.searchParams.delete(key)
    }

    this.replaceHref(url.toString())
  }

  private rememberAccessToken(token: DropboxTokenResponse) {
    // expires_in is server-supplied: a missing or non-numeric value falls back
    // to Dropbox's documented 4-hour lifetime instead of entering arithmetic.
    const expiresIn =
      typeof token.expires_in === 'number' && Number.isFinite(token.expires_in)
        ? token.expires_in
        : 14_400

    this.accessToken = token.access_token
    this.accessTokenExpiresAt = Date.now() + expiresIn * 1000
  }

  private async exchangeAuthorizationCode(code: string, codeVerifier: string, href: string) {
    const body = new URLSearchParams({
      client_id: this.appKey,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: getRedirectUri(href),
    })

    return this.postToken(body)
  }

  private async refreshAccessToken(refreshToken: string) {
    const body = new URLSearchParams({
      client_id: this.appKey,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    })

    return this.postToken(body)
  }

  private async postToken(body: URLSearchParams) {
    try {
      const response = await this.fetcher(DROPBOX_TOKEN_URL, {
        body,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        method: 'POST',
      })

      if (!response.ok) {
        await throwDropboxResponseError(response)
      }

      const token = (await response.json()) as DropboxTokenResponse

      // A well-formed 200 with the wrong shape (no usable access token) must
      // fail here, not later as `Authorization: Bearer undefined`.
      if (typeof token?.access_token !== 'string' || token.access_token.length === 0) {
        throw new DropboxProviderError('auth', 'Dropbox token response was malformed.')
      }

      return token
    } catch (error) {
      return handleNetworkError(error)
    }
  }

  private async getAccessToken() {
    // The account-switch guard's hard stop (SPEC §9): EVERY authorized API
    // call passes through here, so while a mismatch is unresolved no sync,
    // download, upload, or listing can touch the wrong account's files. The
    // persisted check runs BEFORE the cached-token fast path — the mismatch
    // may have been recorded by ANOTHER tab/instance whose in-memory token
    // drop cannot reach this instance's cache.
    const syncRecord = await this.store.getDropboxSync()

    if (syncRecord?.pendingAccountSwitch) {
      throw new DropboxProviderError(
        'account-switch-pending',
        'Resolve the Dropbox account switch first.',
      )
    }

    if (this.accessToken && Date.now() + TOKEN_EXPIRY_SKEW_MS < this.accessTokenExpiresAt) {
      return this.accessToken
    }

    if (!syncRecord?.linked || !syncRecord.refreshToken) {
      throw new DropboxProviderError('unlinked', 'Dropbox is not linked.')
    }

    const token = await this.refreshAccessToken(syncRecord.refreshToken).catch(async (error) => {
      // A refresh rejected as 'auth' means the grant itself is dead — revoked
      // from dropbox.com (possibly on another device, mid-browse), expired, or
      // insufficiently scoped. This is an involuntary unlink: clear token
      // material ONLY. The file selection, local cache, and pending/sync
      // snapshots survive so relinking resumes the same document (SPEC §9).
      if (error instanceof DropboxProviderError && error.code === 'auth') {
        this.accessToken = null
        this.accessTokenExpiresAt = 0
        await this.store.clearDropboxTokens().catch(() => undefined)
      }

      throw error
    })

    this.rememberAccessToken(token)
    await this.store.saveDropboxSync({
      accessTokenExpiresAt: new Date(this.accessTokenExpiresAt).toISOString(),
    })

    return token.access_token
  }

  // Every authorized API call goes through here. An 'auth' rejection of a
  // token getAccessToken considered fresh means it was revoked server-side,
  // expired early, or lacks a scope: drop the cached token and refresh ONCE —
  // a live grant retries transparently (a prematurely expired access token is
  // not a relink event), a dead grant makes getAccessToken clear token
  // material (involuntary unlink, SPEC §9), and a grant that refreshes fine
  // but still fails 'auth' (missing_scope) clears token material here, so the
  // link state never stays `linked: true` past an unusable grant.
  private async withAuthRetry<T>(run: (accessToken: string) => Promise<T>): Promise<T> {
    const accessToken = await this.getAccessToken()

    try {
      return await run(accessToken)
    } catch (error) {
      if (!(error instanceof DropboxProviderError) || error.code !== 'auth') {
        throw error
      }

      this.accessToken = null
      this.accessTokenExpiresAt = 0

      const freshToken = await this.getAccessToken()

      try {
        return await run(freshToken)
      } catch (retryError) {
        if (retryError instanceof DropboxProviderError && retryError.code === 'auth') {
          this.accessToken = null
          this.accessTokenExpiresAt = 0
          await this.store.clearDropboxTokens().catch(() => undefined)
        }

        throw retryError
      }
    }
  }

  private async rpc<T>(path: string, body: unknown) {
    return this.withAuthRetry(async (accessToken) => {
      try {
        const response = await this.fetcher(`${DROPBOX_API_URL}${path}`, {
          body: JSON.stringify(body),
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          method: 'POST',
        })

        if (!response.ok) {
          await throwDropboxResponseError(response)
        }

        return (await response.json()) as T
      } catch (error) {
        return handleNetworkError(error)
      }
    })
  }

  private async getRemoteMetadata(path: string) {
    return this.rpc<DropboxFileMetadata>('/files/get_metadata', {
      include_deleted: false,
      path,
    })
  }

  private async downloadRemote(path: string): Promise<DropboxDownloadResult> {
    return this.withAuthRetry(async (accessToken) => {
      try {
        const response = await this.fetcher(`${DROPBOX_CONTENT_URL}/files/download`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Dropbox-API-Arg': httpHeaderSafeJson({ path }),
          },
          method: 'POST',
        })

        if (!response.ok) {
          await throwDropboxResponseError(response)
        }

        const envelope = await response.text()
        const metadataHeader = response.headers.get('dropbox-api-result')
        const metadata = metadataHeader
          ? (JSON.parse(metadataHeader) as DropboxFileMetadata)
          : null
        const rev = metadata?.rev

        try {
          parseEnvelope(envelope)
        } catch {
          throw new DropboxProviderError(
            'corrupt',
            'Remote file is not a valid encrypted envelope.',
          )
        }

        if (!rev) {
          throw new DropboxProviderError('unknown', 'Dropbox download did not include a revision.')
        }

        return { envelope, metadata: metadata ?? { rev }, rev }
      } catch (error) {
        return handleNetworkError(error)
      }
    })
  }

  private async resolveRecordWritePath(record: DropboxFileRecord) {
    const metadata = await this.getRemoteMetadata(getRecordRemoteLocator(record))

    assertTxtFileMetadata(metadata, record.pathDisplay)

    const displayPath = getMetadataDisplayPath(metadata, record.pathDisplay)
    const writePath = metadata.path_lower ?? displayPath

    if (!writePath) {
      throw new DropboxProviderError('not-found', 'Choose a Dropbox .txt file.')
    }

    if (
      metadata.name !== record.name ||
      metadata.path_display !== record.pathDisplay ||
      metadata.path_lower !== record.pathLower
    ) {
      // Adopt the file's current identity (a remote rename/move) on the record.
      // Never let this transient metadata refresh promote the remote's revision
      // into `baseRev`: during conflict resolution that would discard the real
      // merge base before the upload's outcome is known. Every successful
      // upload sets `baseRev` explicitly anyway. (Rekeying happens only after a
      // flow's final write — see maybeRekeyRecord.)
      await this.store.putDropboxFile({
        key: record.key,
        name: metadata.name ?? record.name,
        pathDisplay: metadata.path_display ?? record.pathDisplay,
        pathLower: metadata.path_lower ?? record.pathLower,
      })
    }

    return {
      metadata,
      path: writePath,
    }
  }

  private async uploadSelectedEnvelope(
    envelope: string,
    record: DropboxFileRecord,
    // When provided, the conditional update is gated on this revision instead of
    // the record's `baseRev` (used by conflict resolution to upload against the
    // downloaded remote conflict rev).
    conditionalRev?: string | null,
    // The `client_modified` to record on Dropbox. Defaults to the record's own
    // `localModifiedAt` (the stored edit time — reused verbatim on a deferred or
    // retried flush, never the retry time), falling back to its `updatedAt` so
    // an upload never silently defaults to Dropbox's upload-time (SPEC §8).
    clientModified?: string,
  ) {
    const selected = await this.resolveRecordWritePath(record)
    const updateRev = conditionalRev === undefined ? record.baseRev : conditionalRev
    const modifiedAt =
      clientModified ??
      record.localModifiedAt ??
      (record.updatedAt ? toDropboxTimestamp(record.updatedAt) : toDropboxTimestamp(new Date()))

    return this.uploadEnvelopeToPath(selected.path, envelope, updateRev, modifiedAt)
  }

  // Every upload is `add` (rev null) or revision-conditional `update` — there
  // is deliberately no unconditional-overwrite mode (SPEC §9): a confirmed
  // replace must be conditional on the revision its confirmation showed.
  // `clientModified` is the whole-second-UTC modified time to store on Dropbox
  // (SPEC §8); the response echoes it back, and markRecordSynced reads it onto
  // both timestamp columns.
  private async uploadEnvelopeToPath(
    path: string,
    envelope: string,
    baseRev: string | null,
    clientModified: string,
  ) {
    const uploadMode = baseRev ? { '.tag': 'update', update: baseRev } : { '.tag': 'add' }

    return this.withAuthRetry(async (accessToken) => {
      try {
        const response = await this.fetcher(`${DROPBOX_CONTENT_URL}/files/upload`, {
          body: envelope,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/octet-stream',
            'Dropbox-API-Arg': httpHeaderSafeJson({
              autorename: false,
              client_modified: clientModified,
              mode: uploadMode,
              mute: true,
              path,
              strict_conflict: true,
            }),
          },
          method: 'POST',
        })

        if (!response.ok) {
          await throwDropboxResponseError(response)
        }

        const metadata = (await response.json()) as DropboxFileMetadata

        if (!metadata.rev) {
          throw new DropboxProviderError('unknown', 'Dropbox upload did not include a revision.')
        }

        return metadata
      } catch (error) {
        return handleNetworkError(error)
      }
    })
  }

  // Connects the vault to `pathInput` by pushing the current envelope and
  // recording it as the new selected remote (synced; prior conflict/pending
  // cleared). `conditionalRev` null = `{ '.tag': 'add' }` (409 if the path
  // already exists); a revision = conditional `{ '.tag': 'update' }` against
  // exactly that revision. Shared by createRemoteFile (add) and
  // replaceRemoteFile (conditional replace).
  private async pushNewSelectedEnvelope(
    pathInput: string,
    envelope: string,
    conditionalRev: string | null,
  ) {
    parseEnvelope(envelope)
    const path = normalizeDropboxTxtPath(pathInput)
    const now = new Date()
    // Creating/promoting a file: its modified time is this moment (SPEC §8).
    // Send it as `client_modified` so the new Dropbox version carries it.
    const modifiedAt = toDropboxTimestamp(now)
    const metadata = await this.uploadEnvelopeToPath(path, envelope, conditionalRev, modifiedAt)
    const pathDisplay = metadata.path_display ?? path
    const pathLower = metadata.path_lower ?? pathDisplay.toLowerCase()
    const key = metadata.id ?? createPathDropboxFileKey(pathLower)

    // The uploaded file becomes (or refreshes) its own recent-list record and
    // takes the selection (SPEC §8/§9). The vault "primary" record is NOT
    // touched: it is the draft, a separate document.
    await this.store.putDropboxFile(
      {
        key,
        name: metadata.name ?? pathDisplay.split('/').filter(Boolean).at(-1) ?? path,
        pathDisplay,
        pathLower,
        envelope,
        baseRev: metadata.rev ?? null,
        lastSyncedEnvelope: envelope,
        lastSyncedContentHash: metadata.content_hash ?? null,
        pendingLocalEnvelope: null,
        syncedModifiedAt: modifiedAt,
        localModifiedAt: modifiedAt,
        lastOpenedAt: now.toISOString(),
      },
      now,
    )
    await this.store.saveDropboxSync({
      lastSyncStatus: 'synced',
      ...clearedRemoteConflictFields(),
      selectedFileKey: key,
    })
  }

  private async uploadPendingEnvelope(
    envelope: string,
    record: DropboxFileRecord,
    // The edit time to upload as `client_modified`. Omitted by the home-check
    // flush, which falls back to the record's stored `localModifiedAt`.
    clientModified?: string,
  ) {
    try {
      const metadata = await this.uploadSelectedEnvelope(envelope, record, undefined, clientModified)

      await this.markRecordSynced(record, metadata, envelope)
    } catch (error) {
      if (error instanceof DropboxProviderError && error.code === 'conflict') {
        await this.recordConflict(envelope, record)
        return
      }

      if (error instanceof DropboxProviderError) {
        await this.recordRecoverableSyncError(error, envelope, record)
        return
      }

      await this.recordRecoverableSyncError(
        new DropboxProviderError('unknown', 'Dropbox upload failed.'),
        envelope,
        record,
      )
    }
  }

  private async recordConflict(pendingLocalEnvelope: string, record: DropboxFileRecord) {
    try {
      const remote = await this.downloadRemote(getRecordRemoteLocator(record))

      // Not a real divergence: the remote already equals our pending bytes, so a
      // previous upload actually succeeded (e.g. it landed just before a crash
      // could clear `pendingLocalEnvelope`/`baseRev`, or another tab pushed the
      // identical envelope). Adopt the remote revision as the new base and mark
      // synced instead of forcing the user through a no-op conflict resolution.
      if (remote.envelope === pendingLocalEnvelope) {
        await this.markRecordSynced(record, remote.metadata, remote.envelope)
        return
      }

      await this.store.putDropboxFile({
        key: record.key,
        name: remote.metadata.name ?? record.name,
        pathDisplay: remote.metadata.path_display ?? record.pathDisplay,
        pathLower: remote.metadata.path_lower ?? record.pathLower,
        // Preserve the last-synced base (`baseRev` untouched); only the
        // conflict rev tracks the remote.
        pendingLocalEnvelope,
      })
      await this.store.saveDropboxSync({
        lastSyncStatus: 'conflict',
        ...remoteConflictFields(remote.envelope, remote.rev, remote.metadata.client_modified),
      })
    } catch {
      // The fresh remote could not be downloaded. Record the conflict, but clear
      // any previously captured remote snapshot so a later resolution never acts
      // on stale remote data — it must re-capture before it can relate to the
      // remote again.
      await this.store.putDropboxFile({
        key: record.key,
        name: record.name,
        pathDisplay: record.pathDisplay,
        pathLower: record.pathLower,
        pendingLocalEnvelope,
      })
      await this.store.saveDropboxSync({
        lastSyncStatus: 'conflict',
        ...clearedRemoteConflictFields(),
      })
    }
  }

  private async recordRecoverableSyncError(
    error: DropboxProviderError,
    pendingLocalEnvelope?: string,
    record?: DropboxFileRecord,
  ) {
    // 'not-found' means the selected remote file no longer exists: surface it
    // as needs-attention ('error') so the user reselects or recreates the file
    // (SPEC §9 step 6) instead of retrying into a permanent 'pending sync'.
    const nextStatus =
      error.code === 'offline'
        ? 'offline'
        : error.code === 'auth' || error.code === 'not-found' || error.code === 'corrupt'
          ? 'error'
          : 'pending-local'

    if (pendingLocalEnvelope !== undefined && record) {
      await this.store.putDropboxFile({
        key: record.key,
        name: record.name,
        pathDisplay: record.pathDisplay,
        pathLower: record.pathLower,
        pendingLocalEnvelope,
      })
      await this.store.saveDropboxSync({ lastSyncStatus: nextStatus })
      return
    }

    const update: SyncRecordDraft = {
      lastSyncStatus: nextStatus,
    }

    if (pendingLocalEnvelope !== undefined) {
      update.pendingLocalEnvelope = pendingLocalEnvelope
    }

    await this.store.saveDropboxSync(update)
  }
}

export const dropboxProvider = new DropboxProvider()
