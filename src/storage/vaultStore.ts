import type {
  DropboxSyncStatus,
  StorageModeKind,
  StorageProvider,
  StorageProviderKind,
  StorageStatus,
} from './storageProvider'
import type { KdfPolicyId } from '../crypto/kdfPolicy'

const DEFAULT_DB_NAME = 'enoteweb'
// Version 2 adds the `dropboxFile` store (SPEC §8):
// one record per recent Dropbox file, each with its own encrypted cache.
const DB_VERSION = 2
const VAULT_STORE = 'vault'
const FILE_STORE = 'file'
const SYNC_STORE = 'sync'
const SETTINGS_STORE = 'settings'
const DROPBOX_FILE_STORE = 'dropboxFile'
const PRIMARY_KEY = 'primary'
// Local File Mode's recovery copy lives under its own key so switching to (or
// using) Local File Mode can never overwrite the draft / Dropbox working copy
// stored under 'primary' (SPEC §8).
const LOCAL_FILE_RECOVERY_KEY = 'local-file-recovery'
const APP_VERSION = '1.0.0'
type StoredStorageProviderKind = StorageProviderKind

export type VaultRecord = {
  key: typeof PRIMARY_KEY | typeof LOCAL_FILE_RECOVERY_KEY
  envelope: string
  activeProvider: StoredStorageProviderKind
  createdAt: string
  updatedAt: string
  appVersion: string
}

export type LocalFileRecord = {
  key: string
  active: boolean
  createdAt: string
  displayName: string | null
  displayPath: string | null
  handle: FileSystemFileHandle | null
  lastModifiedAt: string | null
  lastSavedEnvelope: string | null
  updatedAt: string | null
  permissionState: 'unknown' | 'granted' | 'denied' | 'prompt'
}

type StoredLocalFileRecord = Omit<LocalFileRecord, 'active' | 'createdAt'> &
  Partial<Pick<LocalFileRecord, 'active' | 'createdAt'>>

type LocalFileDraft = Omit<LocalFileRecord, 'active' | 'createdAt' | 'key'> & {
  createdAt?: string | null
  key?: string | null
}

export type SyncRecord = {
  key: 'dropbox'
  linked: boolean
  accessTokenExpiresAt: string | null
  // Owner of the recent files/caches (SPEC §8/§9): captured from the OAuth
  // token exchange; NOT token material — survives Unlink and involuntary
  // authorization loss, cleared only when the caches are wiped.
  accountId: string | null
  accountLabel: string | null
  // True after an INVOLUNTARY token clear (revoked/expired/missing scope):
  // distinguishes the home Dropbox block's authorization-lost state (Relink +
  // export-only table) from a voluntary Unlink (Link only) — both end with
  // linked: false (SPEC §9). Cleared by a successful link and by a voluntary
  // unlink.
  authLost: boolean
  // Non-null while an account-switch guard is unresolved (SPEC §9): the link
  // completed to a DIFFERENT account than the one owning the recent files.
  // Holds the newly linked account id; every Dropbox operation refuses until
  // the user discards the old account's recents (adopt) or cancels (decline).
  pendingAccountSwitch: string | null
  pendingAccountSwitchLabel: string | null
  codeVerifier: string | null
  oauthState: string | null
  refreshToken: string | null
  // The persisted recent-files selection (SPEC §8/§9): the `dropboxFile`
  // record key the home `Open` action acts on.
  selectedFileKey: string | null
  selectedFileId: string | null
  selectedName: string | null
  selectedPathDisplay: string | null
  selectedPathLower: string | null
  baseRev: string | null
  lastSyncedEnvelope: string | null
  pendingLocalEnvelope: string | null
  remoteConflictEnvelope: string | null
  remoteConflictRev: string | null
  // Dropbox `client_modified` of the captured remote conflict snapshot, so a
  // "keep remote" adopt can stamp the synced version's modified time onto the
  // record's columns (SPEC §8) instead of leaving the local edit's stale time.
  remoteConflictClientModified: string | null
  lastSyncAt: string | null
  lastSyncStatus: DropboxSyncStatus
}

// One record per file in the home recent-files list (SPEC §8). The key is the
// raw Dropbox file id (Dropbox ids are self-prefixed "id:..." — never add
// another prefix); a file whose id is not yet known uses "path:<pathLower>"
// until its first successful metadata fetch rekeys it.
export type DropboxFileRecord = {
  key: string
  name: string
  pathDisplay: string
  pathLower: string
  // Encrypted local cache; null = listed but not currently cached.
  envelope: string | null
  baseRev: string | null
  lastSyncedEnvelope: string | null
  // Dropbox's content_hash of the last-synced envelope (SPEC §9): lets the
  // background check tell a metadata-only revision bump (pure move/rename)
  // from a real content change without re-downloading. Null on records
  // written before the field existed — the check then falls back to the
  // download-and-compare path.
  lastSyncedContentHash?: string | null
  // Non-null = unsynced local changes; such a record is never auto-evicted.
  pendingLocalEnvelope: string | null
  // Dropbox `client_modified` of the last-synced REMOTE version (second-
  // precision UTC); the `Last synced` column. Null until the record syncs at
  // least once. Display only — "has ever synced" is derived from
  // baseRev/lastSyncedEnvelope, not this. (SPEC §8)
  syncedModifiedAt: string | null
  // The working copy's own modified time (second-precision UTC); the `Last
  // modified` column. Set on any local envelope rewrite (content/password/
  // read-only flag) and to the adopted remote `client_modified` on a clean
  // download/adopt. Equals `syncedModifiedAt` while clean. (SPEC §8)
  localModifiedAt: string | null
  // Recent-list order, newest first.
  lastOpenedAt: string
  createdAt: string
  updatedAt: string
}

