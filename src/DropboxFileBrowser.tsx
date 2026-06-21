import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { isEncryptedTextFileName } from './exportFileNames'
import type { DropboxFolderEntry, DropboxFolderListing } from './storage/storageProvider'

// The Dropbox file browser dialog content (SPEC §9). One component serves the
// three destination-picking flows; the caller wraps it in ModalShell and runs
// the flow-specific gates (overwrite confirmation, unsynced warning, password
// dialogs) AFTER a path is chosen here. Listing data lives only in this
// component's state and dies with it — never persisted (SPEC §9 privacy rule).
export type DropboxFileBrowserMode = 'choose' | 'create' | 'upload'

type SortColumn = 'name' | 'modified' | 'size'

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; listing: DropboxFolderListing }
  // An ordinary listing failure: retryable in place.
  | { kind: 'error' }
  // Offline mid-browse: retryable once connectivity returns, but the
  // destination action is NOT offered — nothing can succeed (SPEC §9).
  | { kind: 'offline' }
  // Authorization died mid-browse (possibly revoked from another device):
  // nothing here can succeed — point to relink, no retry loop (SPEC §9).
  | { kind: 'auth-lost' }

const FILENAME_VALIDATION_MESSAGE = 'File name must be a single name (no /).'

const isAuthLostError = (error: unknown) => {
  const code = (error as { code?: string } | null)?.code

  return code === 'auth' || code === 'unlinked'
}

const isOfflineError = (error: unknown) =>
  (error as { code?: string } | null)?.code === 'offline'

// '' is the Dropbox root. Display segments for the breadcrumb; the root is
// labeled `Dropbox` and deep trails collapse their middle segments into an
// inert ellipsis (SPEC §9).
const getBreadcrumbSegments = (folderPath: string) => {
  const parts = folderPath.split('/').filter(Boolean)

  return [
    { label: 'Dropbox', path: '' },
    ...parts.map((part, index) => ({
      label: part,
      path: `/${parts.slice(0, index + 1).join('/')}`,
    })),
  ]
}

const formatSize = (size: number | null) => {
  if (size === null) {
    return ''
  }

  if (size < 1024) {
    return `${size} B`
  }

  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

const formatModified = (serverModified: string | null) => {
  if (!serverModified) {
    return ''
  }

  const time = Date.parse(serverModified)

  if (Number.isNaN(time)) {
    return ''
  }

  return new Date(time).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

const isEligibleFile = (entry: DropboxFolderEntry) =>
  entry.kind === 'file' && isEncryptedTextFileName(entry.name)

const byNameAscending = (a: DropboxFolderEntry, b: DropboxFolderEntry) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })

// Sorts within one group. Entries lacking the sorted attribute keep name
// order regardless of direction (SPEC §9) — folders have no modified/size.
const sortGroup = (
  group: DropboxFolderEntry[],
  column: SortColumn,
  direction: 'asc' | 'desc',
) => {
  const flip = direction === 'desc' ? -1 : 1

  return [...group].sort((a, b) => {
    if (column === 'name') {
      return flip * byNameAscending(a, b)
    }

    const aValue =
      column === 'modified'
        ? a.serverModified === null
          ? null
          : Date.parse(a.serverModified)
        : a.size
    const bValue =
      column === 'modified'
        ? b.serverModified === null
          ? null
          : Date.parse(b.serverModified)
        : b.size

    if (aValue === null || bValue === null || Number.isNaN(aValue) || Number.isNaN(bValue)) {
      return byNameAscending(a, b)
    }

    return flip * (aValue - bValue) || byNameAscending(a, b)
  })
}

// Trimmed single path segment. A missing or foreign extension gets `.txt`
// appended so saving never fails on the extension. Empty or path-bearing
// (contains /) names stay invalid.
const validateFileName = (input: string): string | null => {
  const name = input.trim()

  if (!name || name.includes('/')) {
    return null
  }

  return isEncryptedTextFileName(name) ? name : `${name}.txt`
}

