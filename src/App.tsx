import { Component, lazy, Suspense, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  CSSProperties,
  ChangeEvent,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  RefObject,
} from 'react'
import { flushSync } from 'react-dom'
import './App.css'
import { buildLabel } from './buildInfo'
import {
  applyUpdate,
  checkForUpdates,
  reloadOnce,
  subscribeStagedUpdate,
  subscribeVersionPinned,
  UpdateBlockedError,
  type UpdateCheckResult,
} from './registerServiceWorker'
import caseSensitiveIcon from '../icons/case_sensitive.svg'
import chevronLeftIcon from '../icons/chevron_left.svg'
import chevronRightIcon from '../icons/chevron_right.svg'
import dropboxIcon from '../icons/dropbox.svg'
import encryptionIcon from '../icons/encryption.svg'
import exportIcon from '../icons/export.svg'
import folderIcon from '../icons/folder.svg'
import helpIcon from '../icons/help.svg'
import homeIcon from '../icons/home.svg'
import importIcon from '../icons/import.svg'
import randomStringIcon from '../icons/question_box.svg'
import changePasswordIcon from '../icons/key.svg'
import localStorageIcon from '../icons/local_storage.svg'
import markdownIcon from '../icons/markdown.svg'
import qrCodeIcon from '../icons/qr_code.svg'
import redoIcon from '../icons/redo.svg'
import regexIcon from '../icons/regex.svg'
import hierarchyIcon from '../icons/hierarchy.svg'
import saveAsIcon from '../icons/save_as.svg'
import searchIcon from '../icons/search.svg'
import readOnlyOnIcon from '../icons/lock_filled_1.svg'
import readOnlyOffIcon from '../icons/lock_outline_2.svg'
import settingsIcon from '../icons/settings_gear.svg'
import syncIcon from '../icons/sync.svg'
import trashIcon from '../icons/trash.svg'
import undoIcon from '../icons/undo.svg'
import wholeWordIcon from '../icons/whole_word.svg'
import {
  CryptoService,
  DEFAULT_KDF_PARAMS,
  SECRET_KEY_MODE_REQUIRED,
  SecretKeyRequiredError,
  type EncryptedEnvelopeBody,
  getEnvelopeSecretKeyMode,
  isEnvelopeReadOnly,
  parseEnvelope,
} from './crypto/cryptoService'
import {
  DEFAULT_KDF_POLICY_ID,
  getKdfPolicyIdForParams,
  KDF_POLICY_OPTIONS,
  type KdfPolicyId,
  type KdfPolicyParams,
  resolveKdfPolicyParams,
  sanitizeKdfPolicyId,
} from './crypto/kdfPolicy'
import {
  formatSecretKeyString,
  generateSecretKeyString,
  parseSecretKeyString,
} from './crypto/secretKey'
import { DropboxFileBrowser, type DropboxFileBrowserMode } from './DropboxFileBrowser'
import {
  PasswordDialog,
  type SecretKeyFieldConfig,
  type SecretKeyToggleConfig,
} from './PasswordDialog'
const SecretKeyQr = lazy(() => import('./SecretKeyQr').then((m) => ({ default: m.SecretKeyQr })))
import { CodeMirrorEditor } from './editor/CodeMirrorEditor'
import type { EditorCursorInfo, EditorHandle } from './editor/CodeMirrorEditor'
import { countGraphemes, countWords } from './editor/textMetrics'
import { createHelpHeadingIdTracker, getHelpMarkdown, type HelpContext } from './helpContent'
import { MarkdownPreview } from './markdown/MarkdownPreview'
import { RENDER_KEY_ATTR } from './markdown/previewAnchors'
import { alignPreviewToSourceLine, sourceLineAtPreviewTop } from './markdown/previewSync'
import { renderMarkdownToSafeHtml } from './markdown/renderMarkdown'
import { isSupersededResult, validateSearchQuery, type SearchOptions } from './search/searchEngine'
import { findSearchMatchesSafely, terminateSearchWorker } from './search/searchWorkerClient'
const ConflictEditor = lazy(() =>
  import('./conflict/ConflictEditor').then((m) => ({ default: m.ConflictEditor })),
)
import {
  createConflictController,
  type ConflictController,
  type ConflictControllerDeps,
  type ConflictModalState,
  type ConflictResolutionChoice,
  type ConflictResolutions,
} from './conflict/conflictController'
import type { MergeRegion } from './merge/threeWayMerge'
import {
  deriveDropboxSyncDisplay,
  dropboxSyncToneSuffix,
  type SaveStatus,
} from './dropboxSyncDisplay'
import {
  DEFAULT_EXPORT_FILE_NAME,
  ENCRYPTED_FILE_NAME_MESSAGE,
  ENCRYPTED_TEXT_FILE_TYPES,
  LOCAL_CONFLICT_EXPORT_FILE_NAME,
  REMOTE_CONFLICT_EXPORT_FILE_NAME,
  isEncryptedTextFileName,
  toSuggestedTxtName,
} from './exportFileNames'
import {
  LOCAL_FILE_PATH_UNAVAILABLE,
  LocalFileNotFoundError,
  localFileProvider,
  publishLocalFileUnlockDiagnostic,
  type LocalFileCreateTarget,
} from './storage/localFileProvider'
import { requestPersistentStorage } from './storage/persistStorage'
import { getStorageProvider } from './storage/providerRegistry'
import { DropboxProviderError } from './storage/dropboxProvider'
import {
  detectStorageCapabilities,
  isSyncStorageProvider,
  selectDefaultProviderKind,
  type DropboxLinkOptions,
  type DropboxRecentFileCheck,
  type DropboxRecentFiles as DropboxRecentFilesData,
  type DropboxSyncState,
  type StorageModeKind,
  type StorageProvider,
  type StorageProviderKind,
  type StorageStatus,
  type SyncStorageProvider,
} from './storage/storageProvider'
import {
  DropboxRecentFiles,
  RecentFilesTable,
  standardRecentColumns,
  type DropboxRecentFileIndicator,
  type RecentFileTableRow,
} from './DropboxRecentFiles'
import { vaultStore } from './storage/vaultStore'
import type { LocalFileRecord, SettingsRecord } from './storage/vaultStore'
import {
  DEFAULT_RANDOM_STRING_LENGTH,
  MIN_RANDOM_STRING_LENGTH,
  MAX_RANDOM_STRING_LENGTH,
  generateRandomString,
} from './randomString'

type MessageTone = 'error' | 'info'
// Where a message renders on the home: the bottom banner (`global`) or inline
// next to the "Dropbox" label in the Dropbox block (`dropbox`). The editor always
// shows messages in its own area regardless of scope.
type MessageScope = 'global' | 'dropbox' | 'local'

// How long an info-tone message stays before dismissing itself (SPEC §16).
// Error-tone messages never auto-dismiss.
const MESSAGE_AUTO_DISMISS_MS = 5_000
const SOFT_LOCK_RETRY_MS = 10_000
const SECRET_KEY_REQUIRED_UNLOCK_MESSAGE =
  "Enter this file's Secret key, or add it in Settings."
const SECRET_KEY_AUTH_FAILURE_MESSAGE = 'Could not unlock. Check the password or Secret key.'
const SECRET_KEY_INVALID_MESSAGE = 'Invalid Secret key.'
const SECRET_KEY_REPLACE_CONFIRM =
  'Replace the current Secret key? Files saved with the current key cannot be opened unless you paste it again. Record the current key first if you need it.'
const SECRET_KEY_MODE_CHANGED_MESSAGE =
  'This file changed and now needs a Secret key. Reopen it to continue.'
const STRONG_KDF_POLICY_CONFIRM =
  'Strong password hardening uses more memory and may be slower or fail to open on older devices. Files saved with Strong require that memory on every device. Continue?'

// Below this width the markdown preview is an overlay that hides the editor
// (the side-by-side split needs the room). MUST match the App.css breakpoint
// for `.editor-region.is-split .editor-host { display: none }`.
const OVERLAY_PREVIEW_MEDIA_QUERY = '(max-width: 640px)'
const nonMergeableMessage = (reason: 'no-remote' | 'remote-undecryptable' | 'local-undecryptable') =>
  reason === 'no-remote'
    ? 'The remote Dropbox version could not be downloaded. Retry when you are online, or export your encrypted local copy.'
    : reason === 'remote-undecryptable'
      ? 'The remote Dropbox version could not be read with this password. You can keep your local version, keep the remote encrypted copy, or export both encrypted copies first.'
      : 'The local encrypted copy could not be read. You can keep the remote encrypted copy, export the local encrypted copy, or try reopening the vault.'

// Sample regions for the DEV-only conflict-editor preview. Never bundled into a
// production build (the trigger is gated behind import.meta.env.DEV).
const DEV_PREVIEW_REGIONS: MergeRegion[] = [
  { type: 'clean', lines: ['# Meeting notes', 'Date: 2026-06-03', ''] },
  {
    type: 'conflict',
    local: ['Attendees: Alice, Bob, Carol'],
    base: ['Attendees: Alice, Bob'],
    remote: ['Attendees: Alice, Bob, Dave', '(Carol sent regrets)'],
  },
  { type: 'clean', lines: ['', '## Agenda', '- Budget review', ''] },
  {
    type: 'conflict',
    local: ['- Ship date: June 20'],
    base: ['- Ship date: TBD'],
    remote: ['- Ship date: June 27 (slipped)'],
  },
  { type: 'clean', lines: ['', '## Action items', '- Send recap'] },
]

type UpdateDialogState =
  | null
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'up-to-date' }
  | { kind: 'error' }
  | { kind: 'apply-error' }
  | { kind: 'applying' }

type AppTheme = 'system' | 'light' | 'dark'
type EditorMode = 'plain' | 'markdown'
type AutoCapitalizeSetting = 'off' | 'none' | 'sentences' | 'words' | 'characters'

type StorageProviderSetting = StorageModeKind | 'auto'
type SessionDocumentKind = 'draft' | 'dropbox-file' | 'local-file' | null
type EditorStorageProviderKind = 'local-file' | 'dropbox'
type SoftLockState = {
  error: string
  passwordInput: string
  verified: boolean
}

// Memorized recent-files column widths (fractions summing to 1, one per
// column). The two homes have different column counts — Local 3 (Name/Path/Last
// modified), Dropbox 4 (Name/Path/Last synced/Last modified) — so each persists
// its own vector rather than sharing one (SPEC §8).
type RecentsColumnWidths = {
  dropbox: number[]
  local: number[]
}

type RecentsColumnOrder = {
  dropbox: string[]
  local: string[]
}

type AppSettings = {
  autoLockMinutes: number
  autocapitalize: AutoCapitalizeSetting
  autocorrect: boolean
  editorMode: EditorMode
  fontFamily: string
  fontSizePx: number
  kdfPolicy: KdfPolicyId
  lineWrap: boolean
  randomStringLength: number
  recentsColumnOrder: RecentsColumnOrder
  recentsColumnWidths: RecentsColumnWidths
  secretKey: string | null
  showWhitespace: boolean
  spellcheck: boolean
  storageProvider: StorageProviderSetting
  theme: AppTheme
}

const defaultEditorFont =
  "ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace"

const defaultSettings: AppSettings = {
  autoLockMinutes: 0,
  // Normal sentence capitalization in the editor; search/replace inputs stay
  // autoCapitalize="off" so typed queries and regexes are not mangled.
  autocapitalize: 'sentences',
  autocorrect: true,
  editorMode: 'plain',
  fontFamily: defaultEditorFont,
  fontSizePx: 16,
  kdfPolicy: DEFAULT_KDF_POLICY_ID,
  lineWrap: true,
  randomStringLength: DEFAULT_RANDOM_STRING_LENGTH,
  recentsColumnOrder: {
    dropbox: ['name', 'path', 'synced', 'modified'],
    local: ['name', 'path', 'timestamp'],
  },
  recentsColumnWidths: {
    dropbox: [0.3, 0.28, 0.21, 0.21],
    local: [0.36, 0.34, 0.3],
  },
  secretKey: null,
  showWhitespace: false,
  spellcheck: true,
  storageProvider: 'auto',
  theme: 'system',
}

const getEnvelopeKdfParams = (
  envelope: Pick<EncryptedEnvelopeBody, 'opslimit' | 'memlimit'>,
): KdfPolicyParams => ({
  opslimit: envelope.opslimit,
  memlimit: envelope.memlimit,
})

const shouldPassKdfParams = (params: KdfPolicyParams) =>
  params.opslimit !== DEFAULT_KDF_PARAMS.opslimit ||
  params.memlimit !== DEFAULT_KDF_PARAMS.memlimit

// The selector exposes only the two user-facing storage modes (SPEC §2); `auto`
// is an internal first-run default, resolved to a concrete mode at launch and
// never shown as a dropdown option. The draft is not a selectable mode either;
// it is a browser-local document available in both modes, with mode-specific
// home actions (SPEC §4/§10).
const storageProviderOptions: ReadonlyArray<{ label: string; value: StorageModeKind }> = [
  { label: 'Local files', value: 'local-file' },
  { label: 'Dropbox', value: 'dropbox' },
]

const resolveEditorStorageProviderKind = (
  activeProviderKind: StorageProviderKind,
  selectedProviderKind: StorageProviderSetting,
  documentKind: SessionDocumentKind,
): EditorStorageProviderKind => {
  if (documentKind === 'draft') {
    return selectedProviderKind === 'local-file' ? 'local-file' : 'dropbox'
  }

  return activeProviderKind === 'local-file' ? 'local-file' : 'dropbox'
}

const autoLockOptions = [
  { label: 'Never', value: 0 },
  { label: 'After 1 minute', value: 1 },
  { label: 'After 2 minutes', value: 2 },
  { label: 'After 5 minutes', value: 5 },
  { label: 'After 10 minutes', value: 10 },
  { label: 'After 15 minutes', value: 15 },
] as const

const settingsKeys = Object.keys(defaultSettings) as Array<keyof AppSettings>

const fontOptions = [
  { label: 'Fixed width', value: defaultEditorFont },
  { label: 'System UI', value: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
  { label: 'Serif', value: "Georgia, 'Times New Roman', serif" },
  { label: 'Sans serif', value: "Arial, Helvetica, sans-serif" },
] as const

// Coerce a stored `recentsColumnWidths` to the per-home shape: a value that
// doesn't match the expected shape is ignored and defaults are used (per-vector
// length/sum is then validated again in the table). (SPEC §8)
const sanitizeRecentsColumnWidths = (value: unknown): RecentsColumnWidths => {
  const fallback = defaultSettings.recentsColumnWidths

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fallback
  }

  const candidate = value as { dropbox?: unknown; local?: unknown }
  const pickVector = (vector: unknown, fallbackVector: number[]) =>
    Array.isArray(vector) && vector.every((n) => typeof n === 'number' && Number.isFinite(n))
      ? (vector as number[])
      : fallbackVector

  return {
    dropbox: pickVector(candidate.dropbox, fallback.dropbox),
    local: pickVector(candidate.local, fallback.local),
  }
}

const sanitizeColumnOrderVector = (value: unknown, fallback: string[]) => {
  if (!Array.isArray(value) || value.length !== fallback.length) {
    return fallback
  }

  const allowed = new Set(fallback)
  const seen = new Set<string>()

  for (const key of value) {
    if (typeof key !== 'string' || !allowed.has(key) || seen.has(key)) {
      return fallback
    }

    seen.add(key)
  }

  return value
}

const sanitizeRecentsColumnOrder = (value: unknown): RecentsColumnOrder => {
  const fallback = defaultSettings.recentsColumnOrder

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fallback
  }

  const candidate = value as { dropbox?: unknown; local?: unknown }

  return {
    dropbox: sanitizeColumnOrderVector(candidate.dropbox, fallback.dropbox),
    local: sanitizeColumnOrderVector(candidate.local, fallback.local),
  }
}

const ALLOWED_AUTO_LOCK_MINUTES = new Set<number>(autoLockOptions.map((option) => option.value))

const sanitizeAutoLockMinutes = (value: unknown): number =>
  typeof value === 'number' && ALLOWED_AUTO_LOCK_MINUTES.has(value)
    ? value
    : defaultSettings.autoLockMinutes

// Bounds MUST match the Settings font-size control, which renders
// `<input min="12" max="32" …>` and clamps onChange with `clampNumber(12, 32, …)`
// (the `font-size-setting` input in App.tsx). Keep these in sync if the UI changes.
const sanitizeFontSizePx = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(32, Math.max(12, Math.round(value)))
    : defaultSettings.fontSizePx

const sanitizeRandomStringLength = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_RANDOM_STRING_LENGTH, Math.max(MIN_RANDOM_STRING_LENGTH, Math.round(value)))
    : defaultSettings.randomStringLength

const sanitizeEnum = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback

const sanitizeBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

const sanitizeNullableString = (value: unknown, fallback: string | null): string | null =>
  typeof value === 'string' || value === null ? value : fallback

const sanitizeString = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback

const loadStoredSettings = async () => {
  const records = await Promise.all(settingsKeys.map((key) => vaultStore.getSetting(key)))

  const merged = records.reduce<AppSettings>(
    (nextSettings, record) =>
      record ? { ...nextSettings, [record.key]: record.value } : nextSettings,
    defaultSettings,
  )

  return {
    autoLockMinutes: sanitizeAutoLockMinutes(merged.autoLockMinutes),
    autocapitalize: sanitizeEnum<AutoCapitalizeSetting>(
      merged.autocapitalize,
      ['off', 'none', 'sentences', 'words', 'characters'],
      defaultSettings.autocapitalize,
    ),
    autocorrect: sanitizeBoolean(merged.autocorrect, defaultSettings.autocorrect),
    editorMode: sanitizeEnum<EditorMode>(merged.editorMode, ['plain', 'markdown'], defaultSettings.editorMode),
    fontFamily: sanitizeString(merged.fontFamily, defaultSettings.fontFamily),
    fontSizePx: sanitizeFontSizePx(merged.fontSizePx),
    kdfPolicy: sanitizeKdfPolicyId(merged.kdfPolicy),
    lineWrap: sanitizeBoolean(merged.lineWrap, defaultSettings.lineWrap),
    randomStringLength: sanitizeRandomStringLength(merged.randomStringLength),
    recentsColumnOrder: sanitizeRecentsColumnOrder(merged.recentsColumnOrder),
    recentsColumnWidths: sanitizeRecentsColumnWidths(merged.recentsColumnWidths),
    secretKey: sanitizeNullableString(merged.secretKey, defaultSettings.secretKey),
    showWhitespace: sanitizeBoolean(merged.showWhitespace, defaultSettings.showWhitespace),
    spellcheck: sanitizeBoolean(merged.spellcheck, defaultSettings.spellcheck),
    storageProvider: sanitizeEnum<StorageProviderSetting>(
      merged.storageProvider,
      ['auto', 'local-file', 'dropbox'],
      defaultSettings.storageProvider,
    ),
    theme: sanitizeEnum<AppTheme>(merged.theme, ['system', 'light', 'dark'], defaultSettings.theme),
  }
}

type SaveTrigger = 'auto' | 'manual'

type SaveCurrentPlaintextOptions = {
  trigger?: SaveTrigger
  waitForInFlight?: boolean
}

type SaveCurrentPlaintextResult =
  | { envelope: string; ok: true }
  | { ok: false; reason: 'failed' | 'in-flight' | 'locked' }

const isFilePickerAbort = (error: unknown) =>
  typeof DOMException !== 'undefined' &&
  error instanceof DOMException &&
  error.name === 'AbortError'

// CR and CRLF become LF (SPEC §6: line endings are normalized to LF at unlock).
const normalizeToLf = (text: string) => text.replace(/\r\n?/g, '\n')

const VAULT_IN_USE_MESSAGE =
  'This vault is already open in another window. Close it there and try again.'

const LOCAL_FILE_NOT_FOUND_MESSAGE = 'File not found.'

// Catches render/commit crashes in the unlocked editor subtree so an exception
// degrades to a recovery panel instead of unmounting the whole app (which would
// strand unsaved plaintext, disarm auto-lock, and leave secrets unreachable).
// Lives INSIDE App so plaintextRef/passwordRef/saveCurrentPlaintextRef survive
// the crash. Note the limits: a boundary sees only render/lifecycle errors —
// async and event-handler failures are covered by the unhandledrejection
// backstop and per-call-site handling, not by this class.
class EditorErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; onCrash: () => void },
  { crashed: boolean }
> {
  state = { crashed: false }

  static getDerivedStateFromError() {
    return { crashed: true }
  }

  componentDidCatch() {
    this.props.onCrash()
  }

  render() {
    return this.state.crashed ? this.props.fallback : this.props.children
  }
}

// Thrown by unlockEnvelope when another window/tab already holds the vault
// open (the cross-tab Web Lock). Distinct from a decrypt failure so the
// callers can show an accurate message instead of "check the password".
class VaultInUseError extends Error {
  constructor() {
    super('The vault is already open in another window.')
    this.name = 'VaultInUseError'
  }
}

class SecretKeyUnlockFailedError extends Error {
  constructor() {
    super(SECRET_KEY_AUTH_FAILURE_MESSAGE)
    this.name = 'SecretKeyUnlockFailedError'
  }
}

// Thrown when the unlock dialog's inline Secret-key field holds a malformed key
// string (wrong prefix/length/Base64url) — distinct from a wrong-but-valid key,
// which fails at decrypt with the generic Secret-key message (SPEC §10/§16).
class SecretKeyInvalidError extends Error {
  constructor() {
    super(SECRET_KEY_INVALID_MESSAGE)
    this.name = 'SecretKeyInvalidError'
  }
}

// Thrown when a concurrent write turns the file `required-v1` AFTER the unlock
// dialog opened for what was a `none` file (so it has no inline Secret-key field
// to type the key into). Avoids the dead-end of prompting for a key with no
// field; the user reopens to get the field (SPEC §10/§16, SKT-4 P2).
class SecretKeyModeChangedError extends Error {
  constructor() {
    super(SECRET_KEY_MODE_CHANGED_MESSAGE)
    this.name = 'SecretKeyModeChangedError'
  }
}

const isLocalFileWritePermissionError = (error: unknown) =>
  error instanceof Error && error.message === 'Local file write permission was not granted.'

const clearFileInput = (event: ChangeEvent<HTMLInputElement>) => {
  event.currentTarget.value = ''
}

const defaultSearchOptions: SearchOptions = {
  caseSensitive: false,
  regex: false,
  wholeWord: false,
}

type IconStyle = CSSProperties & {
  '--icon-url': string
}

const iconStyle = (icon: string): IconStyle => ({
  '--icon-url': `url("${icon}")`,
})

const ToolbarIcon = ({ icon }: { icon: string }) => (
  <span className="toolbar-icon" style={iconStyle(icon)} aria-hidden="true" />
)

const HelpContent = ({
  markdown,
  onLinkClick,
}: {
  markdown: string
  onLinkClick: (event: ReactMouseEvent<HTMLElement>) => void
}) => {
  const articleRef = useRef<HTMLElement | null>(null)
  const { html } = useMemo(() => {
    const rendered = renderMarkdownToSafeHtml(markdown)
    const template = document.createElement('template')
    const nextHeadingId = createHelpHeadingIdTracker()

    template.innerHTML = rendered.html
    template.content.querySelectorAll<HTMLHeadingElement>('h2, h3').forEach((heading) => {
      heading.id = nextHeadingId(heading.textContent ?? '')
    })
    template.content.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((link) => {
      link.removeAttribute('target')
      link.removeAttribute('rel')
    })

    return { ...rendered, html: template.innerHTML }
  }, [markdown])

  return (
    <article
      ref={articleRef}
      className="help-content"
      onClickCapture={onLinkClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

const scrollHelpContainerTo = (container: HTMLDivElement, top: number): void => {
  if (typeof container.scrollTo === 'function') {
    container.scrollTo({ top, behavior: 'auto' })
    return
  }

  container.scrollTop = top
}

// A status/message line carrying a close (🗙) button at its right edge. Used for
// both transient app messages and the derived storage-status detail. `className`
// supplies the existing tone/layout classes so styling is unchanged; the flex
// row and the close affordance come from `.dismissible-banner`. `role="status"`
// lives on the text span (not the wrapper) so the live region announces only the
// message, never the close control.
const DismissibleBanner = ({
  text,
  className,
  onDismiss,
  dismissLabel,
}: {
  text: string
  className: string
  onDismiss: () => void
  dismissLabel: string
}) => (
  <p className={`${className} dismissible-banner`}>
    <span className="dismissible-banner-text" role="status">
      {text}
    </span>
    <button
      type="button"
      className="dismissible-banner-close"
      aria-label={dismissLabel}
      title={dismissLabel}
      onClick={onDismiss}
    >
      <span aria-hidden="true">&#x1F5D9;</span>
    </button>
  </p>
)

// Theme and auto-lock selects are shared by both the editor and the locked/home
// settings dialogs. The caller passes a distinct `id` so each dialog keeps its
// own label association (e.g. the editor dialog uses `theme-setting`).
const ThemeField = ({
  id,
  value,
  onChange,
}: {
  id: string
  value: AppTheme
  onChange: (value: AppTheme) => void
}) => (
  <label className="settings-field" htmlFor={id}>
    Theme
    <select id={id} value={value} onChange={(event) => onChange(event.target.value as AppTheme)}>
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  </label>
)

const AutoLockField = ({
  id,
  value,
  onChange,
}: {
  id: string
  value: number
  onChange: (value: number) => void
}) => (
  <label className="settings-field" htmlFor={id}>
    Auto-lock
    <select id={id} value={value} onChange={(event) => onChange(Number(event.target.value))}>
      {autoLockOptions.map((autoLockOption) => (
        <option key={autoLockOption.value} value={autoLockOption.value}>
          {autoLockOption.label}
        </option>
      ))}
    </select>
  </label>
)

// Shared chrome for the three locked/home screens: the app-shell main element
// plus the upper-right Settings button and its dialog. (The loading screen uses
// a bare app-shell without these, so it does not use this wrapper.)
const HomeShell = ({
  themeClass,
  settingsDialog,
  children,
}: {
  themeClass: string
  settingsDialog: ReactNode
  children: ReactNode
}) => (
  <main className={`app-shell ${themeClass}`}>
    {settingsDialog}
    {children}
  </main>
)

// The Settings button lives in the brand row as the upper-right counterpart of
// the app icon (upper-left), inside the rounded auth-panel box. The app name is
// the only text here, so it centers vertically against the app icon.
const BrandRow = ({
  onOpenSettings,
  updateAvailable,
}: {
  onOpenSettings: () => void
  updateAvailable: boolean
}) => (
  <div className="brand-row">
    <div className="brand-mark" aria-hidden="true">
      <span className="brand-icon" style={iconStyle(encryptionIcon)} />
    </div>
    <div className="brand-title">
      <h1 id="app-title">eNoteWeb</h1>
      {updateAvailable ? (
        <span className="update-badge" role="status">
          Update available
        </span>
      ) : null}
    </div>
    <div className="brand-settings">
      <button
        type="button"
        className="secondary-button compact-button home-settings-button"
        aria-haspopup="dialog"
        aria-label="Settings"
        title="Settings"
        onClick={onOpenSettings}
      >
        <ToolbarIcon icon={settingsIcon} />
      </button>
    </div>
  </div>
)

// Clamps `value` into [min, max]. Shared by the numeric settings inputs so the
// min/max guard reads the same way in each place.
const clampNumber = (min: number, max: number, value: number) =>
  Math.min(max, Math.max(min, value))

// The version-update dialog (SPEC §14/§15). Purely presentational: it renders the
// current update state and reports the user's choice; all orchestration stays in
// App. Renders nothing when there is no active update flow.
const UpdateDialog = ({
  state,
  onApplyUpdate,
  onClose,
  onCancel,
}: {
  state: UpdateDialogState
  onApplyUpdate: (version: string) => void
  onClose: () => void
  onCancel: () => void
}) => {
  if (state === null) {
    return null
  }

  // Escape mirrors the explicit dismiss action of each state; 'applying' is
  // deliberately blocking (mid-activation cancellation is unsafe, SPEC §14).
  const onEscape =
    state.kind === 'applying' ? undefined : state.kind === 'checking' ? onCancel : onClose

  return (
    <ModalShell
      id="update-dialog"
      className="settings-dialog update-dialog"
      labelledBy="update-dialog-title"
      onEscape={onEscape}
    >
      <>
        {state.kind === 'checking' ? (
          <>
            <h2 id="update-dialog-title">Checking for updates</h2>
            <p>Checking for a newer version…</p>
            {/* The check is bounded by a network timeout, but Cancel lets the user
                dismiss immediately rather than wait — so a stalled network can
                never leave this modal stuck open. */}
            <div className="dialog-actions">
              <button type="button" className="secondary-button compact-button" onClick={onCancel}>
                Cancel
              </button>
            </div>
          </>
        ) : null}
        {state.kind === 'applying' ? (
          <>
            <h2 id="update-dialog-title">Updating</h2>
            <p>Downloading and activating the new version…</p>
          </>
        ) : null}
        {state.kind === 'available' ? (
          <>
            <h2 id="update-dialog-title">Update available</h2>
            <p>A newer version ({state.version}) is available. Update now?</p>
            <div className="dialog-actions">
              <button type="button" className="secondary-button compact-button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="primary-button compact-button"
                onClick={() => onApplyUpdate(state.version)}
              >
                Update
              </button>
            </div>
          </>
        ) : null}
        {state.kind === 'up-to-date' ? (
          <>
            <h2 id="update-dialog-title">Up to date</h2>
            <p>You have the latest version.</p>
            <div className="dialog-actions">
              <button type="button" className="primary-button compact-button" onClick={onClose}>
                OK
              </button>
            </div>
          </>
        ) : null}
        {state.kind === 'error' ? (
          <>
            <h2 id="update-dialog-title">Could not check for updates</h2>
            <p>The update check could not be completed. Your current version is unchanged.</p>
            <div className="dialog-actions">
              <button type="button" className="primary-button compact-button" onClick={onClose}>
                OK
              </button>
            </div>
          </>
        ) : null}
        {state.kind === 'apply-error' ? (
          <>
            <h2 id="update-dialog-title">Could not update</h2>
            <p>The update could not be completed. Your current version is unchanged.</p>
            <div className="dialog-actions">
              <button type="button" className="primary-button compact-button" onClick={onClose}>
                OK
              </button>
            </div>
          </>
        ) : null}
      </>
    </ModalShell>
  )
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Shared modal scaffold: renders the backdrop + dialog
// element with the ARIA wiring, moves focus into the dialog on open (respecting
// an autoFocus already applied inside it), confines Tab/Shift+Tab, restores
// focus to the previously-focused element on close, and optionally dismisses on
// Escape (omitted for deliberately blocking dialogs). The conflict editor keeps
// its own internal dialog structure and is not routed through this shell.
const ModalShell = ({
  as = 'section',
  children,
  className,
  id,
  initialFocus = 'first-control',
  labelledBy,
  onEscape,
  onSubmit,
  role = 'dialog',
}: {
  as?: 'section' | 'form'
  children: ReactNode
  className: string
  id?: string | undefined
  initialFocus?: 'dialog' | 'first-control'
  labelledBy: string
  onEscape?: (() => void) | undefined
  onSubmit?: ((event: FormEvent<HTMLFormElement>) => void) | undefined
  role?: 'dialog' | 'alertdialog'
}) => {
  const containerRef = useRef<HTMLElement | null>(null)
  // Captured during the first render — before the commit applies any autoFocus
  // inside the dialog — so close restores focus to the true opener.
  const [previouslyFocused] = useState(() =>
    typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null,
  )

  useEffect(() => {
    const container = containerRef.current

    if (container && !container.contains(document.activeElement)) {
      if (initialFocus === 'dialog') {
        container.focus()
        return
      }

      const initial =
        Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).find(
          (element) => !element.dataset.skipInitialFocus,
        ) ?? container

      // Never autofocus a <select>: iOS Safari opens the picker on focus, so
      // a dialog whose first control is a dropdown (Settings → Theme) would
      // pop it on open. The dialog itself takes focus instead (tabIndex -1);
      // dialogs that want a specific field focused use an explicit autoFocus,
      // which this fallback already respects.
      ;(initial.tagName === 'SELECT' ? container : initial).focus()
    }

    return () => {
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus()
      }
    }
  }, [initialFocus, previouslyFocused])

  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape' && onEscape) {
      event.stopPropagation()
      onEscape()
      return
    }

    if (event.key !== 'Tab') {
      return
    }

    const container = containerRef.current

    if (!container) {
      return
    }

    const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))

    if (focusables.length === 0) {
      event.preventDefault()
      return
    }

    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement

    if (event.shiftKey) {
      if (active === first || !container.contains(active)) {
        event.preventDefault()
        last?.focus()
      }
    } else if (active === last || !container.contains(active)) {
      event.preventDefault()
      first?.focus()
    }
  }

  const sharedProps = {
    'aria-labelledby': labelledBy,
    'aria-modal': true,
    className,
    id,
    onKeyDown: handleKeyDown,
    role,
    tabIndex: -1,
  }

  return (
    <div className="dialog-backdrop">
      {as === 'form' ? (
        <form
          ref={containerRef as RefObject<HTMLFormElement>}
          {...sharedProps}
          onSubmit={onSubmit}
        >
          {children}
        </form>
      ) : (
        <section ref={containerRef as RefObject<HTMLElement>} {...sharedProps}>
          {children}
        </section>
      )}
    </div>
  )
}