export type DropboxFileDraft = {
  key: string
  name: string
  pathDisplay: string
  pathLower: string
  envelope?: string | null
  baseRev?: string | null
  lastSyncedEnvelope?: string | null
  lastSyncedContentHash?: string | null
  pendingLocalEnvelope?: string | null
  syncedModifiedAt?: string | null
  localModifiedAt?: string | null
  lastOpenedAt?: string
}

export type LocalFilePathRootRecord = {
  key: 'localFilePathRoot'
  handle: FileSystemDirectoryHandle | null
  name: string | null
  updatedAt: string | null
}

// Target cap, deliberately not a hard invariant (SPEC §8): inserting beyond it
// evicts the oldest-opened record WITHOUT unsynced changes; records with
// unsynced changes are never evicted silently, so the list may temporarily
// exceed the cap rather than destroy data.
export const DROPBOX_FILE_TARGET_CAP = 20

export type SyncRecordDraft = Partial<Omit<SyncRecord, 'key'>> & {
  key?: 'dropbox'
}

export type SettingsRecord =
  | { key: 'theme'; value: 'system' | 'light' | 'dark' }
  | { key: 'lineWrap'; value: boolean }
  | { key: 'editorMode'; value: 'plain' | 'markdown' }
  | { key: 'fontFamily'; value: string }
  | { key: 'fontSizePx'; value: number }
  | { key: 'spellcheck'; value: boolean }
  | { key: 'autocorrect'; value: boolean }
  | { key: 'autocapitalize'; value: 'off' | 'none' | 'sentences' | 'words' | 'characters' }
  | { key: 'autoLockMinutes'; value: number }
  | { key: 'randomStringLength'; value: number }
  // Per-home recent-file column layout: order is stable column ids, widths are
  // fractions in the active order. App sanitizes wrong-shape values to defaults
  // on load.
  | { key: 'recentsColumnOrder'; value: { dropbox: string[]; local: string[] } }
  | { key: 'recentsColumnWidths'; value: { dropbox: number[]; local: number[] } }
  | { key: 'showWhitespace'; value: boolean }
  | { key: 'kdfPolicy'; value: KdfPolicyId }
  | { key: 'storageProvider'; value: StorageModeKind | 'auto' }
  | { key: 'secretKey'; value: string | null }
  | LocalFilePathRootRecord

const requestToPromise = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'))
  })

const transactionDone = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'))
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'))
  })

let localFileKeyCounter = 0

const createLocalFileKey = () => {
  localFileKeyCounter += 1
  const randomId =
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  const sequence = localFileKeyCounter.toString().padStart(6, '0')

  return `local-file-${Date.now()}-${sequence}-${randomId}`
}

const normalizeLocalFileRecord = (record: StoredLocalFileRecord): LocalFileRecord => ({
  ...record,
  active: record.active ?? record.key === PRIMARY_KEY,
  createdAt: record.createdAt ?? record.updatedAt ?? new Date(0).toISOString(),
  lastModifiedAt: record.lastModifiedAt ?? null,
})

const compareLocalFileRecords = (first: LocalFileRecord, second: LocalFileRecord) =>
  first.createdAt.localeCompare(second.createdAt) ||
  (first.updatedAt ?? '').localeCompare(second.updatedAt ?? '') ||
  first.key.localeCompare(second.key)

const isSameFileHandle = async (
  firstHandle: FileSystemFileHandle | null,
  secondHandle: FileSystemFileHandle | null,
) => {
  if (!firstHandle || !secondHandle) {
    return false
  }

  const comparableFirstHandle = firstHandle as FileSystemFileHandle & {
    isSameEntry?: (otherHandle: FileSystemHandle) => Promise<boolean>
  }
  const comparableSecondHandle = secondHandle as FileSystemFileHandle & {
    isSameEntry?: (otherHandle: FileSystemHandle) => Promise<boolean>
  }

  try {
    if (comparableFirstHandle.isSameEntry) {
      return await comparableFirstHandle.isSameEntry(secondHandle)
    }

    if (comparableSecondHandle.isSameEntry) {
      return await comparableSecondHandle.isSameEntry(firstHandle)
    }
  } catch {
    return false
  }

  return false
}

