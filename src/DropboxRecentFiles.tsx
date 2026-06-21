import { useEffect, useRef, useState } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react'
import type { DropboxRecentFile } from './storage/storageProvider'

// Per-row session indicator derived from the background revision check
// (SPEC §9) — held in App state, never persisted.
export type DropboxRecentFileIndicator =
  | 'diverged'
  | 'missing'
  | 'replacement-candidate'
  | 'ineligible'

// The Local files home's row shape (a single timestamp). The Dropbox home feeds
// its own `DropboxRecentFile` rows (two timestamps) straight through, so the
// table is generic over the row type — see `RecentFileColumn`.
export type RecentFileTableRow = {
  key: string
  name: string
  folderPath: string
  timestampAt: string | null
}

// One configurable column (SPEC §9/§15): the Local home has 3 (Name / Path /
// Last modified), the Dropbox home 4 (Name / Path / Last synced / Last
// modified). The table renders `columns.length` columns and `columns.length-1`
// resize separators, so it is not pinned to a fixed column count.
export type RecentFileColumn<T> = {
  key: string
  label: string
  cellClassName: string
  render: (file: T, indicator: DropboxRecentFileIndicator | undefined) => ReactNode
  // When true the cell renders as a status message (e.g. a missing row's
  // "Not found"); only the Last synced column uses it.
  isMessage?: (file: T, indicator: DropboxRecentFileIndicator | undefined) => boolean
}

// Long-press threshold for the touch row menu (SPEC §9). iOS Safari delivers
// no contextmenu for long presses inside scrollable containers, so the menu is
// driven by an explicit timer; the CSS suppresses the text-selection callout.
const LONG_PRESS_MS = 500

const formatTimestamp = (iso: string | null) => {
  if (!iso) {
    return '—'
  }

  const date = new Date(iso)

  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

// Resizable recents columns (SPEC §9), memorized per home across sessions.
// Widths are fractions of the table width that always sum to 1, so they stay
// sensible across container and screen sizes — and, when the table is at its
// CSS min-width (wider than a narrow container, which then scrolls
// horizontally), they remain fractions of that rendered width, so the resize
// math is unchanged. App owns persistence (the `recentsColumnWidths` setting,
// SPEC §8); this table is controlled via props.
const MIN_COLUMN_FRACTION = 0.12
const KEYBOARD_RESIZE_STEP = 0.03
// Per-column floor for the table's min-width (SPEC §15): the table never shrinks
// below `columnCount × this`, so on a container narrower than that (a phone, or
// the fixed-width home card with the 4-column Dropbox table) it scrolls
// horizontally instead of crushing the columns. Scales with the column count so
// the 3-column Local table does not over-scroll. At 10rem the 4-column Dropbox
// table (40rem) is wider than the fixed-width home card, so it scrolls
// horizontally there — keeping each column (notably the two date columns) wide
// enough to read — while the 3-column Local table (30rem) still fits the card
// without a scrollbar. A phone-width container scrolls either way.
const MIN_COLUMN_WIDTH_REM = 10
const evenColumnWidths = (count: number): number[] => Array.from({ length: count }, () => 1 / count)

const clamp = (value: number, lo: number, hi: number) => Math.min(Math.max(value, lo), hi)

// Render at 0.1% precision so float drift never reaches the DOM as an ugly
// `45.99999%`; the stored fractions keep full precision for the math.
const toPercent = (fraction: number) => `${Math.round(fraction * 1000) / 10}%`

const isValidWidths = (value: unknown, count: number): value is number[] => {
  if (!Array.isArray(value) || value.length !== count) {
    return false
  }

  if (
    !value.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= MIN_COLUMN_FRACTION)
  ) {
    return false
  }

  const sum = (value as number[]).reduce((total, n) => total + n, 0)
  return Math.abs(sum - 1) < 0.01
}

// Move the boundary between column `boundary` and the next: one grows by the
// drag delta while its neighbor shrinks, so the row always fills the table and
// neither column drops below MIN_COLUMN_FRACTION. Every other column is
// untouched, so the sum (and thus the scroll range) is constant.
const applyBoundaryDelta = (
  start: number[],
  boundary: number,
  deltaFraction: number,
): number[] => {
  const here = start[boundary] ?? 0
  const neighbor = start[boundary + 1] ?? 0
  const pairSum = here + neighbor
  const left = clamp(here + deltaFraction, MIN_COLUMN_FRACTION, pairSum - MIN_COLUMN_FRACTION)
  const next = [...start]
  next[boundary] = left
  next[boundary + 1] = pairSum - left
  return next
}

