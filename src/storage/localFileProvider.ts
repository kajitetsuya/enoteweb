import { parseEnvelope } from '../crypto/cryptoService'
import {
  DEFAULT_EXPORT_FILE_NAME,
  ENCRYPTED_FILE_NAME_MESSAGE,
  ENCRYPTED_TEXT_FILE_TYPES,
  isEncryptedTextFileName,
} from '../exportFileNames'
import type { StorageProvider, StorageStatus } from './storageProvider'
import { VaultStore, vaultStore } from './vaultStore'
import type { LocalFilePathRootRecord, LocalFileRecord } from './vaultStore'

export const LOCAL_FILE_PATH_UNAVAILABLE = 'Full path unavailable'
const LOCAL_FILE_OUTSIDE_PATH_ROOT = 'Outside path root'

type LocalFileDiagnosticSource = 'startup-load' | 'open-recent' | 'browse'
type LocalFileDiagnosticStage =
  | 'action-failed'
  | 'no-handle'
  | 'permission-not-granted'
  | 'read-only'
  | 'read-failed'
  | 'read-invalid'
  | 'read-ok'
  | 'decrypt-ok'
  | 'decrypt-failed'

type LocalFileDiagnostic = {
  aead?: string
  app?: string
  ciphertextBytes?: number
  envelopeBytes: number
  envelopeChars: number
  envelopeSha256Prefix: string
  errorMessage?: string
  errorName?: string
  fileLastModified?: number
  fileName?: string
  fileSize?: number
  fileType?: string
  handleName?: string
  id: number
  keyOrder?: string[]
  kdf?: string
  memlimit?: number
  nonceBytes?: number
  opslimit?: number
  parsed: boolean
  permissionMode?: FilePermissionMode
  permissionQueryState?: FilePermissionState
  permissionRequestState?: FilePermissionState
  saltBytes?: number
  source: LocalFileDiagnosticSource
  stage: LocalFileDiagnosticStage
  timestamp: string
  trimmedChars: number
  userActivationActive?: boolean
  userActivationActiveBeforeRequest?: boolean
  userActivationHasBeenActive?: boolean
  userActivationHasBeenActiveBeforeRequest?: boolean
  v?: number
}

declare global {
  interface Window {
    __ENOTEWEB_LOCAL_FILE_DIAGNOSTICS__?: LocalFileDiagnostic[]
  }
}

type FilePermissionMode = 'read' | 'readwrite'
type FilePermissionState = 'unknown' | PermissionState

// A picked-but-unwritten creation destination (SPEC §10/§17 destination-first
// order): produced by `pickCreateTarget`, consumed by `createAtTarget`.
export type LocalFileCreateTarget = {
  handle: FileSystemFileHandle
  permissionState: FilePermissionState
}

let diagnosticId = 0

// The shared skeleton for diagnostics that carry no envelope metrics (permission,
// read-only, generic failure, and file-read failure). Each call takes one fresh
// diagnostic id, exactly as the inlined literals did.
const createEmptyMetricsDiagnostic = (
  source: LocalFileDiagnosticSource,
  stage: LocalFileDiagnosticStage,
) => ({
  envelopeBytes: 0,
  envelopeChars: 0,
  envelopeSha256Prefix: '',
  id: ++diagnosticId,
  parsed: false,
  source,
  stage,
  timestamp: new Date().toISOString(),
  trimmedChars: 0,
})

const getErrorDetails = (error: unknown) => {
  if (error instanceof Error) {
    return {
      errorMessage: error.message,
      errorName: error.name,
    }
  }

  return {
    errorMessage: String(error),
    errorName: typeof error,
  }
}

const getByteLength = (value: string) => new TextEncoder().encode(value).length

const getExposedDisplayPath = (source: unknown) => {
  const pathSource = source as { fullPath?: unknown; path?: unknown }
  const path = pathSource.path ?? pathSource.fullPath

  return typeof path === 'string' && path.trim() ? path : null
}