// ALL records pointing at the same on-disk file, not just the first: a save
// must collapse every same-entry record, or duplicates that ever entered the
// list (e.g. written by older builds) survive each save and the recent list
// never converges to one entry per file.
const findSameFileRecords = async (
  records: LocalFileRecord[],
  handle: FileSystemFileHandle | null,
  currentKey: string | null | undefined,
) => {
  if (!handle) {
    return []
  }

  const matches: LocalFileRecord[] = []

  for (const record of records) {
    if (record.key !== currentKey && (await isSameFileHandle(record.handle, handle))) {
      matches.push(record)
    }
  }

  return matches
}

export const createDefaultDropboxSyncRecord = (): SyncRecord => ({
  accessTokenExpiresAt: null,
  accountId: null,
  accountLabel: null,
  authLost: false,
  baseRev: null,
  pendingAccountSwitch: null,
  pendingAccountSwitchLabel: null,
  codeVerifier: null,
  key: 'dropbox',
  lastSyncAt: null,
  lastSyncedEnvelope: null,
  lastSyncStatus: 'never',
  linked: false,
  oauthState: null,
  pendingLocalEnvelope: null,
  refreshToken: null,
  remoteConflictEnvelope: null,
  remoteConflictRev: null,
  remoteConflictClientModified: null,
  selectedFileId: null,
  selectedFileKey: null,
  selectedName: null,
  selectedPathDisplay: null,
  selectedPathLower: null,
})

const compareDropboxFileRecords = (first: DropboxFileRecord, second: DropboxFileRecord) =>
  second.lastOpenedAt.localeCompare(first.lastOpenedAt) || first.key.localeCompare(second.key)

// Provisional "path:<pathLower>" key for a record whose Dropbox file id is not
// yet known (SPEC §8). Raw Dropbox ids are self-prefixed "id:...", so the two
// forms can never collide.
export const createPathDropboxFileKey = (pathLower: string) => `path:${pathLower}`

// Inside an open readwrite transaction that includes the sync store: when the
// persisted selection points at one of `matchKeys`, repoint it to
// `replacementKey` (null clears it). Issued through the transaction's own
// request chain so the record mutation and the selection update commit — or
// abort — together (a crash between them could otherwise leave the selection
// pointing at a missing record).
const clearSelectionInTransaction = (
  syncStore: IDBObjectStore,
  matchKeys: string[],
  replacementKey: string | null,
  onDone: () => void,
  onError: (error: unknown) => void,
) => {
  const getRequest = syncStore.get('dropbox')

  getRequest.onsuccess = () => {
    const existing = getRequest.result as Partial<SyncRecord> | undefined

    if (existing?.selectedFileKey && matchKeys.includes(existing.selectedFileKey)) {
      syncStore.put({
        ...createDefaultDropboxSyncRecord(),
        ...existing,
        key: 'dropbox',
        selectedFileKey: replacementKey,
      })
    }

    onDone()
  }
  getRequest.onerror = () =>
    onError(getRequest.error ?? new Error('Failed to read the Dropbox sync record.'))
}

const normalizeDropboxSyncRecord = (
  record: Partial<SyncRecord> | undefined,
): SyncRecord | null => {
  if (!record) {
    return null
  }

  const legacyRecord = record as Partial<SyncRecord> & {
    remoteFileId?: string | null
    remoteName?: string | null
    remotePath?: string | null
    remotePathLower?: string | null
  }

  return {
    ...createDefaultDropboxSyncRecord(),
    ...record,
    key: 'dropbox',
    selectedFileId: record.selectedFileId ?? legacyRecord.remoteFileId ?? null,
    selectedName: record.selectedName ?? legacyRecord.remoteName ?? null,
    selectedPathDisplay: record.selectedPathDisplay ?? legacyRecord.remotePath ?? null,
    selectedPathLower: record.selectedPathLower ?? legacyRecord.remotePathLower ?? null,
  }
}

export class VaultStore {
  readonly dbName: string

  #dbPromise: Promise<IDBDatabase> | undefined

  constructor(dbName = DEFAULT_DB_NAME) {
    this.dbName = dbName
  }

  async getVault() {
    const db = await this.open()
    const transaction = db.transaction(VAULT_STORE, 'readonly')
    const request = transaction.objectStore(VAULT_STORE).get(PRIMARY_KEY)
    const result = await requestToPromise<VaultRecord | undefined>(request)

    await transactionDone(transaction)
    return result ?? null
  }

  async saveEnvelope(
    envelope: string,
    now = new Date(),
    activeProvider: StorageProviderKind = 'draft',
  ) {
    return this.putVaultRecord(PRIMARY_KEY, envelope, now, activeProvider)
  }

  // The Local File Mode recovery copy. Stored under its own key so local-file
  // operations can never overwrite the 'primary' working copy.
  async saveLocalFileRecovery(envelope: string, now = new Date()) {
    return this.putVaultRecord(LOCAL_FILE_RECOVERY_KEY, envelope, now, 'local-file')
  }

