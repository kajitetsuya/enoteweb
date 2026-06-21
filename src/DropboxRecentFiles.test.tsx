import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DropboxRecentFiles } from './DropboxRecentFiles'

const baseFile = {
  key: 'id:a',
  name: 'a.txt',
  folderPath: '/Notes',
  syncedModifiedAt: null,
  localModifiedAt: null,
  hasCache: true,
  hasUnsyncedChanges: false,
}

const files = [baseFile]

// App owns column-width persistence; the table is controlled via these props.
// The Dropbox table has four columns (Name / Path / Last synced / Last
// modified), so the widths are four fractions summing to 1.
const defaultColumnProps = {
  columnOrder: ['name', 'path', 'synced', 'modified'] as string[],
  onColumnOrderChange: () => undefined,
  columnWidths: [0.3, 0.3, 0.2, 0.2] as number[],
  onColumnWidthsChange: () => undefined,
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('DropboxRecentFiles row menu', () => {
  it('exposes a grid whose selected row carries aria-selected', () => {
    render(
      <DropboxRecentFiles
        {...defaultColumnProps}
        files={files}
        selectedKey="id:a"
        onSelect={() => undefined}
        onDeleteFromList={() => undefined}
      />,
    )

    // The interactive table is a grid (role="grid") so aria-selected on its
    // rows is conveyed to assistive tech.
    expect(screen.getByRole('grid')).not.toBeNull()

    const selectedRow = screen.getByRole('row', { selected: true })
    expect(selectedRow).toBe(screen.getByText('a.txt').closest('tr'))
  })

  it('Escape closes the menu and returns focus to the invoking row', () => {
    render(
      <DropboxRecentFiles
        {...defaultColumnProps}
        files={files}
        selectedKey={null}
        onSelect={() => undefined}
        onDeleteFromList={() => undefined}
      />,
    )

    const row = screen.getByText('a.txt').closest('tr')

    if (!row) {
      throw new Error('Recent file row was not rendered.')
    }

    fireEvent.contextMenu(screen.getByText('a.txt'))
    expect(screen.getByRole('menuitem', { name: 'Delete from list' })).not.toBeNull()

    fireEvent.keyDown(window, { key: 'Escape' })

    // The menu closes and focus returns to the row that opened it,
    // rather than falling to <body> when the menu button unmounts.
    expect(screen.queryByRole('menuitem', { name: 'Delete from list' })).toBeNull()
    expect(document.activeElement).toBe(row)
  })

  it('right-click opens the menu; an outside click closes it', () => {
    render(
      <DropboxRecentFiles
        {...defaultColumnProps}
        files={files}
        selectedKey={null}
        onSelect={() => undefined}
        onDeleteFromList={() => undefined}
      />,
    )

    fireEvent.contextMenu(screen.getByText('a.txt'))
    expect(screen.getByRole('menuitem', { name: 'Delete from list' })).not.toBeNull()

    fireEvent.click(document.body)
    expect(screen.queryByRole('menuitem', { name: 'Delete from list' })).toBeNull()
  })

  it('supports keyboard selection and the keyboard row menu', () => {
    const onDeleteFromList = vi.fn()
    const onSelect = vi.fn()

    render(
      <DropboxRecentFiles
        {...defaultColumnProps}
        files={files}
        selectedKey={null}
        onSelect={onSelect}
        onDeleteFromList={onDeleteFromList}
      />,
    )

    const row = screen.getByText('a.txt').closest('tr')

    if (!row) {
      throw new Error('Recent file row was not rendered.')
    }

    row.focus()
    expect(document.activeElement).toBe(row)

    fireEvent.keyDown(row, { key: 'Enter' })
    fireEvent.keyDown(row, { key: ' ' })
    expect(onSelect).toHaveBeenCalledTimes(2)

    fireEvent.keyDown(row, { key: 'ContextMenu' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete from list' }))

    expect(onSelect).toHaveBeenCalledTimes(3)
    expect(onDeleteFromList).toHaveBeenCalledWith('id:a')
  })

  it('resizes a column by dragging the header separator and commits the new widths', () => {
    const onColumnOrderChange = vi.fn()
    const onColumnWidthsChange = vi.fn()

    render(
      <DropboxRecentFiles
        {...defaultColumnProps}
        onColumnOrderChange={onColumnOrderChange}
        onColumnWidthsChange={onColumnWidthsChange}
        files={files}
        selectedKey={null}
        onSelect={() => undefined}
        onDeleteFromList={() => undefined}
      />,
    )

    const table = document.querySelector('table.dropbox-recents-table') as HTMLTableElement
    // jsdom does no layout, so clientWidth is 0; mock it for the px→fraction math.
    Object.defineProperty(table, 'clientWidth', { configurable: true, value: 500 })

    const resizer = screen.getByRole('separator', { name: 'Resize Name column' })

    // Drag +50px on a 500px table = +0.1 fraction: Name 0.3→0.4, Path 0.3→0.2;
    // the other two columns are untouched.
    fireEvent.pointerDown(resizer, { clientX: 180, pointerId: 1 })
    fireEvent.pointerMove(resizer, { clientX: 230, pointerId: 1 })

    // The colgroup updates live during the drag.
    const cols = table.querySelectorAll<HTMLTableColElement>('col')
    expect(cols[0]?.style.width).toBe('40%')
    expect(cols[1]?.style.width).toBe('20%')
    expect(cols[2]?.style.width).toBe('20%')
    expect(cols[3]?.style.width).toBe('20%')

    // Releasing commits the widths to App for persistence.
    fireEvent.pointerUp(resizer, { clientX: 230, pointerId: 1 })
    const committed = onColumnWidthsChange.mock.calls.at(-1)?.[0] as number[]
    expect(committed[0]).toBeCloseTo(0.4)
    expect(committed[1]).toBeCloseTo(0.2)
    expect(committed[2]).toBeCloseTo(0.2)
    expect(committed[3]).toBeCloseTo(0.2)
    expect(onColumnOrderChange).not.toHaveBeenCalled()
  })

  it('applies the provided (persisted) column widths to the colgroup', () => {
    render(
      <DropboxRecentFiles
        {...defaultColumnProps}
        columnWidths={[0.5, 0.2, 0.18, 0.12]}
        files={files}
        selectedKey={null}
        onSelect={() => undefined}
        onDeleteFromList={() => undefined}
      />,
    )

    const cols = document.querySelectorAll<HTMLTableColElement>('table.dropbox-recents-table col')
    expect(cols[0]?.style.width).toBe('50%')
    expect(cols[1]?.style.width).toBe('20%')
    expect(cols[2]?.style.width).toBe('18%')
    expect(cols[3]?.style.width).toBe('12%')
  })

  it('applies the provided (persisted) column order', () => {
    render(
      <DropboxRecentFiles
        {...defaultColumnProps}
        columnOrder={['path', 'name', 'modified', 'synced']}
        files={files}
        selectedKey={null}
        onSelect={() => undefined}
        onDeleteFromList={() => undefined}
      />,
    )

    const headers = Array.from(
      document.querySelectorAll<HTMLTableCellElement>('table.dropbox-recents-table th'),
    )

    expect(
      headers.map((header) =>
        header.querySelector('.dropbox-recents-header-label')?.textContent?.trim(),
      ),
    ).toEqual(['Path', 'Name', 'Last modified', 'Last synced'])
  })

  it('moves a column and keeps its width with the moved column', () => {
    const onColumnOrderChange = vi.fn()

    render(
      <DropboxRecentFiles
        {...defaultColumnProps}
        columnWidths={[0.42, 0.2, 0.23, 0.15]}
        onColumnOrderChange={onColumnOrderChange}
        files={files}
        selectedKey={null}
        onSelect={() => undefined}
        onDeleteFromList={() => undefined}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Move Name column right' }))

    const headers = Array.from(
      document.querySelectorAll<HTMLTableCellElement>('table.dropbox-recents-table th'),
    )
    const cols = document.querySelectorAll<HTMLTableColElement>('table.dropbox-recents-table col')

    expect(
      headers.map((header) =>
        header.querySelector('.dropbox-recents-header-label')?.textContent?.trim(),
      ),
    ).toEqual(['Path', 'Name', 'Last synced', 'Last modified'])
    expect(cols[0]?.style.width).toBe('20%')
    expect(cols[1]?.style.width).toBe('42%')
    expect(onColumnOrderChange).toHaveBeenLastCalledWith(
      ['path', 'name', 'synced', 'modified'],
      [0.2, 0.42, 0.23, 0.15],
    )
  })

  it('reorders columns by dragging a header title', () => {
    const onColumnOrderChange = vi.fn()

    render(
      <DropboxRecentFiles
        {...defaultColumnProps}
        columnWidths={[0.42, 0.2, 0.23, 0.15]}
        onColumnOrderChange={onColumnOrderChange}
        files={files}
        selectedKey={null}
        onSelect={() => undefined}
        onDeleteFromList={() => undefined}
      />,
    )

    const headers = Array.from(
      document.querySelectorAll<HTMLTableCellElement>('table.dropbox-recents-table th'),
    )
    headers.forEach((header, index) => {
      Object.defineProperty(header, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          bottom: 32,
          height: 32,
          left: index * 100,
          right: index * 100 + 100,
          top: 0,
          width: 100,
          x: index * 100,
          y: 0,
          toJSON: () => ({}),
        }),
      })
    })

    const nameHeader = screen.getByRole('button', { name: 'Name' })
    fireEvent.pointerDown(nameHeader, { button: 0, clientX: 20, pointerId: 2 })
    fireEvent.pointerMove(nameHeader, { clientX: 120, pointerId: 2 })
    fireEvent.pointerUp(nameHeader, { clientX: 120, pointerId: 2 })

    const nextHeaders = Array.from(
      document.querySelectorAll<HTMLTableCellElement>('table.dropbox-recents-table th'),
    )
    const cols = document.querySelectorAll<HTMLTableColElement>('table.dropbox-recents-table col')

    expect(
      nextHeaders.map((header) =>
        header.querySelector('.dropbox-recents-header-label')?.textContent?.trim(),
      ),
    ).toEqual(['Path', 'Name', 'Last synced', 'Last modified'])
    expect(cols[0]?.style.width).toBe('20%')
    expect(cols[1]?.style.width).toBe('42%')
    expect(onColumnOrderChange).toHaveBeenLastCalledWith(
      ['path', 'name', 'synced', 'modified'],
      [0.2, 0.42, 0.23, 0.15],
    )
  })

  it('shows column move controls on a title tap and hides them on an outside tap', () => {
    render(
      <DropboxRecentFiles
        {...defaultColumnProps}
        files={files}
        selectedKey={null}
        onSelect={() => undefined}
        onDeleteFromList={() => undefined}
      />,
    )

    const nameHeader = screen.getByRole('button', { name: 'Name' })
    const headerCell = nameHeader.closest('th')

    fireEvent.pointerDown(nameHeader, { button: 0, clientX: 20, pointerId: 3 })
    fireEvent.pointerUp(nameHeader, { clientX: 20, pointerId: 3 })

    expect(headerCell?.className ?? '').toContain('is-column-controls-active')

    fireEvent.pointerDown(document.body)

    expect(headerCell?.className ?? '').not.toContain('is-column-controls-active')
  })

  it('keeps the resize separator usable while title-tap move controls are open', () => {
    const onColumnWidthsChange = vi.fn()

    render(
      <DropboxRecentFiles
        {...defaultColumnProps}
        onColumnWidthsChange={onColumnWidthsChange}
        files={files}
        selectedKey={null}
        onSelect={() => undefined}
        onDeleteFromList={() => undefined}
      />,
    )

    const table = document.querySelector('table.dropbox-recents-table') as HTMLTableElement
    Object.defineProperty(table, 'clientWidth', { configurable: true, value: 500 })

    const nameHeader = screen.getByRole('button', { name: 'Name' })
    fireEvent.pointerDown(nameHeader, { button: 0, clientX: 20, pointerId: 4 })
    fireEvent.pointerUp(nameHeader, { clientX: 20, pointerId: 4 })

    const resizer = screen.getByRole('separator', { name: 'Resize Name column' })
    fireEvent.pointerDown(resizer, { clientX: 180, pointerId: 5 })
    fireEvent.pointerMove(resizer, { clientX: 230, pointerId: 5 })
    fireEvent.pointerUp(resizer, { clientX: 230, pointerId: 5 })

    const committed = onColumnWidthsChange.mock.calls.at(-1)?.[0] as number[]
    expect(committed[0]).toBeCloseTo(0.4)
    expect(committed[1]).toBeCloseTo(0.2)
  })

  it('prefixes a • on a row with unsynced changes, and leaves a synced row plain', () => {
    const { rerender } = render(
      <DropboxRecentFiles
        {...defaultColumnProps}
        files={[{ ...baseFile, hasUnsyncedChanges: false }]}
        selectedKey={null}
        onSelect={() => undefined}
        onDeleteFromList={() => undefined}
      />,
    )

    // Synced row: plain name, no dot.
    expect(screen.getByText('a.txt')).not.toBeNull()
    expect(screen.queryByText('•a.txt')).toBeNull()

    rerender(
      <DropboxRecentFiles
        {...defaultColumnProps}
        files={[{ ...baseFile, hasUnsyncedChanges: true }]}
        selectedKey={null}
        onSelect={() => undefined}
        onDeleteFromList={() => undefined}
      />,
    )

    // Unsynced row: the • prefix appears (bold, no separating space) in the
    // normal (non-diverged) color.
    const cell = screen.getByText('•a.txt')
    expect(cell).not.toBeNull()
    expect(cell.closest('tr')?.className ?? '').not.toContain('is-diverged')
  })

  it('renders Last synced from syncedModifiedAt and Last modified from localModifiedAt', () => {
    render(
      <DropboxRecentFiles
        {...defaultColumnProps}
        files={[
          {
            ...baseFile,
            syncedModifiedAt: '2026-06-12T09:00:00Z',
            localModifiedAt: '2026-06-13T10:30:00Z',
          },
        ]}
        selectedKey="id:a"
        onSelect={() => undefined}
        onDeleteFromList={() => undefined}
      />,
    )

    // Four columns now: Name / Path / Last synced / Last modified. Each
    // timestamp cell formats its own field via toLocaleString.
    const cells = screen.getByText('a.txt').closest('tr')?.querySelectorAll('td')
    expect(cells?.length).toBe(4)
    expect(cells?.[2]?.textContent).toBe(new Date('2026-06-12T09:00:00Z').toLocaleString())
    expect(cells?.[3]?.textContent).toBe(new Date('2026-06-13T10:30:00Z').toLocaleString())

    // Both timestamp headers are present.
    expect(screen.getByRole('columnheader', { name: /Last synced/ })).not.toBeNull()
    expect(screen.getByRole('columnheader', { name: /Last modified/ })).not.toBeNull()
  })

  it('shows a missing row status in Last synced while preserving the folder path', () => {
    render(
      <DropboxRecentFiles
        {...defaultColumnProps}
        files={files}
        selectedKey="id:a"
        indicators={new Map([['id:a', 'missing']])}
        onSelect={() => undefined}
        onDeleteFromList={() => undefined}
      />,
    )

    const row = screen.getByText('a.txt').closest('tr')

    expect(row?.className).toContain('is-missing')
    const cells = row?.querySelectorAll('td')

    expect(cells?.[1]?.textContent).toBe('/Notes')
    expect(cells?.[2]?.textContent).toBe('Not found')
  })

  it('renders a replacement candidate like a conflict row without changing the timestamp', () => {
    render(
      <DropboxRecentFiles
        {...defaultColumnProps}
        files={[{ ...baseFile, syncedModifiedAt: '2026-06-12T09:00:00.000Z' }]}
        selectedKey="id:a"
        indicators={new Map([['id:a', 'replacement-candidate']])}
        onSelect={() => undefined}
        onDeleteFromList={() => undefined}
      />,
    )

    const marked = screen.getByText('•a.txt')
    const row = marked.closest('tr')

    expect(row?.className).toContain('is-replacement-candidate')
    expect(row?.className).not.toContain('is-missing')
    expect(row?.querySelectorAll('td')?.[2]?.textContent).not.toBe('Not found')
  })

  it('long-press opens the menu and the synthetic touchend click does not close it', () => {
    vi.useFakeTimers()

    const onSelect = vi.fn()

    render(
      <DropboxRecentFiles
        {...defaultColumnProps}
        files={files}
        selectedKey={null}
        onSelect={onSelect}
        onDeleteFromList={() => undefined}
      />,
    )

    const row = screen.getByText('a.txt')

    fireEvent.touchStart(row, { touches: [{ clientX: 10, clientY: 10 }] })
    act(() => {
      vi.advanceTimersByTime(600)
    })

    expect(screen.getByRole('menuitem', { name: 'Delete from list' })).not.toBeNull()

    // Most mobile browsers emit a synthetic click after touchend; it must
    // neither close the just-opened menu nor re-fire row selection.
    fireEvent.touchEnd(row)
    fireEvent.click(row)

    expect(screen.getByRole('menuitem', { name: 'Delete from list' })).not.toBeNull()
    expect(onSelect).toHaveBeenCalledTimes(1)

    // Once the suppression window passes, a genuine outside click closes it.
    act(() => {
      vi.advanceTimersByTime(800)
    })
    fireEvent.click(document.body)
    expect(screen.queryByRole('menuitem', { name: 'Delete from list' })).toBeNull()
  })
})