// Human-readable "remote last changed <when>" for the force-out-of-conflict
// consequence confirmation. Falls back to a generic phrase when
// Dropbox omitted the server-modified time.
const formatRemoteChangedWhen = (iso: string | null): string => {
  if (!iso) {
    return 'recently'
  }

  const date = new Date(iso)

  return Number.isNaN(date.getTime()) ? 'recently' : date.toLocaleString()
}

function App() {
  const [isLoading, setIsLoading] = useState(true)
  const [, setSavedEnvelope] = useState<string | null>(null)
  // Document-level read-only flag, carried inside the encrypted envelope
  // (SPEC §7) — document state, never a settings record. The ref mirrors the
  // state synchronously for the save paths.
  const [isReadOnly, setIsReadOnly] = useState(false)
  // App-imposed read-only is a session-level safety lock, separate from the
  // encrypted file's own read-only flag. It applies when a cached Dropbox file
  // is opened while Dropbox is voluntarily unlinked: the user may inspect,
  // select, copy, and export, but the app must not edit, autosave, sync, or
  // toggle the file's embedded read-only flag.
  const [isAppReadOnlySession, setIsAppReadOnlySessionState] = useState(false)
  const [isDeleteVaultConfirmOpen, setIsDeleteVaultConfirmOpen] = useState(false)
  const [helpContext, setHelpContext] = useState<HelpContext | null>(null)
  const [helpBackScrollTop, setHelpBackScrollTop] = useState<number | null>(null)
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null)
  const [dropboxSyncState, setDropboxSyncState] = useState<DropboxSyncState | null>(null)
  // The home Dropbox block's recent-files table (SPEC §9), provider-shaped.
  const [dropboxRecentFiles, setDropboxRecentFiles] = useState<DropboxRecentFilesData | null>(null)
  // Per-row session indicators from the background revision check (SPEC §9):
  // diverged / missing / ineligible, keyed by record key. Session memory only
  // — never persisted, so an offline relaunch shows none.
  const [recentFileIndicators, setRecentFileIndicators] = useState<
    ReadonlyMap<string, DropboxRecentFileIndicator>
  >(new Map())
  // Bumped by the connectivity listeners so the home check re-runs when the
  // device regains connectivity (SPEC §9) and the indicator visibility
  // re-evaluates (indicators are not shown while offline).
  const [connectivityTick, setConnectivityTick] = useState(0)
  // Whether the draft (vault "primary") exists — drives the New/Edit draft
  // label and the Delete/Export enablement (SPEC §10). Dropbox caches do not
  // count.
  const [hasDraft, setHasDraft] = useState(false)
  // The one-time naming confirmation shown when a link completes with recent
  // files present but no stored `accountId`, so cache ownership can't be
  // verified (SPEC §9); set from the link completion.
  const [showOwnershipNotice, setShowOwnershipNotice] = useState(false)
  const [localFileRecords, setLocalFileRecords] = useState<LocalFileRecord[]>([])
  const [activeLocalFileKey, setActiveLocalFileKey] = useState<string | null>(null)
  const [isUnlocked, setIsUnlocked] = useState(false)
  // Failed dirty final saves branch by source.
  // Manual exit asks for Export / Exit anyway / Stay; auto-lock enters a
  // password-gated soft lock so plaintext leaves the DOM but stays recoverable.
  const [isLockSaveFailureDialogOpen, setIsLockSaveFailureDialogOpen] = useState(false)
  const [softLockState, setSoftLockState] = useState<SoftLockState | null>(null)
  const isSoftLocked = softLockState !== null
  const [isSettingsDialogOpen, setIsSettingsDialogOpen] = useState(false)
  // Transient save-status override after a successful Change Password: the line
  // that normally reads "Autosaved" shows "Password changed" for a few seconds.
  const [passwordChangedNotice, setPasswordChangedNotice] = useState(false)
  // "Exit?" confirmation for the editor's Home button: a
  // stray tap must not drop the session back to the locked home.
  const [isExitConfirmOpen, setIsExitConfirmOpen] = useState(false)
  const [isHomeSettingsOpen, setIsHomeSettingsOpen] = useState(false)
  const [isAdvancedSettingsOpen, setIsAdvancedSettingsOpen] = useState(false)
  const [storagePersisted, setStoragePersisted] = useState<boolean | null | undefined>(undefined)
  const [secretKeyManualDialog, setSecretKeyManualDialog] = useState<
    { kind: 'qr'; keyString: string } | { kind: 'paste'; error: string; value: string } | null
  >(null)
  // Secret-key Settings feedback (Invalid/pasted/cleared/…), shown inside the
  // Settings dialog below the action row — not on the home banner the dialog
  // covers.
  const [secretKeySettingsMessage, setSecretKeySettingsMessage] = useState<
    { text: string; tone: MessageTone } | null
  >(null)
  // Unlink lives in the Home Settings dialog; it asks for
  // confirmation only when unsynced cached changes need naming.
  const [isUnlinkConfirmOpen, setIsUnlinkConfirmOpen] = useState(false)
  // "Continue with this account?" shown when Link is pressed and the app still
  // has a retained Dropbox grant for the remembered account. Continue reuses
  // that grant; Switch forgets only the grant before OAuth. Recent files are
  // retained until a different-account callback is explicitly confirmed.
  const [linkContinuePrompt, setLinkContinuePrompt] = useState<string | null>(null)
  const [updateDialog, setUpdateDialog] = useState<UpdateDialogState>(null)
  const [stagedUpdateAvailable, setStagedUpdateAvailable] = useState(false)
  const [plaintext, setPlaintext] = useState('')
  const [cursorInfo, setCursorInfo] = useState<EditorCursorInfo>({
    line: 1,
    column: 1,
    selectionLength: 0,
    selectionWordCount: 0,
  })
  const deferredPlaintext = useDeferredValue(plaintext)
  const characterCount = useMemo(() => countGraphemes(deferredPlaintext), [deferredPlaintext])
  const wordCount = useMemo(() => countWords(deferredPlaintext), [deferredPlaintext])
  const [settings, setSettings] = useState<AppSettings>(defaultSettings)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [replaceInput, setReplaceInput] = useState('')
  const [searchOptions, setSearchOptions] = useState<SearchOptions>(defaultSearchOptions)
  const [searchMessage, setSearchMessage] = useState('')
  const [searchMessageTone, setSearchMessageTone] = useState<MessageTone>('info')
  // Match count of the current query, maintained by the live-highlight effect
  // on every query/option/document change (null = no valid query). Kept apart
  // from `searchMessage` so the live count can never race with — or overwrite
  // — command feedback like "Replaced 3 matches."; the command message always
  // wins in the status bar and is cleared on the next query/option change.
  // `limited` marks a scan stopped at the engine's match cap, so the display
  // can say "10000+ matches" instead of claiming an exact total.
  const [liveMatchCount, setLiveMatchCount] = useState<{
    count: number
    limited: boolean
  } | null>(null)
  const [isSearchPanelOpen, setIsSearchPanelOpen] = useState(false)
  const [isPreviewVisible, setIsPreviewVisible] = useState(false)
  const [conflictModal, setConflictModal] = useState<ConflictModalState>({ mode: 'closed' })
  const [conflictResolutions, setConflictResolutions] = useState<ConflictResolutions>(new Map())
  // The regions array the current resolution map belongs to. A fresh resolve,
  // a remote re-fetch on open, or a 409 re-resolve each build a NEW regions
  // array; when that happens the stale per-hunk choices must be dropped (see
  // the reset effect below). Tracked by identity so returning to the SAME
  // regions (e.g. a non-409 save failure that reopens the editor) keeps the
  // user's choices.
  const lastResolvedRegionsRef = useRef<MergeRegion[] | null>(null)
  const [isConflictPreview, setIsConflictPreview] = useState(false)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  // False until the first completed save of the session: the clean-state
  // status reads "Opened" rather than claiming an autosave that never ran.
  const [hasSavedThisSession, setHasSavedThisSession] = useState(false)
  const [message, setMessage] = useState('')
  const [messageTone, setMessageTone] = useState<MessageTone>('error')
  const [messageScope, setMessageScope] = useState<MessageScope>('global')
  const [localFileDiagnosticEntries, setLocalFileDiagnosticEntries] = useState<string[]>([])
  const [activeStorageProvider, setActiveStorageProvider] = useState<StorageProvider>(() =>
    getStorageProvider(),
  )
  const homeStorageProviderKind: 'local-file' | 'dropbox' =
    activeStorageProvider.kind === 'local-file' ||
    (activeStorageProvider.kind === 'draft' && settings.storageProvider === 'local-file')
      ? 'local-file'
      : 'dropbox'

  const editorRef = useRef<EditorHandle | null>(null)
  const previewRef = useRef<HTMLDivElement | null>(null)
  const helpScrollRef = useRef<HTMLDivElement | null>(null)

  const openHelpDialog = useCallback((context: HelpContext) => {
    setHelpBackScrollTop(null)
    setHelpContext(context)
  }, [])

  const closeHelpDialog = useCallback(() => {
    setHelpBackScrollTop(null)
    setHelpContext(null)
  }, [])

  const handleHelpLinkClick = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    const link =
      event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
    const href = link?.getAttribute('href')

    if (!href?.startsWith('#') || href === '#') {
      return
    }

    event.preventDefault()
    event.stopPropagation()

    const scrollContainer = helpScrollRef.current

    if (!scrollContainer) {
      return
    }

    const targetId = href.slice(1)
    const destination = Array.from(scrollContainer.querySelectorAll<HTMLElement>('[id]')).find(
      (element) => element.id === targetId,
    )

    if (!destination) {
      return
    }

    const containerRect = scrollContainer.getBoundingClientRect()
    const destinationRect = destination.getBoundingClientRect()
    const nextTop = Math.max(
      0,
      scrollContainer.scrollTop + destinationRect.top - containerRect.top,
    )

    setHelpBackScrollTop(scrollContainer.scrollTop)
    scrollHelpContainerTo(scrollContainer, nextTop)
  }, [])

  const handleHelpBack = useCallback(() => {
    const scrollContainer = helpScrollRef.current

    if (scrollContainer && helpBackScrollTop !== null) {
      scrollHelpContainerTo(scrollContainer, helpBackScrollTop)
    }

    setHelpBackScrollTop(null)
  }, [helpBackScrollTop])

  // Editor top line captured at the instant the preview is toggled open, so the
  // preview can be aligned to it after mount. Captured before the open, because in
  // the overlay layout the editor is hidden once the preview is open and would
  // then report line 1. Null except across an open.
  const pendingPreviewAlignRef = useRef<number | null>(null)
  // Mirror for CLOSING the overlay preview: the preview's top source line,
  // captured before the pane unmounts, applied once the editor is visible
  // again. Null except across an overlay close.
  const pendingEditorAlignRef = useRef<number | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const replaceInputRef = useRef<HTMLInputElement | null>(null)
  // The open search panel, for measuring the strip it overlays on the editor.
  const searchPanelRef = useRef<HTMLElement | null>(null)
  const [searchPanelHeight, setSearchPanelHeight] = useState(0)
  // Which panel field the opening shortcut wants focused once the panel has
  // mounted: Ctrl+F targets Find, Ctrl+H targets Replace.
  const searchPanelFocusTargetRef = useRef<'find' | 'replace'>('find')
  // Latest search-shortcut handler; the document listener dispatches through
  // this so it never goes stale and never needs re-registering per render.
  const searchShortcutRef = useRef<(event: KeyboardEvent) => void>(() => undefined)
  // Aborts the in-flight "Check for updates" network wait when the user cancels.
  const updateCheckControllerRef = useRef<AbortController | null>(null)
  const passwordRef = useRef('')
  const sessionSecretKeyBytesRef = useRef<Uint8Array | null>(null)
  const sessionKdfParamsRef = useRef<KdfPolicyParams | null>(null)
  const plaintextRef = useRef('')
  const lastSavedPlaintextRef = useRef('')
  const isReadOnlyRef = useRef(false)
  const isAppReadOnlySessionRef = useRef(false)
  const setAppReadOnlySession = (locked: boolean) => {
    isAppReadOnlySessionRef.current = locked
    setIsAppReadOnlySessionState(locked)
  }
  // Pending auto-dismiss timer for the current transient message (null = none).
  const messageTimerRef = useRef<number | null>(null)
  // Auto-dismiss timer for the in-dialog secret-key Settings message.
  const secretKeySettingsMessageTimerRef = useRef<number | null>(null)
  // Releases the cross-tab vault Web Lock held while unlocked (null = not held).
  const vaultLockReleaseRef = useRef<(() => void) | null>(null)
  const activeStorageProviderRef = useRef<StorageProvider>(activeStorageProvider)
  const activeSavePromiseRef = useRef<Promise<SaveCurrentPlaintextResult> | null>(null)
  // Serializes mutating Dropbox operations (manual sync, online auto-sync, and
  // create-file) through one chain so a background sync can never race a
  // new-file creation. An explicit shared queue, not an informal await.
  const dropboxOpRef = useRef<Promise<unknown>>(Promise.resolve())
  // The in-tab `dropboxOpRef` chain only serializes within one window. The
  // `online` auto-sync fires in every open window at once, so concurrent
  // `syncNow` calls would race against the same remote file. Wrap each
  // op in an exclusive cross-tab Web Lock (named `enoteweb-dropbox`, distinct
  // from the vault lock) so the mutations queue across tabs too. Unlike the
  // vault lock, this one must WAIT its turn, so the request is blocking (no
  // `ifAvailable`). Where the Web Locks API is absent (very old browsers),
  // fall back to running the op directly — today's behavior — and rely on the
  // in-tab chain. The browser releases the lock automatically on tab close.
  const runExclusiveDropboxOp = useCallback(
    <T,>(op: () => Promise<T>): Promise<T> => {
      const guarded =
        'locks' in navigator && typeof navigator.locks?.request === 'function'
          ? () =>
              navigator.locks.request('enoteweb-dropbox', { mode: 'exclusive' }, () => op())
          : op
      const run = dropboxOpRef.current.then(guarded, guarded)
      dropboxOpRef.current = run.then(
        () => undefined,
        () => undefined,
      )
      return run as Promise<T>
    },
    [],
  )
  // Dedupes the home-screen auto-sync so it fires once per visit, not on every
  // render while the home/locked screen is shown.
  const homeAutoSyncDoneRef = useRef(false)
  // Dedupes the home background revision check the same way (SPEC §9): one
  // pass per home visit (and per connectivity regain).
  const homeRevisionCheckDoneRef = useRef(false)
  // The hidden file input behind the home `Import` draft action (SPEC §10).
  const importFileInputRef = useRef<HTMLInputElement | null>(null)
  // Which document the unlocked session holds (SPEC §4 DocumentKind): set at
  // every unlock/create path. The promotion keys on it — a 'draft' session
  // that uploads converts into the Dropbox file and empties the draft slot.
  // Ref + state pair: handlers need the value synchronously mid-flow (the
  // promotion sets it and continues), while the toolbar renders from it
  // (Save + Export to Files in a Dropbox file session, Upload + Export to
  // Files in a draft session — SPEC §4/§15).
  const sessionDocumentKindRef = useRef<SessionDocumentKind>(null)
  const [sessionDocumentKind, setSessionDocumentKindState] = useState<SessionDocumentKind>(null)
  const setSessionDocumentKind = (kind: SessionDocumentKind) => {
    sessionDocumentKindRef.current = kind
    setSessionDocumentKindState(kind)
  }
  // A draft is intentionally stored in the shared draft slot, but its
  // editor chrome follows the storage mode the user selected on Home. Opening
  // the same draft from Local files therefore shows local file actions; opening
  // it from Dropbox mode shows Dropbox draft actions.
  const editorStorageProviderKind = resolveEditorStorageProviderKind(
    activeStorageProvider.kind,
    settings.storageProvider,
    sessionDocumentKind,
  )
  // First-sync gate (SPEC §9): true while the open Dropbox file session is
  // known remotely changed — the editor shows `File changed on Dropbox. Sync
  // is paused.` and every save goes cache-only (no push) until the state
  // changes (conflict resolution commits, or the session ends). Ref + state
  // pair: the save path reads it synchronously, the banner renders from it.
  const dropboxSessionPausedRef = useRef(false)
  const [isDropboxSessionPaused, setIsDropboxSessionPausedState] = useState(false)
  const setDropboxSessionPaused = (paused: boolean) => {
    dropboxSessionPausedRef.current = paused
    setIsDropboxSessionPausedState(paused)
  }
  // The record key of the current Dropbox file session — guards the async
  // first-sync-gate probe against landing on a later session (or none).
  const dropboxFileSessionKeyRef = useRef<string | null>(null)
  // Rows the check found stale-but-clean but could not refresh (download
  // failure, or an open-session probe): the next online Open refreshes them
  // before the password dialog (SPEC §9). Session memory, like indicators.
  const staleRecentKeysRef = useRef<Set<string>>(new Set())
  // The key the home Open flow is currently working on: the background check
  // loop skips it so a stale-but-clean refresh can never swap the cache
  // between the open's read and the unlock dialog's decrypt.
  const openingRecentKeyRef = useRef<string | null>(null)
  // Debounce timer for the focus/visibility-regain remote check, so a burst of
  // focus events fires at most one by-id probe for the open Dropbox file.
  const focusRemoteCheckTimerRef = useRef<number | null>(null)
  const pendingSaveRef = useRef(false)
  const saveCurrentPlaintextRef = useRef<
    (options?: SaveCurrentPlaintextOptions) => Promise<SaveCurrentPlaintextResult>
  >(async () => ({ ok: false, reason: 'locked' }))
  const autoLockRef = useRef<() => void>(() => {})
  const isSoftLockedRef = useRef(false)
  const softLockRetryTimerRef = useRef<number | null>(null)
  // The controller is created once and stable; it holds only the run/snapshot
  // state. Dependencies are passed to each call (built in event handlers via
  // `conflictDeps()`), so React render never reads refs.
  const [conflictController] = useState<ConflictController>(() => createConflictController())

  const showMessage = useCallback(
    (text: string, tone: MessageTone = 'error', scope: MessageScope = 'global') => {
      if (messageTimerRef.current !== null) {
        window.clearTimeout(messageTimerRef.current)
        messageTimerRef.current = null
      }

      setMessage(text)
      setMessageTone(tone)
      setMessageScope(scope)

      // Ordinary message strips are transient, including error-tone strips. Durable
      // failure states use dialogs or banners instead (autosave failure, soft-lock,
      // Dropbox conflict), so those are not affected by this timeout.
      messageTimerRef.current = window.setTimeout(() => {
        messageTimerRef.current = null
        setMessage((current) => (current === text ? '' : current))
      }, MESSAGE_AUTO_DISMISS_MS)
    },
    [],
  )

  const clearMessage = () => setMessage('')

  // Dropbox-block status (SPEC §9 home): renders inline next to the "Dropbox"
  // label on the home instead of the bottom banner. Same tone/auto-dismiss as
  // showMessage; in the editor it falls back to the editor message area.
  const showDropboxMessage = useCallback(
    (text: string, tone: MessageTone = 'error') => showMessage(text, tone, 'dropbox'),
    [showMessage],
  )

  // Local-files-block messages (recents/browse/open/unlock/path-root) render in
  // the Local block header — the parallel of showDropboxMessage's Dropbox block.
  const showLocalMessage = useCallback(
    (text: string, tone: MessageTone = 'error') => showMessage(text, tone, 'local'),
    [showMessage],
  )

  // The transient "offline" home messages are error-tone, so they persist until
  // something replaces them. Clear them once
  // an autosync pass runs again — by then the device is back online and the
  // offline notice is stale. Only these exact strings are cleared, so a real
  // Dropbox message (unlinked, sync failed) is left untouched.
  const clearOfflineDropboxMessage = useCallback(() => {
    setMessage((current) =>
      current === 'Offline.' || current === 'Offline. No cache exists.' ? '' : current,
    )
  }, [])

  const showSearchMessage = (text: string, tone: MessageTone = 'info') => {
    setSearchMessage(text)
    setSearchMessageTone(tone)
  }

  // Surface an editor find/replace command result (or the not-ready fallback when
  // the editor handle is missing) as a search-panel message.
  const reportEditorResult = (result?: { message: string; ok: boolean; superseded?: true }) => {
    // A newer regex request superseded this command before it settled. Ignore
    // it: leave the existing message in place so a fresher result drives the
    // panel, rather than flashing a stale "Regex too expensive."
    if (result?.superseded) {
      return
    }

    showSearchMessage(result?.message ?? 'Editor is not ready.', result?.ok ? 'info' : 'error')
  }

  const getSyncProvider = (): SyncStorageProvider | null => {
    const provider = activeStorageProviderRef.current

    return isSyncStorageProvider(provider) ? provider : null
  }

  const getActiveLocalFileRecord = (records = localFileRecords) =>
    records.find((record) => record.key === activeLocalFileKey) ??
    records.find((record) => record.active) ??
    records.at(-1) ??
    null

  const applyLocalFileRecords = (records: LocalFileRecord[]) => {
    const activeRecord =
      records.find((record) => record.active) ?? records.at(-1) ?? null

    setLocalFileRecords(records)
    setActiveLocalFileKey(activeRecord?.key ?? null)
    return activeRecord
  }

  // Holds an exclusive cross-tab Web Lock while a vault is unlocked, so two
  // windows can never edit (and last-writer-win destroy) the same vault record.
  // The browser releases the lock automatically on tab close or crash. Where
  // the Web Locks API is absent (very old browsers), unlocking proceeds
  // without the guard — today's behavior.
  const acquireVaultLock = async (): Promise<boolean> => {
    if (vaultLockReleaseRef.current) {
      return true
    }

    if (!('locks' in navigator) || typeof navigator.locks?.request !== 'function') {
      return true
    }

    return new Promise<boolean>((resolve) => {
      void navigator.locks
        .request('enoteweb-vault', { ifAvailable: true, mode: 'exclusive' }, (lock) => {
          if (!lock) {
            resolve(false)
            return undefined
          }

          resolve(true)
          // Hold the lock until release is called (or the tab goes away).
          return new Promise<void>((release) => {
            vaultLockReleaseRef.current = () => {
              vaultLockReleaseRef.current = null
              release()
            }
          })
        })
        .catch(() => resolve(true))
    })
  }

  const releaseVaultLock = () => {
    vaultLockReleaseRef.current?.()
  }

  // For locked-screen flows that REPLACE the primary vault (Open from Files,
  // opening a different Dropbox file) but return to the locked screen. Refuses
  // the replacement when another window holds the vault open (unlocked);
  // otherwise runs `operation` while transiently holding the lock and releases
  // it afterward, so the next unlock re-acquires it for the session. Returns the
  // sentinel 'vault-in-use' when blocked. These flows are only reachable while
  // locked, so this tab never already holds the lock — acquireVaultLock returns
  // false iff a different tab does.
  const runReplacingPrimaryVault = async <T,>(
    operation: () => Promise<T>,
  ): Promise<T | 'vault-in-use'> => {
    const hadLock = vaultLockReleaseRef.current !== null

    if (!(await acquireVaultLock())) {
      return 'vault-in-use'
    }

    try {
      return await operation()
    } finally {
      if (!hadLock) {
        releaseVaultLock()
      }
    }
  }

  const getUnlockFailureMessage = (error: unknown) => {
    if (error instanceof VaultInUseError) {
      return VAULT_IN_USE_MESSAGE
    }

    if (error instanceof LocalFileNotFoundError) {
      return LOCAL_FILE_NOT_FOUND_MESSAGE
    }

    if (error instanceof SecretKeyRequiredError) {
      return SECRET_KEY_REQUIRED_UNLOCK_MESSAGE
    }

    if (error instanceof SecretKeyInvalidError) {
      return SECRET_KEY_INVALID_MESSAGE
    }

    if (error instanceof SecretKeyModeChangedError) {
      return SECRET_KEY_MODE_CHANGED_MESSAGE
    }

    if (error instanceof SecretKeyUnlockFailedError) {
      return SECRET_KEY_AUTH_FAILURE_MESSAGE
    }

    return 'Could not unlock. Check the password or file.'
  }

  const showUnlockFailure = (error: unknown) => {
    showLocalMessage(getUnlockFailureMessage(error))
  }

  const getConfiguredSecretKeyBytes = async () => {
    if (!settings.secretKey) {
      return null
    }

    return parseSecretKeyString(settings.secretKey)
  }

  // The unlock dialog's inline `Secret key` field config for an envelope, or
  // undefined when the file is not `required-v1` (the field is only shown for a
  // file that needs the key — SPEC §10/SKT-4). Pre-filled with the Settings key
  // and expanded by default only when none is configured.
  const secretKeyFieldFor = (envelope: string): SecretKeyFieldConfig | undefined => {
    let mode: string
    try {
      mode = getEnvelopeSecretKeyMode(parseEnvelope(envelope))
    } catch {
      return undefined
    }

    if (mode !== SECRET_KEY_MODE_REQUIRED) {
      return undefined
    }

    return { initialValue: settings.secretKey ?? '', initiallyExpanded: !settings.secretKey }
  }

  // The single sanctioned entry point for document encryption. EXPLICIT
  // overrides (used at create/Change Password, before or while changing the
  // session refs) supersede the session refs; otherwise the session's captured
  // Secret-key and KDF policy apply.
  // Do not call `CryptoService.encrypt` directly for a document save; route it
  // through here so a save can never silently change a
  // file's protection (Secret-key mode or KDF strength) by reaching for the raw API.
  const encryptDocument = (
    plaintextValue: string,
    password: string,
    options: {
      kdfParams?: KdfPolicyParams
      readOnly?: boolean
      secretKeyBytes?: Uint8Array | null
    } = {},
  ) => {
    const { kdfParams, secretKeyBytes, ...rest } = options
    const effective =
      secretKeyBytes !== undefined ? secretKeyBytes : sessionSecretKeyBytesRef.current
    const effectiveKdfParams =
      kdfParams ?? sessionKdfParamsRef.current ?? resolveKdfPolicyParams(DEFAULT_KDF_POLICY_ID)
    const kdfOptions = shouldPassKdfParams(effectiveKdfParams) ? effectiveKdfParams : {}
    const encryptOptions = {
      ...rest,
      ...kdfOptions,
      ...(effective ? { secretKeyBytes: effective } : {}),
    }

    // Forward the options object only when it carries something; a keyless,
    // optionless save omits the third argument so the call shape (and the `none`
    // envelope it writes) is identical to the raw two-argument API. This depends
    // on the `standard` policy matching CryptoService's DEFAULT_KDF_PARAMS.
    return CryptoService.encrypt(
      plaintextValue,
      password,
      ...(Object.keys(encryptOptions).length > 0 ? [encryptOptions] : []),
    )
  }

  const encryptWithSessionSecretKey = (
    plaintextValue: string,
    password: string,
    options: { readOnly?: boolean } = {},
  ) => encryptDocument(plaintextValue, password, options)

  // `secretKeyInput` is the unlock dialog's inline `Secret key` field value for a
  // `required-v1` file (null when the file is `none` and the field is not shown);
  // it is authoritative — pre-filled with the Settings key but used as edited
  // (SPEC §6/§10). The session captures key bytes ONLY for a `required-v1` file,
  // so a `none` file opened while a Secret key is configured stays `none` — no
  // automatic promotion (SPEC §6, SKT-1).
  const unlockEnvelope = async (
    envelope: string,
    password: string,
    secretKeyInput: string | null,
  ) => {
    if (!(await acquireVaultLock())) {
      throw new VaultInUseError()
    }

    const parsedEnvelope = parseEnvelope(envelope)
    const secretKeyMode = getEnvelopeSecretKeyMode(parsedEnvelope)
    let sessionKeyBytes: Uint8Array | null = null

    if (secretKeyMode === SECRET_KEY_MODE_REQUIRED) {
      // `null` means the dialog showed NO inline field — it opened for a `none`
      // file but a concurrent write made it `required-v1` since (the callers
      // re-read the envelope at submit). There is nowhere to type the key, so
      // surface a reopen prompt rather than a dead-end key prompt (P2). An empty
      // string means the field WAS shown but left blank → ordinary key prompt.
      if (secretKeyInput === null) {
        releaseVaultLock()
        throw new SecretKeyModeChangedError()
      }

      const provided = secretKeyInput.trim()

      if (!provided) {
        releaseVaultLock()
        throw new SecretKeyRequiredError()
      }

      try {
        sessionKeyBytes = await parseSecretKeyString(provided)
      } catch {
        releaseVaultLock()
        throw new SecretKeyInvalidError()
      }
    }

    let decrypted: string

    try {
      // Line endings are normalized to LF once, explicitly, at unlock (SPEC §6):
      // CodeMirror would silently normalize CR/CRLF in the editor anyway, so an
      // externally-authored envelope is rewritten deliberately here instead of
      // drifting between the editor document and the in-memory plaintext.
      decrypted = normalizeToLf(
        await CryptoService.decrypt(envelope, password, {
          secretKeyBytes: sessionKeyBytes,
        }),
      )
    } catch (error) {
      // The unlock failed: do not keep the cross-tab lock for a still-locked
      // screen (another window may legitimately unlock instead).
      releaseVaultLock()
      // The unlock failed — wipe the parsed Secret-key payload promptly instead
      // of leaving a resident copy for the GC (consistency with the derivation
      // buffers that already zeroize in finally; SPEC §5). Both throws below end
      // this scope, so clearing the contents is the meaningful step; a `= null`
      // reassignment would be dead (no-useless-assignment).
      sessionKeyBytes?.fill(0)
      if (secretKeyMode === SECRET_KEY_MODE_REQUIRED) {
        throw new SecretKeyUnlockFailedError()
      }
      throw error
    }

    // The read-only flag travels inside the envelope (SPEC §7); read it at
    // unlock so the session honors what the file says.
    const envelopeReadOnly = isEnvelopeReadOnly(parsedEnvelope)

    passwordRef.current = password
    sessionSecretKeyBytesRef.current = sessionKeyBytes
    sessionKdfParamsRef.current = getEnvelopeKdfParams(parsedEnvelope)
    plaintextRef.current = decrypted
    lastSavedPlaintextRef.current = decrypted
    isReadOnlyRef.current = envelopeReadOnly
    setIsReadOnly(envelopeReadOnly)
    setAppReadOnlySession(false)
    setSavedEnvelope(envelope)
    setPlaintext(decrypted)
    setIsUnlocked(true)
    setSaveStatus('saved')
    setHasSavedThisSession(false)
    setMessage('')
  }

  // Focus the editor whenever a document opens (unlock or create) so typing
  // works without a click; the caret starts at the beginning of the document.
  useEffect(() => {
    if (isUnlocked) {
      editorRef.current?.focus()
    }
  }, [isUnlocked])

  const refreshLocalFileRecords = async (options: { force?: boolean } = {}) => {
    if (!options.force && activeStorageProviderRef.current.kind !== 'local-file') {
      return []
    }

    const records = await localFileProvider.refreshRecentFileMetadata()

    applyLocalFileRecords(records)
    return records
  }

  const refreshStorageStatus = async () => {
    const provider = activeStorageProviderRef.current
    const status = await provider.status()

    setStorageStatus(status)

    if (isSyncStorageProvider(provider)) {
      setDropboxSyncState(await provider.getSyncState())
    } else if (provider.kind === 'draft') {
      // Draft sessions still show Dropbox affordances (the Save/sync
      // button, the unified home). Refresh the Dropbox snapshot here — runs
      // after every save — so `hasUnsyncedLocal` tracks vault saves made
      // while Dropbox is not the active provider (two local reads, no
      // network).
      const dropbox = getDropboxProvider()

      if (dropbox) {
        setDropboxSyncState(await dropbox.getSyncState())
      }
    }

    return status
  }

  // The Dropbox singleton, regardless of which provider is active. Unlike
  // getSyncProvider() (which only sees Dropbox when it is the active provider),
  // this lets the unified home and the editor toolbar read/drive Dropbox state
  // while the draft is the active working copy.
  const getDropboxProvider = (): SyncStorageProvider | null => {
    const provider = getStorageProvider('dropbox')

    return isSyncStorageProvider(provider) ? provider : null
  }

  // Refreshes dropboxSyncState from the singleton independent of the active
  // provider, so "linked?/file selected?" is accurate even in draft mode.
  const refreshDropboxState = async () => {
    const provider = getDropboxProvider()

    if (provider) {
      setDropboxSyncState(await provider.getSyncState())
    }
  }

  // Folds one background-check outcome into the session indicator map and the
  // stale-row memory (SPEC §9). `check-failed` changes nothing — a probe
  // failure must never flip an indicator either way.
  const applyRecentCheckOutcome = useCallback(
    (key: string, outcome: DropboxRecentFileCheck) => {
      if (outcome.kind === 'check-failed') {
        return false
      }

      let changed = false
      const wasStale = staleRecentKeysRef.current.has(key)
      const willBeStale = outcome.kind === 'stale'

      if (outcome.kind === 'stale') {
        staleRecentKeysRef.current.add(key)
      } else {
        staleRecentKeysRef.current.delete(key)
      }

      if (wasStale !== willBeStale) {
        changed = true
      }

      const indicator: DropboxRecentFileIndicator | null =
        outcome.kind === 'diverged' ||
        outcome.kind === 'missing' ||
        outcome.kind === 'replacement-candidate' ||
        outcome.kind === 'ineligible'
          ? outcome.kind
          : null

      if ((recentFileIndicators.get(key) ?? null) !== indicator) {
        changed = true
      }

      setRecentFileIndicators((current) => {
        if ((current.get(key) ?? null) === indicator) {
          return current
        }

        const next = new Map(current)

        if (indicator) {
          next.set(key, indicator)
        } else {
          next.delete(key)
        }

        return next
      })

      return changed || outcome.kind === 'pushed' || outcome.kind === 'refreshed'
    },
    [recentFileIndicators],
  )

  const serializeDropboxRecents = useCallback(
    (recents: DropboxRecentFilesData | null) =>
      JSON.stringify({
        selectedKey: recents?.selectedKey ?? null,
        files:
          recents?.files.map((file) => ({
            key: file.key,
            name: file.name,
            folderPath: file.folderPath,
            syncedModifiedAt: file.syncedModifiedAt,
            localModifiedAt: file.localModifiedAt,
            hasCache: file.hasCache,
            hasUnsyncedChanges: file.hasUnsyncedChanges,
          })) ?? [],
      }),
    [],
  )

  const didDropboxRecentsChange = useCallback(
    (before: DropboxRecentFilesData | null, after: DropboxRecentFilesData | null) =>
      before !== null &&
      after !== null &&
      serializeDropboxRecents(before) !== serializeDropboxRecents(after),
    [serializeDropboxRecents],
  )

  const refreshDropboxRecentFiles = async () => {
    const provider = getDropboxProvider()

    if (!provider) {
      return
    }

    try {
      setDropboxRecentFiles(await provider.getRecentFiles())
    } catch {
      // Keep the last table contents; the next refresh retries.
    }
  }

  function clearSoftLockRetryTimer() {
    if (softLockRetryTimerRef.current !== null) {
      window.clearTimeout(softLockRetryTimerRef.current)
      softLockRetryTimerRef.current = null
    }
  }

  const clearSecrets = () => {
    clearSoftLockRetryTimer()
    isSoftLockedRef.current = false
    releaseVaultLock()
    passwordRef.current = ''
    // Zero the session key buffer before dropping the reference (consistency with
    // the crypto layer, which zeroes its own buffers in `finally`).
    sessionSecretKeyBytesRef.current?.fill(0)
    sessionSecretKeyBytesRef.current = null
    sessionKdfParamsRef.current = null
    plaintextRef.current = ''
    lastSavedPlaintextRef.current = ''
    setPlaintext('')
    setCanUndo(false)
    setCanRedo(false)
    setIsLockSaveFailureDialogOpen(false)
    setSoftLockState(null)
    setIsExitConfirmOpen(false)
    setIsSettingsDialogOpen(false)
    setSearchQuery('')
    setReplaceInput('')
    setSearchOptions(defaultSearchOptions)
    setSearchMessage('')
    setSearchMessageTone('info')
    setIsSearchPanelOpen(false)
    // Drop all in-flight conflict work and decrypted conflict state on lock.
    conflictController.dispose(conflictDeps())
    setConflictResolutions(new Map())
    setIsConflictPreview(false)
    // The first-sync gate is session state: the next session re-probes.
    setDropboxSessionPaused(false)
    dropboxFileSessionKeyRef.current = null
    setAppReadOnlySession(false)
    terminateSearchWorker()
  }

  useEffect(() => {
    isSoftLockedRef.current = isSoftLocked
  }, [isSoftLocked])

  useEffect(
    () => () => {
      if (softLockRetryTimerRef.current !== null) {
        window.clearTimeout(softLockRetryTimerRef.current)
        softLockRetryTimerRef.current = null
      }
      if (secretKeySettingsMessageTimerRef.current !== null) {
        window.clearTimeout(secretKeySettingsMessageTimerRef.current)
        secretKeySettingsMessageTimerRef.current = null
      }
    },
    [],
  )

  const loadActiveProviderState = async (
    provider: StorageProvider,
    isActive: () => boolean = () => true,
  ) => {
    try {
      const status = await provider.status()

      if (isActive()) {
        setStorageStatus(status)
      }

      if (isActive() && isSyncStorageProvider(provider)) {
        setDropboxSyncState(await provider.getSyncState())
      }

      if (isActive() && provider.kind === 'local-file') {
        const records = await localFileProvider.refreshRecentFileMetadata()

        if (isActive()) {
          applyLocalFileRecords(records)
        }
      }
    } catch {
      if (isActive()) {
        showMessage('Unable to open the selected storage.')
      }
    }

    try {
      const envelope = await provider.load()

      if (isActive()) {
        setSavedEnvelope(envelope)
      }
    } catch {
      // Empty Dropbox/drafts are valid first-run states.
      if (isActive()) {
        setSavedEnvelope(null)
      }
    }

    if (isActive() && isSyncStorageProvider(provider)) {
      setDropboxSyncState(await provider.getSyncState())
      setStorageStatus(await provider.status())
    }
  }

  const changeStorageProvider = async (selection: StorageModeKind) => {
    const provider = getStorageProvider(selection)

    activeStorageProviderRef.current = provider
    setActiveStorageProvider(provider)
    setSettings((current) => ({ ...current, storageProvider: selection }))
    void vaultStore.saveSetting({ key: 'storageProvider', value: selection }).catch(() => undefined)

    setSavedEnvelope(null)
    setLocalFileRecords([])
    setActiveLocalFileKey(null)
    setDropboxSyncState(null)
    setStorageStatus(null)
    setLocalFileDiagnosticEntries([])
    setMessage('')

    await loadActiveProviderState(provider)
  }

  // Rebinds the ACTIVE provider for a session-internal document switch
  // (draft <-> Dropbox file) *without* tearing down the session: unlike
  // changeStorageProvider, it preserves the decrypted plaintext, password,
  // and savedEnvelope. Deliberately NOT persisted: `draft` is no
  // longer a storage mode, just the draft's internal provider, and the
  // persisted `storageProvider` setting stays the user's mode
  // (`local-file`/`dropbox`) regardless of which document is open (SPEC §2).
  const setActiveProviderPreservingSession = (kind: StorageProviderKind) => {
    const provider = getStorageProvider(kind)

    activeStorageProviderRef.current = provider
    setActiveStorageProvider(provider)
  }

  useEffect(() => {
    activeStorageProviderRef.current = activeStorageProvider
  }, [activeStorageProvider])

  // On startup, request browser persistence and surface the resulting draft
  // durability state on the home screen.
  useEffect(() => {
    let active = true
    void requestPersistentStorage().then((state) => {
      if (active) {
        setStoragePersisted(state)
      }
    })
    return () => {
      active = false
    }
  }, [])

  // On the home/locked screen in a non-local-file mode, keep dropboxSyncState
  // fresh from the Dropbox singleton so the unified home's Dropbox section shows
  // accurate link/connection state even in draft mode (where Dropbox is
  // not the active provider). refreshDropboxState only reads the singleton and
  // setState, so it is safe to omit from the dependency list.
  useEffect(() => {
    if (isUnlocked || homeStorageProviderKind === 'local-file') {
      return undefined
    }

    let isActive = true

    void (async () => {
      const provider = getDropboxProvider()

      if (!provider || !isActive) {
        return
      }

      const state = await provider.getSyncState()

      if (isActive) {
        setDropboxSyncState(state)
      }
    })()

    return () => {
      isActive = false
    }
  }, [isUnlocked, homeStorageProviderKind])

  // Passive "Update available" indicator: surfaced when the browser stages a
  // newer build in the background. Informational only — it never starts an
  // update (SPEC Section 14).
  //
  // Same effect also handles a VERSION_PINNED broadcast: another window applied
  // an update and repointed the pin to a newer build. This window is still
  // serving the old (now about-to-be-pruned) cache, so it must reload onto the
  // new pin. The cross-window guard in applyUpdate guarantees only
  // LOCKED windows are running when the pin moves, so reloading here cannot lose
  // in-memory plaintext. Belt-and-braces: if somehow unlocked, never reload an
  // active session (SPEC Section 14) — fall back to the passive notice instead.
  // Depends on isUnlocked so the guard reads the current lock state, not a stale
  // closure.
  useEffect(() => {
    const unsubscribeStaged = subscribeStagedUpdate(setStagedUpdateAvailable)
    const unsubscribePinned = subscribeVersionPinned(() => {
      if (isUnlocked) {
        setStagedUpdateAvailable(true)
        return
      }
      reloadOnce()
    })
    return () => {
      unsubscribeStaged()
      unsubscribePinned()
    }
  }, [isUnlocked])

  // Chrome retraction while typing: when the
  // on-screen keyboard is up AND focus is in the editor itself, the status
  // bar hides in every orientation, and on short screens (landscape phones,
  // via a max-height media query in App.css) the toolbar hides too. Focus in
  // the find/replace boxes deliberately retracts NOTHING — the toolbar stays
  // reachable and the "x of X" summary in the status bar stays visible.
  const [isEditorFocused, setIsEditorFocused] = useState(false)
  const [isKeyboardUp, setIsKeyboardUp] = useState(false)

  // Track the iOS visual viewport so the editor surface equals the area above
  // the on-screen keyboard: iOS does not shrink the layout viewport (or `dvh`)
  // for the keyboard, so without this the shell's bottom (and, via the locked
  // page, its top chrome) is occluded and scrolling "sticks". `.editor-shell`
  // consumes `--app-viewport-height`. Height-only for now; `offsetTop` panning
  // is a device-gated follow-up. Active only while the editor is mounted.
  useEffect(() => {
    const viewport = typeof window !== 'undefined' ? window.visualViewport : null
    if (!isUnlocked || !viewport) {
      return undefined
    }
    const root = document.documentElement
    const apply = () => {
      root.style.setProperty('--app-viewport-height', `${viewport.height}px`)

      // On-screen keyboard heuristic: the visual viewport is substantially
      // shorter than the layout viewport. Scale-corrected so pinch zoom does
      // not read as a keyboard; desktops (no OSK) never trip the threshold,
      // and a hardware keyboard on a tablet/phone leaves it false too.
      setIsKeyboardUp(window.innerHeight - viewport.height * viewport.scale > 150)
      // When iOS pans the visual viewport (offsetTop > 0) and the scroll pin
      // below cannot undo it, the shell translates down by this amount so it
      // keeps covering the visible region when a caret near the bottom would
      // otherwise hide behind the keyboard by roughly this offset. The
      // scroll listener re-runs this, so a successful pin resets it to 0.
      root.style.setProperty('--app-viewport-offset-top', `${viewport.offsetTop}px`)

      // With the on-screen keyboard open, iOS lets the page scroll even
      // though the shell is sized to the visual viewport — exposing blank
      // space below the status bar. Pin the layout scroll back to the top.
      // Skipped while pinch-zoomed (scale > 1), where panning is legitimate.
      if (viewport.scale <= 1.01 && (window.scrollY !== 0 || viewport.offsetTop > 0)) {
        window.scrollTo(0, 0)
      }
    }
    apply()
    viewport.addEventListener('resize', apply)
    viewport.addEventListener('scroll', apply)
    return () => {
      viewport.removeEventListener('resize', apply)
      viewport.removeEventListener('scroll', apply)
      root.style.removeProperty('--app-viewport-height')
      root.style.removeProperty('--app-viewport-offset-top')
      setIsKeyboardUp(false)
    }
  }, [isUnlocked])

  useEffect(() => {
    let isMounted = true
    const isActive = () => isMounted

    const init = async () => {
      let loadedSettings: AppSettings

      try {
        loadedSettings = await loadStoredSettings()
      } catch {
        loadedSettings = defaultSettings
      }

      // Resolve an implicit choice to an explicit provider kind, once, and
      // persist the result. The 'auto' first-run default, and a stored
      // 'local-file' on a platform without the File System Access API (for
      // example Firefox) where it cannot work, both resolve to the capability
      // default.
      const resolvedProviderKind: StorageModeKind =
        loadedSettings.storageProvider === 'auto' ||
        (loadedSettings.storageProvider === 'local-file' &&
          !detectStorageCapabilities().hasFileSystemAccess)
          ? selectDefaultProviderKind()
          : loadedSettings.storageProvider

      if (resolvedProviderKind !== loadedSettings.storageProvider) {
        loadedSettings = { ...loadedSettings, storageProvider: resolvedProviderKind }
        void vaultStore
          .saveSetting({ key: 'storageProvider', value: resolvedProviderKind })
          .catch(() => undefined)
      }

      if (!isActive()) {
        return
      }

      setSettings(loadedSettings)

      const provider = getStorageProvider(resolvedProviderKind)

      activeStorageProviderRef.current = provider
      setActiveStorageProvider(provider)

      // Complete any Dropbox OAuth redirect on the Dropbox singleton, regardless
      // of the active provider — linking can be initiated from draft mode
      // (the unified home), and the redirect reloads the app. No-op when the URL
      // carries no OAuth params.
      const dropboxForLink = getDropboxProvider()

      if (dropboxForLink) {
        try {
          const completedDropboxLink = await dropboxForLink.completeLinkFromRedirect()

          if (isActive() && completedDropboxLink) {
            if (completedDropboxLink.accountMismatch) {
              // The guard dialog renders from the persisted pendingAccountSwitch
              // state; no success message — nothing is usable until resolved.
            } else {
              showDropboxMessage('Dropbox linked.', 'info')
            }

            if (completedDropboxLink.unverifiedOwnership) {
              setShowOwnershipNotice(true)
            }
          }
        } catch {
          // A thrown completion (distinct from a returned account mismatch) would
          // otherwise leave only the generic "not linked" state, so the user could
          // not tell their link attempt failed. Guard on isActive() so a torn-down
          // mount stays silent.
          if (isActive()) {
            showDropboxMessage('Linking failed. Try again.')
          }
        }
      }

      await loadActiveProviderState(provider, isActive)

      if (isActive()) {
        setIsLoading(false)
      }
    }

    void init()

    return () => {
      isMounted = false
    }
    // Run-once startup: resolves persisted settings/provider and loads initial state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (activeStorageProviderRef.current.kind !== 'local-file') {
      return undefined
    }

    const updateLocalFileDiagnostic = (event: Event) => {
      const diagnostic = (event as CustomEvent<unknown>).detail

      setLocalFileDiagnosticEntries((entries) =>
        entries.concat(JSON.stringify(diagnostic, null, 2)).slice(-5),
      )
    }

    window.addEventListener('enoteweb-local-file-diagnostic', updateLocalFileDiagnostic)

    return () => {
      window.removeEventListener('enoteweb-local-file-diagnostic', updateLocalFileDiagnostic)
    }
  }, [])

  useEffect(() => {
    // The provider is resolved when the event FIRES, not when the listener is
    // installed: this effect runs once at mount, and capturing the provider
    // here meant a session that started on the draft provider never gained
    // online auto-sync after switching to Dropbox (and one that started in
    // Dropbox mode kept syncing after switching away).
    const syncWhenOnline = () => {
      // Re-arm the per-visit home passes and re-render: regaining
      // connectivity re-runs the home auto-sync and the background revision
      // check (SPEC §9), and indicator visibility re-evaluates.
      homeAutoSyncDoneRef.current = false
      homeRevisionCheckDoneRef.current = false
      setConnectivityTick((tick) => tick + 1)

      const provider = getSyncProvider()

      if (!provider) {
        return
      }

      // A stale-but-clean remote may be adopted (cache refresh) only while
      // no Dropbox file session is open — adoption swaps cache/baseRev,
      // which must never happen underneath the open editor (SPEC §9).
      void runExclusiveDropboxOp(() =>
        provider.syncNow({ adoptCleanRemote: dropboxFileSessionKeyRef.current === null }),
      )
        .then((status) => setStorageStatus(status))
        .then(() => provider.getSyncState())
        .then(setDropboxSyncState)
        .catch(() => undefined)
    }
    // Indicators are not shown while offline (SPEC §9) — the tick re-renders
    // the home block so they hide and reappear with connectivity.
    const handleOffline = () => setConnectivityTick((tick) => tick + 1)

    window.addEventListener('online', syncWhenOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', syncWhenOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [runExclusiveDropboxOp])

  // Keep the home Dropbox block's recent-files table fresh (SPEC §9): refresh
  // whenever the locked home is shown or the link state changes. setState runs
  // only post-await, guarded against unmount/supersession.
  useEffect(() => {
    if (isUnlocked) {
      return
    }

    let active = true

    // The draft presence drives the New/Edit draft label (SPEC §10). The
    // draft exists in every storage mode, so this must not be gated on the
    // Dropbox provider below.
    vaultStore
      .getVault()
      .then((vault) => {
        if (active) {
          setHasDraft(Boolean(vault))
        }
      })
      .catch(() => undefined)

    const provider = homeStorageProviderKind === 'dropbox' ? getDropboxProvider() : null

    if (provider) {
      provider
        .getRecentFiles()
        .then((recents) => {
          if (active) {
            setDropboxRecentFiles(recents)
          }
        })
        .catch(() => undefined)
    }

    return () => {
      active = false
    }
  }, [
    isUnlocked,
    dropboxSyncState?.linked,
    dropboxSyncState?.pendingAccountSwitch,
    homeStorageProviderKind,
  ])

  // Auto-sync on entering the Dropbox home/locked screen: locking from the editor
  // (Home button) or reopening the app to the home screen fires one background
  // sync, so edits made before locking/closing upload without a manual tap.
  // Manual Sync from the editor still works; greying is unchanged. Deduped per
  // visit via the ref, and serialized through the shared Dropbox op queue.
  useEffect(() => {
    const provider = getSyncProvider()

    if (!provider) {
      homeAutoSyncDoneRef.current = false
      return
    }

    const onDropboxHome =
      !isUnlocked && homeStorageProviderKind === 'dropbox' && (dropboxSyncState?.linked ?? false)

    if (!onDropboxHome) {
      homeAutoSyncDoneRef.current = false
      return
    }

    if (homeAutoSyncDoneRef.current) {
      return
    }

    homeAutoSyncDoneRef.current = true
    // Only sync if a remote file is actually selected — checked inside the op via
    // the provider's own locator (id or path), so path-only records sync too; a
    // record with no selected remote is a no-op.
    void (async () => {
      const beforeRecents = await provider.getRecentFiles().catch(() => null)
      const status = await runExclusiveDropboxOp(async () => {
        if (!(await provider.hasSelectedRemote())) {
          return null
        }

        // Home context, no open session: a stale-but-clean selected file is
        // refreshed by adopting the remote (SPEC §9 flow step 6) — never
        // turned into a conflict the background check would then read as
        // diverged.
        return provider.syncNow({ adoptCleanRemote: true })
      })

      if (status) {
        setStorageStatus(status)
      }

      const afterRecents = await provider.getRecentFiles().catch(() => null)

      if (didDropboxRecentsChange(beforeRecents, afterRecents)) {
        showDropboxMessage('Sync complete.', 'info')
      }

      setDropboxSyncState(await provider.getSyncState())
    })()
      .catch(() => undefined)
  }, [
    isUnlocked,
    dropboxSyncState?.linked,
    homeStorageProviderKind,
    runExclusiveDropboxOp,
    didDropboxRecentsChange,
    showDropboxMessage,
  ])

  // Background revision check over the recent files (SPEC §9): when the
  // Dropbox-Mode home is shown while linked and online — app launch,
  // returning Home from the editor, regaining connectivity — every record is
  // probed by id, one serialized op per record so user actions (Open, Browse)
  // interleave instead of waiting for the whole pass. Outcomes feed the
  // session indicator map; safe adoptions/refreshes/flushes are persisted by
  // the provider. Never blocks Open: opening before (or while) the pass runs
  // is by design, and the row may change state under the user.
  useEffect(() => {
    const provider = getDropboxProvider()
    const onDropboxHome =
      !isUnlocked &&
      homeStorageProviderKind === 'dropbox' &&
      (dropboxSyncState?.linked ?? false) &&
      !dropboxSyncState?.pendingAccountSwitch

    if (!provider || !onDropboxHome) {
      homeRevisionCheckDoneRef.current = false
      return
    }

    if (homeRevisionCheckDoneRef.current || globalThis.navigator?.onLine === false) {
      return
    }

    homeRevisionCheckDoneRef.current = true

    // The Dropbox home is shown, linked, and online (the guards above), so an
    // autosync pass is starting — clear any stale "Offline." notice. This
    // effect re-runs on connectivity regain via connectivityTick,
    // so a reconnect clears it too.
    clearOfflineDropboxMessage()

    let active = true

    void (async () => {
      let recents: DropboxRecentFilesData

      try {
        recents = await provider.getRecentFiles()
      } catch {
        return
      }

      let changed = false

      for (const file of recents.files) {
        // Stop when the home is left: an open session's cache must never be
        // swapped by a late stale-but-clean refresh.
        if (!active) {
          return
        }

        // Skip the row the Open flow is currently reading, for the same
        // reason — its own pre-open refresh covers it.
        if (openingRecentKeyRef.current === file.key) {
          continue
        }

        try {
          const outcome = await runExclusiveDropboxOp(() => provider.checkRecentFile(file.key))

          changed = applyRecentCheckOutcome(file.key, outcome) || changed
        } catch {
          // Per-record failure: no indicator change (SPEC §9).
        }
      }

      if (!active) {
        return
      }

      // Names/paths/modified timestamps may have been adopted; the table
      // re-reads once after the pass (each row's indicator already arrived
      // asynchronously).
      try {
        const refreshed = await provider.getRecentFiles()

        if (active) {
          setDropboxRecentFiles(refreshed)
        }

        if (active && (changed || didDropboxRecentsChange(recents, refreshed))) {
          showDropboxMessage('Sync complete.', 'info')
        }

        const syncState = await provider.getSyncState()

        if (active) {
          setDropboxSyncState(syncState)
        }
      } catch {
        // Keep the last table contents; the next pass retries.
      }
    })()

    return () => {
      active = false
    }
  }, [
    isUnlocked,
    dropboxSyncState?.linked,
    dropboxSyncState?.pendingAccountSwitch,
    homeStorageProviderKind,
    connectivityTick,
    runExclusiveDropboxOp,
    applyRecentCheckOutcome,
    clearOfflineDropboxMessage,
    didDropboxRecentsChange,
    showDropboxMessage,
  ])

  // Manual save/sync/export handlers call this ref from rendered controls. Keep it
  // current before the browser can process a post-render click after unlock.
  useLayoutEffect(() => {
    saveCurrentPlaintextRef.current = async ({
      trigger = 'auto',
      waitForInFlight = false,
    } = {}) => {
      if (!isUnlocked || !passwordRef.current) {
        return { ok: false, reason: 'locked' }
      }

      if (activeSavePromiseRef.current) {
        pendingSaveRef.current = true

        if (!waitForInFlight) {
          return { ok: false, reason: 'in-flight' }
        }

        const inFlightResult = await activeSavePromiseRef.current

        if (!inFlightResult.ok) {
          return inFlightResult
        }

        if (plaintextRef.current !== lastSavedPlaintextRef.current) {
          return saveCurrentPlaintextRef.current({ trigger, waitForInFlight: true })
        }

        return inFlightResult
      }

      const textToSave = plaintextRef.current
      setSaveStatus('saving')

      const savePromise = (async (): Promise<SaveCurrentPlaintextResult> => {
        try {
          const envelope = await encryptWithSessionSecretKey(textToSave, passwordRef.current, {
            readOnly: isReadOnlyRef.current,
          })
          const provider = activeStorageProviderRef.current

          // A Dropbox save uploads, so it must take the shared op queue like
          // every other mutating Dropbox call — an autosave racing a queued
          // syncNow (online listener, home auto-sync, manual Sync) could
          // otherwise interleave rev reads and writes. Local providers have
          // no such cross-operation state and save directly. A paused session
          // (first-sync gate, SPEC §9: the file is known remotely changed)
          // saves cache-only — pushing stops while autosave continues.
          if (isSyncStorageProvider(provider)) {
            await runExclusiveDropboxOp(() =>
              dropboxSessionPausedRef.current
                ? provider.saveLocalOnly(envelope)
                : provider.save(envelope),
            )
          } else {
            await provider.save(envelope)
          }
          setSavedEnvelope(envelope)
          setHasSavedThisSession(true)
          void refreshStorageStatus().catch(() => undefined)
          lastSavedPlaintextRef.current = textToSave

          if (plaintextRef.current === textToSave) {
            setSaveStatus('saved')
          } else {
            pendingSaveRef.current = true
            setSaveStatus('dirty')
          }

          return { envelope, ok: true }
        } catch (error) {
          const saveLabel = trigger === 'manual' ? 'Save' : 'Autosave'

          setSaveStatus('error')
          showMessage(
            isLocalFileWritePermissionError(error)
              ? `${saveLabel} failed. Open the file again and allow write permission.`
              : `${saveLabel} failed. Keep this tab open and try again.`,
          )
          return { ok: false, reason: 'failed' }
        }
      })()

      activeSavePromiseRef.current = savePromise
      const result = await savePromise

      if (activeSavePromiseRef.current === savePromise) {
        activeSavePromiseRef.current = null
      }

      if (pendingSaveRef.current) {
        pendingSaveRef.current = false

        if (plaintextRef.current !== lastSavedPlaintextRef.current) {
          window.setTimeout(() => {
            void saveCurrentPlaintextRef.current({ trigger: 'auto' })
          }, 0)
        }
      }

      return result
    }
    // The save closure reads live values through refs; `refreshStorageStatus`
    // and `runExclusiveDropboxOp` only read refs / setState (stable in
    // behavior), so the closure needs rebuilding only when lock state flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isUnlocked])

  useEffect(() => {
    plaintextRef.current = plaintext
  }, [plaintext])

  useEffect(() => {
    // Only sync CodeMirror search highlights while the panel is open. Running on
    // every keystroke when closed dispatched a redundant setSearchHighlights([])
    // transaction per character, forcing a second relayout that flickered the
    // editor under wrap + landscape. Highlights are cleared once on close below.
    if (!isUnlocked || !isSearchPanelOpen) {
      return
    }

    let isCurrent = true

    const validation = validateSearchQuery(searchQuery, searchOptions)

    if (!validation.ok) {
      // The invalid-query message is derived during render (see
      // `searchValidationMessage`), so this effect only performs the imperative
      // CodeMirror sync and no longer sets React state synchronously. The live
      // match count needs no clearing here either: its status-bar display is
      // gated on the CURRENT query being valid, so a stale count is invisible
      // until the async path below recomputes it for the next valid query.
      editorRef.current?.setSearchHighlights([])
      return
    }

    void findSearchMatchesSafely(deferredPlaintext, searchQuery, searchOptions).then((result) => {
      if (!isCurrent) {
        return
      }

      // A superseded request settled because the user kept typing; a newer
      // request is already in flight. Ignore it entirely — do not wipe
      // highlights, null the count, or surface a stale "Regex too expensive."
      // The newer request's result will drive the next render.
      if (isSupersededResult(result)) {
        return
      }

      editorRef.current?.setSearchHighlights(result.ok ? result.matches : [])
      setLiveMatchCount(
        result.ok ? { count: result.matches.length, limited: result.limited } : null,
      )
      if (!result.ok) {
        showSearchMessage(result.message, 'error')
      }
    })

    return () => {
      isCurrent = false
    }
  }, [isUnlocked, isSearchPanelOpen, deferredPlaintext, searchOptions, searchQuery])

  useEffect(() => {
    if (isSearchPanelOpen) {
      window.setTimeout(() => {
        const target = searchPanelFocusTargetRef.current

        searchPanelFocusTargetRef.current = 'find'

        const input = target === 'replace' ? replaceInputRef.current : searchInputRef.current

        // Select any existing text so a new query can be typed immediately.
        input?.focus()
        input?.select()
      }, 0)
    } else {
      // Clear any leftover highlights once when the panel closes, rather than
      // re-clearing them on every keystroke (see the search-sync effect above).
      // (The live match count keeps its value — its display is gated on the
      // panel being open, and reopening recomputes it.)
      editorRef.current?.setSearchHighlights([])
    }
  }, [isSearchPanelOpen])

  useEffect(() => {
    if (!isUnlocked || isSoftLocked || isAppReadOnlySession || saveStatus !== 'dirty') {
      return
    }

    const timeoutId = window.setTimeout(() => {
      void saveCurrentPlaintextRef.current({ trigger: 'auto' })
    }, 750)

    return () => window.clearTimeout(timeoutId)
  }, [isAppReadOnlySession, isSoftLocked, isUnlocked, plaintext, saveStatus])

  useEffect(() => {
    // Flush unsaved edits when the app is backgrounded or the device is locked,
    // before the 750ms autosave debounce would fire. Use the same ref-based
    // check as lockVault() — not React's saveStatus, which can lag a just-typed
    // edit — and wait through any in-flight save so the newest text is the one
    // persisted (rather than deferring to a setTimeout that won't run once the
    // page is suspended). Best-effort: encrypt + write are async, so a save
    // started here only completes if the page is hidden (lock/app-switch), not
    // hard-killed.
    const flushIfNeeded = () => {
      const needsSave =
        Boolean(activeSavePromiseRef.current) ||
        plaintextRef.current !== lastSavedPlaintextRef.current

      if (
        isUnlocked &&
        !isSoftLockedRef.current &&
        !isAppReadOnlySessionRef.current &&
        passwordRef.current &&
        needsSave
      ) {
        void saveCurrentPlaintextRef.current({ trigger: 'auto', waitForInFlight: true })
      }
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushIfNeeded()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('pagehide', flushIfNeeded)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('pagehide', flushIfNeeded)
    }
  }, [isUnlocked])

  // Remote-change detection on focus/visibility regain. Returning to the
  // tab/app runs a lightweight by-id probe for the
  // OPEN Dropbox file and updates the sync state / first-sync-gate pause exactly
  // as the home check does — so a remote change that landed while the editor was
  // backgrounded surfaces (the status pill and the Resolve banner reflect it)
  // without the removed manual "check now" control. Refresh is disabled
  // (`refreshStaleCache: false`): an open session's cache must never be swapped
  // underneath the editor — a stale/diverged result only pauses pushing.
  // Debounced so a burst of focus/visibility events (or a tab the user flips
  // through) fires at most one probe. ACCEPTED LIMITATION: there is NO
  // continuous polling — a session merely VIEWED (no edits, no refocus) between
  // triggers will not notice a remote change until the next trigger fires
  // (focus/visibility regain here, reconnect, going Home, or an autosave 409).
  useEffect(() => {
    if (!isUnlocked) {
      return
    }

    const runOpenSessionRemoteCheck = () => {
      const sessionKey = dropboxFileSessionKeyRef.current

      if (
        !sessionKey ||
        document.visibilityState !== 'visible' ||
        globalThis.navigator?.onLine === false
      ) {
        return
      }

      const provider = getDropboxProvider()

      if (!provider) {
        return
      }

      void runExclusiveDropboxOp(() =>
        provider.checkRecentFile(sessionKey, { refreshStaleCache: false }),
      )
        .then(async (outcome) => {
          // The session may have changed (lock, open another file) while the
          // probe was queued: ignore a result that no longer applies.
          if (dropboxFileSessionKeyRef.current !== sessionKey) {
            return
          }

          applyRecentCheckOutcome(sessionKey, outcome)

          if (outcome.kind === 'stale' || outcome.kind === 'diverged') {
            setDropboxSessionPaused(true)
          }

          // Reflect the probe in the status pill (a metadata-only bump or a
          // pushed pending side can flip it clean again).
          const synced = await provider.getSyncState().catch(() => null)

          if (synced && dropboxFileSessionKeyRef.current === sessionKey) {
            setDropboxSyncState(synced)
          }
        })
        .catch(() => undefined)
    }

    const scheduleCheck = () => {
      if (focusRemoteCheckTimerRef.current !== null) {
        window.clearTimeout(focusRemoteCheckTimerRef.current)
      }

      focusRemoteCheckTimerRef.current = window.setTimeout(() => {
        focusRemoteCheckTimerRef.current = null
        runOpenSessionRemoteCheck()
      }, 400)
    }

    const handleVisible = () => {
      if (document.visibilityState === 'visible') {
        scheduleCheck()
      }
    }

    window.addEventListener('focus', scheduleCheck)
    document.addEventListener('visibilitychange', handleVisible)

    return () => {
      window.removeEventListener('focus', scheduleCheck)
      document.removeEventListener('visibilitychange', handleVisible)

      if (focusRemoteCheckTimerRef.current !== null) {
        window.clearTimeout(focusRemoteCheckTimerRef.current)
        focusRemoteCheckTimerRef.current = null
      }
    }
  }, [isUnlocked, runExclusiveDropboxOp, applyRecentCheckOutcome])

  // --- Dropbox file browser + password dialogs (SPEC §9/§10, Stage 1) ---
  // Promise-based openers keep the existing imperative flows intact: each
  // flow awaits a dialog exactly where a blocking prompt would otherwise sit.

  const [dropboxBrowserRequest, setDropboxBrowserRequest] = useState<{
    defaultFileName: string | undefined
    initialFolder: string
    mode: DropboxFileBrowserMode
    resolve: (choice: { path: string } | null) => void
  } | null>(null)
  const [unlockDialogRequest, setUnlockDialogRequest] = useState<{
    attempt: (password: string, secretKeyInput: string | null) => Promise<string | null>
    busy: boolean
    error: string
    resolve: (unlocked: boolean) => void
    secretKeyField: SecretKeyFieldConfig | undefined
    title: string
  } | null>(null)
  const [createPasswordRequest, setCreatePasswordRequest] = useState<{
    initialKdfPolicy: KdfPolicyId
    resolve: (result: { kdfPolicy: KdfPolicyId; password: string; secretKeyOn: boolean } | null) => void
    secretKey: SecretKeyToggleConfig
    submitLabel: string
    title: string
  } | null>(null)
  // Session-remembered browse folder (SPEC §9: held in memory only).
  const lastBrowsedDropboxFolderRef = useRef('')

  // '' is the Dropbox root; null when the path is unusable.
  const getDropboxParentFolder = (pathDisplay: string | null | undefined) => {
    if (!pathDisplay || !pathDisplay.startsWith('/')) {
      return null
    }

    return pathDisplay.split('/').slice(0, -1).join('/')
  }

  const getDropboxFileName = (pathDisplay: string | null | undefined) =>
    pathDisplay?.split('/').filter(Boolean).at(-1) ?? null

  // Opens the browser and resolves with the chosen path (null on cancel).
  // Gated up front: the dialog must never open into a state that can only
  // fail (SPEC §9) — offline and unlinked are reported instead.
  const openDropboxBrowser = async (mode: DropboxFileBrowserMode) => {
    const provider = getDropboxProvider()

    if (!provider) {
      return null
    }

    if (globalThis.navigator?.onLine === false) {
      showDropboxMessage('Offline.')
      return null
    }

    const syncState = await provider.getSyncState().catch(() => null)

    if (!syncState?.linked) {
      showDropboxMessage('Link Dropbox first.')
      return null
    }

    return new Promise<{ path: string } | null>((resolve) => {
      // The starting folder is captured here (not at render, where reading
      // the ref is illegal): the selected file's parent, else the last
      // session-browsed folder.
      setDropboxBrowserRequest({
        defaultFileName:
          mode === 'upload' && sessionDocumentKindRef.current === 'dropbox-file'
            ? toSuggestedTxtName(syncState.selectedName ?? getDropboxFileName(syncState.selectedPathDisplay))
            : undefined,
        initialFolder:
          getDropboxParentFolder(syncState.selectedPathDisplay) ??
          lastBrowsedDropboxFolderRef.current,
        mode,
        resolve,
      })
    })
  }

  const settleDropboxBrowser = (choice: { path: string } | null) => {
    const request = dropboxBrowserRequest

    setDropboxBrowserRequest(null)

    if (!request) {
      return
    }

    if (choice) {
      const parent = getDropboxParentFolder(choice.path)

      if (parent !== null) {
        lastBrowsedDropboxFolderRef.current = parent
      }
    }

    request.resolve(choice)
  }

  // Keep the Dropbox file browser's filename input above the iOS on-screen
  // keyboard while editing a name.
  // iOS does not shrink `dvh` for the keyboard, so the modal needs both a visual
  // viewport max-height and a small transform for offset/pan cases. Landscape is
  // especially short, so also scroll the dialog content to the focused filename.
  useEffect(() => {
    const viewport = typeof window !== 'undefined' ? window.visualViewport : null

    if (dropboxBrowserRequest === null || !viewport) {
      return undefined
    }

    const root = document.documentElement
    const keyboardClass = 'dropbox-browser-keyboard-up'

    const apply = () => {
      const input = document.getElementById('dropbox-browser-filename')
      const actions = document.querySelector<HTMLElement>('.dropbox-browser-actions')
      root.style.setProperty('--dropbox-browser-viewport-height', `${viewport.height}px`)
      // The on-screen keyboard heuristic mirrors the editor's: the visual
      // viewport is substantially shorter than the layout viewport (scale-
      // corrected so pinch zoom does not trip it).
      const keyboardUp = window.innerHeight - viewport.height * viewport.scale > 150

      if (!input || !keyboardUp || viewport.scale > 1.01) {
        root.classList.remove(keyboardClass)
        root.style.setProperty('--dropbox-browser-shift', '0px')
        return
      }

      root.classList.add(keyboardClass)

      // Undo the shift already applied so the input's NATURAL bottom is measured
      // — otherwise our own transform feeds back into the next calculation.
      const currentShift =
        Number.parseFloat(root.style.getPropertyValue('--dropbox-browser-shift')) || 0
      const protectedElement = actions ?? input

      protectedElement.scrollIntoView?.({ block: 'nearest' })
      const naturalBottom = protectedElement.getBoundingClientRect().bottom - currentShift
      const visibleBottom = viewport.offsetTop + viewport.height
      const overlap = naturalBottom - (visibleBottom - 12)

      root.style.setProperty('--dropbox-browser-shift', overlap > 0 ? `${-overlap}px` : '0px')
    }

    apply()
    viewport.addEventListener('resize', apply)
    viewport.addEventListener('scroll', apply)

    return () => {
      viewport.removeEventListener('resize', apply)
      viewport.removeEventListener('scroll', apply)
      root.classList.remove(keyboardClass)
      root.style.removeProperty('--dropbox-browser-shift')
      root.style.removeProperty('--dropbox-browser-viewport-height')
    }
  }, [dropboxBrowserRequest])

  // The single sanctioned entry point for opening the unlock password dialog. The
  // inline Secret-key field is derived HERE from `fieldEnvelope` (the envelope being
  // unlocked), so no call site can render the dialog without it — the latent bug
  // where a keyless-device open of a `required-v1` file silently dead-ends because a
  // site forgot `secretKeyFieldFor(envelope)`. `fieldEnvelope` may be null (e.g. an
  // absent draft), matching the prior per-site `envelope ? secretKeyFieldFor(...) :
  // undefined` guard. `attempt` is each site's own closure, unchanged: it returns
  // null on success or an error-message string on failure (see runUnlockPasswordDialog).
  // Do not call `runUnlockPasswordDialog` directly outside this helper.
  const openUnlockDialog = (
    title: string,
    fieldEnvelope: string | null,
    attempt: (password: string, secretKeyInput: string | null) => Promise<string | null>,
  ): Promise<boolean> =>
    runUnlockPasswordDialog(
      title,
      attempt,
      fieldEnvelope ? secretKeyFieldFor(fieldEnvelope) : undefined,
    )

  // Runs the unlock password dialog (SPEC §10): a wrong password keeps the
  // dialog open with the failure inside; Cancel resolves false. `attempt`
  // returns null on success or the in-dialog failure text.
  const runUnlockPasswordDialog = (
    title: string,
    attempt: (password: string, secretKeyInput: string | null) => Promise<string | null>,
    secretKeyField?: SecretKeyFieldConfig,
  ) =>
    new Promise<boolean>((resolve) => {
      setUnlockDialogRequest({ attempt, busy: false, error: '', resolve, secretKeyField, title })
    })

  const submitUnlockPassword = async (password: string, secretKeyInput: string | null) => {
    const request = unlockDialogRequest

    if (!request || request.busy) {
      return
    }

    setUnlockDialogRequest({ ...request, busy: true, error: '' })

    const error = await request.attempt(password, secretKeyInput)

    if (error === null) {
      setUnlockDialogRequest(null)
      request.resolve(true)
      return
    }

    setUnlockDialogRequest({ ...request, busy: false, error })
  }

  const cancelUnlockPassword = () => {
    const request = unlockDialogRequest

    // Inert while busy: the Argon2id attempt is not abortable (SPEC §10).
    if (!request || request.busy) {
      return
    }

    setUnlockDialogRequest(null)
    request.resolve(false)
  }

  const requestCreatePassword = (
    title: string,
    initialKdfPolicy: KdfPolicyId,
    secretKey: SecretKeyToggleConfig,
    submitLabel = 'Create',
  ) =>
    new Promise<{ kdfPolicy: KdfPolicyId; password: string; secretKeyOn: boolean } | null>(
      (resolve) => {
        setCreatePasswordRequest({ initialKdfPolicy, resolve, secretKey, submitLabel, title })
      },
    )

  const getSessionKdfPolicy = (): KdfPolicyId | null => {
    const params = sessionKdfParamsRef.current

    if (!params) {
      return DEFAULT_KDF_POLICY_ID
    }

    try {
      return getKdfPolicyIdForParams(params)
    } catch {
      return null
    }
  }

  const confirmStrongKdfPolicy = () => window.confirm(STRONG_KDF_POLICY_CONFIRM)

  const settleCreatePassword = (
    result: { kdfPolicy: KdfPolicyId; password: string; secretKeyOn: boolean } | null,
  ) => {
    const request = createPasswordRequest

    setCreatePasswordRequest(null)
    request?.resolve(result)
  }

  // Creation is local-only (`New draft`); the only remote-creation path is the
  // promotion (uploadToDropbox), which carries the probe → confirm →
  // conditional-replace guard.

  // New draft (SPEC §10): the only creation flow on the locked home — local by
  // design, no destination step (the destination is chosen later, at
  // promotion). Shown only when no draft exists, so there is no overwrite to
  // confirm; the password comes from the two-field create dialog.
  const createNewDraft = async () => {
    // The create-password `Secret key` toggle (SPEC §6/SKT-2): enabled + on by
    // default when a Settings key is configured, otherwise disabled + off.
    const hasAppKey = Boolean(settings.secretKey)
    const created = await requestCreatePassword(
      'Set a password for the new draft',
      settings.kdfPolicy,
      {
        available: hasAppKey,
        initialOn: hasAppKey,
      },
    )

    if (created === null) {
      return
    }

    const { kdfPolicy, password, secretKeyOn } = created

    // Hold the cross-tab lock before writing: creating a draft while another
    // window has one open would overwrite that window's document.
    const hadVaultLock = vaultLockReleaseRef.current !== null

    if (!(await acquireVaultLock())) {
      showMessage(VAULT_IN_USE_MESSAGE)
      return
    }

    setMessage('')
    setSaveStatus('saving')

    try {
      // Apply the Secret key only when the toggle is on (it can only be on when
      // a Settings key is configured) — no automatic promotion (SKT-1/SKT-2).
      const secretKeyBytes = secretKeyOn ? await getConfiguredSecretKeyBytes() : null
      const kdfParams = resolveKdfPolicyParams(kdfPolicy)
      // Explicit key wins over the (not-yet-established) session ref: the toggle's
      // choice is authoritative at create — `null` writes `none`, the configured
      // key writes `required-v1` (SKT-1/SKT-2). No automatic promotion.
      const envelope = await encryptDocument('', password, { kdfParams, secretKeyBytes })

      // The draft session's document identity (SPEC §10): autosaves land in
      // the vault "primary" record — never a Dropbox record's cache.
      if (activeStorageProviderRef.current.kind !== 'draft') {
        setActiveProviderPreservingSession('draft')
      }

      setSessionDocumentKind('draft')
      await activeStorageProviderRef.current.save(envelope)

      refreshStorageStatus().catch(() => undefined)
      passwordRef.current = password
      sessionSecretKeyBytesRef.current = secretKeyBytes
      sessionKdfParamsRef.current = kdfParams
      plaintextRef.current = ''
      lastSavedPlaintextRef.current = ''
      isReadOnlyRef.current = false
      setIsReadOnly(false)
      setSavedEnvelope(envelope)
      setHasDraft(true)
      setPlaintext('')
      setIsUnlocked(true)
      setSaveStatus('saved')
      setHasSavedThisSession(false)
    } catch {
      if (!hadVaultLock) {
        releaseVaultLock()
      }

      setSaveStatus('error')
      showMessage('Unable to create the draft.')
    }
  }

  // The draft unlock dialog (SPEC §10): switching to the draft provider
  // first fixes the session's document identity, exactly like the auth-lost
  // unlock path. Shared by Edit draft and the post-import auto-open.
  const openDraftUnlockDialog = async () => {
    if (activeStorageProviderRef.current.kind !== 'draft') {
      setActiveProviderPreservingSession('draft')
    }

    setSessionDocumentKind('draft')
    setMessage('')

    // Read once up front to decide whether the unlock dialog shows the inline
    // Secret-key field (SKT-4); the attempt re-reads to catch a concurrent write.
    const draftEnvelope = (await vaultStore.getVault())?.envelope ?? null

    await openUnlockDialog(
      'Unlock draft',
      draftEnvelope,
      async (password, secretKeyInput) => {
        try {
          const envelope = (await vaultStore.getVault())?.envelope ?? null

          if (!envelope) {
            return 'Could not unlock. Check the password or file.'
          }

          await unlockEnvelope(envelope, password, secretKeyInput)
          return null
        } catch (error) {
          clearSecrets()
          return getUnlockFailureMessage(error)
        }
      },
    )
  }

  // Edit draft (SPEC §10): the single-field unlock dialog over the draft.
  const editDraft = async () => {
    if (!hasDraft) {
      return
    }

    await openDraftUnlockDialog()
  }

  // Read-only is document state carried inside the encrypted envelope, not an
  // app setting: toggling re-encrypts the current plaintext with the flag
  // flipped and saves immediately, so it persists across sessions and devices.
  // A failed save reverts the toggle. The follow-up save handles the rare case
  // where the first call coalesced into an in-flight save that had already
  // encrypted under the previous flag.
  const toggleReadOnly = async () => {
    if (isAppReadOnlySessionRef.current) {
      showMessage('Dropbox is unlinked. This cached file is read-only.', 'info')
      return
    }

    const next = !isReadOnlyRef.current

    isReadOnlyRef.current = next
    setIsReadOnly(next)

    let result = await saveCurrentPlaintextRef.current({
      trigger: 'manual',
      waitForInFlight: true,
    })

    if (result.ok && isEnvelopeReadOnly(parseEnvelope(result.envelope)) !== next) {
      result = await saveCurrentPlaintextRef.current({
        trigger: 'manual',
        waitForInFlight: true,
      })
    }

    if (!result.ok) {
      isReadOnlyRef.current = !next
      setIsReadOnly(!next)
      return
    }

    showMessage(next ? 'Read-only on.' : 'Read-only off.', 'info')
  }

  // Change Password (SPEC §10): rotate the current document's password in place,
  // writing to wherever autosave saves (a draft, a Dropbox file, or
  // the bound local file) — never Export to Files. Mirrors toggleReadOnly: swap the
  // session password, force an immediate in-place save, and revert on failure. It
  // does not rebind the session or create a copy, and it stays in the editor. The
  // success notice shows in the save-status line ("Password changed").
  const changePassword = async () => {
    if (!isUnlocked || !passwordRef.current) {
      return
    }

    if (isAppReadOnlySessionRef.current) {
      showMessage('Dropbox is unlinked. This cached file is read-only.', 'info')
      return
    }

    // The Change Password `Secret key` toggle (SPEC §6/SKT-3): default = the
    // document's CURRENT mode (on iff the session holds key bytes), enabled when
    // a key is available — a Settings key, or the session's own unlock key (a
    // keyless device that opened a `required-v1` file).
    const sessionHasKey = sessionSecretKeyBytesRef.current !== null
    const currentKdfPolicy = getSessionKdfPolicy()

    if (currentKdfPolicy === null) {
      showMessage('Could not change the password.')
      return
    }

    const created = await requestCreatePassword(
      'Set a new password',
      currentKdfPolicy,
      { available: Boolean(settings.secretKey) || sessionHasKey, initialOn: sessionHasKey },
      'OK',
    )

    if (created === null) {
      // Cancelled (a mismatched confirmation never submits) — leave the document
      // exactly as it was.
      window.setTimeout(() => editorRef.current?.focus(), 0)
      return
    }

    const { kdfPolicy, password: next, secretKeyOn } = created

    // Auto-lock can fire while the dialog is open (no window activity events).
    // SPEC §10: the rotation aborts with nothing rewritten.
    if (!passwordRef.current) {
      return
    }

    // The new write policy from the toggle: on → reuse the session's key bytes
    // (the key the file was unlocked with) or fall back to the Settings key;
    // off → none (downgrade to password-only). Toggle-on always has a key
    // available (the enable rule guarantees it).
    let nextSecretKeyBytes: Uint8Array | null
    try {
      nextSecretKeyBytes = secretKeyOn
        ? (sessionSecretKeyBytesRef.current ?? (await getConfiguredSecretKeyBytes()))
        : null
    } catch {
      // A corrupt stored Settings key would otherwise reject as an unhandled
      // promise (the caller is `void changePassword()`) with the dialog already
      // closed. The throw precedes the ref swap, so the session is still intact —
      // just notify and bail; no rollback needed.
      showMessage('Could not change the password.')
      return
    }

    // Auto-lock can fire during the await above; abort with nothing revived
    // (SPEC §10) — mirrors the post-await guard in saveAsEncryptedFile.
    if (!passwordRef.current) {
      return
    }

    const previousPassword = passwordRef.current
    const previousSecretKeyBytes = sessionSecretKeyBytesRef.current
    const previousKdfParams = sessionKdfParamsRef.current
    const nextKdfParams = resolveKdfPolicyParams(kdfPolicy)
    // If an autosave is mid-flight it is encrypting under the previous
    // password/Secret-key mode/KDF params; the forced save below coalesces into
    // it, so we save once more afterward to guarantee the document ends up under
    // the new ones.
    const coalesced = Boolean(activeSavePromiseRef.current)
    passwordRef.current = next
    sessionSecretKeyBytesRef.current = nextSecretKeyBytes
    sessionKdfParamsRef.current = nextKdfParams

    let result = await saveCurrentPlaintextRef.current({
      trigger: 'manual',
      waitForInFlight: true,
    })

    if (result.ok && coalesced) {
      result = await saveCurrentPlaintextRef.current({
        trigger: 'manual',
        waitForInFlight: true,
      })
    }

    if (!result.ok) {
      // The write failed, so the durable file still has the old password,
      // Secret-key mode, and KDF params. Roll all three back atomically (SKT-3),
      // or later autosaves would write protection the file never adopted.
      passwordRef.current = previousPassword
      sessionSecretKeyBytesRef.current = previousSecretKeyBytes
      sessionKdfParamsRef.current = previousKdfParams
      // `nextSecretKeyBytes` was never durably adopted; zero it unless it aliases
      // the restored live ref (toggle-on reusing the session key reuses the same
      // buffer) — never zero the array now back in the session ref.
      if (nextSecretKeyBytes && nextSecretKeyBytes !== previousSecretKeyBytes) {
        nextSecretKeyBytes.fill(0)
      }
      showMessage('Could not change the password.')
      return
    }

    // The rotation stuck: the old key is no longer the live ref. Zero it unless it
    // aliases the new live ref (toggle-on reuse keeps the same buffer) — never zero
    // the array currently assigned to sessionSecretKeyBytesRef.current.
    if (previousSecretKeyBytes && previousSecretKeyBytes !== nextSecretKeyBytes) {
      previousSecretKeyBytes.fill(0)
    }

    setPasswordChangedNotice(true)
    window.setTimeout(() => setPasswordChangedNotice(false), 5000)
    window.setTimeout(() => editorRef.current?.focus(), 0)
  }

  const deleteVaultNow = async () => {
    setIsDeleteVaultConfirmOpen(false)

    try {
      // Same cross-tab guard as the other primary-vault replacement flows:
      // refuse while another window has the vault unlocked.
      const result = await runReplacingPrimaryVault(async () => {
        await vaultStore.clearVault()
        return 'deleted' as const
      })

      if (result === 'vault-in-use') {
        showMessage(VAULT_IN_USE_MESSAGE)
        return
      }

      setSavedEnvelope(null)
      setHasDraft(false)
      setSaveStatus('idle')
      refreshStorageStatus().catch(() => undefined)
      showMessage('Draft deleted.', 'info')
    } catch {
      showMessage('Could not delete the draft.')
    }
  }

  // No home screen carries a password field any more (SPEC §10/§17):
  // the Local File home's Open/Browse below collect the password in the
  // unlock dialog, exactly like the Dropbox block's Open and Edit draft.

  // Local File `Open` (SPEC §2): read the selected recent file first (file
  // before password, like everywhere else), then the unlock password dialog.
  // Read/permission failures surface on the home; a wrong password keeps the
  // dialog open with the failure inside.
  const unlockSelectedLocalFile = async () => {
    const selectedLocalFileRecord = getActiveLocalFileRecord()

    if (!selectedLocalFileRecord) {
      showLocalMessage('Choose a recent file or browse for one.')
      return
    }

    setMessage('')
    setSaveStatus('idle')

    let envelope: string

    try {
      envelope = await localFileProvider.loadWithPermission(selectedLocalFileRecord)

      if (activeStorageProviderRef.current.kind !== 'local-file') {
        setActiveProviderPreservingSession('local-file')
      }

      setSessionDocumentKind('local-file')
      dropboxFileSessionKeyRef.current = null
      setDropboxSessionPaused(false)
      await refreshLocalFileRecords()
      await refreshStorageStatus()
    } catch (error) {
      await publishLocalFileUnlockDiagnostic('open-recent', 'action-failed', null, error)
      showUnlockFailure(error)
      return
    }

    await openUnlockDialog(
      'Unlock local file',
      envelope,
      async (password, secretKeyInput) => {
        try {
          await unlockEnvelope(envelope, password, secretKeyInput)
          await publishLocalFileUnlockDiagnostic('open-recent', 'decrypt-ok', envelope)
          return null
        } catch (error) {
          await publishLocalFileUnlockDiagnostic('open-recent', 'decrypt-failed', envelope, error)
          clearSecrets()
          return getUnlockFailureMessage(error)
        }
      },
    )
  }

  const importEncryptedFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    clearFileInput(event)

    if (!file) {
      return
    }

    try {
      const envelope = await file.text()
      parseEnvelope(envelope)

      // Importing touches ONLY the draft (SPEC §10): Dropbox files, their
      // caches, and the link state are not involved, so no disconnect or
      // unsynced-Dropbox guard applies. When a draft already exists, confirm
      // AFTER the file was picked, never before.
      const existingDraft = (await vaultStore.getVault())?.envelope ?? null

      if (existingDraft && existingDraft !== envelope) {
        if (!window.confirm('Replace the draft?')) {
          // Canceled — no message (a non-event, like canceling the file picker).
          return
        }
      }

      // The write is held under the cross-tab vault lock so a second window
      // editing the draft is not clobbered. Written directly to the
      // vault — never through a provider save, so importing never uploads.
      const importResult = await runReplacingPrimaryVault(async () => {
        await vaultStore.saveEnvelope(envelope)
        return 'imported' as const
      })

      if (importResult === 'vault-in-use') {
        showMessage(VAULT_IN_USE_MESSAGE)
        return
      }

      setActiveProviderPreservingSession('draft')
      setHasDraft(true)
      await refreshStorageStatus()
      await refreshDropboxState()

      clearSecrets()
      setSavedEnvelope(envelope)
      setIsUnlocked(false)
      setSaveStatus('idle')

      // The import actually happened — confirm it (shown on the home if the
      // user cancels the unlock dialog that opens next).
      showMessage('Draft imported.', 'info')

      // SPEC §10 import step 5: open the unlock dialog for the imported
      // draft directly; cancelling keeps it locked for a later Edit draft.
      await openDraftUnlockDialog()
    } catch {
      showMessage('That file is not a valid eNoteWeb encrypted file.')
    }
  }

  // Starts the OAuth redirect. Account switching uses Dropbox reauthentication;
  // reapproval alone only shows consent for the same signed-in Dropbox session.
  const linkDropbox = async (options: DropboxLinkOptions = {}) => {
    const provider = getDropboxProvider()

    if (!provider) {
      return
    }

    setMessage('')

    try {
      await provider.beginLink(options)
    } catch {
      showDropboxMessage('Unable to start Dropbox linking.')
      await refreshStorageStatus().catch(() => undefined)
    }
  }

  // The bare Link button. When a retained grant exists for the remembered
  // account, ask whether to Continue with it or Switch. With no retained grant
  // (even if recent files still exist), go straight to OAuth; a different
  // returned account is confirmed only after Dropbox sends it back.
  const beginLinkOrPromptAccount = () => {
    const previousAccount = dropboxSyncState?.accountLabel ?? null

    if (previousAccount && dropboxSyncState?.hasRetainedAuth) {
      setMessage('')
      setLinkContinuePrompt(previousAccount)
      return
    }

    void linkDropbox()
  }

  const chooseDropboxFile = async () => {
    const provider = getDropboxProvider()

    if (!provider) {
      return
    }

    const choice = await openDropboxBrowser('choose')

    if (!choice) {
      return
    }

    const dropboxPath = choice.path

    try {
      // Selecting a file writes its OWN record and cache: nothing is discarded
      // — every recent file keeps its state — and the primary vault (the draft)
      // is untouched, so no discard warning or cross-tab vault lock applies
      // (SPEC §9: no discard warning exists in this flow). The pull still runs
      // inside one exclusive Dropbox op against concurrent syncs.
      const selectedEnvelope = await runExclusiveDropboxOp(() =>
        provider.selectRemoteFile(dropboxPath),
      )

      // Opening a Dropbox file connects to it; make Dropbox the active provider
      // (session preserved) so subsequent autosave/sync target it.
      if (activeStorageProviderRef.current.kind !== 'dropbox') {
        setActiveProviderPreservingSession('dropbox')
      }

      setSessionDocumentKind('dropbox-file')
      clearSecrets()
      setSavedEnvelope(selectedEnvelope)
      setIsUnlocked(false)
      setSaveStatus('idle')
      await refreshStorageStatus()
      await refreshDropboxRecentFiles()

      // Selection flows straight into the unlock password dialog — no detour
      // through the home screen (SPEC §9). A wrong password retries inside
      // the dialog; Cancel keeps the newly selected file locked.
      const unlocked = await openUnlockDialog(
        'Unlock Dropbox file',
        selectedEnvelope,
        async (password, secretKeyInput) => {
          try {
            // Re-read at unlock time, mirroring unlockVault: another window may
            // have written a newer envelope since the selection. The read goes
            // through the Dropbox provider (the selected record's bytes) — the
            // vault holds the draft, a separate document.
            const dropbox = getDropboxProvider()
            const envelope =
              (dropbox ? await dropbox.loadLocalEnvelope() : null) ?? selectedEnvelope

            await unlockEnvelope(envelope, password, secretKeyInput)
            return null
          } catch (error) {
            clearSecrets()
            return getUnlockFailureMessage(error)
          }
        },
      )

      if (!unlocked) {
        showDropboxMessage('File selected. Unlock it with its password.', 'info')
      }
    } catch {
      showDropboxMessage('Unable to choose that .txt file.')
      await refreshStorageStatus().catch(() => undefined)
    }
  }

  // Documents are created locally (`New draft`) and reach Dropbox only via the
  // promotion; there is no blank-Dropbox-file creation flow.

  // Unsynced caches survive an unlink but cannot sync until a later link; name
  // that consequence only when it actually applies.
  const hasUnsyncedDropboxCache =
    dropboxRecentFiles?.files.some((file) => file.hasUnsyncedChanges) ?? false

  // Unlink confirms only when unsynced caches need naming; otherwise the
  // Settings button performs the pause directly.
  const requestUnlinkDropbox = () => {
    setIsHomeSettingsOpen(false)

    if (!hasUnsyncedDropboxCache) {
      void performUnlinkDropbox()
      return
    }

    setIsUnlinkConfirmOpen(true)
  }

  const performUnlinkDropbox = async () => {
    setIsUnlinkConfirmOpen(false)

    const provider = getDropboxProvider()

    if (!provider) {
      return
    }

    // Through the shared queue: unlinking mid-sync (e.g. during the online
    // listener's syncNow) could otherwise clear auth state under an in-flight
    // upload, or let that sync re-persist state after the unlink.
    try {
      await runExclusiveDropboxOp(() => provider.unlink())
    } catch {
      showDropboxMessage('Could not unlink Dropbox. Try again.')
      await refreshStorageStatus().catch(() => undefined)
      return
    }

    // Unlink succeeded — these are best-effort UI refreshes; a failure here is
    // not an unlink failure and must not be reported as one.
    // Indicators are session memory tied to the link (SPEC §9): the next
    // link starts with a fresh check.
    setRecentFileIndicators(new Map())
    staleRecentKeysRef.current.clear()
    await refreshStorageStatus().catch(() => undefined)
    await refreshDropboxRecentFiles().catch(() => undefined)
    showDropboxMessage('Dropbox unlinked.', 'info')
  }

  // The Home Dropbox block's manual Sync. The background check
  // otherwise runs only on entering the Home screen and on regaining
  // connectivity; this forces it on demand — sync the selected file (adopting a
  // clean remote, as the on-Home pass does), re-check every recent row's
  // revision, then refresh the table and sync state.
  const syncDropboxHome = async () => {
    const provider = getDropboxProvider()

    if (!provider) {
      return
    }

    if (globalThis.navigator?.onLine === false) {
      showDropboxMessage('Offline.')
      return
    }

    setMessage('')

    try {
      const beforeRecents = await provider.getRecentFiles().catch(() => null)
      const status = await runExclusiveDropboxOp(async () => {
        if (!(await provider.hasSelectedRemote())) {
          return null
        }

        return provider.syncNow({ adoptCleanRemote: true })
      })

      if (status && activeStorageProviderRef.current.kind === 'dropbox') {
        setStorageStatus(status)
      }

      const recents = await provider.getRecentFiles()
      let changed = didDropboxRecentsChange(beforeRecents, recents)

      for (const file of recents.files) {
        try {
          const outcome = await runExclusiveDropboxOp(() => provider.checkRecentFile(file.key))

          changed = applyRecentCheckOutcome(file.key, outcome) || changed
        } catch {
          // Per-record failure leaves that row's indicator unchanged (SPEC §9).
        }
      }

      const refreshed = await provider.getRecentFiles().catch(() => null)

      if (refreshed) {
        setDropboxRecentFiles(refreshed)
      }

      changed = didDropboxRecentsChange(recents, refreshed) || changed

      const syncState = await provider.getSyncState().catch(() => null)

      if (syncState) {
        setDropboxSyncState(syncState)
      }

      showDropboxMessage(changed ? 'Sync complete.' : 'Up to date.', 'info')
    } catch {
      showDropboxMessage('Sync failed.')
      await refreshStorageStatus().catch(() => undefined)
    }
  }

  // ---- Home Dropbox block (SPEC §9) ----

  const selectRecentRow = (key: string) => {
    // Optimistic: the table reflects the tap immediately; the persisted
    // selection ("memorized like a settings value", SPEC §9) follows.
    setDropboxRecentFiles((current) => (current ? { ...current, selectedKey: key } : current))

    const provider = getDropboxProvider()

    void provider?.setSelectedRecentFile(key).catch(() => undefined)
  }

  // Home `Open` (SPEC §9): the selected row's freshest local bytes → unlock
  // password dialog → editor. An uncached row downloads first (online only).
  // A row KNOWN stale-but-clean (the check classified it but could not
  // refresh) refreshes by download before the password dialog — the visible
  // loading moment is acceptable; an unknown-freshness row opens immediately
  // from cache and the session's first-sync gate probe (below) takes over.
  // `resolveConflictAfterUnlock` is the home `Resolve` entry: straight into
  // the merge flow once the password is collected.
  const openSelectedRecentFile = async (
    options: {
      forceCachedReadOnly?: boolean
      keyOverride?: string
      resolveConflictAfterUnlock?: boolean
    } = {},
  ) => {
    const provider = getDropboxProvider()
    const selectedKey = options.keyOverride ?? dropboxRecentFiles?.selectedKey ?? null
    const selectedFile =
      dropboxRecentFiles?.files.find((file) => file.key === selectedKey) ?? null

    if (!provider || !selectedKey) {
      return
    }

    const opensAppReadOnly =
      options.forceCachedReadOnly === true ||
      (!dropboxSyncState?.linked &&
        !dropboxSyncState?.authLost &&
        !dropboxSyncState?.pendingAccountSwitch)

    if (opensAppReadOnly && !selectedFile?.hasCache) {
      showDropboxMessage('No cached copy is available.')
      return
    }

    setMessage('')
    // The background check loop must not refresh this row's cache between
    // the read below and the unlock dialog's decrypt.
    openingRecentKeyRef.current = selectedKey

    try {
      if (
        !opensAppReadOnly &&
        staleRecentKeysRef.current.has(selectedKey) &&
        globalThis.navigator?.onLine !== false
      ) {
        try {
          const outcome = await runExclusiveDropboxOp(() =>
            provider.checkRecentFile(selectedKey),
          )

          applyRecentCheckOutcome(selectedKey, outcome)
        } catch {
          // The cached bytes still open; the next pass retries the refresh.
        }
      }

      let envelope: string | null = null

      try {
        envelope = options.forceCachedReadOnly
          ? await runExclusiveDropboxOp(() => provider.exportRecentFileCopy(selectedKey))
          : await runExclusiveDropboxOp(() => provider.openRecentFile(selectedKey))
      } catch (error) {
        if (error instanceof DropboxProviderError && error.code === 'offline') {
          showDropboxMessage('Offline. No cache exists.')
        } else {
          showDropboxMessage('Unable to open that file.')
        }

        await refreshStorageStatus().catch(() => undefined)
        return
      }

      if (envelope === null) {
        showDropboxMessage('That file is no longer in the recent list.')
        await refreshDropboxRecentFiles()
        return
      }

      // Opening a Dropbox file makes Dropbox the active provider (session
      // preserved) so autosave/sync target it.
      if (activeStorageProviderRef.current.kind !== 'dropbox') {
        setActiveProviderPreservingSession('dropbox')
      }

      setSessionDocumentKind('dropbox-file')
      clearSecrets()
      setSavedEnvelope(envelope)
      setIsUnlocked(false)
      setSaveStatus('idle')
      await refreshStorageStatus()
      await refreshDropboxRecentFiles()

      const unlocked = await openUnlockDialog(
        'Unlock Dropbox file',
        envelope,
        async (password, secretKeyInput) => {
          try {
            // Re-read at unlock time, mirroring unlockVault: another window may
            // have written newer bytes since the open.
            const fresh = (await provider.loadLocalEnvelope()) ?? envelope

            await unlockEnvelope(fresh, password, secretKeyInput)
            return null
          } catch (error) {
            clearSecrets()
            return getUnlockFailureMessage(error)
          }
        },
      )

      if (!unlocked) {
        showDropboxMessage('File selected. Unlock it with its password.', 'info')
        return
      }

      setAppReadOnlySession(opensAppReadOnly)
      dropboxFileSessionKeyRef.current = opensAppReadOnly ? null : selectedKey

      if (options.resolveConflictAfterUnlock) {
        // Home Resolve (SPEC §9): the password is in hand — enter the merge.
        // One macrotask first, so the unlocked session has rendered and the
        // save closure (saveCurrentPlaintextRef's layout effect) was rebound:
        // the merge flow's pre-flush must save through the UNLOCKED path, not
        // the locked closure this continuation still sees.
        await new Promise((resolve) => window.setTimeout(resolve, 0))

        if (dropboxFileSessionKeyRef.current === selectedKey && passwordRef.current) {
          startConflictResolve()
        }

        return
      }

      // First-sync gate probe (SPEC §9): purely informational for the open
      // session — it never swaps the cache (refreshStaleCache: false). A
      // remote change pauses pushing and shows the paused message; the
      // push's own revision-conditional rejection covers the window before
      // this lands.
      if (opensAppReadOnly) {
        return
      }

      void runExclusiveDropboxOp(() =>
        provider.checkRecentFile(selectedKey, { refreshStaleCache: false }),
      )
        .then((outcome) => {
          if (dropboxFileSessionKeyRef.current !== selectedKey) {
            return
          }

          if (outcome.kind === 'stale' || outcome.kind === 'diverged') {
            setDropboxSessionPaused(true)
          }
        })
        .catch(() => undefined)
    } finally {
      openingRecentKeyRef.current = null
    }
  }

  const resolveReplacementCandidate = async (selectedKey: string) => {
    const provider = getDropboxProvider()

    if (!provider) {
      return
    }

    const confirmed = window.confirm(
      'A different file exists under the same name at this path. Do you want to adopt it?',
    )

    if (!confirmed) {
      await openSelectedRecentFile({ forceCachedReadOnly: true, keyOverride: selectedKey })
      return
    }

    setMessage('')

    let outcome: DropboxRecentFileCheck

    try {
      outcome = await runExclusiveDropboxOp(() => provider.adoptReplacementCandidate(selectedKey))
    } catch {
      showDropboxMessage('Could not check Dropbox.')
      return
    }

    const refreshed = await provider.getRecentFiles().catch(() => null)

    if (refreshed) {
      setDropboxRecentFiles(refreshed)
    }

    const adoptedKey = refreshed?.selectedKey ?? selectedKey

    if (adoptedKey !== selectedKey) {
      staleRecentKeysRef.current.delete(selectedKey)
      setRecentFileIndicators((current) => {
        if (!current.has(selectedKey)) {
          return current
        }

        const next = new Map(current)

        next.delete(selectedKey)
        return next
      })
    }

    applyRecentCheckOutcome(adoptedKey, outcome)

    try {
      const syncState = await provider.getSyncState()

      setDropboxSyncState(syncState)
    } catch {
      // Storage-status refresh below still runs.
    }

    await refreshStorageStatus().catch(() => undefined)

    if (outcome.kind === 'diverged') {
      await openSelectedRecentFile({
        keyOverride: adoptedKey,
        resolveConflictAfterUnlock: true,
      })
      return
    }

    if (outcome.kind === 'refreshed' || outcome.kind === 'up-to-date') {
      await openSelectedRecentFile({ keyOverride: adoptedKey })
      return
    }

    if (outcome.kind === 'missing') {
      showDropboxMessage('File not found.')
      return
    }

    showDropboxMessage('Could not check Dropbox.')
  }

  // Home `Resolve` on a diverged row (SPEC §9): capture the conflict state
  // for the selected record (the provider's existing syncNow conflict
  // pathway downloads and records the remote snapshot), then collect the
  // password in the unlock dialog, then enter the merge flow directly.
  const resolveSelectedRecentFile = async () => {
    const provider = getDropboxProvider()
    const selectedKey = dropboxRecentFiles?.selectedKey ?? null

    if (!provider || !selectedKey) {
      return
    }

    if (recentFileIndicators.get(selectedKey) === 'replacement-candidate') {
      await resolveReplacementCandidate(selectedKey)
      return
    }

    setMessage('')

    try {
      // One queued op, selection first: the conflict snapshot is account-level
      // (transitional, SPEC §8), so it must be captured for THIS row. The row
      // tap's fire-and-forget selection write may not have landed yet, and
      // persisting the selection also clears any conflict fields a previously
      // selected file left behind — a stale remote snapshot must never reach
      // this row's merge. Home context: a stale-but-clean race resolves by
      // adopting the remote instead of capturing a conflict.
      await runExclusiveDropboxOp(async () => {
        await provider.setSelectedRecentFile(selectedKey)
        await provider.syncNow({ adoptCleanRemote: true })
      })
    } catch {
      // The sync-state read below decides how to continue.
    }

    let hasConflict = false

    try {
      const syncState = await provider.getSyncState()

      setDropboxSyncState(syncState)
      hasConflict =
        syncState.hasRemoteConflictEnvelope || syncState.lastSyncStatus === 'conflict'
    } catch {
      // Treated as no captured conflict; the plain open below still works.
    }

    if (!hasConflict) {
      // The divergence resolved itself (the pending side flushed cleanly, or
      // the remote moved back): clear the indicator and open normally.
      applyRecentCheckOutcome(selectedKey, { kind: 'up-to-date' })
      await refreshDropboxRecentFiles()
      await openSelectedRecentFile()
      return
    }

    await openSelectedRecentFile({ resolveConflictAfterUnlock: true })
  }

  // Row menu `Delete from list` (SPEC §9): record and cache go together; the
  // Dropbox file itself is never touched.
  const deleteRecentFromList = async (key: string) => {
    const provider = getDropboxProvider()
    const file = dropboxRecentFiles?.files.find((candidate) => candidate.key === key)

    if (!provider || !file) {
      return
    }

    const confirmed = window.confirm(
      file.hasUnsyncedChanges
        ? 'This file has local changes not yet on Dropbox. Remove anyway? The unsynced changes are lost.'
        : 'Remove from recent files? This deletes the browser-local cached copy. The Dropbox file is not deleted.',
    )

    if (!confirmed) {
      return
    }

    try {
      await runExclusiveDropboxOp(() => provider.removeRecentFile(key))
      showDropboxMessage('Removed from recent files.', 'info')
    } catch {
      showDropboxMessage('Could not remove the file from the list.')
    }

    await refreshDropboxRecentFiles()
    await refreshStorageStatus().catch(() => undefined)
  }

  // Per-row Export for the authorization-lost state (SPEC §9): the cached
  // ciphertext goes to Files with no password step.
  const exportSelectedRecentFile = async () => {
    const provider = getDropboxProvider()
    const selectedKey = dropboxRecentFiles?.selectedKey ?? null
    const selectedFile =
      dropboxRecentFiles?.files.find((file) => file.key === selectedKey) ?? null

    if (!provider || !selectedKey || !selectedFile) {
      return
    }

    try {
      const outcome = await exportEncryptedCopy({
        getEnvelope: async () => provider.exportRecentFileCopy(selectedKey),
        suggestedName: selectedFile.name,
      })

      if (outcome === 'saved') {
        showMessage('Encrypted copy saved.', 'info')
      }
    } catch {
      showMessage('Could not prepare the encrypted copy for download.')
    }
  }

  // The account-switch guard's blocking choice (SPEC §9): discard the previous
  // account's recents and continue, or cancel (unlink again, data kept).
  const resolveAccountSwitch = async (action: 'adopt' | 'decline') => {
    const provider = getDropboxProvider()
    const pendingId = dropboxSyncState?.pendingAccountSwitch ?? null

    if (!provider || !pendingId) {
      return
    }

    try {
      if (action === 'adopt') {
        await runExclusiveDropboxOp(() => provider.adoptLinkedAccountDiscardingRecents(pendingId))
        showDropboxMessage('Continuing with the new Dropbox account.', 'info')
      } else {
        await runExclusiveDropboxOp(() => provider.declineLinkedAccount())
        showDropboxMessage("Dropbox unlinked. The previous account's files are kept.", 'info')
      }
    } catch {
      showDropboxMessage('Could not resolve the Dropbox account switch.')
    }

    // Either way the previous indicators no longer describe the table —
    // adopt wiped the records, decline hid them behind the unlinked block.
    setRecentFileIndicators(new Map())
    staleRecentKeysRef.current.clear()

    try {
      setDropboxSyncState(await provider.getSyncState())
    } catch {
      // Status refresh below still runs.
    }

    await refreshDropboxRecentFiles()
    await refreshStorageStatus().catch(() => undefined)
  }

  const pendingDropboxAccountLabel =
    dropboxSyncState?.pendingAccountSwitchLabel ??
    dropboxSyncState?.pendingAccountSwitch ??
    'the new Dropbox account'

  // Cancel on the one-time ownership confirmation (SPEC §9): unlink again;
  // nothing was discarded either way.
  const declineOwnershipNotice = async () => {
    setShowOwnershipNotice(false)

    const provider = getDropboxProvider()

    if (!provider) {
      return
    }

    try {
      await runExclusiveDropboxOp(() => provider.declineLinkedAccount())
    } catch {
      // The sync-state refresh below reflects whatever state remains.
    }

    try {
      setDropboxSyncState(await provider.getSyncState())
    } catch {
      // Status refresh below still runs.
    }

    await refreshStorageStatus().catch(() => undefined)
  }

  // The editor Resolve banner's entry point for conflict resolution. It must
  // CAPTURE the conflict first, then enter the merge —
  // mirroring the home `resolveSelectedRecentFile`. The banner is driven by the
  // session's stored sync state (first-sync-gate `isDropboxSessionPaused`, a
  // `diverged` background result, or a 409-captured `conflict`); for a paused/
  // diverged session no conflict snapshot has been persisted yet, so a plain
  // `startConflictResolve` would find nothing to merge (`loadConflictEnvelopes`
  // returns null without a conflict signal). We therefore flush the latest
  // edits, run `syncNow()` to capture the conflict (download + record the
  // remote snapshot), and only then open the merge flow.
  const resolveEditorConflict = async () => {
    const provider = getDropboxProvider()

    if (!provider) {
      return
    }

    // Offline: resolution needs a connection (the banner already says so).
    // Editing continues and autosave keeps writing the cache only (paused), so
    // nothing is lost; Export stays reachable for an offline copy.
    if (globalThis.navigator?.onLine === false) {
      showMessage('Resolving needs a connection. Your changes are saved locally and Export still works.')
      return
    }

    // A 409-captured conflict (storageStatus === 'conflict') already has the
    // remote snapshot recorded, so the merge can open directly. A paused/
    // diverged session has NOT captured it yet — capture first.
    if (hasDropboxConflict) {
      startConflictResolve()
      return
    }

    // Flush the latest keystrokes so the captured local side is current, then
    // capture the conflict. No adoptCleanRemote: this is the open editor
    // session, and a stale-but-clean adoption would swap cache/baseRev
    // underneath it (SPEC §9) — a genuine divergence surfaces as a conflict.
    const needsSave =
      isUnlocked &&
      (Boolean(activeSavePromiseRef.current) || plaintextRef.current !== lastSavedPlaintextRef.current)

    if (needsSave) {
      const saveResult = await saveCurrentPlaintextRef.current({
        trigger: 'manual',
        waitForInFlight: true,
      })

      if (!saveResult.ok) {
        showMessage('Could not save your latest changes before resolving.')
        return
      }
    }

    let status
    try {
      status = await runExclusiveDropboxOp(() => provider.syncNow())
    } catch {
      showMessage('Could not check Dropbox. Your local changes are saved and will retry.')
      const refreshed = await provider.getSyncState().catch(() => null)
      if (refreshed) {
        setDropboxSyncState(refreshed)
      }
      return
    }

    if (activeStorageProviderRef.current.kind === 'dropbox') {
      setStorageStatus(status)
    }
    const synced = await provider.getSyncState().catch(() => null)
    if (synced) {
      setDropboxSyncState(synced)
    }

    if (status.state === 'conflict') {
      // The conflict is now captured: enter the merge flow directly.
      startConflictResolve()
      return
    }

    // syncNow did NOT capture a conflict — but for a stale-but-CLEAN open session
    // it deliberately does NOT adopt the newer remote (swapping an open editor's
    // cache/baseRev is unsafe, SPEC §9), so the file can still be remotely changed
    // even though no conflict was recorded. Re-probe (no cache refresh): only lift
    // the pause when the file is genuinely back in sync. If it is still stale/
    // diverged, keep the banner and tell the user the newer version loads on
    // reopen (the next home pass adopts the clean remote) — NEVER silently clear
    // the banner while the editor still shows stale content.
    const sessionKey = dropboxFileSessionKeyRef.current
    const recheck = sessionKey
      ? await runExclusiveDropboxOp(() =>
          provider.checkRecentFile(sessionKey, { refreshStaleCache: false }),
        ).catch(() => null)
      : null

    if (recheck && (recheck.kind === 'stale' || recheck.kind === 'diverged')) {
      setDropboxSessionPaused(true)
      showMessage('This file changed on Dropbox. Exit and reopen to load the newer version.')
      return
    }

    // Genuinely back in sync (the remote matched the local cache, or the situation
    // resolved): lift the pause so the banner clears and pushes resume.
    setDropboxSessionPaused(false)
    showMessage(
      status.state === 'error' ? status.detail : 'Dropbox is back in sync.',
      status.state === 'error' ? 'error' : 'info',
    )
  }

  const exportLocalConflictCopy = async () => {
    const provider = getSyncProvider()

    if (!provider) {
      showMessage('No encrypted local conflict copy is available.')
      return
    }

    try {
      const outcome = await exportEncryptedCopy({
        getEnvelope: () => provider.exportLocalConflictCopy(),
        suggestedName: LOCAL_CONFLICT_EXPORT_FILE_NAME,
      })

      if (outcome === 'unavailable') {
        showMessage('No encrypted local conflict copy is available.')
        return
      }

      if (outcome === 'canceled') {
        return
      }

      showMessage('Encrypted local conflict copy exported.', 'info')
    } catch {
      showMessage('Could not export the encrypted local conflict copy.')
    }
  }

  const exportRemoteConflictCopy = async () => {
    const provider = getSyncProvider()

    if (!provider) {
      showMessage('No encrypted remote copy is available yet.')
      return
    }

    try {
      const outcome = await exportEncryptedCopy({
        getEnvelope: () => provider.exportRemoteConflictCopy(),
        suggestedName: REMOTE_CONFLICT_EXPORT_FILE_NAME,
      })

      if (outcome === 'unavailable') {
        showMessage('No encrypted remote copy is available yet.')
        return
      }

      if (outcome === 'canceled') {
        return
      }

      showMessage('Encrypted remote copy exported.', 'info')
    } catch {
      showMessage('Could not export the encrypted remote copy.')
    }
  }

  // Applies a committed (clean-merged or resolved) plaintext to the editor and
  // keeps all save bookkeeping coherent so the editor and save state never
  // disagree (the document is now both shown and saved).
  const applyCommittedPlaintext = async (text: string, envelope: string) => {
    sessionKdfParamsRef.current = getEnvelopeKdfParams(parseEnvelope(envelope))
    plaintextRef.current = text
    lastSavedPlaintextRef.current = text
    setPlaintext(text)
    setSavedEnvelope(envelope)
    setSaveStatus('saved')
    setHasSavedThisSession(true)
    // A committed resolution puts local and remote back in step: the paused
    // first-sync gate lifts and pushes resume (SPEC §9).
    setDropboxSessionPaused(false)
    await refreshStorageStatus()
  }

  const applyKeptRemoteEnvelope = async () => {
    clearSecrets()
    setIsUnlocked(false)
    setSaveStatus('idle')
    await refreshStorageStatus()
    await refreshDropboxState()
    await refreshDropboxRecentFiles()
    showDropboxMessage('Kept remote Dropbox copy. Unlock it with its current password.', 'info')
  }

  // Builds the controller's dependencies. Called only from event handlers, so the
  // ref reads here never happen during render.
  const conflictDeps = (): ConflictControllerDeps => ({
    getProvider: getSyncProvider,
    getPassword: () => passwordRef.current,
    flushLocal: async () => {
      const result = await saveCurrentPlaintextRef.current({
        trigger: 'manual',
        waitForInFlight: true,
      })
      return result.ok
    },
    getPlaintext: () => plaintextRef.current,
    encrypt: (text, password) =>
      encryptWithSessionSecretKey(text, password, { readOnly: isReadOnlyRef.current }),
    decrypt: (envelope, password) =>
      CryptoService.decrypt(envelope, password, {
        secretKeyBytes: sessionSecretKeyBytesRef.current,
      }),
    applyCommittedPlaintext,
    applyKeptRemoteEnvelope,
    setModalState: setConflictModal,
    showMessage,
    refreshStatus: refreshStorageStatus,
  })

  const disposeConflictState = () => {
    conflictController.dispose(conflictDeps())
    setConflictResolutions(new Map())
    setIsConflictPreview(false)
  }

  const startConflictResolve = () => {
    setConflictResolutions(new Map())
    setIsConflictPreview(false)
    void conflictController.resolve(conflictDeps())
  }

  const chooseConflict = (index: number, choice: ConflictResolutionChoice) =>
    setConflictResolutions((previous) => new Map(previous).set(index, choice))

  const chooseAllConflicts = (kind: 'local' | 'remote' | 'both') => {
    if (conflictModal.mode !== 'editing') {
      return
    }

    const next = new Map<number, ConflictResolutionChoice>()
    let conflictIndex = 0
    for (const region of conflictModal.regions) {
      if (region.type === 'conflict') {
        next.set(conflictIndex, { kind })
        conflictIndex += 1
      }
    }
    setConflictResolutions(next)
  }

  const saveResolvedConflict = () => {
    if (conflictModal.mode !== 'editing') {
      return
    }

    if (isConflictPreview) {
      // DEV preview: don't touch Dropbox; just confirm and close.
      showMessage('Preview only — no Dropbox commit.', 'info')
      disposeConflictState()
      return
    }

    void conflictController.commitResolved(conflictDeps(), {
      regions: conflictModal.regions,
      resolutions: conflictResolutions,
      remoteConflictRev: conflictModal.remoteConflictRev,
    })
  }

  // Drop stale per-hunk choices whenever a genuinely new merge is presented.
  // The controller builds a fresh `regions` array on every resolve — including
  // the remote re-fetch on open and the 409 re-resolve — so keying on identity
  // resets exactly when the conflict set changes, and never when the editor
  // merely reopens against the same regions (a non-409 save failure), which
  // must preserve the user's selections for retry. Without this, a leftover
  // resolution map mis-keys against the new conflicts: Save would look ready
  // and the bulk actions inert because the map already reads "all resolved".
  useEffect(() => {
    const regions = conflictModal.mode === 'editing' ? conflictModal.regions : null

    if (regions && regions !== lastResolvedRegionsRef.current) {
      lastResolvedRegionsRef.current = regions
      setConflictResolutions(new Map())
    } else if (conflictModal.mode === 'closed') {
      lastResolvedRegionsRef.current = null
    }
  }, [conflictModal])

  // Local File `Browse` (SPEC §2): file picker first, then the unlock
  // password dialog for the chosen encrypted file — file first, password
  // second, consistent with the destination-then-password order everywhere.
  const browseAndUnlockLocalEncryptedFile = async () => {
    setMessage('')
    setSaveStatus('idle')

    let envelope: string

    try {
      envelope = await localFileProvider.open()

      if (activeStorageProviderRef.current.kind !== 'local-file') {
        setActiveProviderPreservingSession('local-file')
      }

      setSessionDocumentKind('local-file')
      dropboxFileSessionKeyRef.current = null
      setDropboxSessionPaused(false)
      setSavedEnvelope(envelope)
      await refreshLocalFileRecords()
      await refreshStorageStatus()
    } catch (error) {
      if (isFilePickerAbort(error)) {
        return
      }

      await publishLocalFileUnlockDiagnostic('browse', 'action-failed', null, error)
      showUnlockFailure(error)
      return
    }

    const unlocked = await openUnlockDialog(
      'Unlock local file',
      envelope,
      async (password, secretKeyInput) => {
        try {
          await unlockEnvelope(envelope, password, secretKeyInput)
          await publishLocalFileUnlockDiagnostic('browse', 'decrypt-ok', envelope)
          return null
        } catch (error) {
          await publishLocalFileUnlockDiagnostic('browse', 'decrypt-failed', envelope, error)
          clearSecrets()
          return getUnlockFailureMessage(error)
        }
      },
    )

    if (!unlocked) {
      // The browsed file is already in the recent list (selected); say how to
      // continue, mirroring the Dropbox block's cancelled-unlock hint.
      showLocalMessage('File selected. Unlock it with its password.', 'info')
    }
  }

  const selectLocalFileRecord = async (recordKey: string) => {
    setActiveLocalFileKey(recordKey)
    await localFileProvider.select(recordKey)
    await refreshLocalFileRecords()
  }

  const setLocalFilePathRoot = async () => {
    try {
      await localFileProvider.setPathRoot()
      await refreshLocalFileRecords()
      showLocalMessage('Path root set.', 'info')
    } catch (error) {
      if (isFilePickerAbort(error)) {
        return
      }

      showLocalMessage('Unable to set the path root.')
    }
  }

  const removeLocalFileFromList = async (recordKey: string) => {
    try {
      const nextActiveRecord = await localFileProvider.forget(recordKey)
      clearSecrets()
      setSavedEnvelope(nextActiveRecord?.lastSavedEnvelope ?? null)
      setIsUnlocked(false)
      setSaveStatus('idle')
      await refreshLocalFileRecords()
      await refreshStorageStatus()
      showLocalMessage('Removed from recent files.', 'info')
    } catch {
      showLocalMessage('Could not remove the file from the list.')
    }
  }

  // Exports one encrypted envelope as a one-shot `.txt` copy (SPEC §10 platform
  // export flow): a native save dialog pre-filled with `suggestedName` where the
  // File System Access API exists, otherwise an anchor download named with it.
  // The picker opens first, inside the caller's user activation, and only then is
  // the envelope produced — `getEnvelope` can be a slow Argon2id encryption, and
  // awaiting it before `showSaveFilePicker` could drop the transient activation
  // the picker requires. Non-cancel failures throw; callers show their own toast.
  const exportEncryptedCopy = async ({
    getEnvelope,
    suggestedName,
  }: {
    getEnvelope: () => Promise<string | null | undefined>
    suggestedName: string
  }): Promise<'saved' | 'downloaded' | 'canceled' | 'unavailable'> => {
    const showSaveFilePicker = globalThis.showSaveFilePicker

    if (!showSaveFilePicker) {
      const envelope = await getEnvelope()

      if (!envelope) {
        return 'unavailable'
      }

      const blob = new Blob([`${envelope}\n`], {
        type: 'text/plain;charset=utf-8',
      })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = suggestedName
      anchor.rel = 'noopener'
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)

      return 'downloaded'
    }

    let handle: FileSystemFileHandle

    try {
      handle = await showSaveFilePicker({
        excludeAcceptAllOption: true,
        suggestedName,
        types: ENCRYPTED_TEXT_FILE_TYPES,
      })
    } catch (error) {
      if (isFilePickerAbort(error)) {
        return 'canceled'
      }

      throw error
    }

    if (!isEncryptedTextFileName(handle.name)) {
      showMessage('Export filename must end in .txt or .text.')
      return 'canceled'
    }

    const envelope = await getEnvelope()

    if (!envelope) {
      return 'unavailable'
    }

    const writable = await handle.createWritable()

    await writable.write(`${envelope}\n`)
    await writable.close()

    return 'saved'
  }

  const clearPromotedDraftSlot = async () => {
    try {
      await vaultStore.clearVault()
      setHasDraft(false)
      return true
    } catch {
      return false
    }
  }

  // Save As (Local File Mode) is a full rebind, like desktop editors: the
  // picked file becomes the active document and all subsequent autosaves target
  // it. The editor is not remounted, so content and undo/redo history survive.
  // Save As reuses the CURRENT session password — it never sets or rotates a
  // password (that is the separate Change Password action, SPEC §10). Order:
  // destination first (native save picker), then encrypt under the current
  // password and write. A cancelled picker changes nothing.
  const saveAsEncryptedFile = async () => {
    if (isAppReadOnlySessionRef.current) {
      showMessage('Dropbox is unlinked. This cached file is read-only.', 'info')
      return
    }

    setMessage('')

    // Whether THIS Save As is a draft promotion (SPEC §10): a draft opened from
    // the Local files home converts into the written local file and the draft
    // slot empties — the local-mode analogue of Upload to Dropbox. Captured
    // before the rebind below sets the session to 'local-file'.
    const wasDraftSession = sessionDocumentKindRef.current === 'draft'

    // Open the picker FIRST, before any encryption (SPEC §10/§17): the save
    // dialog needs the click's transient user activation, and a pre-picker
    // Argon2id flush of a dirty document could spend it, leaving the picker
    // unable to open. The dirty/in-flight flush is deferred until after the
    // picker resolves (below) — the session is not rebound until the end, so
    // that later flush still targets the OLD file.
    let target: LocalFileCreateTarget

    try {
      const suggestedName =
        sessionDocumentKindRef.current === 'local-file' ? getActiveLocalFileRecord() : null

      target = await localFileProvider.pickCreateTarget({
        ...(suggestedName?.handle ? { startIn: suggestedName.handle } : {}),
        suggestedName: toSuggestedTxtName(suggestedName?.displayName),
      })
    } catch (error) {
      if (isFilePickerAbort(error)) {
        return
      }

      showMessage(
        error instanceof Error && error.message === ENCRYPTED_FILE_NAME_MESSAGE
          ? ENCRYPTED_FILE_NAME_MESSAGE
          : 'Unable to save to that file.',
      )
      return
    }

    // Now flush a dirty or in-flight autosave to the CURRENT (still-bound)
    // file: the old document keeps its final content, and `waitForInFlight`
    // drains any save started before Save As so none can land after the
    // rebind below. The picker's activation is already spent, so this
    // Argon2id wait is harmless to it. A failed flush does not block the
    // Save As — the new file is written fresh either way.
    const needsOldFileFlush =
      Boolean(activeSavePromiseRef.current) ||
      plaintextRef.current !== lastSavedPlaintextRef.current ||
      saveStatus === 'error'

    if (needsOldFileFlush) {
      await saveCurrentPlaintextRef.current({ trigger: 'manual', waitForInFlight: true })
    }

    // Save As reuses the CURRENT session password with no prompt (SPEC §10):
    // both a draft promotion and a bound-file Save As write the copy under the
    // current password and rebind to it. Rotation is the separate Change Password
    // action, not Save As. `null` here means the session locked during the
    // picker/flush (auto-lock).
    const newPassword = passwordRef.current || null

    if (newPassword === null) {
      // Auto-lock fired during the picker or the flush, clearing the session
      // password — write nothing.
      window.setTimeout(() => editorRef.current?.focus(), 0)
      return
    }

    // Auto-lock can fire while the native picker or the password dialog is
    // open (no window activity events). SPEC §10: the flow aborts with
    // nothing written — plaintext is gone with the lock, so no copy can be
    // produced.
    if (!passwordRef.current) {
      return
    }

    const plaintextSnapshot = plaintextRef.current
    let envelope: string

    try {
      // A Save As copy (and rebind) inherits the current read-only flag.
      envelope = await encryptWithSessionSecretKey(plaintextSnapshot, newPassword, {
        readOnly: isReadOnlyRef.current,
      })

      await localFileProvider.createAtTarget(target, envelope)
    } catch {
      showMessage('Unable to save to that file.')
      return
    }

    // Auto-lock can also fire during the encrypt/write themselves. The
    // file was still written (a valid copy of the pre-lock text), but a
    // locked session must not be revived.
    if (!passwordRef.current) {
      return
    }

    // The promotion empties the draft slot. Cleanup failure is nonfatal.
    // If cleanup fails after the file write, keep the new local-file session
    // and report cleanup separately.
    const draftCleared = !wasDraftSession || (await clearPromotedDraftSlot())

    if (activeStorageProviderRef.current.kind !== 'local-file') {
      setActiveProviderPreservingSession('local-file')
    }

    setSessionDocumentKind('local-file')
    dropboxFileSessionKeyRef.current = null
    setDropboxSessionPaused(false)
    passwordRef.current = newPassword
    lastSavedPlaintextRef.current = plaintextSnapshot
    setSavedEnvelope(envelope)
    setSaveStatus('saved')
    setHasSavedThisSession(true)
    await refreshLocalFileRecords().catch(() => undefined)
    await refreshStorageStatus().catch(() => undefined)
    showMessage(
      draftCleared
        ? 'Saved As. Edits now save to the selected file.'
        : 'Saved As. Edits now save to the selected file, but the old draft could not be cleared.',
      draftCleared ? 'info' : 'error',
    )
    window.setTimeout(() => editorRef.current?.focus(), 0)
  }

  // Export to Files: a one-shot encrypted export of the current document. Uses
  // a freshly-encrypted envelope (not a possibly-stale autosave) so the exported
  // copy always matches the editor; the current password is reused. The suggested
  // filename prefers the connected Dropbox file's name.
  const exportToFiles = async () => {
    const password = passwordRef.current

    if (!isUnlocked || !password) {
      return
    }

    const isConnectedToDropboxFile = Boolean(
      dropboxSyncState?.linked &&
        (dropboxSyncState.selectedFileId || dropboxSyncState.selectedPathDisplay),
    )
    const connectedDropboxName = isConnectedToDropboxFile
      ? (dropboxSyncState?.selectedName ?? dropboxSyncState?.selectedPathDisplay)
      : null
    // Snapshot before the picker: auto-lock can fire while the native dialog
    // is open (no window activity events), and the export must carry the text
    // the user asked to export.
    const plaintextSnapshot = plaintextRef.current

    try {
      const outcome = await exportEncryptedCopy({
        getEnvelope: () =>
          encryptWithSessionSecretKey(plaintextSnapshot, password, {
            readOnly: isReadOnlyRef.current,
          }),
        suggestedName: toSuggestedTxtName(connectedDropboxName),
      })

      if (outcome === 'saved') {
        showMessage('Encrypted copy saved.', 'info')
      }
    } catch {
      showMessage('Could not prepare the encrypted copy for download.')
    }
  }

  // Export the stored vault envelope as-is — no password required: the record
  // is already ciphertext, so this equals copying the IndexedDB blob. Lets the
  // user archive a vault (for example before Create vault) even when its
  // password is not at hand. The vault itself is not modified or deleted.
  const exportVaultEnvelope = async () => {
    try {
      const outcome = await exportEncryptedCopy({
        // The DRAFT's stored ciphertext only (SPEC §10) — never savedEnvelope,
        // which can hold a selected Dropbox record's cache.
        getEnvelope: async () => (await vaultStore.getVault().catch(() => null))?.envelope ?? null,
        suggestedName: DEFAULT_EXPORT_FILE_NAME,
      })

      // Confirm only a genuinely completed export. 'saved' (File System Access
      // write) is reliable. 'downloaded' (anchor fallback) can't be confirmed —
      // the OS save flow may be canceled and is not observable — so, like
      // Import, it shows nothing rather than a possibly-false confirmation.
      // 'canceled'/'unavailable' are non-events.
      if (outcome === 'saved') {
        showMessage('Draft exported.', 'info')
      }
    } catch {
      showMessage('Could not prepare the encrypted copy for download.')
    }
  }

  const findDropboxRecentForPath = (dropboxPath: string) =>
    dropboxRecentFiles?.files.find(
      (file) =>
        `${file.folderPath === '/' ? '' : file.folderPath}/${file.name}`.toLowerCase() ===
        dropboxPath.toLowerCase(),
    )

  const uploadEnvelopeToDropbox = async ({
    currentSessionFileId = null,
    dropboxPath,
    envelope,
    isDivergedSession = false,
    localLossSuffix = '',
    provider,
  }: {
    currentSessionFileId?: string | null
    dropboxPath: string
    envelope: string
    isDivergedSession?: boolean
    localLossSuffix?: string
    provider: SyncStorageProvider
  }) => {
    const attemptCreate = () =>
      runExclusiveDropboxOp(async () => {
        try {
          await provider.createRemoteFile(dropboxPath, envelope)
          return 'created' as const
        } catch (error) {
          if (error instanceof DropboxProviderError && error.code === 'conflict') {
            return 'exists' as const
          }

          throw error
        }
      })

    const outcome = await attemptCreate()

    if (outcome !== 'exists') {
      return 'uploaded' as const
    }

    let stat = await runExclusiveDropboxOp(() => provider.statRemoteTxtFile(dropboxPath))
    let changedSinceConfirm = false

    while (stat.exists) {
      const isOwnDivergedFile =
        isDivergedSession &&
        currentSessionFileId !== null &&
        stat.id !== null &&
        stat.id === currentSessionFileId
      const remoteWhen = formatRemoteChangedWhen(stat.serverModified)
      const confirmText =
        (isOwnDivergedFile
          ? `This replaces the Dropbox copy, including changes made on other devices (remote last changed ${remoteWhen}). Continue?`
          : changedSinceConfirm
            ? `The Dropbox file at ${dropboxPath} changed while you were confirming. Replace the NEW current file with this document?`
            : `A Dropbox file already exists at ${dropboxPath}. Replace it with the current document?`) +
        localLossSuffix

      if (!window.confirm(confirmText)) {
        showMessage('Upload canceled. Dropbox was not changed.', 'info')
        return 'canceled' as const
      }

      const expectedRev = stat.rev

      try {
        await runExclusiveDropboxOp(() =>
          provider.replaceRemoteFile(dropboxPath, envelope, expectedRev),
        )
        return 'uploaded' as const
      } catch (error) {
        if (error instanceof DropboxProviderError && error.code === 'conflict') {
          stat = await runExclusiveDropboxOp(() => provider.statRemoteTxtFile(dropboxPath))
          changedSinceConfirm = true
          continue
        }

        throw error
      }
    }

    await runExclusiveDropboxOp(() => provider.createRemoteFile(dropboxPath, envelope))
    return 'uploaded' as const
  }

  const promoteDraftToLocalFile = async () => {
    if (!hasDraft) {
      return
    }

    setMessage('')

    let target: LocalFileCreateTarget

    try {
      target = await localFileProvider.pickCreateTarget({
        suggestedName: DEFAULT_EXPORT_FILE_NAME,
      })
    } catch (error) {
      if (isFilePickerAbort(error)) {
        return
      }

      showMessage(
        error instanceof Error && error.message === ENCRYPTED_FILE_NAME_MESSAGE
          ? ENCRYPTED_FILE_NAME_MESSAGE
          : 'Unable to save to that file.',
      )
      return
    }

    const envelope = (await vaultStore.getVault().catch(() => null))?.envelope ?? null

    if (!envelope) {
      setHasDraft(false)
      showMessage('No draft to save.', 'info')
      return
    }

    try {
      await localFileProvider.createAtTarget(target, envelope)
    } catch {
      showMessage('Unable to save to that file.')
      return
    }

    const draftCleared = await clearPromotedDraftSlot()

    await refreshLocalFileRecords({ force: true }).catch(() => undefined)
    await refreshStorageStatus().catch(() => undefined)
    showMessage(
      draftCleared
        ? 'Draft saved as a local file.'
        : 'Draft saved as a local file, but the old draft could not be cleared.',
      draftCleared ? 'info' : 'error',
    )
  }

  const promoteDraftToDropbox = async () => {
    if (!hasDraft) {
      return
    }

    const provider = getDropboxProvider()

    if (!provider) {
      return
    }

    const choice = await openDropboxBrowser('upload')

    if (!choice) {
      return
    }

    const dropboxPath = choice.path
    const envelope = (await vaultStore.getVault().catch(() => null))?.envelope ?? null

    if (!envelope) {
      setHasDraft(false)
      showMessage('No draft to upload.', 'info')
      return
    }

    const localLossSuffix = findDropboxRecentForPath(dropboxPath)?.hasUnsyncedChanges
      ? ' This also replaces its local cached copy; unsynced changes there are lost.'
      : ''

    try {
      const outcome = await uploadEnvelopeToDropbox({
        dropboxPath,
        envelope,
        localLossSuffix,
        provider,
      })

      if (outcome === 'canceled') {
        return
      }
    } catch {
      showMessage('Unable to upload that draft to Dropbox.')
      await refreshStorageStatus().catch(() => undefined)
      return
    }

    const draftCleared = await clearPromotedDraftSlot()

    await refreshDropboxState().catch(() => undefined)
    await refreshDropboxRecentFiles().catch(() => undefined)
    await refreshStorageStatus().catch(() => undefined)
    showMessage(
      draftCleared
        ? 'Draft uploaded to Dropbox.'
        : 'Draft uploaded to Dropbox, but the old draft could not be cleared.',
      draftCleared ? 'info' : 'error',
    )
  }

  // "Save to Dropbox": push
  // the current document to a chosen Dropbox file and rebind the session to it —
  // upload-as-a-new-Dropbox-file. Works from BOTH a draft session (the
  // promotion: the draft slot empties) and a Dropbox-file session (save a copy
  // to Dropbox and move to editing it). Push-only — it never pulls. New path →
  // create (add); existing path → confirm, then revision-conditional replace.
  //
  // The ONE force-out-of-conflict exception: choosing the
  // CURRENT session's OWN Dropbox file (matched by FILE ID, not merely the same
  // path) while the session is diverged is a deliberate "my version wins" exit.
  // Even then it is never an unconditional path overwrite: a fresh metadata
  // probe is surfaced in a consequence confirmation, then the replace runs
  // revision-conditionally against the freshly-probed rev — overriding the
  // STALE SESSION BASE (what made the session diverged), not the revision guard,
  // so a change landing between probe and upload still 409s and re-confirms.
  const uploadToDropbox = async () => {
    const provider = getDropboxProvider()

    if (!provider) {
      return
    }

    if (isAppReadOnlySessionRef.current) {
      showMessage('Dropbox is unlinked. This cached file is read-only.', 'info')
      return
    }

    const syncState = await provider.getSyncState()

    // Linking is initiated only from the Home screen (SPEC §4): the editor
    // never starts the OAuth redirect, which would navigate away and drop the
    // unlocked draft. The toolbar control is muted while unlinked and points
    // the user to Home rather than promoting.
    if (!syncState.linked) {
      showMessage('Link Dropbox from the Home screen to upload.', 'info')
      return
    }

    // The current session's own bound Dropbox file id and whether the session is
    // diverged — the two conditions for the force-out-of-conflict path. A
    // diverged session is one the first-sync gate paused, or one carrying a
    // captured 409 conflict.
    const currentSessionFileId =
      sessionDocumentKindRef.current === 'dropbox-file' ? (syncState.selectedFileId ?? null) : null
    const isDivergedSession =
      dropboxSessionPausedRef.current || storageStatus?.state === 'conflict'

    const choice = await openDropboxBrowser('upload')

    if (!choice) {
      return
    }

    const dropboxPath = choice.path

    // Prepare a destination envelope without running the normal autosave path.
    // The overwrite confirmation has not happened yet, so cancelling there must
    // not mark the editor as saved/synced.
    const inFlightSave = activeSavePromiseRef.current
    if (inFlightSave) {
      const saveResult = await inFlightSave

      if (!saveResult.ok) {
        showMessage('Save failed. Upload to Dropbox was not started.')
        return
      }
    }

    const password = passwordRef.current
    if (!isUnlocked || !password) {
      return
    }

    const plaintextSnapshot = plaintextRef.current
    let envelope: string

    try {
      envelope = await encryptWithSessionSecretKey(plaintextSnapshot, password, {
        readOnly: isReadOnlyRef.current,
      })
    } catch {
      showMessage('Could not prepare the Dropbox upload.')
      return
    }

    // Whether THIS upload is a promotion: a draft session converts into the
    // cached Dropbox file and the draft slot empties (SPEC §4/§10).
    const wasDraftSession = sessionDocumentKindRef.current === 'draft'
    // When the destination is itself a cached recent file with unsynced
    // changes, the overwrite also replaces that local cache — the
    // confirmation must name the local loss (SPEC §4/§9).
    const localLossSuffix = findDropboxRecentForPath(dropboxPath)?.hasUnsyncedChanges
      ? ' This also replaces its local cached copy; unsynced changes there are lost.'
      : ''

    // The add attempt runs inside an exclusive Dropbox op. Under the per-file
    // model, uploading to a DIFFERENT file discards nothing — every recent
    // file keeps its own cache and pending state — so no unsynced-discard
    // guard applies (SPEC §9). The add (no baseRev) is never an overwrite, so
    // a 409 'conflict' here means the path already exists — surfaced as
    // 'exists' for an explicit overwrite confirmation (no overwrite upload
    // before consent).
    try {
      const outcome = await uploadEnvelopeToDropbox({
        currentSessionFileId,
        dropboxPath,
        envelope,
        isDivergedSession,
        localLossSuffix,
        provider,
      })

      if (outcome === 'canceled') {
        return
      }

      const draftCleared = !wasDraftSession || (await clearPromotedDraftSlot())

      // Connecting makes Dropbox the active provider (session preserved); the
      // session is a Dropbox file session from here on.
      if (activeStorageProviderRef.current.kind !== 'dropbox') {
        setActiveProviderPreservingSession('dropbox')
      }

      setSessionDocumentKind('dropbox-file')
      // The upload cleared any conflict and recorded the fresh rev as the base
      // (pushNewSelectedEnvelope), so the session is no longer paused/diverged —
      // lift the first-sync gate so the Resolve banner clears and pushes resume.
      // This is what makes "Save to Dropbox → my own file" a working
      // force-out-of-conflict exit.
      setDropboxSessionPaused(false)
      lastSavedPlaintextRef.current = plaintextSnapshot
      setSavedEnvelope(envelope)
      setHasSavedThisSession(true)
      if (plaintextRef.current === plaintextSnapshot) {
        setSaveStatus('saved')
      } else {
        pendingSaveRef.current = true
        setSaveStatus('dirty')
      }
      await refreshStorageStatus().catch(() => undefined)
      await refreshDropboxState().catch(() => undefined)
      await refreshDropboxRecentFiles().catch(() => undefined)
      // Rebind the session key to the (possibly new) uploaded file so the
      // first-sync-gate probe and the focus/visibility remote check target it.
      const reboundState = await provider.getSyncState().catch(() => null)
      if (reboundState?.selectedFileId) {
        dropboxFileSessionKeyRef.current = reboundState.selectedFileId
      }
      showMessage(
        draftCleared
          ? 'Uploaded to Dropbox and connected.'
          : 'Uploaded to Dropbox and connected, but the old draft could not be cleared.',
        draftCleared ? 'info' : 'error',
      )
    } catch {
      showMessage('Unable to upload to that Dropbox .txt file.')
      await refreshStorageStatus().catch(() => undefined)
    }
  }

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((currentSettings) => ({
      ...currentSettings,
      [key]: value,
    }))

    void vaultStore.saveSetting({ key, value } as SettingsRecord).catch(() => {
      showMessage('Unable to save settings.')
    })
  }

  // Secret-key Settings feedback renders inside the Settings dialog (below the
  // action row), not on the home banner the dialog covers. Auto-dismisses after
  // the standard interval.
  const showSecretKeyMessage = (text: string, tone: MessageTone = 'error') => {
    if (secretKeySettingsMessageTimerRef.current !== null) {
      window.clearTimeout(secretKeySettingsMessageTimerRef.current)
    }
    setSecretKeySettingsMessage({ text, tone })
    secretKeySettingsMessageTimerRef.current = window.setTimeout(() => {
      secretKeySettingsMessageTimerRef.current = null
      setSecretKeySettingsMessage((current) => (current?.text === text ? null : current))
    }, MESSAGE_AUTO_DISMISS_MS)
  }

  const saveSecretKeySetting = async (value: string | null, message?: string) => {
    // Persist FIRST: the in-memory key (which getConfiguredSecretKeyBytes reads to
    // encrypt this session) is adopted only after the write durably succeeds, so
    // the session can never use a key that is not stored. On failure nothing
    // changes, and the error shows on the Settings surface — not the home banner
    // the dialog covers.
    try {
      await vaultStore.saveSetting({ key: 'secretKey', value } as SettingsRecord)
    } catch {
      showSecretKeyMessage('Unable to save Secret key.')
      return
    }

    setSettings((currentSettings) => ({ ...currentSettings, secretKey: value }))

    if (message) {
      showSecretKeyMessage(message, 'info')
    }
  }

  const updateKdfPolicySetting = (value: KdfPolicyId) => {
    if (value === settings.kdfPolicy) {
      return
    }

    if (value === 'strong' && settings.kdfPolicy !== 'strong') {
      const confirmed = window.confirm(STRONG_KDF_POLICY_CONFIRM)

      if (!confirmed) {
        return
      }
    }

    updateSetting('kdfPolicy', value)
  }

  // Open Home Settings, clearing any leftover secret-key message (and its
  // pending timer) so each open starts fresh and never shows a stale note.
  const openHomeSettings = () => {
    if (secretKeySettingsMessageTimerRef.current !== null) {
      window.clearTimeout(secretKeySettingsMessageTimerRef.current)
      secretKeySettingsMessageTimerRef.current = null
    }
    setSecretKeySettingsMessage(null)
    setIsHomeSettingsOpen(true)
  }

  const importSecretKeyString = async (value: string) => {
    const secretKeyBytes = await parseSecretKeyString(value)
    const canonicalSecretKey = formatSecretKeyString(secretKeyBytes)

    // Replacing an existing key is destructive (the old key is lost), so confirm
    // first — analogous to the Generate/Clear confirmations. Validation runs
    // above, so an invalid paste never triggers a pointless confirm.
    if (settings.secretKey && !window.confirm(SECRET_KEY_REPLACE_CONFIRM)) {
      return
    }

    await saveSecretKeySetting(canonicalSecretKey, 'Secret key pasted.')
    setSecretKeyManualDialog(null)
  }

  const generateSecretKey = async () => {
    const confirmed = window.confirm(
      settings.secretKey
        ? 'Generate a new Secret key? Files saved with the current key cannot be opened unless you paste the current key again. Record the current key first if you need it.'
        : 'Files saved while Secret key is set require the same key on every device. Losing it can make those files unreadable. Continue?',
    )

    if (!confirmed) {
      return
    }

    try {
      await saveSecretKeySetting(await generateSecretKeyString())
    } catch {
      showSecretKeyMessage('Unable to generate Secret key.')
    }
  }

  const clearSecretKey = () => {
    if (!settings.secretKey) {
      return
    }

    const confirmed = window.confirm(
      'Clear Secret key? Files that require it cannot be opened on this device until you paste the same key again.',
    )

    if (confirmed) {
      void saveSecretKeySetting(null, 'Secret key cleared.')
    }
  }

  const pasteSecretKey = async () => {
    let text: string

    try {
      text = await navigator.clipboard.readText()
    } catch {
      setSecretKeyManualDialog({ kind: 'paste', error: '', value: '' })
      return
    }

    try {
      await importSecretKeyString(text)
    } catch {
      showSecretKeyMessage(SECRET_KEY_INVALID_MESSAGE)
    }
  }

  const submitManualSecretKeyPaste = async () => {
    if (secretKeyManualDialog?.kind !== 'paste') {
      return
    }

    try {
      await importSecretKeyString(secretKeyManualDialog.value)
    } catch {
      setSecretKeyManualDialog({
        ...secretKeyManualDialog,
        error: 'Invalid Secret key.',
      })
    }
  }

  const closeSettingsDialog = () => {
    setIsSettingsDialogOpen(false)
    window.setTimeout(() => editorRef.current?.focus(), 0)
  }

  const updateSearchQuery = (value: string) => {
    setSearchQuery(value)
    showSearchMessage('')
  }

  // Preview position sync (SPEC: preview position sync). One-shot, against the
  // preview as currently rendered — if a recent edit's deferred re-render has not
  // landed yet, pressing again once it does re-aligns to the new content.
  const previewRenderKey = () => previewRef.current?.getAttribute(RENDER_KEY_ATTR) ?? ''

  // Button A: match the preview's first line to the editor's.
  const alignPreviewToEditor = () => {
    const root = previewRef.current
    const line = editorRef.current?.getTopVisibleLine()

    if (root && line !== undefined) {
      alignPreviewToSourceLine(root, previewRenderKey(), line)
    }
  }

  // Button B: match the editor's first line to the preview's.
  const alignEditorToPreview = () => {
    const root = previewRef.current

    if (!root) {
      return
    }

    const line = sourceLineAtPreviewTop(root, previewRenderKey())

    if (line !== null) {
      editorRef.current?.scrollLineToTop(line)
    }
  }

  // Opening the preview shows it aligned to the editor's current position (same as
  // pressing "Jump to Markdown"), in both the side-by-side and overlay layouts.
  // The editor's top line is captured here, before the open, because the overlay
  // layout hides the editor once the preview is open. Only the toggle open path
  // aligns; reaching markdown mode with the preview already on does not (the
  // editor may be hidden, so there is no reliable line to read).
  //
  // CLOSING the overlay preview does the mirror move ("Jump to Editor"): the
  // editor was hidden while the preview scrolled, so its own position is
  // stale. The preview's top source line is captured before the close (the
  // pane unmounts) and applied once the editor is visible again. Side-by-side
  // keeps both panes visible, so closing there does not jump.
  const togglePreview = () => {
    if (!isPreviewVisible) {
      pendingPreviewAlignRef.current = editorRef.current?.getTopVisibleLine() ?? null
    } else if (window.matchMedia(OVERLAY_PREVIEW_MEDIA_QUERY).matches) {
      const root = previewRef.current
      pendingEditorAlignRef.current = root
        ? sourceLineAtPreviewTop(root, root.getAttribute(RENDER_KEY_ATTR) ?? '')
        : null
    }

    setIsPreviewVisible((visible) => !visible)
  }

  // The same condition as `isPreviewOpen` (computed later for JSX), recomputed
  // from its inputs so this hook stays above the unlock early-return where hooks
  // are valid.
  const previewOpen = settings.editorMode === 'markdown' && isPreviewVisible
  useLayoutEffect(() => {
    if (!previewOpen) {
      const line = pendingEditorAlignRef.current
      pendingEditorAlignRef.current = null

      // Overlay close path: the editor just became visible again.
      if (line !== null) {
        editorRef.current?.scrollLineToTop(line)
      }

      return
    }

    const line = pendingPreviewAlignRef.current
    pendingPreviewAlignRef.current = null
    const root = previewRef.current

    // Aligns before paint (no visible jump). Only when this open came through the
    // toggle, which captured a valid line.
    if (line !== null && root) {
      alignPreviewToSourceLine(root, root.getAttribute(RENDER_KEY_ATTR) ?? '', line)
    }
  }, [previewOpen])

  // The search panel overlays the editor's top edge (SPEC §12); its live
  // height feeds the editor's top scroll margin so match navigation and
  // caret reveals never land underneath it. ResizeObserver tracks layout
  // changes (orientation, the 640px restack); it is absent in jsdom, where
  // the single initial measure suffices.
  useLayoutEffect(() => {
    const panel = searchPanelRef.current

    if (!isSearchPanelOpen || !panel) {
      setSearchPanelHeight(0)
      return undefined
    }

    const measure = () => setSearchPanelHeight(panel.offsetHeight)

    measure()

    if (typeof ResizeObserver === 'undefined') {
      return undefined
    }

    const observer = new ResizeObserver(measure)

    observer.observe(panel)
    return () => observer.disconnect()
  }, [isSearchPanelOpen])

  const toggleSearchOption = (option: keyof SearchOptions) => {
    setSearchOptions((currentOptions) => ({
      ...currentOptions,
      [option]: !currentOptions[option],
    }))
    showSearchMessage('')
  }

  const findPreviousMatch = async () => {
    const result = await editorRef.current?.findPrevious(searchQuery, searchOptions)
    reportEditorResult(result)
  }

  const findNextMatch = async () => {
    const result = await editorRef.current?.findNext(searchQuery, searchOptions)
    reportEditorResult(result)
  }

  const toggleSearchPanel = () => {
    setIsSearchPanelOpen((currentIsOpen) => {
      if (currentIsOpen) {
        window.setTimeout(() => editorRef.current?.focus(), 0)
      }

      return !currentIsOpen
    })
  }

  // The toolbar Search button's own handler. Opening must focus the Find field
  // synchronously inside this tap so iOS raises the on-screen keyboard: iOS only
  // shows the keyboard for a focus() that happens within a user gesture, and the
  // deferred focus effect (which fires after the panel renders) loses that
  // activation — so previously the keyboard appeared only if it was already up.
  // flushSync renders the panel before this gesture returns, so the Find input
  // exists and can be focused in the same call stack.
  const handleSearchToggleButton = () => {
    if (isSearchPanelOpen) {
      toggleSearchPanel()
      return
    }

    searchPanelFocusTargetRef.current = 'find'
    flushSync(() => setIsSearchPanelOpen(true))
    searchInputRef.current?.focus()
    searchInputRef.current?.select()
  }

  // Document-level search shortcuts: while unlocked, Ctrl/Cmd+F and
  // Ctrl/Cmd+H open (or refocus) the custom search panel, and F3 / Shift+F3 /
  // Ctrl+G / Shift+Ctrl+G run find next/previous. Registered on the document
  // in the CAPTURE phase so these bindings win over both CodeMirror's bundled
  // searchKeymap and the browser's native find bar — CodeMirror's built-in
  // search panel (untimed main-thread regex) is therefore unreachable, while
  // Mod-d multi-cursor and Alt-g go-to-line stay available. The listener is
  // registered once per unlocked session and dispatches through a ref that is
  // re-pointed every render, so it always sees the current search state
  // without listener churn.
  useEffect(() => {
    searchShortcutRef.current = (event: KeyboardEvent) => {
      // Never react during IME composition.
      if (event.isComposing) {
        return
      }

      // During soft-lock the session is still "unlocked" (plaintext is in
      // memory) but unverified: no editor shortcut may run — in particular
      // Ctrl+S must not export plaintext past the soft-lock verification gate.
      // This no longer depends on the soft-lock overlay happening to be a modal.
      if (isSoftLockedRef.current) {
        return
      }

      // Escape in the editor is the Home button: show the exit
      // confirmation rather than dropping the session. Defer to anything that
      // already owns Escape — an open modal (its own ModalShell handler) or the
      // search panel (closes itself) — so Escape never opens the exit dialog on
      // top of them.
      if (event.key === 'Escape') {
        if (isSearchPanelOpen || document.querySelector('[aria-modal="true"]')) {
          return
        }

        event.preventDefault()
        event.stopPropagation()
        setIsExitConfirmOpen(true)
        return
      }

      const isMod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      const plainMod = isMod && !event.altKey && !event.shiftKey
      // Ctrl+F targets Find; Ctrl+H targets Replace — not an alias.
      const opensFind = plainMod && key === 'f'
      const opensReplace = plainMod && key === 'h'
      // Ctrl+S runs the app's file action instead of the browser's save-page
      // dialog: Save As in Local File editor chrome, Export to Files otherwise.
      const savesAs = plainMod && key === 's'
      const navigates =
        (event.key === 'F3' && !isMod && !event.altKey) || (isMod && !event.altKey && key === 'g')

      if (!opensFind && !opensReplace && !savesAs && !navigates) {
        return
      }

      // Stand down while any modal dialog is open: its fields keep their own
      // key handling, and the browser find bar is the right tool there.
      if (document.querySelector('[aria-modal="true"]')) {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      if (savesAs) {
        if (editorStorageProviderKind === 'local-file') {
          void saveAsEncryptedFile()
        } else {
          void exportToFiles()
        }

        return
      }

      if (opensFind || opensReplace) {
        const target = opensReplace ? 'replace' : 'find'

        if (isSearchPanelOpen) {
          const input = target === 'replace' ? replaceInputRef.current : searchInputRef.current

          // Select existing text so a new query can be typed immediately.
          input?.focus()
          input?.select()
        } else {
          searchPanelFocusTargetRef.current = target
          toggleSearchPanel()
        }

        return
      }

      if (!isSearchPanelOpen) {
        toggleSearchPanel()
      } else if (event.shiftKey) {
        void findPreviousMatch()
      } else {
        void findNextMatch()
      }
    }
  })

  useEffect(() => {
    if (!isUnlocked) {
      return undefined
    }

    const listener = (event: KeyboardEvent) => searchShortcutRef.current(event)

    document.addEventListener('keydown', listener, true)
    return () => document.removeEventListener('keydown', listener, true)
  }, [isUnlocked])

  const replaceDirectionalMatch = async (direction: 'next' | 'previous') => {
    const result =
      direction === 'next'
        ? await editorRef.current?.replaceNext(searchQuery, replaceInput, searchOptions)
        : await editorRef.current?.replacePrevious(searchQuery, replaceInput, searchOptions)
    reportEditorResult(result)
  }

  const replaceEveryMatch = async () => {
    const result = await editorRef.current?.replaceAll(searchQuery, replaceInput, searchOptions)
    reportEditorResult(result)
  }

  const insertRandomString = () => {
    editorRef.current?.insertText(generateRandomString(settings.randomStringLength))
  }

  function hardLockToHome() {
    clearSecrets()
    setIsUnlocked(false)
    setSaveStatus('idle')
    setMessage('')
  }

  function scheduleSoftLockRetry() {
    clearSoftLockRetryTimer()
    softLockRetryTimerRef.current = window.setTimeout(() => {
      softLockRetryTimerRef.current = null
      void (async () => {
        if (!isSoftLockedRef.current) {
          return
        }

        const saveResult = await saveCurrentPlaintextRef.current({
          trigger: 'manual',
          waitForInFlight: true,
        })
        const stillDirty = plaintextRef.current !== lastSavedPlaintextRef.current

        if (saveResult.ok && !stillDirty && isSoftLockedRef.current) {
          hardLockToHome()
          return
        }

        if (isSoftLockedRef.current) {
          scheduleSoftLockRetry()
        }
      })()
    }, SOFT_LOCK_RETRY_MS)
  }

  function enterSoftLock() {
    isSoftLockedRef.current = true
    setSoftLockState({ error: '', passwordInput: '', verified: false })
    setIsLockSaveFailureDialogOpen(false)
    setIsExitConfirmOpen(false)
    setIsSettingsDialogOpen(false)
    setIsSearchPanelOpen(false)
    setConflictResolutions(new Map())
    setIsConflictPreview(false)
    setMessage('')
    scheduleSoftLockRetry()
  }

  const lockVault = async (source: 'auto' | 'voluntary' = 'voluntary') => {
    if (isSoftLockedRef.current) {
      return
    }

    const needsSave =
      Boolean(activeSavePromiseRef.current) || plaintextRef.current !== lastSavedPlaintextRef.current

    if (needsSave) {
      await saveCurrentPlaintextRef.current({
        trigger: 'manual',
        waitForInFlight: true,
      })
      // Key off whether unsaved bytes remain, not the save's ok flag: a
      // successful save updates lastSavedPlaintextRef, so `stillDirty` is the
      // single source of truth for "is there work that would be lost on exit".
      const stillDirty = plaintextRef.current !== lastSavedPlaintextRef.current

      if (stillDirty) {
        if (source === 'auto') {
          enterSoftLock()
        } else {
          setIsLockSaveFailureDialogOpen(true)
        }
        return
      }
    }

    hardLockToHome()
  }

  const stayInEditorAfterFailedExit = () => {
    setIsLockSaveFailureDialogOpen(false)
    window.setTimeout(() => editorRef.current?.focus(), 0)
  }

  // Crash recovery (error boundary): best-effort encrypted save the moment the
  // unlocked subtree crashes, and an always-available path back to the locked
  // screen. The forced lock proceeds even when the save fails — the user has
  // explicitly chosen to leave the crashed session (Export is offered first).
  const handleEditorCrash = () => {
    void saveCurrentPlaintextRef.current({ trigger: 'auto' }).catch(() => undefined)
  }

  const forceLockAfterCrash = async () => {
    try {
      await saveCurrentPlaintextRef.current({ trigger: 'manual', waitForInFlight: true })
    } catch {
      // Locking anyway: secrets must be clearable even when storage is broken.
    }

    hardLockToHome()
  }

  const exitAnywayAfterFailedSave = () => {
    // The user explicitly accepted losing the unsaved edits: purge plaintext
    // and lock even though the save could not complete. This is the guaranteed
    // path to clear secrets when storage is persistently broken.
    hardLockToHome()
  }

  const submitSoftLockPassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    setSoftLockState((current) => {
      if (!current) {
        return current
      }

      if (current.passwordInput === passwordRef.current && passwordRef.current) {
        return { ...current, error: '', verified: true }
      }

      return { ...current, error: 'Incorrect password.', verified: false }
    })
  }

  const continueFromSoftLock = () => {
    clearSoftLockRetryTimer()
    isSoftLockedRef.current = false
    setSoftLockState(null)
    setMessage('')
    window.setTimeout(() => editorRef.current?.focus(), 0)
  }

  const exportFromSoftLock = async () => {
    if (!softLockState?.verified) {
      return
    }

    await exportToFiles()
  }

  const exitSoftLockDiscard = () => {
    hardLockToHome()
  }

  useEffect(() => {
    autoLockRef.current = () => {
      if (isSoftLockedRef.current) {
        return
      }

      void lockVault('auto')
    }
  })

  useEffect(() => {
    if (!isUnlocked || isSoftLocked || settings.autoLockMinutes <= 0) {
      return
    }

    const timeoutMs = settings.autoLockMinutes * 60_000
    let timeoutId = 0
    const scheduleLock = () => {
      window.clearTimeout(timeoutId)
      timeoutId = window.setTimeout(() => autoLockRef.current(), timeoutMs)
    }
    const activityEvents = ['keydown', 'pointerdown', 'wheel', 'touchstart'] as const

    scheduleLock()

    for (const eventName of activityEvents) {
      window.addEventListener(eventName, scheduleLock, { passive: true })
    }

    return () => {
      window.clearTimeout(timeoutId)

      for (const eventName of activityEvents) {
        window.removeEventListener(eventName, scheduleLock)
      }
    }
  }, [isSoftLocked, isUnlocked, settings.autoLockMinutes])

  // Backstop for async failures whose call site forgot a catch: surface the
  // generic failure affordance instead of dying silently with a stale status.
  // Deliberately generic — never the rejection reason, which could carry
  // document-derived text (SPEC §16 forbids content-bearing logs/messages).
  useEffect(() => {
    const onUnhandledRejection = () => {
      setMessage('A background operation failed. Check the storage status; encrypted local saves are unaffected.')
      setMessageTone('error')
    }

    window.addEventListener('unhandledrejection', onUnhandledRejection)
    return () => window.removeEventListener('unhandledrejection', onUnhandledRejection)
  }, [])

  const handleEditorChange = (nextPlaintext: string) => {
    if (isAppReadOnlySessionRef.current) {
      return
    }

    setPlaintext(nextPlaintext)
    plaintextRef.current = nextPlaintext

    if (nextPlaintext !== lastSavedPlaintextRef.current) {
      setSaveStatus('dirty')
      setMessage('')
    } else if (!activeSavePromiseRef.current) {
      setSaveStatus('saved')
      setMessage('')
    }
  }

  const handleCursorChange = (info: EditorCursorInfo) => {
    setCursorInfo(info)
  }

  const handleHistoryAvailabilityChange = ({
    canRedo: nextCanRedo,
    canUndo: nextCanUndo,
  }: {
    canRedo: boolean
    canUndo: boolean
  }) => {
    setCanUndo(nextCanUndo)
    setCanRedo(nextCanRedo)
  }

  const appThemeClass = `theme-${settings.theme}`

  const handleCheckForUpdates = async () => {
    // Close the home Settings dialog before opening the update dialog so only
    // one aria-modal dialog is ever mounted (no stacked modals). The user lands
    // on the home screen after dismissing the update result.
    setIsHomeSettingsOpen(false)
    const controller = new AbortController()
    updateCheckControllerRef.current = controller
    setUpdateDialog({ kind: 'checking' })
    let result: UpdateCheckResult
    try {
      result = await checkForUpdates(controller.signal)
    } catch {
      result = { status: 'error' }
    }

    // A user Cancel aborts this controller and closes the dialog itself; suppress
    // any late-arriving result so it can't reopen the modal. A timeout, by
    // contrast, leaves the signal un-aborted and surfaces "could not check".
    if (controller.signal.aborted) {
      return
    }
    updateCheckControllerRef.current = null

    if (result.status === 'update-available') {
      setUpdateDialog({ kind: 'available', version: result.latest.version })
    } else if (result.status === 'up-to-date') {
      setUpdateDialog({ kind: 'up-to-date' })
    } else {
      setUpdateDialog({ kind: 'error' })
    }
  }

  const handleCancelUpdateCheck = () => {
    updateCheckControllerRef.current?.abort()
    updateCheckControllerRef.current = null
    setUpdateDialog(null)
  }

  const handleApplyUpdate = async (version: string) => {
    setUpdateDialog({ kind: 'applying' })
    try {
      // Resolves into a reload onto the new build; only rejects if no staged
      // build matching the offered version can be activated.
      await applyUpdate(version)
    } catch (error) {
      // Cross-window guard (SPEC Section 14): another window has a document
      // unlocked, so the pin was left untouched. Surface a non-destructive
      // message and close the dialog rather than the generic apply-error — the
      // running build is unchanged, nothing to retry until that window closes.
      if (error instanceof UpdateBlockedError) {
        showMessage('Close the document open in another window before updating.', 'error')
        setUpdateDialog(null)
        return
      }
      setUpdateDialog({ kind: 'apply-error' })
    }
  }

  const updateDialogNode = (
    <UpdateDialog
      state={updateDialog}
      onApplyUpdate={(version) => void handleApplyUpdate(version)}
      onClose={() => setUpdateDialog(null)}
      onCancel={handleCancelUpdateCheck}
    />
  )

  // One capability probe per render (it parses the user agent), shared by the
  // provider options below instead of re-detecting per <option>.
  const hasFileSystemAccess = detectStorageCapabilities().hasFileSystemAccess

  const showSettingsDropboxUnlink =
    homeStorageProviderKind === 'dropbox' && (dropboxSyncState?.linked ?? false)
  const showSettingsDropboxRelink =
    homeStorageProviderKind === 'dropbox' &&
    !showSettingsDropboxUnlink &&
    (dropboxSyncState?.authLost ?? false)
  const showSettingsDropboxLink =
    homeStorageProviderKind === 'dropbox' &&
    !showSettingsDropboxUnlink &&
    !showSettingsDropboxRelink

  const beginDropboxLinkFromSettings = () => {
    setIsHomeSettingsOpen(false)
    beginLinkOrPromptAccount()
  }

  const relinkDropboxFromSettings = () => {
    setIsHomeSettingsOpen(false)
    void linkDropbox()
  }

  const homeSettingsDialog = isHomeSettingsOpen ? (
    <ModalShell
      id="home-settings-dialog"
      className="settings-dialog has-pinned-actions"
      labelledBy="home-settings-title"
      onEscape={() => setIsHomeSettingsOpen(false)}
    >
        <div className="settings-title-row">
          <h2 id="home-settings-title">Settings</h2>
          <button
            type="button"
            className="secondary-button compact-button toolbar-icon-button settings-help-button"
            aria-label="Help"
            title="Help"
            data-skip-initial-focus="true"
            onClick={() => openHelpDialog('home')}
          >
            <ToolbarIcon icon={helpIcon} />
          </button>
        </div>
        <div className="settings-scroll">
        <div className="settings-grid">
          <ThemeField
            id="home-theme-setting"
            value={settings.theme}
            onChange={(value) => updateSetting('theme', value)}
          />

          <AutoLockField
            id="home-auto-lock-setting"
            value={settings.autoLockMinutes}
            onChange={(value) => updateSetting('autoLockMinutes', value)}
          />

          <label className="settings-field" htmlFor="home-storage-provider-setting">
            Storage provider
            <select
              id="home-storage-provider-setting"
              value={settings.storageProvider}
              onChange={(event) =>
                void changeStorageProvider(event.target.value as StorageModeKind)
              }
            >
              {storageProviderOptions.map((providerOption) => (
                <option
                  key={providerOption.value}
                  value={providerOption.value}
                  // Local File Mode needs the File System Access API; on
                  // platforms without it (Firefox, mobile) the option is
                  // visible but unselectable instead of leading to a home
                  // screen whose actions all fail (SPEC §4).
                  disabled={providerOption.value === 'local-file' && !hasFileSystemAccess}
                >
                  {providerOption.label}
                </option>
              ))}
            </select>
          </label>

          {/* Mirrors the Home Dropbox block's connection action in Settings.
              Linked state shows the account and Unlink. Ordinary unlinked
              states, including retained-auth and account-label-only ownership
              hints, show Link with no email. Authorization-lost state shows
              Relink. Hidden (not disabled) for Local files. */}
          {showSettingsDropboxUnlink ? (
            <div className="settings-field home-settings-dropbox-account">
              {dropboxSyncState?.accountLabel ? (
                <p className="settings-account-email">{dropboxSyncState.accountLabel}</p>
              ) : null}
              <button
                type="button"
                className="secondary-button compact-button"
                onClick={requestUnlinkDropbox}
              >
                Unlink Dropbox
              </button>
            </div>
          ) : showSettingsDropboxRelink ? (
            <div className="settings-field home-settings-dropbox-account">
              <button
                type="button"
                className="secondary-button compact-button"
                onClick={relinkDropboxFromSettings}
              >
                Relink
              </button>
            </div>
          ) : showSettingsDropboxLink ? (
            <div className="settings-field home-settings-dropbox-account">
              <button
                type="button"
                className="secondary-button compact-button"
                onClick={beginDropboxLinkFromSettings}
              >
                Link
              </button>
            </div>
          ) : null}
        </div>

        <details
          className="settings-advanced"
          open={isAdvancedSettingsOpen}
        >
          <summary
            onClick={(event) => {
              event.preventDefault()
              setIsAdvancedSettingsOpen((open) => !open)
            }}
          >
            <span>Advanced Settings</span>
            <span className="settings-inline-status">
              {isAdvancedSettingsOpen ? 'Hide' : 'Show'}
            </span>
          </summary>
          <label className="settings-field" htmlFor="home-kdf-policy-setting">
            Password hardening
            <select
              id="home-kdf-policy-setting"
              value={settings.kdfPolicy}
              onChange={(event) => updateKdfPolicySetting(event.target.value as KdfPolicyId)}
            >
              {KDF_POLICY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <div className="settings-field secret-key-setting">
            <span>Secret key</span>
            <textarea
              className="secret-key-display"
              readOnly
              rows={2}
              value={settings.secretKey ?? 'Not set'}
              onFocus={(event) => event.currentTarget.select()}
            />
            <div className="secret-key-actions">
              <button
                type="button"
                className="secondary-button compact-button"
                onClick={() => void generateSecretKey()}
              >
                Generate
              </button>
              <button
                type="button"
                className="secondary-button compact-button"
                disabled={!settings.secretKey}
                onClick={clearSecretKey}
              >
                Clear
              </button>
              <button
                type="button"
                className="secondary-button compact-button"
                onClick={() => void pasteSecretKey()}
              >
                Paste
              </button>
              <button
                type="button"
                className="secondary-button compact-button toolbar-icon-button"
                disabled={!settings.secretKey}
                aria-label="Show Secret key QR"
                title="Show Secret key QR"
                onClick={() => {
                  if (settings.secretKey) {
                    setSecretKeyManualDialog({ kind: 'qr', keyString: settings.secretKey })
                  }
                }}
              >
                <ToolbarIcon icon={qrCodeIcon} />
              </button>
            </div>
            {secretKeySettingsMessage ? (
              <p
                className={`secret-key-settings-message message-${secretKeySettingsMessage.tone}`}
                role="status"
              >
                {secretKeySettingsMessage.text}
              </p>
            ) : null}
          </div>
        </details>

        <div className="settings-about">
          <p className="settings-version">
            Version <span className="build-version">{buildLabel()}</span>
          </p>
          <button
            type="button"
            className="secondary-button compact-button"
            onClick={() => void handleCheckForUpdates()}
          >
            Check for updates
          </button>
        </div>
        </div>

        <div className="dialog-actions">
          <button
            type="button"
            className="primary-button compact-button"
            onClick={() => setIsHomeSettingsOpen(false)}
          >
            Close
          </button>
        </div>
    </ModalShell>
  ) : null

  const secretKeyManualDialogElement =
    secretKeyManualDialog === null ? null : secretKeyManualDialog.kind === 'qr' ? (
      <ModalShell
        id="secret-key-qr-dialog"
        className="settings-dialog secret-key-qr-dialog"
        labelledBy="secret-key-qr-title"
        onEscape={() => setSecretKeyManualDialog(null)}
      >
        <h2 id="secret-key-qr-title">Secret key QR</h2>
        <p>Scan this on another device, then paste it in that device&apos;s Secret key settings.</p>
        <Suspense fallback={null}>
          <SecretKeyQr value={secretKeyManualDialog.keyString} />
        </Suspense>
        <div className="dialog-actions">
          <button
            type="button"
            className="primary-button compact-button"
            onClick={() => setSecretKeyManualDialog(null)}
          >
            Done
          </button>
        </div>
      </ModalShell>
    ) : (
      <ModalShell
        as="form"
        id="secret-key-paste-dialog"
        className="settings-dialog"
        labelledBy="secret-key-paste-title"
        onEscape={() => setSecretKeyManualDialog(null)}
        onSubmit={(event) => {
          event.preventDefault()
          void submitManualSecretKeyPaste()
        }}
      >
        <h2 id="secret-key-paste-title">Paste Secret key</h2>
        <label className="settings-field" htmlFor="secret-key-manual-paste">
          Secret key
          <textarea
            id="secret-key-manual-paste"
            className="secret-key-manual-text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={secretKeyManualDialog.value}
            onChange={(event) =>
              setSecretKeyManualDialog({
                kind: 'paste',
                error: '',
                value: event.target.value,
              })
            }
          />
        </label>
        {secretKeyManualDialog.error ? (
          <p className="dialog-error" role="alert">
            {secretKeyManualDialog.error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button
            type="button"
            className="secondary-button compact-button"
            onClick={() => setSecretKeyManualDialog(null)}
          >
            Cancel
          </button>
          <button type="submit" className="primary-button compact-button">
            Paste
          </button>
        </div>
      </ModalShell>
    )

  const unlinkConfirmDialog = isUnlinkConfirmOpen ? (
    <ModalShell
      id="unlink-confirm-dialog"
      className="settings-dialog"
      labelledBy="unlink-confirm-title"
      role="alertdialog"
      onEscape={() => setIsUnlinkConfirmOpen(false)}
    >
      <h2 id="unlink-confirm-title">Unlink Dropbox?</h2>
      <p>
        This unlinks Dropbox from this app. Cached files stay visible and can be opened
        read-only or exported. Files with changes not yet on Dropbox will not sync until
        Dropbox is linked again.
      </p>
      <div className="dialog-actions">
        <button
          type="button"
          className="secondary-button compact-button"
          onClick={() => setIsUnlinkConfirmOpen(false)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="primary-button compact-button"
          onClick={() => void performUnlinkDropbox()}
        >
          Unlink
        </button>
      </div>
    </ModalShell>
  ) : null

  const linkContinueDialog = linkContinuePrompt !== null ? (
    <ModalShell
      id="link-continue-dialog"
      className="settings-dialog"
      labelledBy="link-continue-title"
      role="alertdialog"
      onEscape={() => setLinkContinuePrompt(null)}
    >
      <h2 id="link-continue-title">Continue with this account?</h2>
      <p>
        This app has authorization for {linkContinuePrompt}. Continue with this account, or
        switch to a different one.
      </p>
      <div className="dialog-actions">
        <button
          type="button"
          className="secondary-button compact-button"
          onClick={() => setLinkContinuePrompt(null)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="secondary-button compact-button"
          onClick={() => {
            setLinkContinuePrompt(null)
            void linkDropbox({
              forceReapprove: true,
              forceReauthentication: true,
              forgetRetainedAuth: true,
            })
          }}
        >
          Switch
        </button>
        <button
          type="button"
          className="primary-button compact-button"
          onClick={() => {
            setLinkContinuePrompt(null)
            void linkDropbox({ forceReapprove: true })
          }}
        >
          Continue
        </button>
      </div>
    </ModalShell>
  ) : null

  const helpDialogElement = helpContext ? (
    <ModalShell
      id="help-dialog"
      className="settings-dialog help-dialog has-pinned-actions"
      initialFocus="dialog"
      labelledBy="help-dialog-title"
      onEscape={closeHelpDialog}
    >
      <h2 id="help-dialog-title">Help</h2>
      <div ref={helpScrollRef} className="settings-scroll help-scroll">
        <HelpContent markdown={getHelpMarkdown(helpContext)} onLinkClick={handleHelpLinkClick} />
      </div>
      <div className="dialog-actions help-dialog-actions">
        <button
          type="button"
          className="secondary-button compact-button help-back-button"
          disabled={helpBackScrollTop === null}
          onClick={handleHelpBack}
        >
          Back
        </button>
        <button
          type="button"
          className="primary-button compact-button"
          onClick={closeHelpDialog}
        >
          Close
        </button>
      </div>
    </ModalShell>
  ) : null

  // The shared upper-right chrome for the locked/home screens: the Settings dialog
  // plus the update dialog. Identical across all three home variants.
  const homeChrome = (
    <>
      {homeSettingsDialog}
      {secretKeyManualDialogElement}
      {unlinkConfirmDialog}
      {linkContinueDialog}
      {updateDialogNode}
      {helpDialogElement}
    </>
  )

  // The Dropbox file browser and the password dialogs (SPEC §9/§10), rendered
  // on the unified Dropbox-Mode home, the Local File home (Open/Browse), and
  // in the editor (Upload to Dropbox, Save As).
  const dropboxFlowDialogs = (
    <>
      {dropboxBrowserRequest !== null ? (
        <ModalShell
          className="settings-dialog dropbox-browser-dialog"
          labelledBy="dropbox-browser-title"
          onEscape={() => settleDropboxBrowser(null)}
        >
          <DropboxFileBrowser
            mode={dropboxBrowserRequest.mode}
            listFolder={(path) => {
              const provider = getDropboxProvider()

              if (!provider) {
                throw new DropboxProviderError('unlinked', 'Dropbox is not linked.')
              }

              return provider.listFolder(path)
            }}
            defaultFileName={dropboxBrowserRequest.defaultFileName}
            initialFolder={dropboxBrowserRequest.initialFolder}
            markedPathLower={dropboxSyncState?.selectedPathDisplay?.toLowerCase() ?? null}
            onCancel={() => settleDropboxBrowser(null)}
            onChooseFile={(path) => settleDropboxBrowser({ path })}
            onChooseDestination={(path) => settleDropboxBrowser({ path })}
            onNavigate={(folderPath) => {
              // Browse-and-cancel still counts as browsing (SPEC §9).
              lastBrowsedDropboxFolderRef.current = folderPath
            }}
          />
        </ModalShell>
      ) : null}
      {unlockDialogRequest !== null ? (
        <ModalShell
          className="settings-dialog password-dialog-shell"
          labelledBy="password-dialog-title"
          onEscape={unlockDialogRequest.busy ? undefined : cancelUnlockPassword}
        >
          <PasswordDialog
            mode="unlock"
            title={unlockDialogRequest.title}
            submitLabel="Unlock"
            busy={unlockDialogRequest.busy}
            errorMessage={unlockDialogRequest.error}
            secretKeyField={unlockDialogRequest.secretKeyField}
            onCancel={cancelUnlockPassword}
            onSubmit={(password, secretKey) =>
              void submitUnlockPassword(
                password,
                secretKey?.kind === 'unlock-key' ? secretKey.value : null,
              )
            }
          />
        </ModalShell>
      ) : null}
      {createPasswordRequest !== null ? (
        <ModalShell
          className="settings-dialog password-dialog-shell"
          labelledBy="password-dialog-title"
          onEscape={() => settleCreatePassword(null)}
        >
          <PasswordDialog
            mode="create"
            title={createPasswordRequest.title}
            submitLabel={createPasswordRequest.submitLabel}
            kdfPolicyToggle={{
              initialStrong: createPasswordRequest.initialKdfPolicy === 'strong',
              onConfirmStrong: confirmStrongKdfPolicy,
            }}
            secretKeyToggle={createPasswordRequest.secretKey}
            onCancel={() => settleCreatePassword(null)}
            onSubmit={(password, secretKey, kdfPolicy) =>
              settleCreatePassword({
                kdfPolicy: kdfPolicy ?? createPasswordRequest.initialKdfPolicy,
                password,
                secretKeyOn: secretKey?.kind === 'toggle' ? secretKey.on : false,
              })
            }
          />
        </ModalShell>
      ) : null}
    </>
  )

  const draftDeleteConfirmDialog = isDeleteVaultConfirmOpen ? (
    <ModalShell
      className="settings-dialog"
      labelledBy="delete-vault-confirm-title"
      onEscape={() => setIsDeleteVaultConfirmOpen(false)}
    >
      <h2 id="delete-vault-confirm-title">Delete the draft?</h2>
      <p>This permanently deletes the draft. Dropbox files are unaffected.</p>
      <div className="dialog-actions">
        <button
          type="button"
          className="secondary-button compact-button"
          onClick={() => setIsDeleteVaultConfirmOpen(false)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="primary-button compact-button"
          onClick={() => void deleteVaultNow()}
        >
          OK
        </button>
      </div>
    </ModalShell>
  ) : null

  const draftImportInput = (
    <input
      ref={importFileInputRef}
      id="encrypted-file-import"
      aria-label="Import encrypted file"
      className="visually-hidden"
      type="file"
      accept=".txt,.text"
      tabIndex={-1}
      onChange={(event) => void importEncryptedFile(event)}
    />
  )

  const draftPersistenceMessage =
    storagePersisted === true
      ? 'Draft is protected from automatic eviction.'
      : storagePersisted === false
        ? 'Draft may be evicted under storage pressure.'
        : storagePersisted === null
          ? 'This browser may clear drafts; keep a backup.'
          : null

  const renderDraftActions = (
    mode: 'dropbox' | 'local-file',
    options: { isDropboxLinked?: boolean } = {},
  ) => {
    const isDropboxLinked = options.isDropboxLinked ?? false

    return (
      <>
        {/* The draft/Files actions (SPEC §10): no password field on the
            screen — New draft opens the two-field create dialog, Edit draft the
            single-field unlock dialog. Provider recent-file caches do not count
            as a draft. */}
        <div className={`vault-actions draft-actions draft-actions-${mode}`}>
          <button
            type="button"
            className="draft-action-primary"
            onClick={() => void (hasDraft ? editDraft() : createNewDraft())}
          >
            {hasDraft ? 'Edit draft' : 'New draft'}
          </button>
          <button
            type="button"
            className="draft-icon-button"
            aria-label="Delete draft"
            title="Delete draft"
            disabled={!hasDraft}
            onClick={() => setIsDeleteVaultConfirmOpen(true)}
          >
            <ToolbarIcon icon={trashIcon} />
          </button>
          {mode === 'local-file' ? (
            <button
              type="button"
              className="draft-icon-button"
              aria-label="Save As"
              title="Save As"
              disabled={!hasDraft}
              onClick={() => void promoteDraftToLocalFile()}
            >
              <ToolbarIcon icon={saveAsIcon} />
            </button>
          ) : (
            <>
              <button
                type="button"
                className={`draft-icon-button${hasDraft && !isDropboxLinked ? ' is-muted' : ''}`}
                aria-label="Dropbox"
                aria-disabled={hasDraft && !isDropboxLinked}
                disabled={!hasDraft}
                title={isDropboxLinked ? 'Save draft to Dropbox' : 'Link Dropbox first'}
                onClick={() => void promoteDraftToDropbox()}
              >
                <ToolbarIcon icon={dropboxIcon} />
              </button>
              <button
                type="button"
                className="draft-icon-button"
                aria-label="Export draft"
                title="Export draft"
                disabled={!hasDraft}
                onClick={() => void exportVaultEnvelope()}
              >
                <ToolbarIcon icon={exportIcon} />
              </button>
              <button
                type="button"
                className="draft-icon-button"
                aria-label="Import draft"
                title="Import draft"
                onClick={() => importFileInputRef.current?.click()}
              >
                <ToolbarIcon icon={importIcon} />
              </button>
            </>
          )}
        </div>
        {draftPersistenceMessage ? (
          <p className="draft-persistence-status" role="status">
            {draftPersistenceMessage}
          </p>
        ) : null}
        {mode === 'dropbox' ? draftImportInput : null}
        {draftDeleteConfirmDialog}
      </>
    )
  }
  // Local file diagnostic preview hidden for now; flip to true to restore.
  const showLocalFileDiagnosticPreview = false

  if (isLoading) {
    return (
      <main className={`app-shell ${appThemeClass}`}>
        <section className="auth-panel" aria-live="polite">
          <h1>eNoteWeb</h1>
          <p>Opening local vault storage...</p>
        </section>
      </main>
    )
  }

  if (!isUnlocked) {
    const isLocalFileMode = homeStorageProviderKind === 'local-file'

    if (isLocalFileMode) {
      const selectedLocalFileRecord = getActiveLocalFileRecord()
      const hasRecentLocalFile = Boolean(selectedLocalFileRecord)
      const localRecentFiles: RecentFileTableRow[] = localFileRecords.map((record) => ({
        key: record.key,
        name: record.displayName ?? 'Unnamed file',
        folderPath: record.displayPath ?? LOCAL_FILE_PATH_UNAVAILABLE,
        timestampAt: record.lastModifiedAt,
      }))

      return (
        <HomeShell themeClass={appThemeClass} settingsDialog={homeChrome}>
          <section className="auth-panel dropbox-panel" aria-labelledby="app-title">
            <BrandRow
              onOpenSettings={openHomeSettings}
              updateAvailable={stagedUpdateAvailable}
            />

            <div className="dropbox-status-card">
              <div className="dropbox-block">
                <div className="dropbox-block-header">
                  <span className="dropbox-block-title">
                    <ToolbarIcon icon={localStorageIcon} />
                    <span>Local files</span>
                  </span>
                  {message && messageScope === 'local' ? (
                    <span
                      className={`dropbox-block-message message-${messageTone}`}
                      role="status"
                    >
                      {message}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="secondary-button compact-button dropbox-block-browse"
                    aria-label="Set path root"
                    title="Set path root"
                    onClick={() => void setLocalFilePathRoot()}
                  >
                    <ToolbarIcon icon={hierarchyIcon} />
                  </button>
                </div>

                <RecentFilesTable
                  columnOrder={settings.recentsColumnOrder.local}
                  onColumnOrderChange={(order, widths) => {
                    updateSetting('recentsColumnOrder', {
                      ...settings.recentsColumnOrder,
                      local: order,
                    })
                    updateSetting('recentsColumnWidths', {
                      ...settings.recentsColumnWidths,
                      local: widths,
                    })
                  }}
                  columnWidths={settings.recentsColumnWidths.local}
                  onColumnWidthsChange={(widths) =>
                    updateSetting('recentsColumnWidths', {
                      ...settings.recentsColumnWidths,
                      local: widths,
                    })
                  }
                  emptyMessage="No recent files yet."
                  columns={standardRecentColumns('Last modified')}
                  files={localRecentFiles}
                  onSelect={(key) => void selectLocalFileRecord(key)}
                  onDeleteFromList={(key) => void removeLocalFileFromList(key)}
                  selectedKey={selectedLocalFileRecord?.key ?? null}
                />

                <div className="dropbox-block-actions">
                  <button
                    type="button"
                    className="secondary-button compact-button dropbox-block-browse"
                    aria-label="Browse"
                    title="Browse"
                    onClick={() => void browseAndUnlockLocalEncryptedFile()}
                  >
                    <ToolbarIcon icon={folderIcon} />
                  </button>
                  <button
                    type="button"
                    className="secondary-button compact-button"
                    disabled={!hasRecentLocalFile}
                    onClick={() => void unlockSelectedLocalFile()}
                  >
                    Open
                  </button>
                </div>
              </div>
            </div>

            {message && messageScope === 'global' ? (
              <DismissibleBanner
                text={message}
                className={`form-message message-${messageTone}`}
                onDismiss={clearMessage}
                dismissLabel="Dismiss message"
              />
            ) : null}

            {renderDraftActions('local-file')}

            {/* The unlock and create-password dialogs serve this home's
                Open/Browse and shared draft actions. */}
            {dropboxFlowDialogs}

            {showLocalFileDiagnosticPreview && localFileDiagnosticEntries.length > 0 ? (
              <pre className="local-file-diagnostic">
                {localFileDiagnosticEntries.join('\n\n')}
              </pre>
            ) : null}
          </section>
        </HomeShell>
      )
    }

    // Unified Dropbox-mode home: dropboxSyncState is kept fresh from the
    // singleton (effect below) so the Dropbox section is accurate while the
    // Local files mode stays on its separate provider-specific home above.
    if (!isLocalFileMode) {
      const isDropboxLinked = dropboxSyncState?.linked ?? false
      // Authorization-lost vs voluntary unlink (SPEC §9): both are unlinked;
      // the persisted authLost flag is what shows Relink + the export-only
      // table instead of the bare Link button.
      const isDropboxAuthLost = !isDropboxLinked && (dropboxSyncState?.authLost ?? false)
      const recentFiles = dropboxRecentFiles?.files ?? []
      const hasRecentDropboxFiles = recentFiles.length > 0
      const isDropboxPausedWithRecents =
        !isDropboxLinked &&
        !isDropboxAuthLost &&
        !dropboxSyncState?.pendingAccountSwitch &&
        hasRecentDropboxFiles
      const selectedRecentKey = dropboxRecentFiles?.selectedKey ?? null
      const selectedRecentFile =
        recentFiles.find((file) => file.key === selectedRecentKey) ?? null
      // Indicators are session memory shown only while online (SPEC §9):
      // resolution and re-checks need the network, so an offline home simply
      // hides them (connectivityTick re-renders on the transition).
      const visibleRecentIndicators =
        connectivityTick >= 0 && globalThis.navigator?.onLine !== false
          ? recentFileIndicators
          : undefined
      const selectedRecentIndicator = selectedRecentKey
        ? visibleRecentIndicators?.get(selectedRecentKey)
        : undefined

      return (
        <HomeShell themeClass={appThemeClass} settingsDialog={homeChrome}
      >
          <section className="auth-panel dropbox-panel" aria-labelledby="app-title">
            <BrandRow
              onOpenSettings={openHomeSettings}
              updateAvailable={stagedUpdateAvailable}
            />

            <div className="dropbox-status-card">
              <div className="dropbox-block">
                <div className="dropbox-block-header">
                  <span className="dropbox-block-title">
                    <ToolbarIcon icon={dropboxIcon} />
                    <span>Dropbox</span>
                  </span>
                  {message && messageScope === 'dropbox' ? (
                    <span
                      className={`dropbox-block-message message-${messageTone}`}
                      role="status"
                    >
                      {message}
                    </span>
                  ) : null}
                  {isDropboxLinked ? (
                    // Sync took the corner Unlink's place (Unlink moved to Home
                    // Settings). Icon button styled like Browse.
                    <button
                      type="button"
                      className="secondary-button compact-button dropbox-block-browse"
                      aria-label="Sync"
                      title="Sync"
                      onClick={() => void syncDropboxHome()}
                    >
                      <ToolbarIcon icon={syncIcon} />
                    </button>
                  ) : isDropboxAuthLost ? (
                    // The same begin-link action as Link — there is no
                    // separate relink mechanism (SPEC §9).
                    <button
                      type="button"
                      className="secondary-button compact-button dropbox-block-corner"
                      onClick={() => void linkDropbox()}
                    >
                      Relink
                    </button>
                  ) : isDropboxPausedWithRecents ? (
                    <button
                      type="button"
                      className="secondary-button compact-button dropbox-block-corner"
                      onClick={beginLinkOrPromptAccount}
                    >
                      Link
                    </button>
                  ) : null}
                </div>

                {isDropboxLinked || isDropboxAuthLost || isDropboxPausedWithRecents ? (
                  <>
                    <DropboxRecentFiles
                      columnOrder={settings.recentsColumnOrder.dropbox}
                      onColumnOrderChange={(order, widths) => {
                        updateSetting('recentsColumnOrder', {
                          ...settings.recentsColumnOrder,
                          dropbox: order,
                        })
                        updateSetting('recentsColumnWidths', {
                          ...settings.recentsColumnWidths,
                          dropbox: widths,
                        })
                      }}
                      columnWidths={settings.recentsColumnWidths.dropbox}
                      onColumnWidthsChange={(widths) =>
                        updateSetting('recentsColumnWidths', {
                          ...settings.recentsColumnWidths,
                          dropbox: widths,
                        })
                      }
                      files={recentFiles}
                      selectedKey={selectedRecentKey}
                      indicators={visibleRecentIndicators}
                      onSelect={selectRecentRow}
                      onDeleteFromList={(key) => void deleteRecentFromList(key)}
                    />
                    <div className="dropbox-block-actions">
                      <button
                        type="button"
                        className="secondary-button compact-button dropbox-block-browse"
                        aria-label="Browse"
                        title="Browse"
                        // Visible but disabled while authorization is lost
                        // (SPEC §9): browsing cannot succeed without a grant.
                        disabled={isDropboxAuthLost || isDropboxPausedWithRecents}
                        onClick={() => void chooseDropboxFile()}
                      >
                        <ToolbarIcon icon={folderIcon} />
                      </button>
                      {isDropboxAuthLost ||
                      selectedRecentIndicator === 'missing' ||
                      selectedRecentIndicator === 'ineligible' ? (
                        <button
                          type="button"
                          className="secondary-button compact-button"
                          // Export needs a cached envelope (SPEC §8/§9). The
                          // missing/ineligible selected row is export-only:
                          // the remote side cannot be synced to (SPEC §9).
                          disabled={!selectedRecentFile?.hasCache}
                          onClick={() => void exportSelectedRecentFile()}
                        >
                          Export
                        </button>
                      ) : selectedRecentIndicator === 'diverged' ||
                        selectedRecentIndicator === 'replacement-candidate' ? (
                        <button
                          type="button"
                          className="secondary-button compact-button"
                          onClick={() => void resolveSelectedRecentFile()}
                        >
                          Resolve
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="secondary-button compact-button"
                          disabled={!selectedRecentFile || isDropboxPausedWithRecents && !selectedRecentFile.hasCache}
                          onClick={() => void openSelectedRecentFile()}
                        >
                          Open
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <button
                    type="button"
                    className="secondary-button compact-button dropbox-block-link"
                    onClick={beginLinkOrPromptAccount}
                  >
                    Link
                  </button>
                )}
              </div>
            </div>

            {dropboxSyncState?.pendingAccountSwitch ? (
              <ModalShell
                className="settings-dialog"
                labelledBy="account-switch-title"
                onEscape={() => void resolveAccountSwitch('decline')}
              >
                <h2 id="account-switch-title">Different Dropbox account</h2>
                <p>
                  This is a different Dropbox account. Continue with{' '}
                  {pendingDropboxAccountLabel}?
                  {recentFiles.some((file) => file.hasCache)
                    ? ' Cached files from the previous account will be lost.'
                    : ''}{' '}
                  The draft is kept.
                </p>
                <div className="dialog-actions">
                  <button
                    type="button"
                    className="secondary-button compact-button"
                    onClick={() => void resolveAccountSwitch('decline')}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="primary-button compact-button"
                    onClick={() => void resolveAccountSwitch('adopt')}
                  >
                    Continue
                  </button>
                </div>
              </ModalShell>
            ) : null}

            {showOwnershipNotice && !dropboxSyncState?.pendingAccountSwitch ? (
              <ModalShell
                className="settings-dialog"
                labelledBy="ownership-notice-title"
                onEscape={() => setShowOwnershipNotice(false)}
              >
                <h2 id="ownership-notice-title">Dropbox account linked</h2>
                <p>
                  Your recent files could not be matched to an account, so they now belong to{' '}
                  {dropboxSyncState?.accountLabel ?? 'the linked account'}. Nothing is discarded.
                </p>
                <div className="dialog-actions">
                  <button
                    type="button"
                    className="secondary-button compact-button"
                    onClick={() => void declineOwnershipNotice()}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="primary-button compact-button"
                    onClick={() => setShowOwnershipNotice(false)}
                  >
                    OK
                  </button>
                </div>
              </ModalShell>
            ) : null}

            {message && messageScope === 'global' ? (
            <DismissibleBanner
              text={message}
              className={`form-message message-${messageTone}`}
              onDismiss={clearMessage}
              dismissLabel="Dismiss message"
            />
          ) : null}

            {renderDraftActions('dropbox', { isDropboxLinked })}

            {dropboxFlowDialogs}
          </section>
        </HomeShell>
      )
    }
  }

  const searchValidation = validateSearchQuery(searchQuery, searchOptions)
  const isFindNavigationAvailable = searchValidation.ok

  // Invalid-query feedback ("Invalid regex.", "Regex too expensive.") is pure
  // derived state — a function of the query and options — so it is computed
  // during render rather than pushed from the search effect (which would set
  // state synchronously inside an effect). An empty or valid query shows no
  // validation message. It takes priority over the async/command search message
  // (`searchMessage`), which is cleared on query/option change, so a stale
  // worker timeout or match-count message can never linger over a new invalid
  // query.
  const searchValidationMessage =
    !searchValidation.ok && searchValidation.error !== 'empty-query'
      ? searchValidation.message
      : ''
  const effectiveSearchMessage = searchValidationMessage || searchMessage
  const effectiveSearchMessageTone: MessageTone = searchValidationMessage
    ? 'error'
    : searchMessageTone
  // Search feedback is split by tone: the green match summary ("3 of 3",
  // "Replaced 2 matches.") shows in the status bar while the panel is open; red
  // errors keep their place in the message area below the toolbar. The
  // empty-query case stays silent (handled by searchValidationMessage above).
  const searchInfoMessage =
    isSearchPanelOpen && effectiveSearchMessage && effectiveSearchMessageTone === 'info'
      ? effectiveSearchMessage
      : ''
  const searchErrorMessage =
    effectiveSearchMessage && effectiveSearchMessageTone === 'error' ? effectiveSearchMessage : ''
  // Live match count, updated as the query (or the document) changes — no
  // navigation needed. A command result ("2 of 3", "Replaced
  // 3 matches.") outranks it until the next query/option change clears the
  // command message; an empty or invalid query shows nothing. A capped scan
  // shows "10000+ matches" rather than claiming an exact total.
  const statusbarSearchText =
    searchInfoMessage ||
    (isSearchPanelOpen && searchValidation.ok && liveMatchCount !== null
      ? liveMatchCount.limited
        ? `${liveMatchCount.count}+ matches`
        : `${liveMatchCount.count} ${liveMatchCount.count === 1 ? 'match' : 'matches'}`
      : '')
  const effectiveReadOnly = isReadOnly || isAppReadOnlySession
  const isDropboxFileSession = sessionDocumentKind === 'dropbox-file'
  const hasDropboxConflict =
    isDropboxFileSession && !isAppReadOnlySession && storageStatus?.state === 'conflict'
  // First-sync gate (SPEC §9/§16): the open Dropbox file session is known
  // remotely changed (stale/diverged) — pushing stopped, cache autosave
  // continues — but no conflict snapshot is captured yet.
  const showDropboxPausedBanner =
    isDropboxSessionPaused && isDropboxFileSession && !isAppReadOnlySession && !hasDropboxConflict
  // The single in-editor Resolve banner: shown for every stored-state way a
  // conflict arises — the
  // first-sync-gate pause, a diverged/stale background result (also a pause), or
  // a 409-captured conflict — and hidden once the conflict modal is open (the
  // merge UI takes over) or the state clears. It is the ONLY in-editor entry to
  // resolution, so it must not get stuck hidden
  // while genuinely diverged: both the pause and the captured-conflict signals
  // drive it.
  const showResolveBanner =
    conflictModal.mode === 'closed' && (showDropboxPausedBanner || hasDropboxConflict)
  // `connectivityTick` re-renders on every online/offline transition, so reading
  // navigator.onLine here keeps the banner's offline copy and the Resolve
  // button's muting current.
  const isOffline = connectivityTick >= 0 && globalThis.navigator?.onLine === false

  // The Markdown preview pane/toggle exists only in markdown mode (SPEC Section
  // 11). In plain mode the toggle is absent and the pane is never rendered, so a
  // preview left open from a previous markdown session stays hidden until the
  // user returns to markdown mode.
  const isMarkdownMode = settings.editorMode === 'markdown'
  const isPreviewOpen = isMarkdownMode && isPreviewVisible

  // Status bar document kind (SPEC §15): Local files / Dropbox / Draft —
  // keyed on the session's document, not the storage mode.
  const providerStatusLabel =
    sessionDocumentKind === 'draft'
      ? 'Draft'
      : sessionDocumentKind === 'dropbox-file'
        ? 'Dropbox'
        : activeStorageProvider.kind === 'local-file'
          ? 'Local files'
          : 'Draft'
  // Shared decision for all three Dropbox sync indicators (icon, pill, footer) so
  // they can never disagree (SPEC §9).
  const dropboxSyncDisplay = deriveDropboxSyncDisplay(
    storageStatus,
    saveStatus,
    dropboxSyncState?.linked ?? false,
  )
  const dropboxSyncStatusLabel =
    dropboxSyncDisplay.kind === 'synced'
      ? 'Synced'
      : dropboxSyncDisplay.kind === 'unsynced'
        ? 'Unsynced'
        : dropboxSyncDisplay.kind === 'offline'
          ? 'Offline'
            : dropboxSyncDisplay.kind === 'conflict'
              ? 'Conflict'
              : dropboxSyncDisplay.linked
                ? 'Check Dropbox'
                : 'Not linked'
  // Line 1 of the toolbar status: which document is open (SPEC §15). Local
  // file and Dropbox file sessions show the bound file's name; a draft
  // session reads "Draft". CSS truncates with an ellipsis.
  const editorFileLabel =
    sessionDocumentKind === 'draft'
      ? 'Draft'
      : sessionDocumentKind === 'dropbox-file'
        ? (dropboxSyncState?.selectedName ?? dropboxSyncState?.selectedPathDisplay ?? 'Dropbox file')
        : activeStorageProvider.kind === 'local-file'
          ? (getActiveLocalFileRecord()?.displayName ?? 'Local files')
          : 'Draft'

  const editorCrashFallback = (
    <main className={`editor-shell theme-${settings.theme}`}>
      <ModalShell
        className="save-as-dialog"
        role="alertdialog"
        labelledBy="editor-crash-title"
      >
          <h2 id="editor-crash-title">The editor hit an unexpected error</h2>
          <p className="dialog-message message-error">
            An automatic encrypted save was attempted. Export an encrypted copy if you want to
            be safe, then lock the vault to clear the document from memory and unlock again.
          </p>
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary-button compact-button"
              onClick={() => void exportToFiles()}
            >
              Export encrypted copy
            </button>
            <button
              type="button"
              className="primary-button compact-button"
              autoFocus
              onClick={() => void forceLockAfterCrash()}
            >
              Lock vault
            </button>
          </div>
      </ModalShell>
    </main>
  )

  return (
    <EditorErrorBoundary fallback={editorCrashFallback} onCrash={handleEditorCrash}>
    <main
      className={`editor-shell theme-${settings.theme}${
        isKeyboardUp && isEditorFocused ? ' is-typing-in-editor' : ''
      }`}
    >
      <header className="editor-toolbar">
        {/* Home + status are pinned to the left edge; all other controls sit
            in the right-aligned actions row. */}
        <div className="toolbar-status">
          <button
            type="button"
            className="secondary-button compact-button toolbar-icon-button"
            aria-label="Home"
            title="Home"
            onClick={() => setIsExitConfirmOpen(true)}
          >
            <ToolbarIcon icon={homeIcon} />
          </button>
          <div className="toolbar-status-text">
            <p className="toolbar-file-name" title={editorFileLabel}>
              {editorFileLabel}
            </p>
            <p className={`save-status save-status-${saveStatus}`}>
              {saveStatus === 'dirty'
                ? 'Unsaved changes'
                : saveStatus === 'saving'
                  ? 'Encrypting autosave...'
                  : saveStatus === 'error'
                    ? 'Autosave failed'
                    : passwordChangedNotice
                      ? 'Password changed'
                      : hasSavedThisSession
                        ? 'Autosaved'
                        : 'Opened'}
              {isDropboxFileSession ? (
                <>
                  {' · '}
                  <span
                    className={`storage-inline-status storage-inline-status-${dropboxSyncToneSuffix(
                      dropboxSyncDisplay,
                      storageStatus,
                    )}`}
                  >
                    {dropboxSyncStatusLabel}
                  </span>
                </>
              ) : null}
            </p>
          </div>
        </div>

        <div className="toolbar-corner">
          <span className="toolbar-separator toolbar-corner-separator" aria-hidden="true" />
          <button
            type="button"
            className={`secondary-button compact-button toolbar-icon-button read-only-toggle${
              isReadOnly ? ' is-active' : ''
            }`}
            aria-label="Read-only"
            aria-pressed={isReadOnly}
            disabled={isAppReadOnlySession}
            title={
              isAppReadOnlySession
                ? 'Dropbox is unlinked; this cached file is read-only'
                : 'Read-only'
            }
            onClick={() => void toggleReadOnly()}
          >
            <ToolbarIcon icon={isReadOnly ? readOnlyOnIcon : readOnlyOffIcon} />
          </button>
          <button
            type="button"
            className={`secondary-button compact-button toolbar-icon-button settings-toggle${
              isSettingsDialogOpen ? ' is-active' : ''
            }`}
            aria-controls="settings-dialog"
            aria-expanded={isSettingsDialogOpen}
            aria-label="Settings"
            title="Settings"
            onClick={() => setIsSettingsDialogOpen(true)}
          >
            <ToolbarIcon icon={settingsIcon} />
          </button>
        </div>

        <div className="toolbar-actions" aria-label="Editor controls">
          <button
            type="button"
            className="secondary-button compact-button toolbar-icon-button"
            aria-label="Undo"
            disabled={!canUndo}
            title="Undo"
            onClick={() => editorRef.current?.undo()}
          >
            <ToolbarIcon icon={undoIcon} />
          </button>
          <button
            type="button"
            className="secondary-button compact-button toolbar-icon-button"
            aria-label="Redo"
            disabled={!canRedo}
            title="Redo"
            onClick={() => editorRef.current?.redo()}
          >
            <ToolbarIcon icon={redoIcon} />
          </button>
          {isMarkdownMode ? (
            <>
              <span className="toolbar-separator" aria-hidden="true" />
              <button
                type="button"
                className={`secondary-button compact-button toolbar-icon-button preview-toggle${
                  isPreviewVisible ? ' is-active' : ''
                }`}
                aria-label="Preview markdown"
                aria-pressed={isPreviewVisible}
                title="Preview markdown"
                onClick={togglePreview}
              >
                <ToolbarIcon icon={markdownIcon} />
              </button>
            </>
          ) : null}
          <span className="toolbar-separator" aria-hidden="true" />
          <button
            type="button"
            className="secondary-button compact-button toolbar-icon-button"
            aria-label="Insert random string"
            disabled={effectiveReadOnly}
            title="Random string"
            onClick={insertRandomString}
          >
            <ToolbarIcon icon={randomStringIcon} />
          </button>
          <button
            type="button"
            className="secondary-button compact-button toolbar-icon-button"
            aria-label="Change password"
            disabled={isAppReadOnlySession}
            title="Change password"
            onClick={() => void changePassword()}
          >
            <ToolbarIcon icon={changePasswordIcon} />
          </button>
          <span className="toolbar-separator" aria-hidden="true" />
          {editorStorageProviderKind === 'local-file' ? (
            // Local sessions (local file AND a Local-home draft): Save As only.
            // There is no Save button — autosave is the continuous save — and
            // no Export:
            // Save As already writes an encrypted file to local disk with no
            // network dependency, so it IS the offline savior. Save As branches
            // to a new local file and rebinds (draft → promotion).
            <button
              type="button"
              className="secondary-button compact-button toolbar-icon-button"
              aria-label="Save As…"
              disabled={isAppReadOnlySession}
              title="Save As…"
              onClick={() => void saveAsEncryptedFile()}
            >
              <ToolbarIcon icon={saveAsIcon} />
            </button>
          ) : (
            <>
              {/* Dropbox sessions (file AND draft): Dropbox + Export. No Save
                  button — autosave already pushes revision-conditionally, and
                  conflict resolution is in the Resolve banner below. The Dropbox
                  button means "save a copy to
                  Dropbox / upload as a new Dropbox file and edit it there", NOT
                  "sync this file" — so the accessible label is descriptive
                  ("Save to Dropbox"). For a Dropbox-file session, choosing the
                  session's OWN file is the deliberate force-out-of-conflict exit
                  (uploadToDropbox handles it by id). Muted-but-
                  tappable while unlinked: the editor never starts linking (that
                  redirect would drop the unlocked session — Home-only), so the
                  button points the user to Home instead of acting. */}
              <button
                type="button"
                className={`secondary-button compact-button toolbar-icon-button${
                  dropboxSyncState?.linked ? '' : ' is-muted'
                }`}
                aria-label="Save to Dropbox"
                aria-disabled={!dropboxSyncState?.linked || isAppReadOnlySession}
                title={
                  isAppReadOnlySession
                    ? 'Dropbox is unlinked; this cached file is read-only'
                    : dropboxSyncState?.linked
                      ? 'Save to Dropbox'
                      : 'Link Dropbox from the Home screen to save there'
                }
                onClick={() => void uploadToDropbox()}
              >
                <ToolbarIcon icon={dropboxIcon} />
              </button>
              <button
                type="button"
                className="secondary-button compact-button toolbar-icon-button"
                aria-label="Export to Files"
                title="Export to Files"
                onClick={() => void exportToFiles()}
              >
                <ToolbarIcon icon={exportIcon} />
              </button>
            </>
          )}
          {/* Search sits at the far right of the actions row: a
              separator after all the save-related buttons, then the Search
              toggle. handleSearchToggleButton focuses the Find field inside the
              tap so iOS raises the keyboard. */}
          <span className="toolbar-separator" aria-hidden="true" />
          <button
            type="button"
            className={`secondary-button compact-button toolbar-icon-button search-toggle${
              isSearchPanelOpen ? ' is-active' : ''
            }`}
            aria-controls="search-panel"
            aria-expanded={isSearchPanelOpen}
            aria-label="Search"
            title="Search"
            onClick={handleSearchToggleButton}
          >
            <ToolbarIcon icon={searchIcon} />
          </button>
        </div>
      </header>

      {isSearchPanelOpen && !isSoftLocked ? (
        <section
          id="search-panel"
          ref={searchPanelRef}
          className="search-panel"
          aria-label="Find and replace"
          // Escape anywhere inside the panel closes it and returns focus to
          // the editor (toggleSearchPanel handles the refocus).
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              event.stopPropagation()
              toggleSearchPanel()
            }
          }}
        >
          <form
            className="search-panel-row find-panel-row"
            onSubmit={(event) => {
              event.preventDefault()
              if (isFindNavigationAvailable) {
                void findNextMatch()
              }
            }}
          >
            <label className="visually-hidden" htmlFor="find-text">
              Find text
            </label>
            <div className="search-input-wrap">
              <input
                id="find-text"
                ref={searchInputRef}
                autoComplete="off"
                autoCapitalize="off"
                placeholder="Find"
                type="search"
                value={searchQuery}
                onChange={(event) => updateSearchQuery(event.target.value)}
              />
              {searchQuery ? (
                <button
                  type="button"
                  className="search-clear-button"
                  aria-label="Clear find"
                  title="Clear"
                  // Don't steal focus on press; refocus keeps the mobile
                  // keyboard up after the clear.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    updateSearchQuery('')
                    searchInputRef.current?.focus()
                  }}
                >
                  <span aria-hidden="true">✕</span>
                </button>
              ) : null}
            </div>
            <div className="search-actions">
              <button
                type="button"
                className="secondary-button search-icon-button"
                aria-label="Find previous"
                disabled={!isFindNavigationAvailable}
                title="Find previous"
                onClick={() => void findPreviousMatch()}
              >
                <ToolbarIcon icon={chevronLeftIcon} />
              </button>
              <button
                type="submit"
                className="secondary-button search-icon-button"
                aria-label="Find next"
                disabled={!isFindNavigationAvailable}
                title="Find next"
              >
                <ToolbarIcon icon={chevronRightIcon} />
              </button>
              <button
                type="button"
                className={`secondary-button search-icon-button search-option-button${
                  searchOptions.caseSensitive ? ' is-active' : ''
                }`}
                aria-label="Case sensitive"
                aria-pressed={searchOptions.caseSensitive}
                title="Case sensitive"
                onClick={() => toggleSearchOption('caseSensitive')}
              >
                <ToolbarIcon icon={caseSensitiveIcon} />
              </button>
              <button
                type="button"
                className={`secondary-button search-icon-button search-option-button${
                  searchOptions.wholeWord ? ' is-active' : ''
                }`}
                aria-label="Whole word"
                aria-pressed={searchOptions.wholeWord}
                title="Whole word"
                onClick={() => toggleSearchOption('wholeWord')}
              >
                <ToolbarIcon icon={wholeWordIcon} />
              </button>
              <button
                type="button"
                className={`secondary-button search-icon-button search-option-button${
                  searchOptions.regex ? ' is-active' : ''
                }`}
                aria-label="Regex"
                aria-pressed={searchOptions.regex}
                title="Regex"
                onClick={() => toggleSearchOption('regex')}
              >
                <ToolbarIcon icon={regexIcon} />
              </button>
            </div>
          </form>

          {/* Read-only hides the whole replace row (the buttons would all be
              disabled anyway) which gives a line of space back on phones; the
              draft replace text lives in state, so it survives the round trip. */}
          {!effectiveReadOnly ? (
            <div className="search-panel-row replace-panel-row">
              <label className="visually-hidden" htmlFor="replace-with">
                Replace text
              </label>
              <div className="search-input-wrap">
                <input
                  id="replace-with"
                  ref={replaceInputRef}
                  autoComplete="off"
                  autoCapitalize="off"
                  placeholder="Replace"
                  value={replaceInput}
                  onChange={(event) => setReplaceInput(event.target.value)}
                />
                {replaceInput ? (
                  <button
                    type="button"
                    className="search-clear-button"
                    aria-label="Clear replace"
                    title="Clear"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setReplaceInput('')
                      replaceInputRef.current?.focus()
                    }}
                  >
                    <span aria-hidden="true">✕</span>
                  </button>
                ) : null}
              </div>
              <div className="search-actions replace-actions">
                <button
                  type="button"
                  className="secondary-button search-icon-button"
                  aria-label="Replace previous"
                  title="Replace previous"
                  disabled={!isFindNavigationAvailable}
                  onClick={() => void replaceDirectionalMatch('previous')}
                >
                  <ToolbarIcon icon={chevronLeftIcon} />
                </button>
                <button
                  type="button"
                  className="secondary-button search-icon-button"
                  aria-label="Replace next"
                  title="Replace next"
                  disabled={!isFindNavigationAvailable}
                  onClick={() => void replaceDirectionalMatch('next')}
                >
                  <ToolbarIcon icon={chevronRightIcon} />
                </button>
                <button
                  type="button"
                  className="secondary-button compact-button search-text-button"
                  aria-label="Replace all"
                  title="Replace all"
                  disabled={!isFindNavigationAvailable}
                  onClick={() => void replaceEveryMatch()}
                >
                  <span aria-hidden="true">All</span>
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Save As collects its password through the shared two-field
          create-password dialog, after the destination picker (SPEC §10/§17). */}

      {isLockSaveFailureDialogOpen ? (
        <ModalShell
          className="save-as-dialog"
          role="alertdialog"
          labelledBy="lock-save-failure-title"
        >
            <h2 id="lock-save-failure-title">Couldn&rsquo;t save changes</h2>
            <p className="dialog-message message-error">
              Couldn&rsquo;t save your latest changes — they&rsquo;ll be lost if you exit.
            </p>
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary-button compact-button"
                onClick={() => void exportToFiles()}
              >
                Export a copy
              </button>
              <button
                type="button"
                className="secondary-button compact-button"
                onClick={exitAnywayAfterFailedSave}
              >
                Exit anyway
              </button>
              <button
                type="button"
                className="primary-button compact-button"
                autoFocus
                onClick={stayInEditorAfterFailedExit}
              >
                Stay
              </button>
            </div>
        </ModalShell>
      ) : null}

      {softLockState ? (
        <ModalShell
          as="form"
          className="settings-dialog soft-lock-dialog"
          role="alertdialog"
          labelledBy="soft-lock-title"
          onSubmit={submitSoftLockPassword}
        >
          <h2 id="soft-lock-title">Unsaved changes not saved</h2>
          <p className="dialog-message message-error">
            Unsaved changes will be lost if you exit now. Enter password to continue.
          </p>
          {!softLockState.verified ? (
            <>
              <label className="settings-field" htmlFor="soft-lock-password">
                Password
                <input
                  id="soft-lock-password"
                  autoComplete="current-password"
                  autoFocus
                  type="password"
                  value={softLockState.passwordInput}
                  onChange={(event) =>
                    setSoftLockState((current) =>
                      current
                        ? { ...current, error: '', passwordInput: event.target.value }
                        : current,
                    )
                  }
                />
              </label>
              {softLockState.error ? (
                <p className="dialog-message message-error">{softLockState.error}</p>
              ) : null}
              <div className="dialog-actions">
                <button
                  type="button"
                  className="secondary-button compact-button"
                  onClick={exitSoftLockDiscard}
                >
                  Exit &amp; discard
                </button>
                <button type="submit" className="primary-button compact-button">
                  Unlock options
                </button>
              </div>
            </>
          ) : (
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary-button compact-button"
                onClick={exitSoftLockDiscard}
              >
                Exit &amp; discard
              </button>
              <button
                type="button"
                className="secondary-button compact-button"
                onClick={() => void exportFromSoftLock()}
              >
                Export a copy
              </button>
              <button
                type="button"
                className="primary-button compact-button"
                autoFocus
                onClick={continueFromSoftLock}
              >
                Continue
              </button>
            </div>
          )}
        </ModalShell>
      ) : null}

      {isExitConfirmOpen ? (
        <ModalShell
          id="exit-confirm-dialog"
          className="settings-dialog"
          labelledBy="exit-confirm-title"
          role="alertdialog"
          onEscape={() => setIsExitConfirmOpen(false)}
        >
          <h2 id="exit-confirm-title">Exit?</h2>
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary-button compact-button"
              onClick={() => setIsExitConfirmOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary-button compact-button"
              onClick={() => {
                setIsExitConfirmOpen(false)
                void lockVault()
              }}
            >
              OK
            </button>
          </div>
        </ModalShell>
      ) : null}

      {isSettingsDialogOpen ? (
        <ModalShell
          id="settings-dialog"
          className="settings-dialog has-pinned-actions"
          labelledBy="settings-title"
          onEscape={closeSettingsDialog}
        >
            <div className="settings-title-row">
              <h2 id="settings-title">Settings</h2>
              <button
                type="button"
                className="secondary-button compact-button toolbar-icon-button settings-help-button"
                aria-label="Help"
                title="Help"
                data-skip-initial-focus="true"
                onClick={() => openHelpDialog('editor')}
              >
                <ToolbarIcon icon={helpIcon} />
              </button>
            </div>
            <div className="settings-scroll">
            <div className="settings-grid">
              <ThemeField
                id="theme-setting"
                value={settings.theme}
                onChange={(value) => updateSetting('theme', value)}
              />

              <label className="settings-field" htmlFor="font-setting">
                Font
                <select
                  id="font-setting"
                  value={settings.fontFamily}
                  onChange={(event) => updateSetting('fontFamily', event.target.value)}
                >
                  {fontOptions.map((fontOption) => (
                    <option key={fontOption.label} value={fontOption.value}>
                      {fontOption.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="settings-field" htmlFor="font-size-setting">
                Font size
                <input
                  id="font-size-setting"
                  min="12"
                  max="32"
                  step="1"
                  type="number"
                  value={settings.fontSizePx}
                  onChange={(event) =>
                    updateSetting(
                      'fontSizePx',
                      clampNumber(12, 32, Math.round(Number(event.target.value) || 16)),
                    )
                  }
                />
              </label>

              <label className="settings-field" htmlFor="random-string-length-setting">
                Random string length
                <input
                  id="random-string-length-setting"
                  min={MIN_RANDOM_STRING_LENGTH}
                  max={MAX_RANDOM_STRING_LENGTH}
                  step="1"
                  type="number"
                  value={settings.randomStringLength}
                  onChange={(event) =>
                    updateSetting(
                      'randomStringLength',
                      clampNumber(
                        MIN_RANDOM_STRING_LENGTH,
                        MAX_RANDOM_STRING_LENGTH,
                        Math.round(Number(event.target.value) || DEFAULT_RANDOM_STRING_LENGTH),
                      ),
                    )
                  }
                />
              </label>

              <label className="settings-field" htmlFor="editor-mode-setting">
                Editor mode
                <select
                  id="editor-mode-setting"
                  value={settings.editorMode}
                  onChange={(event) =>
                    updateSetting('editorMode', event.target.value as EditorMode)
                  }
                >
                  <option value="plain">Plain text</option>
                  <option value="markdown">Markdown</option>
                </select>
              </label>

              <label className="settings-field" htmlFor="autocapitalize-setting">
                Autocapitalize
                <select
                  id="autocapitalize-setting"
                  value={settings.autocapitalize}
                  onChange={(event) =>
                    updateSetting(
                      'autocapitalize',
                      event.target.value as AutoCapitalizeSetting,
                    )
                  }
                >
                  <option value="off">Off</option>
                  <option value="none">None</option>
                  <option value="sentences">Sentences</option>
                  <option value="words">Words</option>
                  <option value="characters">Characters</option>
                </select>
              </label>

              <AutoLockField
                id="auto-lock-setting"
                value={settings.autoLockMinutes}
                onChange={(value) => updateSetting('autoLockMinutes', value)}
              />
            </div>

            <div className="settings-checks">
              <label className="settings-checkbox">
                <input
                  id="line-wrap-setting"
                  checked={settings.lineWrap}
                  type="checkbox"
                  onChange={(event) => updateSetting('lineWrap', event.target.checked)}
                />
                Line wrap
              </label>
              <label className="settings-checkbox">
                <input
                  id="show-whitespace-setting"
                  checked={settings.showWhitespace}
                  type="checkbox"
                  onChange={(event) => updateSetting('showWhitespace', event.target.checked)}
                />
                Show whitespace
              </label>
              <label className="settings-checkbox">
                <input
                  id="read-only-setting"
                  checked={isReadOnly}
                  type="checkbox"
                  disabled={isAppReadOnlySession}
                  // Document state, not an app setting: same toggle (and save)
                  // as the toolbar lock button, never `updateSetting`.
                  onChange={() => void toggleReadOnly()}
                />
                Read-only
              </label>
              <label className="settings-checkbox">
                <input
                  id="spellcheck-setting"
                  checked={settings.spellcheck}
                  type="checkbox"
                  onChange={(event) => updateSetting('spellcheck', event.target.checked)}
                />
                Spellcheck
              </label>
              <label className="settings-checkbox">
                <input
                  id="autocorrect-setting"
                  checked={settings.autocorrect}
                  type="checkbox"
                  onChange={(event) => updateSetting('autocorrect', event.target.checked)}
                />
                Autocorrect
              </label>
            </div>

            <div className="settings-about">
              <p className="settings-version">
                Version <span className="build-version">{buildLabel()}</span>
              </p>
            </div>
            </div>

            <div className="dialog-actions">
              <button
                type="button"
                className="primary-button compact-button"
                onClick={closeSettingsDialog}
              >
                Close
              </button>
            </div>
        </ModalShell>
      ) : null}
      {helpDialogElement}

      {!isSoftLocked && (message || searchErrorMessage || showResolveBanner) ? (
        <div className="editor-messages">
          {message ? (
            <DismissibleBanner
              text={message}
              className={`editor-message message-${messageTone}`}
              onDismiss={clearMessage}
              dismissLabel="Dismiss message"
            />
          ) : null}
          {searchErrorMessage ? (
            <p className="editor-message message-error">{searchErrorMessage}</p>
          ) : null}
          {showResolveBanner ? (
            // The Resolve banner is driven by the session's STORED sync state —
            // the first-sync
            // gate (paused), a diverged background result (also paused), or a
            // 409-captured conflict (storageStatus === 'conflict') — so it
            // covers every way a conflict arises, not only a live failure.
            // Resolve CAPTURES the conflict first, then enters the merge
            // (resolveEditorConflict); offline it explains resolution needs a
            // connection while editing + cache autosave continue, and Export
            // stays reachable throughout (a conflicted session can always
            // download an encrypted copy of the current local text).
            <section className="conflict-banner" aria-label="Dropbox conflict">
              <p>
                {isOffline
                  ? 'File changed on Dropbox. Resolving needs a connection; your changes are saved locally.'
                  : 'File changed on Dropbox.'}
              </p>
              <button
                type="button"
                className="secondary-button compact-button"
                onClick={() => void exportLocalConflictCopy()}
              >
                Export local
              </button>
              <button
                type="button"
                className="primary-button compact-button"
                aria-disabled={isOffline}
                onClick={() => void resolveEditorConflict()}
              >
                Resolve…
              </button>
            </section>
          ) : null}
        </div>
      ) : null}

      {!isSoftLocked && conflictModal.mode !== 'closed' ? (
        conflictModal.mode === 'editing' ? (
          // The conflict editor renders its own dialog structure (a full-area
          // merged view with its own controls); it keeps the plain backdrop and
          // is deliberately not routed through ModalShell.
          <div className="dialog-backdrop">
            <Suspense fallback={null}>
              <ConflictEditor
                regions={conflictModal.regions}
                resolutions={conflictResolutions}
                busy={false}
                onChoose={chooseConflict}
                onChooseAll={chooseAllConflicts}
                onSave={saveResolvedConflict}
                onCancel={disposeConflictState}
                onExportLocal={() => void exportLocalConflictCopy()}
                onExportRemote={() => void exportRemoteConflictCopy()}
              />
            </Suspense>
          </div>
        ) : conflictModal.mode === 'non-mergeable' ? (
          <ModalShell
            className="conflict-status-dialog"
            labelledBy="conflict-nonmergeable-title"
            onEscape={disposeConflictState}
          >
              <h2 id="conflict-nonmergeable-title">Can&rsquo;t merge automatically</h2>
              <p>{nonMergeableMessage(conflictModal.reason)}</p>
              <div className="dialog-actions">
                <button
                  type="button"
                  className="secondary-button compact-button"
                  onClick={() => void exportLocalConflictCopy()}
                >
                  Export local
                </button>
                {conflictModal.reason !== 'no-remote' ? (
                  <button
                    type="button"
                    className="secondary-button compact-button"
                    onClick={() => void exportRemoteConflictCopy()}
                  >
                    Export remote
                  </button>
                ) : null}
                {conflictModal.keepLocal ? (
                  <button
                    type="button"
                    className="secondary-button compact-button"
                    onClick={() => {
                      if (conflictModal.mode === 'non-mergeable' && conflictModal.keepLocal) {
                        void conflictController.keepLocal(conflictDeps(), conflictModal.keepLocal)
                      }
                    }}
                  >
                    Keep local
                  </button>
                ) : null}
                {conflictModal.keepRemote ? (
                  <button
                    type="button"
                    className="secondary-button compact-button"
                    onClick={() => {
                      if (conflictModal.mode === 'non-mergeable' && conflictModal.keepRemote) {
                        void conflictController.keepRemote(conflictDeps(), conflictModal.keepRemote)
                      }
                    }}
                  >
                    Keep remote
                  </button>
                ) : (
                  <button
                    type="button"
                    className="secondary-button compact-button"
                    onClick={() => void conflictController.retry(conflictDeps())}
                  >
                    Retry
                  </button>
                )}
                <button
                  type="button"
                  className="primary-button compact-button"
                  onClick={disposeConflictState}
                >
                  Close
                </button>
              </div>
          </ModalShell>
        ) : (
          // Transient progress state: intentionally has no dismiss action (the
          // work is short and cancellation mid-commit is handled elsewhere).
          <ModalShell
            className="conflict-status-dialog"
            role="alertdialog"
            labelledBy="conflict-status-title"
          >
            <h2 id="conflict-status-title">
              {conflictModal.mode === 'committing' ? 'Saving to Dropbox…' : 'Loading conflict…'}
            </h2>
            <p>Working with Dropbox. This will only take a moment.</p>
          </ModalShell>
        )
      ) : null}

      {!isSoftLocked && import.meta.env.DEV ? (
        <button
          type="button"
          className="secondary-button compact-button"
          style={{ position: 'fixed', left: '8px', bottom: '8px', zIndex: 50, opacity: 0.85 }}
          onClick={() => {
            setIsConflictPreview(true)
            setConflictResolutions(new Map())
            setConflictModal({
              mode: 'editing',
              regions: DEV_PREVIEW_REGIONS,
              remoteConflictRev: 'dev-preview',
            })
          }}
        >
          🐞 Preview conflict editor
        </button>
      ) : null}

      {isPreviewOpen && !isSoftLocked ? (
        // Thin one-shot sync row, shown only with the side-by-side preview (CSS
        // hides it in the <=640px overlay). The two halves mirror the 50/50 pane
        // split so each button centers over its pane; the center slot is reserved
        // for the future continuous-sync toggle (C).
        <div className="preview-sync-bar" aria-label="Preview position sync">
          <div className="preview-sync-half">
            <button
              type="button"
              className="secondary-button compact-button"
              title="Jump to Markdown"
              onClick={alignPreviewToEditor}
            >
              Jump to Markdown
            </button>
          </div>
          <div className="preview-sync-center" aria-hidden="true" />
          <div className="preview-sync-half">
            <button
              type="button"
              className="secondary-button compact-button"
              title="Jump to Editor"
              onClick={alignEditorToPreview}
            >
              Jump to Editor
            </button>
          </div>
        </div>
      ) : null}

      <div
        className={`editor-region${isPreviewOpen && !isSoftLocked ? ' is-split' : ''}${
          isSoftLocked ? ' is-soft-locked' : ''
        }`}
      >
        {isSoftLocked ? (
          <div className="editor-soft-lock-blackout" aria-hidden="true" />
        ) : (
          <>
            <CodeMirrorEditor
              ref={editorRef}
              autocapitalize={settings.autocapitalize}
              autocorrect={settings.autocorrect}
              editorMode={settings.editorMode}
              fontFamily={settings.fontFamily}
              fontSizePx={settings.fontSizePx}
              lineWrap={settings.lineWrap}
              readOnly={effectiveReadOnly}
              showWhitespace={settings.showWhitespace}
              spellcheck={settings.spellcheck}
              value={plaintext}
              onChange={handleEditorChange}
              onCursorChange={handleCursorChange}
              onHistoryAvailabilityChange={handleHistoryAvailabilityChange}
              onLineWordCopied={() => showMessage('Last word copied.', 'info')}
              onFocusChange={setIsEditorFocused}
              topScrollMargin={isSearchPanelOpen ? searchPanelHeight : 0}
            />
            {isPreviewOpen ? (
              <MarkdownPreview
                ref={previewRef}
                fontFamily={settings.fontFamily}
                fontSizePx={settings.fontSizePx}
                source={plaintext}
              />
            ) : null}
          </>
        )}
      </div>

      {isSoftLocked ? (
        <footer className="editor-statusbar" aria-label="Editor status">
          <div className="statusbar-group statusbar-meta">
            <span className="statusbar-item">Soft locked</span>
          </div>
        </footer>
      ) : (
        <footer className="editor-statusbar" aria-label="Editor status">
          <div className="statusbar-group statusbar-position">
            <span className="statusbar-item">
              Ln {cursorInfo.line}, Col {cursorInfo.column}
            </span>
            <span className="statusbar-item">
              {characterCount} {characterCount === 1 ? 'char' : 'chars'}
              {cursorInfo.selectionLength > 0 ? ` (${cursorInfo.selectionLength} selected)` : ''}
            </span>
            <span className="statusbar-item">
              {wordCount} {wordCount === 1 ? 'word' : 'words'}
              {cursorInfo.selectionWordCount > 0
                ? ` (${cursorInfo.selectionWordCount} selected)`
                : ''}
            </span>
          </div>
          {statusbarSearchText ? (
            <div className="statusbar-group statusbar-search">
              <span className="statusbar-item">{statusbarSearchText}</span>
            </div>
          ) : null}
          <div className="statusbar-group statusbar-meta">
            <span className="statusbar-item">
              {settings.editorMode === 'markdown' ? 'Markdown' : 'Plain text'}
            </span>
            <span className="statusbar-item">{providerStatusLabel}</span>
            {isDropboxFileSession ? (
              <span className="statusbar-item">{dropboxSyncStatusLabel}</span>
            ) : null}
          </div>
        </footer>
      )}
      {dropboxFlowDialogs}
    </main>
    </EditorErrorBoundary>
  )
}

export default App