  async getLocalFileRecovery() {
    const db = await this.open()
    const transaction = db.transaction(VAULT_STORE, 'readonly')
    const request = transaction.objectStore(VAULT_STORE).get(LOCAL_FILE_RECOVERY_KEY)
    const result = await requestToPromise<VaultRecord | undefined>(request)

    await transactionDone(transaction)
    return result ?? null
  }

  async clearLocalFileRecovery() {
    const db = await this.open()
    const transaction = db.transaction(VAULT_STORE, 'readwrite')
    transaction.objectStore(VAULT_STORE).delete(LOCAL_FILE_RECOVERY_KEY)
    await transactionDone(transaction)
  }

  private async putVaultRecord(
    key: VaultRecord['key'],
    envelope: string,
    now: Date,
    activeProvider: StoredStorageProviderKind,
  ) {
    // Read-merge-write inside ONE readwrite transaction: IndexedDB serializes
    // readwrite transactions on a store across tabs, so a concurrent writer's
    // update can never be merged over from a stale read. The put is
    // issued synchronously inside the get's onsuccess — awaiting in between
    // would auto-commit the transaction.
    const db = await this.open()
    const timestamp = now.toISOString()
    const transaction = db.transaction(VAULT_STORE, 'readwrite')
    const objectStore = transaction.objectStore(VAULT_STORE)
    const record = await new Promise<VaultRecord>((resolve, reject) => {
      const getRequest = objectStore.get(key)

      getRequest.onsuccess = () => {
        const existing = getRequest.result as VaultRecord | undefined
        const nextRecord: VaultRecord = {
          key,
          envelope,
          activeProvider,
          createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp,
          appVersion: APP_VERSION,
        }

        objectStore.put(nextRecord)
        resolve(nextRecord)
      }
      getRequest.onerror = () =>
        reject(getRequest.error ?? new Error('Failed to read the vault record.'))
    })

    await transactionDone(transaction)
    return record
  }

  async clearVault() {
    const db = await this.open()
    const transaction = db.transaction(VAULT_STORE, 'readwrite')
    transaction.objectStore(VAULT_STORE).delete(PRIMARY_KEY)
    await transactionDone(transaction)
  }

  async getLocalFiles() {
    const db = await this.open()
    const transaction = db.transaction(FILE_STORE, 'readonly')
    const request = transaction.objectStore(FILE_STORE).getAll()
    const result = await requestToPromise<StoredLocalFileRecord[]>(request)

    await transactionDone(transaction)
    return result.map(normalizeLocalFileRecord).sort(compareLocalFileRecords)
  }

  async getActiveLocalFile() {
    const records = await this.getLocalFiles()

    return records.findLast((record) => record.active) ?? records.at(-1) ?? null
  }

  async saveLocalFile(record: LocalFileDraft) {
    const records = await this.getLocalFiles()
    const existingRecord =
      record.key ? records.find((localFileRecord) => localFileRecord.key === record.key) : null
    const sameFileRecords = await findSameFileRecords(records, record.handle, record.key)
    const metadataFallbackRecord = existingRecord ?? sameFileRecords.at(-1) ?? null
    const sameFileKeys = new Set(sameFileRecords.map((sameFileRecord) => sameFileRecord.key))
    const now = record.updatedAt ?? new Date().toISOString()
    const nextRecord: LocalFileRecord = {
      ...record,
      active: true,
      createdAt: record.createdAt ?? existingRecord?.createdAt ?? now,
      key: record.key ?? createLocalFileKey(),
      lastModifiedAt: record.lastModifiedAt ?? metadataFallbackRecord?.lastModifiedAt ?? null,
      updatedAt: now,
    }
    const db = await this.open()
    const transaction = db.transaction(FILE_STORE, 'readwrite')
    const objectStore = transaction.objectStore(FILE_STORE)

    for (const existingLocalFileRecord of records) {
      if (sameFileKeys.has(existingLocalFileRecord.key)) {
        objectStore.delete(existingLocalFileRecord.key)
      } else if (existingLocalFileRecord.key !== nextRecord.key) {
        objectStore.put({ ...existingLocalFileRecord, active: false } satisfies LocalFileRecord)
      }
    }

    objectStore.put(nextRecord)
    await transactionDone(transaction)
    return nextRecord
  }

  async setActiveLocalFile(key: string) {
    const records = await this.getLocalFiles()
    const activeRecord = records.find((record) => record.key === key)

    if (!activeRecord) {
      return null
    }

    const db = await this.open()
    const transaction = db.transaction(FILE_STORE, 'readwrite')
    const objectStore = transaction.objectStore(FILE_STORE)

    for (const record of records) {
      objectStore.put({ ...record, active: record.key === key } satisfies LocalFileRecord)
    }

    await transactionDone(transaction)
    return { ...activeRecord, active: true } satisfies LocalFileRecord
  }