export const DropboxFileBrowser = ({
  defaultFileName = 'enote.txt',
  initialFolder = '',
  listFolder,
  markedPathLower = null,
  mode,
  onCancel,
  onChooseDestination,
  onChooseFile,
  onNavigate,
}: {
  defaultFileName?: string | undefined
  // Display path of the starting folder; '' is the root. A start folder that
  // fails to list falls back to the root (SPEC §9).
  initialFolder?: string
  listFolder: (path: string) => Promise<DropboxFolderListing>
  // path_lower of the currently connected file, visibly marked in the list.
  markedPathLower?: string | null
  mode: DropboxFileBrowserMode
  onCancel: () => void
  // Create/Upload: the chosen destination path (current folder + filename).
  // `collidesWithListing` is the case-insensitive in-listing collision check
  // (SPEC §9) — a UI courtesy; the caller's provider-level existence probe
  // remains the authoritative overwrite guard.
  onChooseDestination?: (pathDisplay: string, collidesWithListing: boolean) => void
  // Reports every folder navigation (including the root fallback), so the
  // caller can remember the most recently browsed folder for the session
  // (SPEC §9) — even when the dialog is then cancelled.
  onNavigate?: (folderPath: string) => void
  // Choose: the picked existing file (one tap).
  onChooseFile?: (pathDisplay: string) => void
}) => {
  const [currentFolder, setCurrentFolder] = useState(initialFolder)
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' })
  const [sortColumn, setSortColumn] = useState<SortColumn>('name')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc')
  const [fileNameInput, setFileNameInput] = useState(defaultFileName)
  const [validationMessage, setValidationMessage] = useState('')

  // Monotonic navigation counter: a slow older listing must never overwrite a
  // newer one (stale rows under the wrong breadcrumb).
  const loadSequenceRef = useRef(0)
  const currentFolderRef = useRef(initialFolder)
  const fileNameInputRef = useRef<HTMLInputElement | null>(null)
  const actionsRef = useRef<HTMLDivElement | null>(null)

  const attemptListing = useCallback(
    async (target: string): Promise<LoadState> => {
      try {
        return { kind: 'ready', listing: await listFolder(target === '' ? '/' : target) }
      } catch (error) {
        if (isAuthLostError(error)) {
          return { kind: 'auth-lost' }
        }

        return isOfflineError(error) ? { kind: 'offline' } : { kind: 'error' }
      }
    },
    [listFolder],
  )

  // Navigation from event handlers; the initial state is already 'loading',
  // so the mount effect below fetches without this synchronous reset.
  const load = useCallback(
    async (folder: string) => {
      const sequence = ++loadSequenceRef.current

      currentFolderRef.current = folder
      setLoadState({ kind: 'loading' })

      const result = await attemptListing(folder)

      if (loadSequenceRef.current === sequence) {
        setLoadState(result)
      }
    },
    [attemptListing],
  )

  useEffect(() => {
    const sequence = ++loadSequenceRef.current

    void (async () => {
      // The remembered/initial start folder may have been deleted: fall back
      // to the root instead of opening into an error (SPEC §9).
      let result = await attemptListing(initialFolder)

      if (result.kind === 'error' && initialFolder !== '') {
        if (loadSequenceRef.current !== sequence) {
          return
        }

        setCurrentFolder('')
        currentFolderRef.current = ''
        onNavigate?.('')
        result = await attemptListing('')
      }

      if (loadSequenceRef.current === sequence) {
        setLoadState(result)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only initial load
  }, [])

  const navigateTo = (folder: string) => {
    currentFolderRef.current = folder
    setCurrentFolder(folder)
    onNavigate?.(folder)
    void load(folder)
  }

  const retryCurrentFolder = useCallback(() => {
    const folder = currentFolderRef.current

    setCurrentFolder(folder)
    onNavigate?.(folder)
    void load(folder)
  }, [load, onNavigate])

  useEffect(() => {
    if (loadState.kind !== 'offline') {
      return undefined
    }

    const retryIfOnline = () => {
      if (globalThis.navigator?.onLine === false) {
        return
      }

      retryCurrentFolder()
    }
    const retryWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        retryIfOnline()
      }
    }

    window.addEventListener('online', retryIfOnline)
    document.addEventListener('visibilitychange', retryWhenVisible)

    return () => {
      window.removeEventListener('online', retryIfOnline)
      document.removeEventListener('visibilitychange', retryWhenVisible)
    }
  }, [loadState.kind, retryCurrentFolder])

  const toggleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection((direction) => (direction === 'asc' ? 'desc' : 'asc'))
      return
    }

    setSortColumn(column)
    setSortDirection('asc')
  }

  const groups = useMemo(() => {
    if (loadState.kind !== 'ready') {
      return null
    }

    const folders: DropboxFolderEntry[] = []
    const eligible: DropboxFolderEntry[] = []
    const ineligible: DropboxFolderEntry[] = []

    for (const entry of loadState.listing.entries) {
      if (entry.kind === 'folder') {
        folders.push(entry)
      } else if (isEligibleFile(entry)) {
        eligible.push(entry)
      } else {
        ineligible.push(entry)
      }
    }

    return {
      eligible: sortGroup(eligible, sortColumn, sortDirection),
      folders: sortGroup(folders, sortColumn, sortDirection),
      ineligible: sortGroup(ineligible, sortColumn, sortDirection),
    }
  }, [loadState, sortColumn, sortDirection])

  // The destination action is a plain "Save" in both create and upload modes;
  // the dialog title still names the context.
  const primaryActionLabel = 'Save'

  // Keep the action row scrolled to its right (primary-action) end when the
  // labels overflow. This mirrors the editor's scrollable toolbar but reveals
  // the end first; CSS right-aligns the row while it fits (SPEC §9/§15).
  useEffect(() => {
    const row = actionsRef.current

    if (row && row.scrollWidth > row.clientWidth) {
      row.scrollLeft = row.scrollWidth
    }
  }, [primaryActionLabel, loadState.kind])

  // Dropbox paths are case-insensitive: compare lowercase against the current
  // listing (SPEC §9 destination rules). Courtesy only — the provider probe
  // at upload/create time stays authoritative.
  const collidesWithListing = (pathDisplay: string) => {
    if (loadState.kind !== 'ready') {
      return false
    }

    const pathLower = pathDisplay.toLowerCase()

    return loadState.listing.entries.some(
      (candidate) => candidate.kind !== 'folder' && candidate.pathLower === pathLower,
    )
  }

  const submitDestination = () => {
    const name = validateFileName(fileNameInput)

    if (!name) {
      setValidationMessage(FILENAME_VALIDATION_MESSAGE)
      return
    }

    setValidationMessage('')

    const pathDisplay = `${currentFolder}/${name}`

    onChooseDestination?.(pathDisplay, collidesWithListing(pathDisplay))
  }

  // SPEC §9 desktop interaction: arrow keys move the row focus; Enter on a
  // focused row button descends/selects natively.
  const handleListKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return
    }

    const rows = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('button.dropbox-browser-row'),
    )

    if (rows.length === 0) {
      return
    }

    event.preventDefault()

    const activeIndex = rows.findIndex((row) => row === document.activeElement)
    const nextIndex =
      activeIndex === -1
        ? 0
        : event.key === 'ArrowDown'
          ? Math.min(activeIndex + 1, rows.length - 1)
          : Math.max(activeIndex - 1, 0)

    rows[nextIndex]?.focus()
  }

  const sortIndicator = (column: SortColumn) =>
    sortColumn === column ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''

  const ariaSort = (column: SortColumn) =>
    sortColumn === column ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'

  const renderRow = (entry: DropboxFolderEntry) => {
    if (entry.kind === 'folder') {
      return (
        <li key={entry.pathLower}>
          <button
            type="button"
            className="dropbox-browser-row is-folder"
            onClick={() => navigateTo(entry.pathDisplay)}
          >
            <span className="dropbox-browser-name">{entry.name}</span>
          </button>
        </li>
      )
    }

    const eligible = isEligibleFile(entry)
    const marked = markedPathLower !== null && entry.pathLower === markedPathLower
    const detail = (
      <>
        <span className="dropbox-browser-name">{entry.name}</span>
        <span className="dropbox-browser-modified">{formatModified(entry.serverModified)}</span>
        <span className="dropbox-browser-size">{formatSize(entry.size)}</span>
      </>
    )

    if (!eligible) {
      // Ineligible entries are never tappable; they only orient the user.
      return (
        <li key={entry.pathLower}>
          <div
            className={`dropbox-browser-row is-ineligible${marked ? ' is-marked' : ''}`}
            aria-disabled="true"
            {...(marked ? { 'aria-current': 'true' } : {})}
          >
            {detail}
          </div>
        </li>
      )
    }

    if (mode === 'choose') {
      return (
        <li key={entry.pathLower}>
          <button
            type="button"
            className={`dropbox-browser-row is-eligible${marked ? ' is-marked' : ''}`}
            {...(marked ? { 'aria-current': 'true' } : {})}
            onClick={() => onChooseFile?.(entry.pathDisplay)}
          >
            {detail}
          </button>
        </li>
      )
    }

    // Create/Upload: tapping an existing eligible file copies its name into
    // the File name field, so overwriting it takes no typing (SPEC §9). The
    // destination is still confirmed through the primary action and the
    // downstream overwrite gate — this only fills the field.
    return (
      <li key={entry.pathLower}>
        <button
          type="button"
          className={`dropbox-browser-row is-eligible${marked ? ' is-marked' : ''}`}
          title={`Use “${entry.name}” as the file name`}
          {...(marked ? { 'aria-current': 'true' } : {})}
          onClick={() => {
            setFileNameInput(entry.name)
            setValidationMessage('')
            // Optional call: scrollIntoView is absent in jsdom and on some
            // engines — filling the field is the point; the scroll is a hint.
            fileNameInputRef.current?.scrollIntoView?.({ block: 'nearest' })
          }}
        >
          {detail}
        </button>
      </li>
    )
  }

  const breadcrumbSegments = getBreadcrumbSegments(currentFolder)
  // Deep trails: keep the root and the last two segments; the middle
  // collapses into an inert ellipsis segment (SPEC §9).
  const collapsedSegments =
    breadcrumbSegments.length > 4
      ? [...breadcrumbSegments.slice(0, 1), null, ...breadcrumbSegments.slice(-2)]
      : breadcrumbSegments

  const dialogTitle =
    mode === 'choose'
      ? 'Open Dropbox file'
      : mode === 'create'
        ? 'Create Dropbox file'
        : 'Upload to Dropbox'

  return (
    <div className="dropbox-browser">
      <h2 id="dropbox-browser-title">{dialogTitle}</h2>

      <nav className="dropbox-browser-breadcrumb" aria-label="Dropbox folder trail">
            {collapsedSegments.map((segment, index) =>
              segment === null ? (
                <span key="ellipsis" className="dropbox-browser-crumb-ellipsis">
                  …
                </span>
              ) : index === collapsedSegments.length - 1 ? (
                <span key={segment.path || 'root'} className="dropbox-browser-crumb is-current">
                  {segment.label}
                </span>
              ) : (
                <button
                  key={segment.path || 'root'}
                  type="button"
                  className="dropbox-browser-crumb"
                  onClick={() => navigateTo(segment.path)}
                >
                  {segment.label}
                </button>
              ),
            )}
          </nav>

          {loadState.kind === 'loading' ? (
            <p className="dropbox-browser-status" role="status">
              Loading folder…
            </p>
          ) : null}

          {loadState.kind === 'error' ? (
            <div className="dropbox-browser-status" role="alert">
              <p>Could not list this Dropbox folder.</p>
              <button type="button" onClick={retryCurrentFolder}>
                Retry
              </button>
            </div>
          ) : null}

          {loadState.kind === 'offline' ? (
            <div className="dropbox-browser-status" role="alert">
              <p>Device is offline.</p>
              <button type="button" onClick={retryCurrentFolder}>
                Retry
              </button>
            </div>
          ) : null}

          {loadState.kind === 'auth-lost' ? (
            <div className="dropbox-browser-status" role="alert">
              <p>Dropbox authorization was lost. Relink Dropbox from the home screen.</p>
            </div>
          ) : null}

          {loadState.kind === 'ready' && groups ? (
            <>
              <div className="dropbox-browser-headers">
                <button
                  type="button"
                  aria-sort={ariaSort('name')}
                  onClick={() => toggleSort('name')}
                >
                  Name{sortIndicator('name')}
                </button>
                <button
                  type="button"
                  aria-sort={ariaSort('modified')}
                  onClick={() => toggleSort('modified')}
                >
                  Modified{sortIndicator('modified')}
                </button>
                <button
                  type="button"
                  aria-sort={ariaSort('size')}
                  onClick={() => toggleSort('size')}
                >
                  Size{sortIndicator('size')}
                </button>
              </div>
              {/* The keydown handler only moves focus between the row buttons
                  inside; the list itself is not interactive. */}
              <ul className="dropbox-browser-list" onKeyDown={handleListKeyDown}>
                {groups.folders.map(renderRow)}
                {groups.eligible.map(renderRow)}
                {groups.ineligible.map(renderRow)}
              </ul>
              {groups.folders.length + groups.eligible.length + groups.ineligible.length === 0 ? (
                <p className="dropbox-browser-status">This folder is empty.</p>
              ) : null}
              {loadState.listing.truncated ? (
                <p className="dropbox-browser-status" role="status">
                  Showing the first 10000 entries.
                </p>
              ) : null}
            </>
          ) : null}

          {mode !== 'choose' && loadState.kind === 'ready' ? (
            <div className="dropbox-browser-destination">
              <label htmlFor="dropbox-browser-filename">File name</label>
              <input
                id="dropbox-browser-filename"
                ref={fileNameInputRef}
                type="text"
                value={fileNameInput}
                onChange={(event) => setFileNameInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    submitDestination()
                  }
                }}
              />
            </div>
          ) : null}

          {validationMessage ? <p className="dialog-error">{validationMessage}</p> : null}

          <div className="dialog-actions dropbox-browser-actions" ref={actionsRef}>
            {/* Cancel sits left, the primary "Save" right.
                Destination submission exists only on a READY listing — never
                while loading (the in-listing collision check needs the rows,
                and the start folder may still fall back to the root). */}
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            {mode !== 'choose' && loadState.kind === 'ready' ? (
              <button type="button" onClick={submitDestination}>
                {primaryActionLabel}
              </button>
            ) : null}
          </div>
    </div>
  )
}