const getFileLastModifiedAt = (file: File) => {
  const { lastModified } = file

  if (!Number.isFinite(lastModified) || lastModified <= 0) {
    return null
  }

  const date = new Date(lastModified)

  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

const getSha256Prefix = async (value: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  const bytes = Array.from(new Uint8Array(digest.slice(0, 8)))

  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const getBase64ByteLength = (value: string) => {
  const normalized = value.trim()
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0

  return (normalized.length / 4) * 3 - padding
}

const publishLocalFileDiagnostic = (diagnostic: LocalFileDiagnostic) => {
  if (typeof window === 'undefined') {
    return
  }

  window.__ENOTEWEB_LOCAL_FILE_DIAGNOSTICS__ = [
    ...(window.__ENOTEWEB_LOCAL_FILE_DIAGNOSTICS__ ?? []),
    diagnostic,
  ].slice(-20)
  window.dispatchEvent(
    new CustomEvent('enoteweb-local-file-diagnostic', {
      detail: diagnostic,
    }),
  )

  if (import.meta.env.DEV) {
    console.info('[eNoteWeb local file diagnostic]', diagnostic)
  }
}

const publishLocalFilePermissionDiagnostic = (
  source: LocalFileDiagnosticSource,
  handle: FileSystemFileHandle,
  permissionState: FilePermissionState,
  details: Partial<LocalFileDiagnostic> = {},
) => {
  publishLocalFileDiagnostic({
    ...createEmptyMetricsDiagnostic(source, 'permission-not-granted'),
    errorMessage: `Local file permission state: ${permissionState}`,
    errorName: 'PermissionState',
    handleName: handle.name,
    ...details,
  })
}

const publishLocalFileReadOnlyDiagnostic = (
  source: LocalFileDiagnosticSource,
  handle: FileSystemFileHandle,
  details: Partial<LocalFileDiagnostic>,
) => {
  publishLocalFileDiagnostic({
    ...createEmptyMetricsDiagnostic(source, 'read-only'),
    errorMessage: 'Local file opened without write permission.',
    errorName: 'ReadOnlyPermission',
    handleName: handle.name,
    ...details,
  })
}

const publishLocalFileFailureDiagnostic = (
  source: LocalFileDiagnosticSource,
  stage: Extract<LocalFileDiagnosticStage, 'action-failed' | 'no-handle'>,
  error: unknown,
) => {
  publishLocalFileDiagnostic({
    ...createEmptyMetricsDiagnostic(source, stage),
    ...getErrorDetails(error),
  })
}

const buildEnvelopeDiagnostic = async (
  source: LocalFileDiagnosticSource,
  stage: LocalFileDiagnosticStage,
  envelope: string,
  error?: unknown,
) => {
  const baseDiagnostic = {
    envelopeBytes: getByteLength(envelope),
    envelopeChars: envelope.length,
    envelopeSha256Prefix: await getSha256Prefix(envelope),
    id: ++diagnosticId,
    parsed: false,
    source,
    stage,
    timestamp: new Date().toISOString(),
    trimmedChars: envelope.trim().length,
    ...(error === undefined ? {} : getErrorDetails(error)),
  } satisfies LocalFileDiagnostic

  try {
    const parsed = parseEnvelope(envelope)

    return {
      ...baseDiagnostic,
      aead: parsed.aead,
      app: parsed.app,
      ciphertextBytes: getBase64ByteLength(parsed.ciphertext),
      keyOrder: Object.keys(parsed),
      kdf: parsed.kdf,
      memlimit: parsed.memlimit,
      nonceBytes: getBase64ByteLength(parsed.nonce),
      opslimit: parsed.opslimit,
      parsed: true,
      saltBytes: getBase64ByteLength(parsed.salt),
      v: parsed.v,
    }
  } catch (parseError) {
    return {
      ...baseDiagnostic,
      ...getErrorDetails(error ?? parseError),
    }
  }
}

export const publishLocalFileUnlockDiagnostic = async (
  source: LocalFileDiagnosticSource,
  stage: Extract<LocalFileDiagnosticStage, 'action-failed' | 'decrypt-ok' | 'decrypt-failed'>,
  envelope: string | null,
  error?: unknown,
) => {
  if (!envelope) {
    publishLocalFileFailureDiagnostic(source, 'action-failed', error)
    return
  }

  publishLocalFileDiagnostic(await buildEnvelopeDiagnostic(source, stage, envelope, error))
}

const getOpenFilePicker = () => {
  if (!globalThis.showOpenFilePicker) {
    throw new Error('Local file picker is not available.')
  }

  return globalThis.showOpenFilePicker.bind(globalThis)
}

const getSaveFilePicker = () => {
  if (!globalThis.showSaveFilePicker) {
    throw new Error('Local file save picker is not available.')
  }

  return globalThis.showSaveFilePicker.bind(globalThis)
}

const getDirectoryPicker = () => {
  if (!globalThis.showDirectoryPicker) {
    throw new Error('Local folder picker is not available.')
  }

  return globalThis.showDirectoryPicker.bind(globalThis)
}

const queryPermissionState = async (
  handle: FileSystemFileHandle,
  mode: FilePermissionMode,
): Promise<FilePermissionState> => {
  if (!handle.queryPermission) {
    return 'unknown'
  }

  try {
    return await handle.queryPermission({ mode })
  } catch {
    return 'unknown'
  }
}

const readLastModifiedAtFromHandle = async (handle: FileSystemFileHandle) => {
  const permissionState = await queryPermissionState(handle, 'read')

  if (permissionState !== 'granted' && permissionState !== 'unknown') {
    return null
  }

  try {
    return getFileLastModifiedAt(await handle.getFile())
  } catch {
    return null
  }
}

const getRelativeFolderPath = async (
  rootRecord: LocalFilePathRootRecord | null,
  handle: FileSystemFileHandle,
) => {
  if (!rootRecord?.handle) {
    return null
  }

  const resolve = rootRecord.handle.resolve

  if (!resolve) {
    return null
  }

  try {
    const pathParts = await resolve.call(rootRecord.handle, handle)

    if (!pathParts) {
      return LOCAL_FILE_OUTSIDE_PATH_ROOT
    }

    const folderParts = pathParts.slice(0, -1)

    return folderParts.length > 0 ? folderParts.join('/') : '/'
  } catch {
    return null
  }
}

const getDisplayPathForHandle = async (
  handle: FileSystemFileHandle,
  rootRecord: LocalFilePathRootRecord | null,
  fallbackPath: string | null | undefined,
) => {
  if (rootRecord?.handle) {
    return (
      (await getRelativeFolderPath(rootRecord, handle)) ??
      fallbackPath ??
      getExposedDisplayPath(handle)
    )
  }

  return fallbackPath ?? getExposedDisplayPath(handle)
}

const requestPermissionState = async (
  handle: FileSystemFileHandle,
  mode: FilePermissionMode,
): Promise<FilePermissionState> => {
  if (!handle.requestPermission) {
    return 'unknown'
  }

  try {
    return await handle.requestPermission({ mode })
  } catch {
    return 'unknown'
  }
}

type EnsurePermissionOptions = {
  requestFirst?: boolean
}

const getUserActivationDetails = () => {
  const userActivation = navigator.userActivation

  return userActivation
    ? {
        userActivationActive: userActivation.isActive,
        userActivationHasBeenActive: userActivation.hasBeenActive,
      }
    : {}
}

const ensurePermission = async (
  handle: FileSystemFileHandle,
  mode: FilePermissionMode,
  options: EnsurePermissionOptions = {},
) => {
  if (options.requestFirst) {
    const beforeRequestActivation = getUserActivationDetails()
    const requestedState = await requestPermissionState(handle, mode)
    const beforeRequestDetails =
      beforeRequestActivation.userActivationActive === undefined
        ? {}
        : {
            userActivationActiveBeforeRequest: beforeRequestActivation.userActivationActive,
            userActivationHasBeenActiveBeforeRequest:
              beforeRequestActivation.userActivationHasBeenActive,
          }

    if (requestedState === 'granted') {
      return {
        ...getUserActivationDetails(),
        ...beforeRequestDetails,
        permissionMode: mode,
        permissionRequestState: requestedState,
        state: requestedState,
      }
    }

    const queriedState = await queryPermissionState(handle, mode)

    return {
      ...getUserActivationDetails(),
      ...beforeRequestDetails,
      permissionMode: mode,
      permissionQueryState: queriedState,
      permissionRequestState: requestedState,
      state: queriedState,
    }
  }

  const queriedState = await queryPermissionState(handle, mode)

  if (queriedState === 'granted') {
    return {
      ...getUserActivationDetails(),
      permissionMode: mode,
      permissionQueryState: queriedState,
      state: queriedState,
    }
  }

  const requestedState = await requestPermissionState(handle, mode)

  return {
    ...getUserActivationDetails(),
    permissionMode: mode,
    permissionQueryState: queriedState,
    permissionRequestState: requestedState,
    state: requestedState,
  }
}

const ensureReadWritePermission = (
  handle: FileSystemFileHandle,
  options: EnsurePermissionOptions = {},
) => ensurePermission(handle, 'readwrite', options)

const ensureReadPermission = (
  handle: FileSystemFileHandle,
  options: EnsurePermissionOptions = {},
) => ensurePermission(handle, 'read', options)

const getPermissionDiagnosticDetails = (
  result: Partial<LocalFileDiagnostic>,
): Partial<LocalFileDiagnostic> => ({
  ...(result.permissionMode ? { permissionMode: result.permissionMode } : {}),
  ...(result.permissionQueryState
    ? { permissionQueryState: result.permissionQueryState }
    : {}),
  ...(result.permissionRequestState
    ? { permissionRequestState: result.permissionRequestState }
    : {}),
  ...(result.userActivationActive === undefined
    ? {}
    : { userActivationActive: result.userActivationActive }),
  ...(result.userActivationActiveBeforeRequest === undefined
    ? {}
    : { userActivationActiveBeforeRequest: result.userActivationActiveBeforeRequest }),
  ...(result.userActivationHasBeenActive === undefined
    ? {}
    : { userActivationHasBeenActive: result.userActivationHasBeenActive }),
  ...(result.userActivationHasBeenActiveBeforeRequest === undefined
    ? {}
    : {
        userActivationHasBeenActiveBeforeRequest:
          result.userActivationHasBeenActiveBeforeRequest,
      }),
})

const ensureEditablePermission = async (
  handle: FileSystemFileHandle,
  source: LocalFileDiagnosticSource,
) => {
  const writePermissionResult = await ensureReadWritePermission(handle, { requestFirst: true })

  if (writePermissionResult.state === 'granted') {
    return writePermissionResult
  }

  const readPermissionResult = await ensureReadPermission(handle, { requestFirst: true })

  if (readPermissionResult.state !== 'granted') {
    publishLocalFilePermissionDiagnostic(
      source,
      handle,
      readPermissionResult.state,
      readPermissionResult,
    )
    throw new Error('Local file read permission is required.')
  }

  publishLocalFileReadOnlyDiagnostic(
    source,
    handle,
    getPermissionDiagnosticDetails(writePermissionResult),
  )

  return readPermissionResult
}

// The remembered file no longer exists at its saved location (moved, renamed,
// or deleted). Detected before any decryption, so surfacing it specifically
// reveals nothing about the password or envelope contents (SPEC Section 16).
export class LocalFileNotFoundError extends Error {
  constructor() {
    super('The selected local file was not found at its saved location.')
    this.name = 'LocalFileNotFoundError'
  }
}

const readEnvelopeFromHandle = async (
  handle: FileSystemFileHandle,
  source: LocalFileDiagnosticSource,
) => {
  let file: File
  let rawText: string

  try {
    file = await handle.getFile()
    rawText = await file.text()
  } catch (error) {
    publishLocalFileDiagnostic({
      ...createEmptyMetricsDiagnostic(source, 'read-failed'),
      handleName: handle.name,
      ...getErrorDetails(error),
    })

    if (error instanceof DOMException && error.name === 'NotFoundError') {
      throw new LocalFileNotFoundError()
    }

    throw error
  }

  const envelope = rawText.trim()
  const diagnostic = await buildEnvelopeDiagnostic(source, 'read-ok', envelope)

  publishLocalFileDiagnostic({
    ...diagnostic,
    fileLastModified: file.lastModified,
    fileName: file.name,
    fileSize: file.size,
    handleName: handle.name,
    stage: diagnostic.parsed ? 'read-ok' : 'read-invalid',
    ...(file.type ? { fileType: file.type } : {}),
  })

  return {
    displayPath: getExposedDisplayPath(handle) ?? getExposedDisplayPath(file),
    envelope,
    lastModifiedAt: getFileLastModifiedAt(file),
  }
}

const writeEnvelopeToHandle = async (handle: FileSystemFileHandle, envelope: string) => {
  const writable = await handle.createWritable()

  await writable.write(`${envelope.trim()}\n`)
  await writable.close()
}

export class LocalFileProvider implements StorageProvider {
  readonly kind = 'local-file'

  private activeHandle: FileSystemFileHandle | null = null

  private activeRecordKey: string | null = null

  private readonly store: VaultStore

  constructor(store: VaultStore) {
    this.store = store
  }

  async load() {
    const { handle, record } = await this.getSelectedFile()

    if (!handle) {
      publishLocalFileFailureDiagnostic(
        'startup-load',
        'no-handle',
        new Error('No local file handle is saved.'),
      )
      throw new Error('No local file handle is saved.')
    }

    const permissionState = await queryPermissionState(handle, 'read')

    if (permissionState !== 'granted') {
      await this.rememberFile(handle, record?.lastSavedEnvelope ?? null, permissionState, {
        displayPath: record?.displayPath ?? getExposedDisplayPath(handle),
        recordKey: record?.key,
      })
      publishLocalFilePermissionDiagnostic('startup-load', handle, permissionState)
      throw new Error('Local file read permission is required.')
    }

    const { displayPath, envelope, lastModifiedAt } = await readEnvelopeFromHandle(
      handle,
      'startup-load',
    )

    parseEnvelope(envelope)
    await this.rememberFile(handle, envelope, permissionState, {
      displayPath: displayPath ?? record?.displayPath,
      lastModifiedAt,
      recordKey: record?.key,
    })
    return envelope
  }

  async loadWithPermission(selectedRecord?: LocalFileRecord) {
    const { handle, record } = selectedRecord
      ? {
          handle:
            selectedRecord.handle ??
            (this.activeRecordKey === selectedRecord.key ? this.activeHandle : null),
          record: selectedRecord,
        }
      : await this.getSelectedFile()

    if (!handle) {
      publishLocalFileFailureDiagnostic(
        'open-recent',
        'no-handle',
        new Error('No local file handle is saved.'),
      )
      throw new Error('No local file handle is saved.')
    }

    this.activeRecordKey = record?.key ?? null
    this.activeHandle = handle

    const permissionResult = await ensureEditablePermission(handle, 'open-recent')
    const permissionState = permissionResult.state

    if (permissionState !== 'granted') {
      await this.rememberFile(handle, record?.lastSavedEnvelope ?? null, permissionState, {
        displayPath: record?.displayPath ?? getExposedDisplayPath(handle),
        recordKey: record?.key,
      })
      publishLocalFilePermissionDiagnostic(
        'open-recent',
        handle,
        permissionState,
        permissionResult,
      )
      throw new Error('Local file read permission is required.')
    }

    const { displayPath, envelope, lastModifiedAt } = await readEnvelopeFromHandle(
      handle,
      'open-recent',
    )

    parseEnvelope(envelope)
    await this.rememberFile(handle, envelope, permissionState, {
      displayPath: displayPath ?? record?.displayPath,
      lastModifiedAt,
      recordKey: record?.key,
    })
    return envelope
  }

  async save(envelope: string) {
    parseEnvelope(envelope)

    const { handle, record } = await this.getSelectedFile()

    if (!handle) {
      throw new Error('No local file is selected.')
    }

    const permissionResult = await ensureReadWritePermission(handle)
    const permissionState = permissionResult.state

    if (permissionState !== 'granted') {
      await this.rememberFile(handle, record?.lastSavedEnvelope ?? null, permissionState, {
        displayPath: record?.displayPath ?? getExposedDisplayPath(handle),
        recordKey: record?.key,
      })
      throw new Error('Local file write permission was not granted.')
    }

    await writeEnvelopeToHandle(handle, envelope)
    await this.rememberFile(handle, envelope, permissionState, {
      displayPath: record?.displayPath ?? getExposedDisplayPath(handle),
      recordKey: record?.key,
    })
  }

  async status(): Promise<StorageStatus> {
    const { handle } = await this.getSelectedFile()

    if (!handle) {
      return {
        detail: 'Choose or create an encrypted text file.',
        state: 'needs-user-action',
      }
    }

    const permissionState = await queryPermissionState(handle, 'readwrite')

    if (permissionState === 'granted') {
      return {
        detail: 'Local encrypted text file is ready.',
        state: 'ready',
      }
    }

    return {
      detail:
        permissionState === 'denied'
          ? 'Local file write permission was denied.'
          : 'Open the local file and allow write permission to save.',
      state: permissionState === 'denied' ? 'error' : 'needs-user-action',
    }
  }

  async setPathRoot() {
    const showDirectoryPicker = getDirectoryPicker()
    const handle = await showDirectoryPicker({ mode: 'read' })

    await this.store.saveLocalFilePathRoot(handle)
    await this.refreshRecentFileMetadata()
    return handle
  }

  async refreshRecentFileMetadata() {
    const rootRecord = await this.store.getLocalFilePathRoot()
    const records = await this.store.getLocalFiles()

    for (const record of records) {
      if (!record.handle) {
        continue
      }

      const displayPath = await getDisplayPathForHandle(
        record.handle,
        rootRecord,
        record.displayPath,
      )
      const lastModifiedAt =
        (await readLastModifiedAtFromHandle(record.handle)) ?? record.lastModifiedAt

      if (displayPath !== record.displayPath || lastModifiedAt !== record.lastModifiedAt) {
        await this.store.updateLocalFileMetadata(record.key, { displayPath, lastModifiedAt })
      }
    }

    return this.store.getLocalFiles()
  }

  // Destination-first creation, step 1 (SPEC §10/§17: destination before any
  // password dialog): the native save picker plus its write-permission prompt
  // resolve the target handle; nothing is written. The caller collects the
  // password afterwards and writes through `createAtTarget` — discarding the
  // target (a cancelled password dialog) writes nothing.
  async pickCreateTarget(options?: {
    startIn?: FileSystemHandle | string
    suggestedName?: string
  }): Promise<LocalFileCreateTarget> {
    const showSaveFilePicker = getSaveFilePicker()
    // SPEC §10: creation opens the picker pre-filled with the suggested default
    // filename (user-editable) and accepts .txt/.text only (no "All files"
    // option).
    const handle = await showSaveFilePicker({
      excludeAcceptAllOption: true,
      suggestedName: options?.suggestedName ?? DEFAULT_EXPORT_FILE_NAME,
      ...(options?.startIn ? { startIn: options.startIn } : {}),
      types: ENCRYPTED_TEXT_FILE_TYPES,
    })

    if (!isEncryptedTextFileName(handle.name)) {
      throw new Error(ENCRYPTED_FILE_NAME_MESSAGE)
    }

    const permissionResult = await ensureReadWritePermission(handle)
    const permissionState = permissionResult.state

    if (permissionState !== 'granted') {
      throw new Error('Local file write permission was not granted.')
    }

    return { handle, permissionState }
  }

  // Destination-first creation, step 2: write the envelope to the picked
  // target and remember it as the active recent file.
  async createAtTarget(target: LocalFileCreateTarget, envelope: string) {
    parseEnvelope(envelope)
    await writeEnvelopeToHandle(target.handle, envelope)
    await this.rememberFile(target.handle, envelope, target.permissionState, {
      append: true,
      displayPath: getExposedDisplayPath(target.handle),
    })
    return envelope
  }

  async create(
    envelope: string,
    options?: { startIn?: FileSystemHandle | string; suggestedName?: string },
  ) {
    // Validate before opening any picker (the historical contract of this
    // one-shot form, kept for callers that already hold the envelope).
    parseEnvelope(envelope)

    const target = await this.pickCreateTarget(options)

    return this.createAtTarget(target, envelope)
  }

  async open() {
    const showOpenFilePicker = getOpenFilePicker()
    // SPEC §10: file pickers accept .txt only (no "All files" option).
    const [handle] = await showOpenFilePicker({
      excludeAcceptAllOption: true,
      multiple: false,
      types: ENCRYPTED_TEXT_FILE_TYPES,
    })

    if (!handle) {
      publishLocalFileFailureDiagnostic(
        'browse',
        'no-handle',
        new Error('No local file was selected.'),
      )
      throw new Error('No local file was selected.')
    }

    // Post-picker guard (SPEC §7): the picker filter normally enforces
    // this, but a hand-typed filename can bypass it.
    if (!isEncryptedTextFileName(handle.name)) {
      throw new Error(ENCRYPTED_FILE_NAME_MESSAGE)
    }

    const permissionResult = await ensureEditablePermission(handle, 'browse')
    const permissionState = permissionResult.state

    if (permissionState !== 'granted') {
      publishLocalFilePermissionDiagnostic('browse', handle, permissionState, permissionResult)
      throw new Error('Local file read permission was not granted.')
    }

    const { displayPath, envelope, lastModifiedAt } = await readEnvelopeFromHandle(
      handle,
      'browse',
    )

    parseEnvelope(envelope)
    await this.rememberFile(handle, envelope, permissionState, {
      append: true,
      displayPath,
      lastModifiedAt,
    })
    return envelope
  }

  async select(recordKey: string) {
    const record = await this.store.setActiveLocalFile(recordKey)

    this.activeRecordKey = record?.key ?? null
    this.activeHandle = record?.handle ?? null
    return record
  }

  async forget(recordKey?: string) {
    const activeRecord = await this.store.getActiveLocalFile()
    const keyToForget = recordKey ?? this.activeRecordKey ?? activeRecord?.key
    const nextActiveRecord = await this.store.clearLocalFile(keyToForget)

    this.activeRecordKey = nextActiveRecord?.key ?? null
    this.activeHandle = nextActiveRecord?.handle ?? null

    if (nextActiveRecord?.lastSavedEnvelope) {
      await this.store.saveLocalFileRecovery(nextActiveRecord.lastSavedEnvelope)
    } else {
      await this.store.clearLocalFileRecovery()
    }

    return nextActiveRecord
  }

  private async rememberFile(
    handle: FileSystemFileHandle,
    envelope: string | null,
    permissionState: FilePermissionState,
    options: {
      append?: boolean
      displayPath?: string | null | undefined
      lastModifiedAt?: string | null | undefined
      recordKey?: string | null | undefined
    } = {},
  ) {
    const now = new Date()
    const rootRecord = await this.store.getLocalFilePathRoot()
    const displayPath = await getDisplayPathForHandle(handle, rootRecord, options.displayPath)
    const lastModifiedAt =
      options.lastModifiedAt ?? (await readLastModifiedAtFromHandle(handle)) ?? null

    this.activeHandle = handle

    if (envelope) {
      // Recovery copy under its own vault key — never the 'primary' record,
      // which holds the draft / Dropbox working copy.
      await this.store.saveLocalFileRecovery(envelope, now)
    }

    const savedRecord = await this.store.saveLocalFile({
      key: options.append ? null : (options.recordKey ?? this.activeRecordKey),
      displayName: handle.name,
      displayPath,
      handle,
      lastModifiedAt,
      lastSavedEnvelope: envelope,
      permissionState,
      updatedAt: now.toISOString(),
    })

    this.activeRecordKey = savedRecord.key
  }

  private async getSelectedFile(): Promise<{
    handle: FileSystemFileHandle | null
    record: LocalFileRecord | null
  }> {
    const record = await this.store.getActiveLocalFile()

    if (record?.key !== this.activeRecordKey) {
      this.activeRecordKey = record?.key ?? null
      this.activeHandle = record?.handle ?? null
    }

    return {
      handle: this.activeHandle ?? record?.handle ?? null,
      record,
    }
  }
}

export const localFileProvider = new LocalFileProvider(vaultStore)