  async clearLocalFile(key?: string) {
    const records = await this.getLocalFiles()
    const activeRecord = records.findLast((record) => record.active) ?? records.at(-1) ?? null
    const keyToDelete = key ?? activeRecord?.key

    if (!keyToDelete) {
      return null
    }

    const remainingRecords = records.filter((record) => record.key !== keyToDelete)
    const nextActiveRecord =
      remainingRecords.find((record) => record.active) ?? remainingRecords.at(-1) ?? null

    const db = await this.open()
    const transaction = db.transaction(FILE_STORE, 'readwrite')
    const objectStore = transaction.objectStore(FILE_STORE)

    objectStore.delete(keyToDelete)

    for (const record of remainingRecords) {
      objectStore.put({
        ...record,
        active: record.key === nextActiveRecord?.key,
      } satisfies LocalFileRecord)
    }

    await transactionDone(transaction)
    return nextActiveRecord ? { ...nextActiveRecord, active: true } : null
  }

  async updateLocalFileMetadata(
    key: string,
    metadata: Pick<LocalFileRecord, 'displayPath' | 'lastModifiedAt'>,
  ) {
    const db = await this.open()
    const transaction = db.transaction(FILE_STORE, 'readwrite')
    const objectStore = transaction.objectStore(FILE_STORE)
    const request = objectStore.get(key)
    const result = await requestToPromise<StoredLocalFileRecord | undefined>(request)

    if (!result) {
      await transactionDone(transaction)
      return null
    }

    const nextRecord = normalizeLocalFileRecord({
      ...result,
      displayPath: metadata.displayPath,
      lastModifiedAt: metadata.lastModifiedAt,
    })

    objectStore.put(nextRecord)
    await transactionDone(transaction)
    return nextRecord
  }

  async getLocalFilePathRoot() {
    const db = await this.open()
    const transaction = db.transaction(SETTINGS_STORE, 'readonly')
    const request = transaction.objectStore(SETTINGS_STORE).get('localFilePathRoot')
    const result = await requestToPromise<LocalFilePathRootRecord | undefined>(request)

    await transactionDone(transaction)
    return result ?? null
  }

  async saveLocalFilePathRoot(handle: FileSystemDirectoryHandle | null, now = new Date()) {
    const record: LocalFilePathRootRecord = {
      key: 'localFilePathRoot',
      handle,
      name: handle?.name ?? null,
      updatedAt: now.toISOString(),
    }

    const db = await this.open()
    const transaction = db.transaction(SETTINGS_STORE, 'readwrite')
    transaction.objectStore(SETTINGS_STORE).put(record)
    await transactionDone(transaction)
    return record
  }

  async getDropboxSync() {
    const db = await this.open()
    const transaction = db.transaction(SYNC_STORE, 'readonly')
    const request = transaction.objectStore(SYNC_STORE).get('dropbox')
    const result = await requestToPromise<Partial<SyncRecord> | undefined>(request)

    await transactionDone(transaction)
    return normalizeDropboxSyncRecord(result)
  }

  async saveDropboxSync(record: SyncRecordDraft) {
    // Atomic read-merge-write (one transaction): a concurrent writer's update
    // — e.g. a fresh OAuth refreshToken written by another window — can never
    // be reverted by merging this draft over a stale read.
    const db = await this.open()
    const transaction = db.transaction(SYNC_STORE, 'readwrite')
    const objectStore = transaction.objectStore(SYNC_STORE)
    const nextRecord = await new Promise<SyncRecord>((resolve, reject) => {
      const getRequest = objectStore.get('dropbox')

      getRequest.onsuccess = () => {
        const existing = normalizeDropboxSyncRecord(
          getRequest.result as Partial<SyncRecord> | undefined,
        )
        const merged: SyncRecord = {
          ...(existing ?? createDefaultDropboxSyncRecord()),
          ...record,
          key: 'dropbox',
        }

        objectStore.put(merged)
        resolve(merged)
      }
      getRequest.onerror = () =>
        reject(getRequest.error ?? new Error('Failed to read the Dropbox sync record.'))
    })

    await transactionDone(transaction)
    return nextRecord
  }

  // Involuntary authorization loss (refresh token revoked, expired, or missing
  // a required scope): clears token material ONLY — unlike clearDropboxAuth
  // (user-initiated Unlink) below, the file selection, sync snapshots, and any
  // pending local envelope survive, so relinking resumes the same document
  // with nothing lost (SPEC §9). `accountLabel` is kept as a relink hint.
  async clearDropboxTokens(options: { authLost?: boolean } = {}) {
    return this.saveDropboxSync({
      accessTokenExpiresAt: null,
      // Default true: this method's normal caller is the involuntary-loss
      // path. The account-switch guard's Cancel passes false — that clear is
      // the user's choice, so the block must read as unlinked, not auth-lost.
      authLost: options.authLost ?? true,
      codeVerifier: null,
      linked: false,
      oauthState: null,
      // Tokens are gone, so any unresolved account switch is moot.
      pendingAccountSwitch: null,
      pendingAccountSwitchLabel: null,
      refreshToken: null,
    })
  }

