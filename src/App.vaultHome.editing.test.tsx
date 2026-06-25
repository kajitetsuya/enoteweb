import { getProviderState, seedDraft } from './App.vaultHome.testkit'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App'
import {
  CryptoService,
  SECRET_KEY_MODE_REQUIRED,
  getEnvelopeSecretKeyMode,
  parseEnvelope,
} from './crypto/cryptoService'
import { generateSecretKeyString, parseSecretKeyString } from './crypto/secretKey'
import {
  createDraftThroughDialog,
  fastKdf,
  findEditDraftButton,
  unlockDraftThroughDialog,
} from './test/appHarness'

const providerState = getProviderState()

const expectedAutoLockOptionLabels = [
  'Never',
  'After 1 minute',
  'After 2 minutes',
  'After 5 minutes',
  'After 10 minutes',
  'After 15 minutes',
]

const expectedAutoLockOptionValues = ['0', '1', '2', '5', '10', '15']

const expectAutoLockOptions = (select: HTMLSelectElement) => {
  expect(Array.from(select.options, (option) => option.textContent)).toEqual(
    expectedAutoLockOptionLabels,
  )
  expect(Array.from(select.options, (option) => option.value)).toEqual(
    expectedAutoLockOptionValues,
  )
}

describe('Draft home actions', () => {
  it('resolves a stored local-file override to the device default when unsupported', async () => {
    const { vaultStore } = await import('./storage/vaultStore')
    await vaultStore.saveSetting({ key: 'storageProvider', value: 'local-file' })

    render(<App />)

    // The unified draft home must render, not the Local File home with its
    // recent-files table.
    expect(await screen.findByRole('button', { name: 'New draft' })).not.toBeNull()
    expect(screen.queryByText('Local encrypted files')).toBeNull()

    // Without the File System Access API a stored `local-file` choice cannot
    // work, so it is re-resolved to the capability default (Dropbox Mode) and
    // persisted as an explicit mode, once (SPEC §2).
    await waitFor(async () => {
      expect((await vaultStore.getSetting('storageProvider'))?.value).toBe('dropbox')
    })
  })

  it('shows the supported Auto-lock choices in Home and editor Settings', async () => {
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
    const homeDialog = screen.getByRole('dialog', { name: 'Settings' })
    const homeAutoLock = within(homeDialog).getByLabelText('Auto-lock') as HTMLSelectElement

    expect(homeAutoLock.id).toBe('home-auto-lock-setting')
    expectAutoLockOptions(homeAutoLock)

    fireEvent.click(within(homeDialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull())

    await createDraftThroughDialog('auto-lock-options-pass')
    await screen.findByTestId('editor', undefined, { timeout: 15_000 })
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))

    const editorDialog = screen.getByRole('dialog', { name: 'Settings' })
    const editorAutoLock = within(editorDialog).getByLabelText(
      'Auto-lock',
    ) as HTMLSelectElement

    expect(editorAutoLock.id).toBe('auto-lock-setting')
    expectAutoLockOptions(editorAutoLock)
  })

  it.each([
    ['corrupt', 'not-a-number' as unknown],
    ['old 30-minute', 30],
    ['old 60-minute', 60],
  ])('coerces a %s stored autoLockMinutes back to the default (Never)', async (_label, value) => {
    const { vaultStore } = await import('./storage/vaultStore')
    await vaultStore.saveSetting({
      key: 'autoLockMinutes',
      value: value as number,
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))

    const autoLock = within(screen.getByRole('dialog', { name: 'Settings' })).getByLabelText(
      'Auto-lock',
    ) as HTMLSelectElement
    // Unsupported stored values fall back to the default (0 = "Never").
    expect(autoLock.value).toBe('0')
  })

  it('Ctrl+F opens the custom search panel while unlocked', async () => {
    render(<App />)

    await createDraftThroughDialog('shortcut-pass')
    await screen.findByTestId('editor', undefined, { timeout: 15_000 })

    expect(screen.queryByPlaceholderText('Find')).toBeNull()
    fireEvent.keyDown(document, { key: 'f', ctrlKey: true })

    expect(
      await screen.findByPlaceholderText('Find', undefined, { timeout: 15_000 }),
    ).not.toBeNull()
  })

  it('search shortcuts are inert while locked', async () => {
    render(<App />)

    await screen.findByRole('button', { name: 'New draft' })
    fireEvent.keyDown(document, { key: 'f', ctrlKey: true })

    expect(screen.queryByPlaceholderText('Find')).toBeNull()
  })

  it('Ctrl+H opens the panel focusing Replace; Escape closes it', async () => {
    render(<App />)

    await createDraftThroughDialog('shortcut-pass')
    await screen.findByTestId('editor', undefined, { timeout: 15_000 })

    fireEvent.keyDown(document, { key: 'h', ctrlKey: true })

    // Generous timeout: sibling tests run real Argon2id, so the panel render
    // can land late under full-suite CPU load.
    const replaceInput = (await screen.findByPlaceholderText('Replace', undefined, {
      timeout: 15_000,
    })) as HTMLInputElement

    await waitFor(() => expect(document.activeElement).toBe(replaceInput))

    fireEvent.keyDown(replaceInput, { key: 'Escape' })
    expect(screen.queryByPlaceholderText('Find')).toBeNull()
  })

  it('Ctrl+F selects the existing query text for immediate retyping', async () => {
    render(<App />)

    await createDraftThroughDialog('shortcut-pass')
    await screen.findByTestId('editor', undefined, { timeout: 15_000 })

    fireEvent.keyDown(document, { key: 'f', ctrlKey: true })

    // Generous timeout: sibling tests run real Argon2id (full-suite CPU load).
    const findInput = (await screen.findByPlaceholderText('Find', undefined, {
      timeout: 15_000,
    })) as HTMLInputElement

    fireEvent.change(findInput, { target: { value: 'alpha' } })
    fireEvent.keyDown(document, { key: 'f', ctrlKey: true })

    await waitFor(() => {
      expect(document.activeElement).toBe(findInput)
      expect(findInput.selectionStart).toBe(0)
      expect(findInput.selectionEnd).toBe('alpha'.length)
    })
  })

  it('Ctrl+S runs Export to Files in a draft session', async () => {
    const written: string[] = []
    globalThis.showSaveFilePicker = async () =>
      ({
        kind: 'file',
        name: 'enote.txt',
        createWritable: async () => ({
          close: async () => undefined,
          write: async (data: unknown) => {
            written.push(String(data))
          },
        }),
      }) as unknown as FileSystemFileHandle

    render(<App />)

    await createDraftThroughDialog('shortcut-pass')
    await screen.findByTestId('editor', undefined, { timeout: 15_000 })

    fireEvent.keyDown(document, { key: 's', ctrlKey: true })

    expect(await screen.findByText('Encrypted copy saved.', undefined, { timeout: 15_000 })).not.toBeNull()
    expect(written).toHaveLength(1)
  })

  it('status shows Opened until the first save of the session', async () => {
    render(<App />)

    await createDraftThroughDialog('status-pass')
    await screen.findByTestId('editor', undefined, { timeout: 15_000 })

    // Freshly created/opened: no save has run this session yet. The filename
    // line reads "Draft" in a draft session (SPEC §15).
    expect(screen.getByText('Opened')).not.toBeNull()
    expect(screen.getByText('Draft', { selector: '.toolbar-file-name' })).not.toBeNull()
    expect(screen.queryByText('Autosaved')).toBeNull()

    // The read-only toggle performs a real save; the label switches over.
    fireEvent.click(screen.getByRole('button', { name: 'Read-only' }))
    expect(
      await screen.findByText('Autosaved', undefined, { timeout: 15_000 }),
    ).not.toBeNull()

    // A relock/unlock starts a new session: back to Opened. Home confirms
    // before exiting.
    fireEvent.click(screen.getByRole('button', { name: 'Home' }))
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }))
    await unlockDraftThroughDialog('status-pass')
    await screen.findByTestId('editor', undefined, { timeout: 15_000 })

    expect(screen.getByText('Opened')).not.toBeNull()
  })

  it('the clear (✕) empties the find box and hides itself', async () => {
    render(<App />)

    await createDraftThroughDialog('clear-pass')
    await screen.findByTestId('editor', undefined, { timeout: 15_000 })

    fireEvent.keyDown(document, { key: 'f', ctrlKey: true })
    const findInput = (await screen.findByPlaceholderText('Find', undefined, {
      timeout: 15_000,
    })) as HTMLInputElement

    // No text, no button.
    expect(screen.queryByRole('button', { name: 'Clear find' })).toBeNull()

    fireEvent.change(findInput, { target: { value: 'alpha' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clear find' }))

    expect(findInput.value).toBe('')
    expect(screen.queryByRole('button', { name: 'Clear find' })).toBeNull()
  })

  it('shows the live match count while typing a query, no navigation needed', async () => {
    render(<App />)

    await createDraftThroughDialog('live-count-pass')
    const editor = await screen.findByTestId('editor', undefined, { timeout: 15_000 })

    fireEvent.change(editor, { target: { value: 'alpha beta alpha' } })

    fireEvent.keyDown(document, { key: 'f', ctrlKey: true })
    const findInput = await screen.findByPlaceholderText('Find', undefined, {
      timeout: 15_000,
    })

    fireEvent.change(findInput, { target: { value: 'alpha' } })
    expect(await screen.findByText('2 matches', undefined, { timeout: 15_000 })).not.toBeNull()

    fireEvent.change(findInput, { target: { value: 'alpha b' } })
    expect(await screen.findByText('1 match', undefined, { timeout: 15_000 })).not.toBeNull()

    // A scan stopped at the engine's 10000-match cap reports "10000+", not a
    // false exact total.
    fireEvent.change(editor, { target: { value: 'a '.repeat(10_001) } })
    fireEvent.change(findInput, { target: { value: 'a' } })
    expect(await screen.findByText('10000+ matches', undefined, { timeout: 15_000 })).not.toBeNull()

    // Deleting the query clears the count (empty query stays silent).
    fireEvent.change(findInput, { target: { value: '' } })
    await waitFor(() => expect(screen.queryByText('1 match')).toBeNull(), { timeout: 15_000 })
    expect(screen.queryByText('0 matches')).toBeNull()
  })

  it('retracts chrome only while the keyboard belongs to the editor', async () => {
    // Fake on-screen keyboard: a visual viewport much shorter than the window.
    class FakeViewport extends EventTarget {
      height = window.innerHeight - 300
      offsetTop = 0
      scale = 1
    }
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: new FakeViewport(),
    })

    try {
      render(<App />)

      await createDraftThroughDialog('retract-pass')
      const editor = await screen.findByTestId('editor', undefined, { timeout: 15_000 })
      const shell = document.querySelector('.editor-shell') as HTMLElement

      expect(shell.className).not.toContain('is-typing-in-editor')

      // Keyboard up + editor focus: chrome retracts.
      fireEvent.focus(editor)
      await waitFor(() => expect(shell.className).toContain('is-typing-in-editor'))

      // Focus in the find box instead: nothing retracts (the toolbar and the
      // "x of X" summary must stay available while typing a query).
      fireEvent.blur(editor)
      fireEvent.keyDown(document, { key: 'f', ctrlKey: true })
      const findInput = await screen.findByPlaceholderText('Find', undefined, {
        timeout: 15_000,
      })
      fireEvent.focus(findInput)
      await waitFor(() => expect(shell.className).not.toContain('is-typing-in-editor'))
    } finally {
      delete (window as { visualViewport?: unknown }).visualViewport
    }
  })

  it('refreshes editor viewport variables when the app returns visible', async () => {
    class FakeViewport extends EventTarget {
      height = window.innerHeight - 300
      offsetTop = 0
      scale = 1
    }

    const fakeViewport = new FakeViewport()
    const previousViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport')
    const previousScrollTo = Object.getOwnPropertyDescriptor(window, 'scrollTo')
    const previousVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')

    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: fakeViewport,
    })
    Object.defineProperty(window, 'scrollTo', {
      configurable: true,
      value: () => undefined,
    })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    })

    try {
      render(<App />)

      await createDraftThroughDialog('resume-viewport-pass')
      const root = document.documentElement

      await waitFor(() =>
        expect(root.style.getPropertyValue('--app-viewport-height')).toBe(
          `${fakeViewport.height}px`,
        ),
      )

      fakeViewport.height = window.innerHeight - 123
      fakeViewport.offsetTop = 37
      expect(root.style.getPropertyValue('--app-viewport-height')).not.toBe(
        `${fakeViewport.height}px`,
      )

      document.dispatchEvent(new Event('visibilitychange'))

      await waitFor(() => {
        expect(root.style.getPropertyValue('--app-viewport-height')).toBe(
          `${fakeViewport.height}px`,
        )
        expect(root.style.getPropertyValue('--app-viewport-offset-top')).toBe('37px')
      })
    } finally {
      if (previousViewport) {
        Object.defineProperty(window, 'visualViewport', previousViewport)
      } else {
        delete (window as { visualViewport?: unknown }).visualViewport
      }

      if (previousScrollTo) {
        Object.defineProperty(window, 'scrollTo', previousScrollTo)
      } else {
        delete (window as { scrollTo?: unknown }).scrollTo
      }

      if (previousVisibility) {
        Object.defineProperty(document, 'visibilityState', previousVisibility)
      } else {
        delete (document as { visibilityState?: unknown }).visibilityState
      }
    }
  })

  it('read-only hides the replace row but keeps the draft text', async () => {
    render(<App />)

    await createDraftThroughDialog('ro-replace-pass')
    await screen.findByTestId('editor', undefined, { timeout: 15_000 })

    fireEvent.keyDown(document, { key: 'f', ctrlKey: true })
    const replaceInput = (await screen.findByPlaceholderText('Replace', undefined, {
      timeout: 15_000,
    })) as HTMLInputElement
    fireEvent.change(replaceInput, { target: { value: 'draft' } })

    // Read-only: the replace row disappears entirely; find stays usable.
    fireEvent.click(screen.getByRole('button', { name: 'Read-only' }))
    expect(await screen.findByText('Read-only on.', undefined, { timeout: 15_000 })).not.toBeNull()
    expect(screen.queryByPlaceholderText('Replace')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Replace all' })).toBeNull()
    expect(screen.getByPlaceholderText('Find')).not.toBeNull()

    // Back to writable: the row returns with the draft untouched.
    fireEvent.click(screen.getByRole('button', { name: 'Read-only' }))
    expect(await screen.findByText('Read-only off.', undefined, { timeout: 15_000 })).not.toBeNull()
    expect(
      ((await screen.findByPlaceholderText('Replace')) as HTMLInputElement).value,
    ).toBe('draft')
  })

  it('info messages dismiss themselves after a few seconds', async () => {
    render(<App />)

    await createDraftThroughDialog('dismiss-pass')
    await screen.findByTestId('editor', undefined, { timeout: 15_000 })

    fireEvent.click(screen.getByRole('button', { name: 'Read-only' }))
    expect(await screen.findByText('Read-only on.', undefined, { timeout: 15_000 })).not.toBeNull()

    // No dismiss click: the info message clears on its own (SPEC §16).
    await waitFor(() => expect(screen.queryByText('Read-only on.')).toBeNull(), {
      timeout: 8_000,
    })
  })

  it('ordinary error messages dismiss themselves after a few seconds', async () => {
    render(<App />)

    providerState.save.mockRejectedValueOnce(new Error('save failed'))
    fireEvent.click(await screen.findByRole('button', { name: 'New draft' }))
    await screen.findByText('Set a password for the new draft')

    const dialog = screen.getByRole('dialog')

    fireEvent.change(within(dialog).getByLabelText('Password'), {
      target: { value: 'error-dismiss-pass' },
    })
    fireEvent.change(within(dialog).getByLabelText('Confirm password'), {
      target: { value: 'error-dismiss-pass' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    expect(
      await screen.findByText('Unable to create the draft.', undefined, { timeout: 15_000 }),
    ).not.toBeNull()

    await waitFor(() => expect(screen.queryByText('Unable to create the draft.')).toBeNull(), {
      timeout: 8_000,
    })
  })

  it('Read-only toggles into the saved envelope and persists across relock', async () => {
    render(<App />)

    await createDraftThroughDialog('ro-pass')
    await screen.findByTestId('editor', undefined, { timeout: 15_000 })

    fireEvent.click(screen.getByRole('button', { name: 'Read-only' }))
    expect(await screen.findByText('Read-only on.', undefined, { timeout: 15_000 })).not.toBeNull()

    const { parseEnvelope } = await import('./crypto/cryptoService')

    expect(parseEnvelope(providerState.envelope ?? '').readOnly).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Insert random string' }) as HTMLButtonElement).disabled,
    ).toBe(true)

    // Relock and unlock: the flag must come back from the file, not memory.
    // Cancel first — the editor must stay unlocked — then OK exits.
    fireEvent.click(screen.getByRole('button', { name: 'Home' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Password')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Home' }))
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }))
    await unlockDraftThroughDialog('ro-pass')
    await screen.findByTestId('editor', undefined, { timeout: 15_000 })

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Read-only' }).getAttribute('aria-pressed'),
      ).toBe('true'),
    )
  })

  it('reverts the Read-only toggle when its save fails (SPEC §11)', async () => {
    render(<App />)
    await createDraftThroughDialog('ro-fail-pass')
    await screen.findByTestId('editor', undefined, { timeout: 15_000 })

    const { parseEnvelope } = await import('./crypto/cryptoService')
    const envelopeBeforeToggle = providerState.envelope

    // The NEXT save (the read-only toggle's) fails.
    providerState.save.mockImplementationOnce(async () => {
      throw new Error('save failed')
    })

    const savesBefore = providerState.save.mock.calls.length
    const toggle = screen.getByRole('button', { name: 'Read-only' })
    fireEvent.click(toggle)

    // The toggle must NOT end up pressed (it reverted), and the persisted
    // envelope must NOT have gained read-only protection.
    await waitFor(() => expect(toggle.getAttribute('aria-pressed')).toBe('false'))

    // It DID attempt the (failed) save — proving the revert is the failure path,
    // not a no-op that trivially passes the assertions above.
    expect(providerState.save.mock.calls.length).toBe(savesBefore + 1)

    expect(parseEnvelope(providerState.envelope ?? '').readOnly).not.toBe(true)
    // The stored envelope is unchanged from before the failed toggle.
    expect(providerState.envelope).toBe(envelopeBeforeToggle)

    // The editor is still usable (not stuck read-only).
    expect(
      (screen.getByRole('button', { name: 'Insert random string' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it('Export saves the stored draft envelope without asking for the password', async () => {
    const envelope = await CryptoService.encrypt('archived text', 'forgotten-pass', fastKdf)
    await seedDraft(envelope)

    const written: string[] = []
    globalThis.showSaveFilePicker = async () =>
      ({
        kind: 'file',
        name: 'enote.txt',
        createWritable: async () => ({
          close: async () => undefined,
          write: async (data: unknown) => {
            written.push(String(data))
          },
        }),
      }) as unknown as FileSystemFileHandle

    render(<App />)
    await findEditDraftButton()

    // No password is entered at any point in this flow.
    fireEvent.click(screen.getByRole('button', { name: 'Export draft' }))

    expect(await screen.findByText('Draft exported.')).not.toBeNull()
    expect(written).toEqual([`${envelope}\n`])
    // Export does not modify or delete the draft.
    expect((await findEditDraftButton()).disabled).toBe(false)
  })

  it('Export saves a Secret-key-protected stored draft envelope verbatim without a local key', async () => {
    const secretKey = await generateSecretKeyString()
    const envelope = await CryptoService.encrypt('archived protected text', 'forgotten-pass', {
      ...fastKdf,
      secretKeyBytes: await parseSecretKeyString(secretKey),
    })

    await seedDraft(envelope)

    const written: string[] = []

    globalThis.showSaveFilePicker = async () =>
      ({
        kind: 'file',
        name: 'enote.txt',
        createWritable: async () => ({
          close: async () => undefined,
          write: async (data: unknown) => {
            written.push(String(data))
          },
        }),
      }) as unknown as FileSystemFileHandle

    render(<App />)
    await findEditDraftButton()

    fireEvent.click(screen.getByRole('button', { name: 'Export draft' }))

    expect(await screen.findByText('Draft exported.')).not.toBeNull()
    expect(written).toEqual([`${envelope}\n`])
    expect(getEnvelopeSecretKeyMode(parseEnvelope(written[0]!.trim()))).toBe(
      SECRET_KEY_MODE_REQUIRED,
    )
  })
})
