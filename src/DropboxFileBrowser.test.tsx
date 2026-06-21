import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DropboxFileBrowser } from './DropboxFileBrowser'
import type { DropboxFolderEntry } from './storage/storageProvider'

const entry = (overrides: Partial<DropboxFolderEntry>): DropboxFolderEntry => ({
  kind: 'file',
  name: 'file.txt',
  pathDisplay: '/file.txt',
  pathLower: '/file.txt',
  rev: null,
  serverModified: null,
  size: null,
  ...overrides,
})

const rootListing = {
  entries: [
    entry({ kind: 'file', name: 'thesis.pdf', pathDisplay: '/thesis.pdf', pathLower: '/thesis.pdf', size: 2_100_000 }),
    entry({
      kind: 'file',
      name: 'enote.txt',
      pathDisplay: '/enote.txt',
      pathLower: '/enote.txt',
      rev: 'rev-1',
      serverModified: '2026-06-10T12:00:00Z',
      size: 48_000,
    }),
    entry({ kind: 'folder', name: 'Notes', pathDisplay: '/Notes', pathLower: '/notes' }),
    entry({
      kind: 'file',
      name: 'old.txt',
      pathDisplay: '/old.txt',
      pathLower: '/old.txt',
      serverModified: '2026-03-03T12:00:00Z',
      size: 31_000,
    }),
  ],
  truncated: false,
}

afterEach(cleanup)