  // Voluntary Unlink pauses the Dropbox connection but keeps the retained
  // refresh token and recent-file ownership. Cached records remain visible and
  // open read-only in the app; relinking can reuse the grant unless the user
  // explicitly chooses Switch.
  async pauseDropboxLink() {
    return this.saveDropboxSync({
      accessTokenExpiresAt: null,
      authLost: false,
      codeVerifier: null,
      linked: false,
      oauthState: null,
      pendingAccountSwitch: null,
      pendingAccountSwitchLabel: null,
    })
  }

  async clearDropboxAuth() {
    return this.saveDropboxSync({
      accessTokenExpiresAt: null,
      // accountLabel/accountId are kept so the recent-file owner remains named
      // even when the live Dropbox grant is forgotten before Switch.
      authLost: false,
      pendingAccountSwitch: null,
      pendingAccountSwitchLabel: null,
      codeVerifier: null,
      linked: false,
      oauthState: null,
      refreshToken: null,
    })
  }

  // Disconnects the selected Dropbox file while keeping the OAuth link: clears
  // the file selection and all sync/conflict state but leaves `linked`,
  // `refreshToken`, `accountLabel`, and `accessTokenExpiresAt` intact (unlike
  // clearDropboxAuth, which also wipes auth).
  async clearDropboxFileSelection() {
    return this.saveDropboxSync({
      baseRev: null,
      lastSyncAt: null,
      lastSyncStatus: 'never',
      lastSyncedEnvelope: null,
      pendingLocalEnvelope: null,
      remoteConflictEnvelope: null,
      remoteConflictRev: null,
      remoteConflictClientModified: null,
      selectedFileId: null,
      // The selection is the record key; clearing it leaves
      // the record itself — and its cache — untouched (nothing is discarded
      // by deselecting under the per-file model).
      selectedFileKey: null,
      selectedName: null,
      selectedPathDisplay: null,
      selectedPathLower: null,
    })
  }

  // ---- Per-file Dropbox records (SPEC §8) ----

  async getDropboxFiles() {
    const db = await this.open()
    const transaction = db.transaction(DROPBOX_FILE_STORE, 'readonly')
    const request = transaction.objectStore(DROPBOX_FILE_STORE).getAll()
    const result = await requestToPromise<DropboxFileRecord[]>(request)

    await transactionDone(transaction)
    return result.sort(compareDropboxFileRecords)
  }

  async getDropboxFile(key: string) {
    const db = await this.open()
    const transaction = db.transaction(DROPBOX_FILE_STORE, 'readonly')
    const request = transaction.objectStore(DROPBOX_FILE_STORE).get(key)
    const result = await requestToPromise<DropboxFileRecord | undefined>(request)

    await transactionDone(transaction)
    return result ?? null
  }

  // Atomic upsert with target-cap eviction (SPEC §8): merge over any existing
  // record, evict the oldest-opened records WITHOUT unsynced changes until the
  // store is back at the cap, and clear the persisted selection if it pointed
  // at an evicted record — all inside ONE readwrite transaction spanning both
  // stores, so a crash can never leave `selectedFileKey` pointing at a missing
  // record. Records with unsynced changes are never evicted, so the store may
  // temporarily exceed the cap. Returns the merged record and what was evicted.
  async putDropboxFile(draft: DropboxFileDraft, now = new Date()) {
    const timestamp = now.toISOString()
    const db = await this.open()
    const transaction = db.transaction([DROPBOX_FILE_STORE, SYNC_STORE], 'readwrite')
    const objectStore = transaction.objectStore(DROPBOX_FILE_STORE)
    const syncStore = transaction.objectStore(SYNC_STORE)
    const { record, evictedKeys } = await new Promise<{
      record: DropboxFileRecord
      evictedKeys: string[]
    }>((resolve, reject) => {
      const getAllRequest = objectStore.getAll()

      getAllRequest.onsuccess = () => {
        const existingRecords = (getAllRequest.result ?? []) as DropboxFileRecord[]
        const existing = existingRecords.find((candidate) => candidate.key === draft.key)
        const merged: DropboxFileRecord = {
          key: draft.key,
          name: draft.name,
          pathDisplay: draft.pathDisplay,
          pathLower: draft.pathLower,
          envelope: draft.envelope === undefined ? (existing?.envelope ?? null) : draft.envelope,
          baseRev: draft.baseRev === undefined ? (existing?.baseRev ?? null) : draft.baseRev,
          lastSyncedEnvelope:
            draft.lastSyncedEnvelope === undefined
              ? (existing?.lastSyncedEnvelope ?? null)
              : draft.lastSyncedEnvelope,
          lastSyncedContentHash:
            draft.lastSyncedContentHash === undefined
              ? (existing?.lastSyncedContentHash ?? null)
              : draft.lastSyncedContentHash,
          pendingLocalEnvelope:
            draft.pendingLocalEnvelope === undefined
              ? (existing?.pendingLocalEnvelope ?? null)
              : draft.pendingLocalEnvelope,
          syncedModifiedAt:
            draft.syncedModifiedAt === undefined
              ? (existing?.syncedModifiedAt ?? null)
              : draft.syncedModifiedAt,
          localModifiedAt:
            draft.localModifiedAt === undefined
              ? (existing?.localModifiedAt ?? null)
              : draft.localModifiedAt,
          lastOpenedAt: draft.lastOpenedAt ?? existing?.lastOpenedAt ?? timestamp,
          createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp,
        }

        objectStore.put(merged)

        const allRecords = [
          merged,
          ...existingRecords.filter((candidate) => candidate.key !== merged.key),
        ]
        const overflow = allRecords.length - DROPBOX_FILE_TARGET_CAP
        const evicted: string[] = []

        if (overflow > 0) {
          const evictable = allRecords
            .filter(
              (candidate) => candidate.key !== merged.key && !candidate.pendingLocalEnvelope,
            )
            .sort((first, second) => first.lastOpenedAt.localeCompare(second.lastOpenedAt))

          for (const candidate of evictable.slice(0, overflow)) {
            objectStore.delete(candidate.key)
            evicted.push(candidate.key)
          }
        }

        if (evicted.length === 0) {
          resolve({ record: merged, evictedKeys: evicted })
          return
        }

        clearSelectionInTransaction(
          syncStore,
          evicted,
          null,
          () => resolve({ record: merged, evictedKeys: evicted }),
          reject,
        )
      }
      getAllRequest.onerror = () =>
        reject(getAllRequest.error ?? new Error('Failed to read the Dropbox file records.'))
    })

    await transactionDone(transaction)
    return { evictedKeys, record }
  }

