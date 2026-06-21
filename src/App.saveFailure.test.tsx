import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { createDraftThroughDialog, mockBlobUrls } from './test/appHarness'

const providerState = vi.hoisted(() => ({
  envelope: null as string | null,
  failSaves: false,
  save: vi.fn(async (envelope: string) => {
    if (providerState.failSaves) {
      throw new Error('save failed')
    }

    providerState.envelope = envelope
  }),
}))

vi.mock('./storage/providerRegistry', () => ({
  getStorageProvider: () => ({
    kind: 'draft',
    load: async () => {
      if (!providerState.envelope) {
        throw new Error('No vault')
      }

      return providerState.envelope
    },
    save: providerState.save,
    status: async () => ({
      detail: providerState.envelope ? 'Draft is ready.' : 'No draft yet. Create one with New draft.',
      state: providerState.envelope ? 'ready' : 'needs-user-action',
    }),
  }),
}))

vi.mock('./editor/CodeMirrorEditor', async () => {
  const React = await import('react')

  return {
    CodeMirrorEditor: React.forwardRef(
      (
        {
          onChange,
          value,
        }: {
          onChange: (value: string) => void
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
          onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
            onChange(event.target.value),
          value,
        })
      },
    ),
  }
})

beforeEach(() => {
  providerState.envelope = null
  providerState.failSaves = false
  providerState.save.mockClear()
  // jsdom has no File System Access API; tests that exercise the native save
  // picker branch define this per-test and restore it in their finally blocks.
  globalThis.showSaveFilePicker = undefined
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const createUnlockedVault = async () => {
  render(<App />)

  await createDraftThroughDialog('correct horse battery staple')

  return screen.findByTestId('editor')
}

const createFakeSaveHandle = (name: string) => {
  const written: string[] = []
  const handle = {
    kind: 'file',
    name,
    createWritable: async () => ({
      close: async () => undefined,
      write: async (data: unknown) => {
        written.push(String(data))
      },
    }),
  } as unknown as FileSystemFileHandle

  return { handle, written }
}

const setAutoLockToOneMinute = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
  const dialog = screen.getByRole('dialog', { name: 'Settings' })

  fireEvent.change(within(dialog).getByLabelText('Auto-lock'), { target: { value: '1' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
}

const advanceTimers = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

const triggerFailedAutoLock = async (text: string) => {
  const editor = (await createUnlockedVault()) as HTMLTextAreaElement

  vi.useFakeTimers()
  await setAutoLockToOneMinute()
  providerState.failSaves = true
  fireEvent.change(editor, { target: { value: text } })
  await advanceTimers(60_000)

  return screen.getByRole('alertdialog', { name: 'Unsaved changes not saved' })
}

describe('App save failure handling', () => {
  it('voluntary Home exit with failed dirty save offers Export / Exit anyway / Stay (SPEC §10)', async () => {
    const editor = (await createUnlockedVault()) as HTMLTextAreaElement
    const restoreBlobUrls = mockBlobUrls()
    let clickedDownload = ''
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        clickedDownload = this.download
      })

    try {
      providerState.failSaves = true
      fireEvent.change(editor, { target: { value: 'unsaved text' } })
      fireEvent.click(screen.getByRole('button', { name: 'Home' }))
      // Home asks "Exit?" first; confirm to reach the lock path.
      fireEvent.click(await screen.findByRole('button', { name: 'OK' }))

      const dialog = await screen.findByRole('alertdialog', { name: /save changes/i })

      expect(
        within(dialog).getByText(/Couldn.t save your latest changes.*lost if you exit/),
      ).not.toBeNull()
      expect(within(dialog).getByRole('button', { name: 'Export a copy' })).not.toBeNull()
      expect(within(dialog).getByRole('button', { name: 'Exit anyway' })).not.toBeNull()
      expect(within(dialog).getByRole('button', { name: 'Stay' })).not.toBeNull()
      expect((screen.getByTestId('editor') as HTMLTextAreaElement).value).toBe('unsaved text')
      expect(screen.queryByRole('button', { name: 'Edit draft' })).toBeNull()

      fireEvent.click(within(dialog).getByRole('button', { name: 'Export a copy' }))
      await waitFor(() => expect(clickedDownload).toBe('enote.txt'))
      expect((screen.getByTestId('editor') as HTMLTextAreaElement).value).toBe('unsaved text')

      fireEvent.click(within(dialog).getByRole('button', { name: 'Stay' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog', { name: /save changes/i })).toBeNull())
      expect((screen.getByTestId('editor') as HTMLTextAreaElement).value).toBe('unsaved text')

      fireEvent.click(screen.getByRole('button', { name: 'Home' }))
      fireEvent.click(await screen.findByRole('button', { name: 'OK' }))
      const reopenedDialog = await screen.findByRole('alertdialog', { name: /save changes/i })

      fireEvent.click(within(reopenedDialog).getByRole('button', { name: 'Exit anyway' }))
      expect(await screen.findByRole('button', { name: 'Edit draft' })).not.toBeNull()
      expect(screen.queryByTestId('editor')).toBeNull()
    } finally {
      anchorClick.mockRestore()
      restoreBlobUrls()
    }
  })

  it('auto-lock with failed dirty save soft-locks and removes plaintext from the DOM', async () => {
    const sensitiveText = 'unsaved auto-lock secret'

    await triggerFailedAutoLock(sensitiveText)

    expect(
      screen.getByText('Unsaved changes will be lost if you exit now. Enter password to continue.'),
    ).not.toBeNull()
    expect(screen.queryByTestId('editor')).toBeNull()
    expect(screen.queryByDisplayValue(sensitiveText)).toBeNull()
    expect(document.body.textContent).not.toContain(sensitiveText)
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Export a copy' })).toBeNull()

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock options' }))

    expect(screen.getByText('Incorrect password.')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Export a copy' })).toBeNull()
    expect(document.body.textContent).not.toContain(sensitiveText)
  })

  it('soft-lock blocks the Ctrl+S export shortcut so plaintext cannot leave past the verification gate', async () => {
    const sensitiveText = 'shortcut must not export this'
    const restoreBlobUrls = mockBlobUrls()
    let clickedDownload = ''
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        clickedDownload = this.download
      })
    const savePicker = vi.fn(async (): Promise<FileSystemFileHandle> => {
      throw new DOMException('The user aborted a request.', 'AbortError')
    })
    globalThis.showSaveFilePicker = savePicker

    try {
      const softLockDialog = await triggerFailedAutoLock(sensitiveText)
      vi.useRealTimers()

      const dispatchCtrlS = async () => {
        act(() => {
          document.dispatchEvent(
            new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }),
          )
        })
        await new Promise((resolve) => setTimeout(resolve, 0))
      }

      // With the soft-lock overlay mounted, Ctrl+S must not run any export path:
      // neither the download-anchor branch nor the native save picker.
      await dispatchCtrlS()
      expect(clickedDownload).toBe('')
      expect(anchorClick).not.toHaveBeenCalled()
      expect(savePicker).not.toHaveBeenCalled()

      // Now neutralize the `[aria-modal="true"]` DOM coincidence the older check
      // relied on. The shortcut must STILL stand down — proving the explicit
      // `isSoftLockedRef` guard (not the modal probe) is what blocks export
      // during soft-lock. Without that guard this dispatch would export plaintext.
      const modalEls = document.querySelectorAll('[aria-modal="true"]')
      expect(modalEls.length).toBeGreaterThan(0)
      modalEls.forEach((el) => el.removeAttribute('aria-modal'))

      await dispatchCtrlS()
      expect(clickedDownload).toBe('')
      expect(anchorClick).not.toHaveBeenCalled()
      expect(savePicker).not.toHaveBeenCalled()

      // The soft-lock verification gate is still in front, plaintext still hidden.
      expect(softLockDialog).not.toBeNull()
      expect(
        screen.getByText('Unsaved changes will be lost if you exit now. Enter password to continue.'),
      ).not.toBeNull()
      expect(document.body.textContent).not.toContain(sensitiveText)
    } finally {
      anchorClick.mockRestore()
      restoreBlobUrls()
      globalThis.showSaveFilePicker = undefined
    }
  })

  it('soft-lock Continue restores the in-memory editor only after the password is verified', async () => {
    const sensitiveText = 'continue restores this text'
    const restoreBlobUrls = mockBlobUrls()
    let clickedDownload = ''
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        clickedDownload = this.download
      })

    try {
      await triggerFailedAutoLock(sensitiveText)
      vi.useRealTimers()

      fireEvent.change(screen.getByLabelText('Password'), {
        target: { value: 'correct horse battery staple' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Unlock options' }))

      expect(screen.getByRole('button', { name: 'Continue' })).not.toBeNull()
      expect(screen.getByRole('button', { name: 'Export a copy' })).not.toBeNull()
      expect(document.body.textContent).not.toContain(sensitiveText)

      fireEvent.click(screen.getByRole('button', { name: 'Export a copy' }))
      await vi.waitFor(() => expect(clickedDownload).toBe('enote.txt'))
      expect(screen.queryByTestId('editor')).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
      const editor = (await screen.findByTestId('editor')) as HTMLTextAreaElement

      expect(editor.value).toBe(sensitiveText)
    } finally {
      anchorClick.mockRestore()
      restoreBlobUrls()
    }
  })

  it('soft-lock retry success hard-locks after the dirty save finally succeeds', async () => {
    await triggerFailedAutoLock('retry eventually saves this')

    providerState.failSaves = false
    await advanceTimers(10_000)

    await vi.waitFor(() => {
      expect(screen.queryByRole('alertdialog', { name: 'Unsaved changes not saved' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Edit draft' })).not.toBeNull()
    })
    expect(screen.queryByTestId('editor')).toBeNull()
    expect(providerState.envelope).not.toBeNull()
  })

  it('soft-lock Exit & discard hard-locks without saving the failed dirty text', async () => {
    await triggerFailedAutoLock('discard this failed text')
    const envelopeBeforeDiscard = providerState.envelope

    fireEvent.click(screen.getByRole('button', { name: 'Exit & discard' }))

    expect(screen.getByRole('button', { name: 'Edit draft' })).not.toBeNull()
    expect(screen.queryByTestId('editor')).toBeNull()
    expect(providerState.envelope).toBe(envelopeBeforeDiscard)
  })

  it('auto-lock without a failed dirty save hard-locks normally', async () => {
    await createUnlockedVault()

    vi.useFakeTimers()
    await setAutoLockToOneMinute()
    await advanceTimers(60_000)

    expect(screen.queryByRole('alertdialog', { name: 'Unsaved changes not saved' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Edit draft' })).not.toBeNull()
    expect(screen.queryByTestId('editor')).toBeNull()
  })

  it('a draft session offers Save to Dropbox + Export to Files, never a Save button (SPEC §4)', async () => {
    // The draft persists via autosave; no Save button is shown
    // from every session. A Dropbox-mode draft session's storage actions are
    // Save to Dropbox (the promotion) and Export to Files.
    await createUnlockedVault()

    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Save to Dropbox' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Export to Files' })).not.toBeNull()
  })

  it('Export to Files downloads under the suggested default name without prompting', async () => {
    const editor = (await createUnlockedVault()) as HTMLTextAreaElement
    const restoreBlobUrls = mockBlobUrls()
    const promptSpy = vi.spyOn(window, 'prompt')
    let clickedDownload = ''
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        clickedDownload = this.download
      })

    try {
      fireEvent.change(editor, { target: { value: 'export text' } })
      fireEvent.click(screen.getByRole('button', { name: 'Export to Files' }))

      await waitFor(() => expect(clickedDownload).toBe('enote.txt'))
      expect(promptSpy).not.toHaveBeenCalled()
    } finally {
      anchorClick.mockRestore()
      promptSpy.mockRestore()
      restoreBlobUrls()
    }
  })

  it('Export to Files writes through the native save picker with the suggested name', async () => {
    const editor = (await createUnlockedVault()) as HTMLTextAreaElement
    const { handle, written } = createFakeSaveHandle('enote.txt')
    const savePicker = vi.fn(async () => handle)
    globalThis.showSaveFilePicker = savePicker

    try {
      fireEvent.change(editor, { target: { value: 'export text' } })
      fireEvent.click(screen.getByRole('button', { name: 'Export to Files' }))

      expect(await screen.findByText('Encrypted copy saved.')).not.toBeNull()
      expect(savePicker).toHaveBeenCalledWith(
        expect.objectContaining({ excludeAcceptAllOption: true, suggestedName: 'enote.txt' }),
      )
      expect(written).toHaveLength(1)
      expect(written[0]).toContain('ciphertext')
      expect(written[0]).toMatch(/\n$/)
    } finally {
      globalThis.showSaveFilePicker = undefined
    }
  })

  it('Export to Files stays quiet when the native save picker is canceled', async () => {
    const editor = (await createUnlockedVault()) as HTMLTextAreaElement
    const savePicker = vi.fn(async (): Promise<FileSystemFileHandle> => {
      throw new DOMException('The user aborted a request.', 'AbortError')
    })
    globalThis.showSaveFilePicker = savePicker

    try {
      fireEvent.change(editor, { target: { value: 'export text' } })
      fireEvent.click(screen.getByRole('button', { name: 'Export to Files' }))

      await waitFor(() => expect(savePicker).toHaveBeenCalled())
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(screen.queryByText('Encrypted copy saved.')).toBeNull()
      expect(screen.queryByText('Could not prepare the encrypted copy for download.')).toBeNull()
    } finally {
      globalThis.showSaveFilePicker = undefined
    }
  })

  it('Export to Files aborts when the picked name is not .txt or .text', async () => {
    const editor = (await createUnlockedVault()) as HTMLTextAreaElement
    const { handle, written } = createFakeSaveHandle('encrypted-export.enote')
    const savePicker = vi.fn(async () => handle)
    globalThis.showSaveFilePicker = savePicker

    try {
      fireEvent.change(editor, { target: { value: 'export text' } })
      fireEvent.click(screen.getByRole('button', { name: 'Export to Files' }))

      expect(await screen.findByText('Export filename must end in .txt or .text.')).not.toBeNull()
      expect(written).toHaveLength(0)
    } finally {
      globalThis.showSaveFilePicker = undefined
    }
  })
})