const normalizeColumnOrder = <T,>(
  value: unknown,
  columns: RecentFileColumn<T>[],
): string[] => {
  const fallback = columns.map((column) => column.key)

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

const moveItem = <T,>(items: T[], fromIndex: number, toIndex: number): T[] => {
  if (toIndex < 0 || toIndex >= items.length || fromIndex === toIndex) {
    return items
  }

  const next = [...items]
  const [moved] = next.splice(fromIndex, 1)

  if (moved === undefined) {
    return items
  }

  next.splice(toIndex, 0, moved)
  return next
}

const MoveColumnIcon = ({ direction }: { direction: -1 | 1 }) => (
  <svg
    aria-hidden="true"
    className="dropbox-recents-order-icon"
    focusable="false"
    viewBox="0 0 16 16"
  >
    <path
      d={direction < 0 ? 'M10 4 6 8l4 4' : 'M6 4l4 4-4 4'}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    />
  </svg>
)

type RowMenuState = {
  key: string
  x: number
  y: number
}

// Memorized column widths (fractions summing to 1, one per column) plus the
// commit callback. App owns persistence; the table drives the live drag locally
// and commits on release (SPEC §8/§9).
type ColumnWidthControl = {
  columnWidths: number[]
  onColumnWidthsChange: (widths: number[]) => void
}

type ColumnOrderControl = {
  columnOrder: string[]
  onColumnOrderChange: (order: string[], widths: number[]) => void
}

type RecentFilesTableProps<T extends { key: string }> = ColumnWidthControl &
  ColumnOrderControl & {
  columns: RecentFileColumn<T>[]
  emptyMessage: string
  files: T[]
  // Session indicators from the background revision check (SPEC §9). Color
  // is never the only signal: diverged/replacement-candidate add an attention
  // prefix, missing replaces the Last synced cell text, ineligible shows the
  // real ineligible name.
  // Undefined = none shown (e.g. while offline).
  indicators?: ReadonlyMap<string, DropboxRecentFileIndicator> | undefined
  onSelect: (key: string) => void
  onDeleteFromList: (key: string) => void
  selectedKey: string | null
}

type DropboxRecentFilesProps = ColumnWidthControl &
  ColumnOrderControl & {
  files: DropboxRecentFile[]
  selectedKey: string | null
  indicators?: ReadonlyMap<string, DropboxRecentFileIndicator> | undefined
  onSelect: (key: string) => void
  onDeleteFromList: (key: string) => void
}

// Shared home recent-files table. Dropbox uses it for synced files; Local files
// use the same visual structure for file handles and display metadata. Generic
// over the row type so each home supplies its own columns (SPEC §9/§15).
export function RecentFilesTable<T extends { key: string }>({
  columns,
  columnOrder: persistedColumnOrder,
  onColumnOrderChange,
  columnWidths: persistedColumnWidths,
  onColumnWidthsChange,
  emptyMessage,
  files,
  selectedKey,
  indicators,
  onSelect,
  onDeleteFromList,
}: RecentFilesTableProps<T>) {
  const columnCount = columns.length
  const columnsByKey = new Map(columns.map((column) => [column.key, column]))
  const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null)
  const rowMenuButtonRef = useRef<HTMLButtonElement | null>(null)
  // The row element that opened the menu: on close the
  // menu button unmounts, so focus would fall to <body>; we restore it here.
  const menuInvokerRef = useRef<HTMLTableRowElement | null>(null)
  const longPressTimerRef = useRef<number | null>(null)
  const tableRef = useRef<HTMLTableElement | null>(null)
  const resizeRef = useRef<{
    boundary: number
    startX: number
    tableWidth: number
    startWidths: number[]
  } | null>(null)
  const columnDragRef = useRef<{
    columnKey: string
    pointerId: number
    startIndex: number
    startX: number
    started: boolean
    targetIndex: number
  } | null>(null)
  // Seeded once from the persisted prop (validated against the column count):
  // the prop only ever changes as a result of this table's own commits, and App
  // loads it before the home renders, so there is no prop→state drift to
  // reconcile mid-session.
  const [columnOrder, setColumnOrder] = useState<string[]>(() =>
    normalizeColumnOrder(persistedColumnOrder, columns),
  )
  const [columnWidths, setColumnWidths] = useState<number[]>(() =>
    isValidWidths(persistedColumnWidths, columnCount)
      ? persistedColumnWidths
      : evenColumnWidths(columnCount),
  )
  const [draggingColumnKey, setDraggingColumnKey] = useState<string | null>(null)
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null)
  const [activeColumnControlsKey, setActiveColumnControlsKey] = useState<string | null>(null)
  const columnOrderRef = useRef(columnOrder)
  const columnWidthsRef = useRef(columnWidths)
  // Touch long-press commonly emits a synthetic click on touchend; without
  // suppression that click would bubble to the window closer and shut the
  // menu the instant it opened. Set when the long-press fires, consumed by
  // the first follow-up click, and self-cleared shortly after in case the
  // platform never sends one.
  const suppressNextClickRef = useRef(false)

  const clearLongPressTimer = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }

  useEffect(() => {
    if (!rowMenu) {
      return
    }

    // Restore focus to the row that opened the menu so keyboard users are not
    // dropped onto <body> when the menu (and its focused button) unmounts.
    const closeAndRestoreFocus = () => {
      const invoker = menuInvokerRef.current
      setRowMenu(null)
      invoker?.focus()
    }

    const close = () => {
      if (suppressNextClickRef.current) {
        suppressNextClickRef.current = false
        return
      }

      closeAndRestoreFocus()
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeAndRestoreFocus()
      }
    }

    window.addEventListener('click', close)
    window.addEventListener('keydown', closeOnEscape)
    window.addEventListener('scroll', close, true)
    window.setTimeout(() => rowMenuButtonRef.current?.focus(), 0)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('scroll', close, true)
    }
  }, [rowMenu])

  useEffect(() => clearLongPressTimer, [])

  useEffect(() => {
    if (activeColumnControlsKey === null) {
      return
    }

    const closeColumnControls = () => {
      setActiveColumnControlsKey(null)
      const activeElement = document.activeElement

      if (activeElement instanceof HTMLElement && tableRef.current?.contains(activeElement)) {
        activeElement.blur()
      }
    }

    window.addEventListener('pointerdown', closeColumnControls)
    return () => window.removeEventListener('pointerdown', closeColumnControls)
  }, [activeColumnControlsKey])

  const openRowMenu = (
    key: string,
    x: number,
    y: number,
    invoker: HTMLTableRowElement | null,
  ) => {
    menuInvokerRef.current = invoker
    onSelect(key)
    setRowMenu({ key, x, y })
  }

  const openKeyboardRowMenu = (key: string, row: HTMLTableRowElement) => {
    const rect = row.getBoundingClientRect()

    openRowMenu(key, rect.left + 12, rect.top + rect.height / 2, row)
  }

  const beginResize = (boundary: number) => (event: ReactPointerEvent<HTMLSpanElement>) => {
    // Keep the pointerdown from reaching the header (sort/selection elsewhere)
    // and from starting a text selection while dragging.
    event.preventDefault()
    event.stopPropagation()

    const tableWidth = tableRef.current?.clientWidth ?? 0

    if (tableWidth <= 0) {
      return
    }

    resizeRef.current = {
      boundary,
      startX: event.clientX,
      tableWidth,
      startWidths: columnWidthsRef.current,
    }

    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Pointer capture is unavailable in some environments (e.g. jsdom).
    }
  }

  const updateResize = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const drag = resizeRef.current

    if (!drag) {
      return
    }

    const deltaFraction = (event.clientX - drag.startX) / drag.tableWidth
    const next = applyBoundaryDelta(drag.startWidths, drag.boundary, deltaFraction)
    columnWidthsRef.current = next
    setColumnWidths(next)
  }

  const endResize = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!resizeRef.current) {
      return
    }

    resizeRef.current = null

    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // ignore
    }

    onColumnWidthsChange(columnWidthsRef.current)
  }

  const nudgeResize = (boundary: number) => (event: ReactKeyboardEvent<HTMLSpanElement>) => {
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0

    if (direction === 0) {
      return
    }

    event.preventDefault()
    const next = applyBoundaryDelta(
      columnWidthsRef.current,
      boundary,
      direction * KEYBOARD_RESIZE_STEP,
    )
    columnWidthsRef.current = next
    setColumnWidths(next)
    onColumnWidthsChange(next)
  }

  const commitColumnMove = (fromIndex: number, toIndex: number) => {
    const nextOrder = moveItem(columnOrderRef.current, fromIndex, toIndex)

    if (nextOrder === columnOrderRef.current) {
      return
    }

    const nextWidths = moveItem(columnWidthsRef.current, fromIndex, toIndex)
    columnOrderRef.current = nextOrder
    columnWidthsRef.current = nextWidths
    setActiveColumnControlsKey(null)
    setColumnOrder(nextOrder)
    setColumnWidths(nextWidths)
    onColumnOrderChange(nextOrder, nextWidths)
  }

  const moveColumn =
    (index: number, direction: -1 | 1) => (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      commitColumnMove(index, index + direction)
    }

  const getColumnIndexFromClientX = (clientX: number) => {
    const headers = Array.from(
      tableRef.current?.querySelectorAll<HTMLTableCellElement>('thead th') ?? [],
    )

    const firstHeader = headers[0]

    if (!firstHeader) {
      return 0
    }

    for (const [index, header] of headers.entries()) {
      const rect = header.getBoundingClientRect()

      if (clientX >= rect.left && clientX <= rect.right) {
        return index
      }
    }

    if (clientX < firstHeader.getBoundingClientRect().left) {
      return 0
    }

    return headers.length - 1
  }

  const beginColumnDrag =
    (index: number, columnKey: string) => (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      columnDragRef.current = {
        columnKey,
        pointerId: event.pointerId,
        startIndex: index,
        startX: event.clientX,
        started: false,
        targetIndex: index,
      }
      setDraggingColumnKey(columnKey)
      setDropTargetIndex(index)

      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Pointer capture is unavailable in some environments (e.g. jsdom).
      }
    }

  const updateColumnDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = columnDragRef.current

    if (!drag) {
      return
    }

    if (!drag.started && Math.abs(event.clientX - drag.startX) >= 4) {
      drag.started = true
    }

    if (!drag.started) {
      return
    }

    drag.targetIndex = getColumnIndexFromClientX(event.clientX)
    setDropTargetIndex(drag.targetIndex)
  }

  const clearColumnDrag = () => {
    columnDragRef.current = null
    setDraggingColumnKey(null)
    setDropTargetIndex(null)
  }

  const endColumnDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = columnDragRef.current

    if (!drag) {
      return
    }

    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // ignore
    }

    if (drag.started) {
      commitColumnMove(drag.startIndex, drag.targetIndex)
    } else {
      setActiveColumnControlsKey(drag.columnKey)
    }

    clearColumnDrag()
  }

  const nudgeColumnFromLabel =
    (index: number) => (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (!event.altKey) {
        return
      }

      const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0

      if (direction === 0) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      commitColumnMove(index, index + direction)
    }

  const renderMoveButton = (index: number, direction: -1 | 1, columnLabel: string) => {
    const targetIndex = index + direction
    const disabled = targetIndex < 0 || targetIndex >= columnCount
    const directionLabel = direction < 0 ? 'left' : 'right'

    return (
      <button
        type="button"
        className="dropbox-recents-order-button"
        aria-label={`Move ${columnLabel} column ${directionLabel}`}
        title={`Move ${columnLabel} column ${directionLabel}`}
        disabled={disabled}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={moveColumn(index, direction)}
      >
        <MoveColumnIcon direction={direction} />
      </button>
    )
  }

  const renderResizer = (boundary: number, columnLabel: string) => (
    <span
      className="dropbox-recents-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${columnLabel} column`}
      tabIndex={0}
      onPointerDown={beginResize(boundary)}
      onPointerMove={updateResize}
      onPointerUp={endResize}
      onPointerCancel={endResize}
      onKeyDown={nudgeResize(boundary)}
    />
  )

  if (files.length === 0) {
    return <p className="dropbox-recents-empty">{emptyMessage}</p>
  }

  const orderedColumns = columnOrder
    .map((key) => columnsByKey.get(key))
    .filter((column): column is RecentFileColumn<T> => column !== undefined)

  return (
    <div className="dropbox-recents">
      <table
        ref={tableRef}
        className="dropbox-recents-table"
        role="grid"
        aria-multiselectable="false"
        onPointerMove={updateColumnDrag}
        onPointerUp={endColumnDrag}
        onPointerCancel={clearColumnDrag}
        style={{ minWidth: `${columnCount * MIN_COLUMN_WIDTH_REM}rem` }}
      >
        <colgroup>
          {orderedColumns.map((column, index) => (
            <col key={column.key} style={{ width: toPercent(columnWidths[index] ?? 1 / columnCount) }} />
          ))}
        </colgroup>
        <thead>
          <tr role="row">
            {orderedColumns.map((column, index) => (
              <th
                key={column.key}
                scope="col"
                role="columnheader"
                className={[
                  draggingColumnKey === column.key ? 'is-column-dragging' : null,
                  dropTargetIndex === index ? 'is-column-drop-target' : null,
                  activeColumnControlsKey === column.key ? 'is-column-controls-active' : null,
                ]
                  .filter(Boolean)
                  .join(' ') || undefined}
              >
                <span className="dropbox-recents-header">
                  <button
                    type="button"
                    className="dropbox-recents-header-label"
                    title="Drag to reorder column. Press Alt+Left or Alt+Right to move."
                    onPointerDown={beginColumnDrag(index, column.key)}
                    onPointerMove={updateColumnDrag}
                    onPointerUp={endColumnDrag}
                    onPointerCancel={clearColumnDrag}
                    onKeyDown={nudgeColumnFromLabel(index)}
                  >
                    {column.label}
                  </button>
                  <span className="dropbox-recents-order-controls">
                    {renderMoveButton(index, -1, column.label)}
                    {renderMoveButton(index, 1, column.label)}
                  </span>
                </span>
                {index < columnCount - 1 ? renderResizer(index, column.label) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {files.map((file) => {
            const indicator = indicators?.get(file.key)
            const rowClasses = [
              file.key === selectedKey ? 'is-selected' : null,
              indicator ? `is-${indicator}` : null,
            ].filter(Boolean)

            return (
              <tr
                key={file.key}
                role="row"
                aria-haspopup="menu"
                aria-selected={file.key === selectedKey}
                className={rowClasses.length > 0 ? rowClasses.join(' ') : undefined}
                onClick={() => {
                  // The long-press's synthetic click must not re-select or
                  // race the just-opened menu (the window closer consumes it).
                  if (suppressNextClickRef.current) {
                    return
                  }

                  onSelect(file.key)
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  openRowMenu(file.key, event.clientX, event.clientY, event.currentTarget)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onSelect(file.key)
                    return
                  }

                  if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
                    event.preventDefault()
                    openKeyboardRowMenu(file.key, event.currentTarget)
                  }
                }}
                onTouchStart={(event) => {
                  const touch = event.touches[0]

                  if (!touch) {
                    return
                  }

                  const { clientX, clientY } = touch
                  // Capture the row now; React reuses the synthetic event, so
                  // currentTarget is null by the time the deferred timer fires.
                  const invoker = event.currentTarget

                  clearLongPressTimer()
                  longPressTimerRef.current = window.setTimeout(() => {
                    longPressTimerRef.current = null
                    suppressNextClickRef.current = true
                    window.setTimeout(() => {
                      suppressNextClickRef.current = false
                    }, 700)
                    openRowMenu(file.key, clientX, clientY, invoker)
                  }, LONG_PRESS_MS)
                }}
                onTouchEnd={clearLongPressTimer}
                onTouchMove={clearLongPressTimer}
                onTouchCancel={clearLongPressTimer}
                tabIndex={0}
              >
                {orderedColumns.map((column) => (
                  <td
                    key={column.key}
                    className={`${column.cellClassName}${
                      column.isMessage?.(file, indicator) ? ' is-message' : ''
                    }`}
                    role="gridcell"
                  >
                    {column.render(file, indicator)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>

      {rowMenu ? (
        <div
          className="recent-files-context-menu"
          role="menu"
          style={{ left: rowMenu.x, top: rowMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            ref={rowMenuButtonRef}
            type="button"
            role="menuitem"
            onClick={() => {
              setRowMenu(null)
              onDeleteFromList(rowMenu.key)
            }}
          >
            Delete from list
          </button>
        </div>
      ) : null}
    </div>
  )
}

// The standard three columns for a single-timestamp home (the Local files
// table, SPEC §15): Name / Path / <timestampLabel>. The Path cell's inner span
// is left-truncated by CSS so the direct parent folder stays visible. A plain
// helper that lives with the table it configures; the fast-refresh rule only
// flags it because this module also exports components.
// eslint-disable-next-line react-refresh/only-export-components
export const standardRecentColumns = (
  timestampLabel: string,
): RecentFileColumn<RecentFileTableRow>[] => [
  {
    key: 'name',
    label: 'Name',
    cellClassName: 'dropbox-recents-name',
    render: (file) => file.name,
  },
  {
    key: 'path',
    label: 'Path',
    cellClassName: 'dropbox-recents-path',
    render: (file) => <span>{file.folderPath}</span>,
  },
  {
    key: 'timestamp',
    label: timestampLabel,
    cellClassName: 'dropbox-recents-synced',
    render: (file) => formatTimestamp(file.timestampAt),
  },
]

// The home Dropbox block's recent-files table (SPEC §9): Name / Path (the
// parent folder, left-truncated by CSS so the direct parent stays visible) /
// Last synced (the synced version's `client_modified`) / Last modified (the
// working copy's own edit time). Tap selects; tap-and-hold (touch) or
// right-click (desktop) opens the row menu with `Delete from list`. A `•` name
// prefix marks a row with local changes not yet on Dropbox: red on a diverged
// or replacement-candidate row (the conflict treatment), otherwise the normal
// text color for an ordinary unsynced row. A missing row keeps its folder path
// and shows "Not found" in the Last synced column.
export function DropboxRecentFiles({
  columnOrder,
  onColumnOrderChange,
  columnWidths,
  onColumnWidthsChange,
  files,
  selectedKey,
  indicators,
  onSelect,
  onDeleteFromList,
}: DropboxRecentFilesProps) {
  // Persisted per-file flag (available offline), unlike the network-derived
  // indicators: drives the normal-color unsynced dot.
  const unsyncedKeys = new Set(
    files.filter((file) => file.hasUnsyncedChanges).map((file) => file.key),
  )

  const columns: RecentFileColumn<DropboxRecentFile>[] = [
    {
      key: 'name',
      label: 'Name',
      cellClassName: 'dropbox-recents-name',
      // A dirty/diverged/replacement-candidate row gets a bold name with the
      // dot directly attached (no separating space); the row
      // color (red on network-derived attention states) still carries the
      // conflict-like signal.
      render: (file, indicator) =>
        indicator === 'diverged' ||
        indicator === 'replacement-candidate' ||
        unsyncedKeys.has(file.key) ? (
          <span className="dropbox-recents-name-dirty">{`•${file.name}`}</span>
        ) : (
          file.name
        ),
    },
    {
      key: 'path',
      label: 'Path',
      cellClassName: 'dropbox-recents-path',
      render: (file) => <span>{file.folderPath}</span>,
    },
    {
      key: 'synced',
      label: 'Last synced',
      cellClassName: 'dropbox-recents-synced',
      render: (file, indicator) =>
        indicator === 'missing' ? 'Not found' : formatTimestamp(file.syncedModifiedAt),
      isMessage: (_file, indicator) => indicator === 'missing',
    },
    {
      key: 'modified',
      label: 'Last modified',
      // Shares the Last synced cell styling (muted color + diverged/missing
      // attention overrides across themes); the extra class is a future hook.
      cellClassName: 'dropbox-recents-synced dropbox-recents-modified',
      render: (file) => formatTimestamp(file.localModifiedAt),
    },
  ]

  return (
    <RecentFilesTable
      columns={columns}
      columnOrder={columnOrder}
      onColumnOrderChange={onColumnOrderChange}
      columnWidths={columnWidths}
      onColumnWidthsChange={onColumnWidthsChange}
      emptyMessage="No recent files yet."
      files={files}
      indicators={indicators}
      onSelect={onSelect}
      onDeleteFromList={onDeleteFromList}
      selectedKey={selectedKey}
    />
  )
}