  // Wipes the whole recent-files list and every cache, clearing the persisted
  // selection in the same transaction — the account-switch guard's
  // discard-and-continue (SPEC §9). The draft (vault "primary") is untouched.
  async clearDropboxFiles() {
    const db = await this.open()
    const transaction = db.transaction([DROPBOX_FILE_STORE, SYNC_STORE], 'readwrite')
    const syncStore = transaction.objectStore(SYNC_STORE)

    transaction.objectStore(DROPBOX_FILE_STORE).clear()
    await new Promise<void>((resolve, reject) => {
      const getRequest = syncStore.get('dropbox')

      getRequest.onsuccess = () => {
        const existing = getRequest.result as Partial<SyncRecord> | undefined

        if (existing?.selectedFileKey) {
          syncStore.put({
            ...createDefaultDropboxSyncRecord(),
            ...existing,
            key: 'dropbox',
            selectedFileKey: null,
          })
        }

        resolve()
      }
      getRequest.onerror = () =>
        reject(getRequest.error ?? new Error('Failed to read the Dropbox sync record.'))
    })
    await transactionDone(transaction)
  }

  async deleteDropboxFile(key: string) {
    const db = await this.open()
    const transaction = db.transaction([DROPBOX_FILE_STORE, SYNC_STORE], 'readwrite')
    const syncStore = transaction.objectStore(SYNC_STORE)

    transaction.objectStore(DROPBOX_FILE_STORE).delete(key)
    await new Promise<void>((resolve, reject) => {
      clearSelectionInTransaction(syncStore, [key], null, resolve, reject)
    })
    await transactionDone(transaction)
  }

  // Rekeys a provisional "path:<pathLower>" record to the raw Dropbox file id
  // once the id is known (SPEC §8). Runs as ONE transaction over both stores.
  // When a record already exists under the id, the id-keyed record is
  // authoritative for cache/sync/identity fields; the path-keyed record
  // contributes its pending envelope only when the target has none. When BOTH
  // records hold distinct pending envelopes, the rekey is refused (returns
  // null, both records kept) — an automatic merge would necessarily destroy one
  // unsynced edit.
  async rekeyDropboxFile(oldKey: string, newKey: string, now = new Date()) {
    if (oldKey === newKey) {
      return this.getDropboxFile(oldKey)
    }

    const timestamp = now.toISOString()
    const db = await this.open()
    const transaction = db.transaction([DROPBOX_FILE_STORE, SYNC_STORE], 'readwrite')
    const objectStore = transaction.objectStore(DROPBOX_FILE_STORE)
    const syncStore = transaction.objectStore(SYNC_STORE)
    const result = await new Promise<DropboxFileRecord | null>((resolve, reject) => {
      const getOldRequest = objectStore.get(oldKey)

      getOldRequest.onsuccess = () => {
        const oldRecord = getOldRequest.result as DropboxFileRecord | undefined

        if (!oldRecord) {
          resolve(null)
          return
        }

        const getTargetRequest = objectStore.get(newKey)

        getTargetRequest.onsuccess = () => {
          const target = getTargetRequest.result as DropboxFileRecord | undefined

          if (
            target?.pendingLocalEnvelope &&
            oldRecord.pendingLocalEnvelope &&
            target.pendingLocalEnvelope !== oldRecord.pendingLocalEnvelope
          ) {
            resolve(null)
            return
          }

          const merged: DropboxFileRecord = target
            ? {
                ...target,
                pendingLocalEnvelope:
                  target.pendingLocalEnvelope ?? oldRecord.pendingLocalEnvelope,
                lastOpenedAt:
                  target.lastOpenedAt > oldRecord.lastOpenedAt
                    ? target.lastOpenedAt
                    : oldRecord.lastOpenedAt,
                updatedAt: timestamp,
              }
            : { ...oldRecord, key: newKey, updatedAt: timestamp }

          objectStore.put(merged)
          objectStore.delete(oldKey)
          clearSelectionInTransaction(syncStore, [oldKey], newKey, () => resolve(merged), reject)
        }
        getTargetRequest.onerror = () =>
          reject(getTargetRequest.error ?? new Error('Failed to read the Dropbox file record.'))
      }
      getOldRequest.onerror = () =>
        reject(getOldRequest.error ?? new Error('Failed to read the Dropbox file record.'))
    })

    await transactionDone(transaction)
    return result
  }