describe('DropboxFileBrowser', () => {
  it('groups folders, eligible files, then grayed ineligible entries; one tap opens', async () => {
    const listFolder = vi.fn(async () => rootListing)
    const onChooseFile = vi.fn()

    render(
      <DropboxFileBrowser
        mode="choose"
        listFolder={listFolder}
        markedPathLower="/enote.txt"
        onCancel={() => undefined}
        onChooseFile={onChooseFile}
      />,
    )

    const list = await screen.findByRole('list')
    const rows = Array.from(list.querySelectorAll('.dropbox-browser-row'))

    // Fixed group order: folder, eligible (.txt) files, ineligible last.
    expect(
      rows.map((row) => row.querySelector('.dropbox-browser-name')?.textContent),
    ).toEqual(['Notes', 'enote.txt', 'old.txt', 'thesis.pdf'])

    // The ineligible row is inert; the connected file is marked.
    const pdfRow = rows[3]
    expect(pdfRow?.tagName).toBe('DIV')
    expect(pdfRow?.getAttribute('aria-disabled')).toBe('true')
    expect(rows[1]?.getAttribute('aria-current')).toBe('true')

    // One tap on an eligible file chooses it — no second confirm step.
    fireEvent.click(screen.getByRole('button', { name: /enote\.txt/ }))
    expect(onChooseFile).toHaveBeenCalledWith('/enote.txt')
  })

  it('column header taps toggle ascending/descending within groups', async () => {
    const listFolder = vi.fn(async () => rootListing)

    render(
      <DropboxFileBrowser
        mode="choose"
        listFolder={listFolder}
        onCancel={() => undefined}
        onChooseFile={() => undefined}
      />,
    )

    await screen.findByRole('list')
    const names = () =>
      Array.from(document.querySelectorAll('.dropbox-browser-name')).map(
        (node) => node.textContent,
      )

    fireEvent.click(screen.getByRole('button', { name: /^Modified/ }))
    // Ascending by date within the eligible group; the folder stays first
    // (folders lack a modified time and keep name order).
    expect(names()).toEqual(['Notes', 'old.txt', 'enote.txt', 'thesis.pdf'])

    fireEvent.click(screen.getByRole('button', { name: /^Modified/ }))
    expect(names()).toEqual(['Notes', 'enote.txt', 'old.txt', 'thesis.pdf'])
  })

  it('breadcrumb descends into folders and jumps back to the root', async () => {
    const notesListing = {
      entries: [
        entry({
          kind: 'file',
          name: 'inner.txt',
          pathDisplay: '/Notes/inner.txt',
          pathLower: '/notes/inner.txt',
        }),
      ],
      truncated: false,
    }
    const listFolder = vi.fn(async (path: string) =>
      path === '/Notes' ? notesListing : rootListing,
    )
    const onNavigate = vi.fn()

    render(
      <DropboxFileBrowser
        mode="choose"
        listFolder={listFolder}
        onCancel={() => undefined}
        onChooseFile={() => undefined}
        onNavigate={onNavigate}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Notes' }))
    await screen.findByText('inner.txt')

    // Every navigation is reported, so browse-and-cancel still updates the
    // caller's session-remembered folder (SPEC §9).
    expect(onNavigate).toHaveBeenCalledWith('/Notes')

    const breadcrumb = screen.getByRole('navigation', { name: 'Dropbox folder trail' })
    expect(breadcrumb.textContent).toContain('Notes')

    // The root segment jumps straight back.
    fireEvent.click(screen.getByRole('button', { name: 'Dropbox' }))
    await screen.findByText('thesis.pdf')
  })

  it('create mode submits folder + filename and validates the name', async () => {
    const listFolder = vi.fn(async () => rootListing)
    const onChooseDestination = vi.fn()

    render(
      <DropboxFileBrowser
        mode="create"
        listFolder={listFolder}
        onCancel={() => undefined}
        onChooseDestination={onChooseDestination}
      />,
    )

    await screen.findByRole('list')

    // The destination action is a plain Save (the dialog title names the context).
    const primary = screen.getByRole('button', { name: 'Save' })
    const nameField = screen.getByLabelText('File name') as HTMLInputElement

    // Pre-filled suggestion, freely editable.
    expect(nameField.value).toBe('enote.txt')

    // A name with a slash is refused; nothing is submitted.
    fireEvent.change(nameField, { target: { value: 'sub/dir.txt' } })
    fireEvent.click(primary)
    expect(onChooseDestination).not.toHaveBeenCalled()
    expect(screen.getByText(/single name .no \/./)).not.toBeNull()

    // A missing or foreign extension is no longer rejected — .txt is appended.
    fireEvent.change(nameField, { target: { value: 'memo' } })
    fireEvent.click(primary)
    expect(onChooseDestination).toHaveBeenCalledWith('/memo.txt', false)

    // .TEXT is accepted case-insensitively and trimmed; no in-listing collision.
    fireEvent.change(nameField, { target: { value: '  notes.TEXT  ' } })
    fireEvent.click(primary)
    expect(onChooseDestination).toHaveBeenLastCalledWith('/notes.TEXT', false)

    // A name colliding case-insensitively with a listed file reports it
    // (UI courtesy; the provider probe stays authoritative).
    fireEvent.change(nameField, { target: { value: 'ENOTE.txt' } })
    fireEvent.click(primary)
    expect(onChooseDestination).toHaveBeenLastCalledWith('/ENOTE.txt', true)

    // Tapping an eligible existing file copies its name into the field, so
    // overwriting it needs no typing (the primary action still confirms).
    fireEvent.click(screen.getByRole('button', { name: /enote\.txt/ }))
    expect(nameField.value).toBe('enote.txt')
  })

  it('shows an in-dialog error with Retry on a listing failure — never an empty folder', async () => {
    const listFolder = vi
      .fn()
      .mockRejectedValueOnce(new Error('server hiccup'))
      .mockResolvedValueOnce(rootListing)

    render(
      <DropboxFileBrowser
        mode="choose"
        listFolder={listFolder}
        onCancel={() => undefined}
        onChooseFile={() => undefined}
      />,
    )

    expect(await screen.findByText('Could not list this Dropbox folder.')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('enote.txt')
  })

  it('authorization loss mid-browse points to relink — no retry', async () => {
    const authError = Object.assign(new Error('auth'), { code: 'auth' })
    const listFolder = vi.fn().mockRejectedValue(authError)

    render(
      <DropboxFileBrowser
        mode="choose"
        listFolder={listFolder}
        onCancel={() => undefined}
        onChooseFile={() => undefined}
      />,
    )

    expect(
      await screen.findByText('Dropbox authorization was lost. Relink Dropbox from the home screen.'),
    ).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(listFolder).toHaveBeenCalledTimes(1)
  })

  it('falls back to the root when the remembered start folder fails to list', async () => {
    const listFolder = vi
      .fn()
      .mockRejectedValueOnce(new Error('folder gone'))
      .mockResolvedValueOnce(rootListing)

    render(
      <DropboxFileBrowser
        mode="choose"
        initialFolder="/Deleted/folder"
        listFolder={listFolder}
        onCancel={() => undefined}
        onChooseFile={() => undefined}
      />,
    )

    await screen.findByText('enote.txt')
    expect(listFolder).toHaveBeenLastCalledWith('/')
  })

  it('shows the truncation notice for a capped listing', async () => {
    const listFolder = vi.fn(async () => ({ ...rootListing, truncated: true }))

    render(
      <DropboxFileBrowser
        mode="choose"
        listFolder={listFolder}
        onCancel={() => undefined}
        onChooseFile={() => undefined}
      />,
    )

    expect(await screen.findByText('Showing the first 10000 entries.')).not.toBeNull()
  })

  it('withholds the destination action while the listing is still loading', async () => {
    // A listing that never resolves: the dialog stays in its loading state.
    const listFolder = vi.fn(() => new Promise<never>(() => undefined))

    render(
      <DropboxFileBrowser
        mode="create"
        listFolder={listFolder}
        onCancel={() => undefined}
        onChooseDestination={() => undefined}
      />,
    )

    expect(await screen.findByText('Loading folder…')).not.toBeNull()
    // No destination can be chosen before the rows exist — the collision
    // check needs them, and the start folder may still fall back to the root.
    expect(screen.queryByLabelText('File name')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    // Cancel always works.
    expect(screen.getByRole('button', { name: 'Cancel' })).not.toBeNull()
  })

  it('offline mid-browse shows Retry but withholds the destination action', async () => {
    const offlineError = Object.assign(new Error('offline'), { code: 'offline' })
    const listFolder = vi
      .fn()
      .mockResolvedValueOnce(rootListing)
      .mockRejectedValueOnce(offlineError)
      .mockResolvedValueOnce(rootListing)

    render(
      <DropboxFileBrowser
        mode="create"
        listFolder={listFolder}
        onCancel={() => undefined}
        onChooseDestination={() => undefined}
      />,
    )

    // Going into a folder while offline fails with the offline state.
    fireEvent.click(await screen.findByRole('button', { name: 'Notes' }))
    expect(await screen.findByText('Device is offline.')).not.toBeNull()

    // Nothing can succeed offline: no destination submit, no name field.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByLabelText('File name')).toBeNull()

    // Connectivity back: Retry recovers in place and the destination returns.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('enote.txt')
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeNull()
  })

  it('retries the current folder when the app comes back online', async () => {
    const offlineError = Object.assign(new Error('offline'), { code: 'offline' })
    const listFolder = vi
      .fn()
      .mockResolvedValueOnce(rootListing)
      .mockRejectedValueOnce(offlineError)
      .mockResolvedValueOnce(rootListing)

    render(
      <DropboxFileBrowser
        mode="create"
        listFolder={listFolder}
        onCancel={() => undefined}
        onChooseDestination={() => undefined}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Notes' }))
    expect(await screen.findByText('Device is offline.')).not.toBeNull()

    // The `online` listener is installed by the offline-state passive effect.
    // Flush it before firing `online`, or a loaded worker can drop the event.
    await act(async () => {})

    fireEvent(window, new Event('online'))

    // The `online` listener re-lists the current folder. Wait on the retry CALL
    // first — under full-suite parallel load the re-render that paints the result
    // can lag the listing, so a bare findByText('enote.txt') races. Asserting the
    // mock call is the deterministic signal that the retry fired against /Notes;
    // the rendered name then follows.
    await waitFor(() => expect(listFolder).toHaveBeenLastCalledWith('/Notes'))
    await screen.findByText('enote.txt')
  })

  it('arrow keys move the row focus through the list', async () => {
    const listFolder = vi.fn(async () => rootListing)

    render(
      <DropboxFileBrowser
        mode="choose"
        listFolder={listFolder}
        onCancel={() => undefined}
        onChooseFile={() => undefined}
      />,
    )

    const list = await screen.findByRole('list')
    const folderRow = screen.getByRole('button', { name: 'Notes' })
    const fileRow = screen.getByRole('button', { name: /enote\.txt/ })

    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(folderRow)

    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(fileRow)

    fireEvent.keyDown(list, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(folderRow)
  })

  it('a slow older navigation never overwrites a newer one', async () => {
    let resolveSlowNotes: (value: typeof rootListing) => void = () => undefined
    const notesPromise = new Promise<typeof rootListing>((resolve) => {
      resolveSlowNotes = resolve
    })
    const listFolder = vi.fn(async (path: string) => {
      if (path === '/Notes') {
        return notesPromise
      }

      return rootListing
    })

    render(
      <DropboxFileBrowser
        mode="choose"
        listFolder={listFolder}
        onCancel={() => undefined}
        onChooseFile={() => undefined}
      />,
    )

    // Start a slow navigation into /Notes, then jump back to the root before
    // it resolves.
    fireEvent.click(await screen.findByRole('button', { name: 'Notes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dropbox' }))
    await screen.findByText('enote.txt')

    // The stale /Notes listing finally arrives — it must be discarded.
    resolveSlowNotes({
      entries: [
        entry({
          kind: 'file',
          name: 'stale.txt',
          pathDisplay: '/Notes/stale.txt',
          pathLower: '/notes/stale.txt',
        }),
      ],
      truncated: false,
    })
    await waitFor(() => expect(screen.queryByText('stale.txt')).toBeNull())
    expect(screen.getByText('enote.txt')).not.toBeNull()
  })

  it('a deep trail collapses middle segments into an inert ellipsis', async () => {
    const deepListing = { entries: [], truncated: false }
    const listFolder = vi.fn(async () => deepListing)

    render(
      <DropboxFileBrowser
        mode="choose"
        initialFolder="/a/b/c/d/e"
        listFolder={listFolder}
        onCancel={() => undefined}
        onChooseFile={() => undefined}
      />,
    )

    const breadcrumb = await screen.findByRole('navigation', { name: 'Dropbox folder trail' })

    await waitFor(() => expect(breadcrumb.textContent).toContain('…'))
    // Root + ellipsis + the last two segments; the middle is not tappable.
    expect(breadcrumb.textContent).toBe('Dropbox…de')
    expect(screen.queryByRole('button', { name: 'b' })).toBeNull()
  })
})