  async touchDropboxFileOpened(key: string, now = new Date()) {
    const record = await this.getDropboxFile(key)

    if (!record) {
      return null
    }

    const { record: touched } = await this.putDropboxFile(
      { ...record, lastOpenedAt: now.toISOString() },
      now,
    )

    return touched
  }

  async setSelectedDropboxFileKey(key: string | null) {
    return this.saveDropboxSync({ selectedFileKey: key })
  }

  async getSetting<K extends SettingsRecord['key']>(key: K) {
    const db = await this.open()
    const transaction = db.transaction(SETTINGS_STORE, 'readonly')
    const request = transaction.objectStore(SETTINGS_STORE).get(key)
    const result = await requestToPromise<Extract<SettingsRecord, { key: K }> | undefined>(request)

    await transactionDone(transaction)
    return result ?? null
  }

  async saveSetting(record: SettingsRecord) {
    const db = await this.open()
    const transaction = db.transaction(SETTINGS_STORE, 'readwrite')
    transaction.objectStore(SETTINGS_STORE).put(record)
    await transactionDone(transaction)
  }

  close() {
    if (!this.#dbPromise) {
      return
    }

    this.#dbPromise.then((db) => db.close()).catch(() => undefined)
    this.#dbPromise = undefined
  }

  private open() {
    if (this.#dbPromise) {
      return this.#dbPromise
    }

    const promise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION)
      let settled = false

      request.onupgradeneeded = () => {
        const db = request.result

        for (const storeName of [
          VAULT_STORE,
          FILE_STORE,
          SYNC_STORE,
          SETTINGS_STORE,
          DROPBOX_FILE_STORE,
        ]) {
          if (!db.objectStoreNames.contains(storeName)) {
            db.createObjectStore(storeName, { keyPath: 'key' })
          }
        }
      }

      request.onsuccess = () => {
        const db = request.result

        // A blocked open can still succeed later; if we already rejected,
        // close the late connection instead of leaking it.
        if (settled) {
          db.close()
          return
        }

        settled = true
        // If a future build ever bumps DB_VERSION, close this connection so
        // the other tab's upgrade is not deadlocked forever; the next store
        // call here re-opens (and surfaces a versioned error if outdated).
        db.onversionchange = () => {
          db.close()

          if (this.#dbPromise === promise) {
            this.#dbPromise = undefined
          }
        }
        resolve(db)
      }
      request.onerror = () => {
        settled = true
        reject(request.error ?? new Error('Failed to open IndexedDB.'))
      }
      request.onblocked = () => {
        settled = true
        reject(new Error('IndexedDB open was blocked.'))
      }
    })

    // Never memoize a failure: a transient open error (storage pressure, a
    // blocked upgrade) must not poison every later read/write for the whole
    // session — the next operation retries with a fresh open.
    promise.catch(() => {
      if (this.#dbPromise === promise) {
        this.#dbPromise = undefined
      }
    })

    this.#dbPromise = promise
    return this.#dbPromise
  }
}

export class DraftProvider implements StorageProvider {
  readonly kind = 'draft'

  private readonly store: VaultStore

  constructor(store: VaultStore) {
    this.store = store
  }

  async load() {
    const record = await this.store.getVault()

    if (!record) {
      throw new Error('No draft is saved.')
    }

    return record.envelope
  }

  async save(envelope: string) {
    await this.store.saveEnvelope(envelope, new Date(), this.kind)
  }

  // The vault "primary" record IS the draft (SPEC §4/§8), and
  // this status surfaces on the unified home, so the wording follows the
  // draft-action labels there.
  async status(): Promise<StorageStatus> {
    const record = await this.store.getVault()

    return record
      ? { state: 'ready', detail: 'Draft is ready.' }
      : { state: 'needs-user-action', detail: 'No draft yet. Create one with New draft.' }
  }
}

export const vaultStore = new VaultStore()
export const draftProvider = new DraftProvider(vaultStore)
