import { seedDraft } from './App.vaultHome.testkit'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import App from './App'
import { CryptoService } from './crypto/cryptoService'
import {
  createDraftThroughDialog,
  fastKdf,
  findEditDraftButton,
  unlockDraftThroughDialog,
} from './test/appHarness'

describe('Draft home actions', () => {
it('shows the draft actions; Delete/Export disabled without a draft', async () => {
    render(<App />)

    expect(await screen.findByRole('heading', { name: 'eNoteWeb' })).not.toBeNull()

    const newDraft = (await screen.findByRole('button', {
      name: 'New draft',
    })) as HTMLButtonElement

    expect(newDraft.disabled).toBe(false)
    expect(
      (screen.getByRole('button', { name: 'Delete draft' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Export draft' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Import draft' }) as HTMLButtonElement).disabled,
    ).toBe(false)
    // The create/unlock button is ONE slot: no Edit draft until a draft exists.
    expect(screen.queryByRole('button', { name: 'Edit draft' })).toBeNull()
  })

  it('a created draft survives lock and unlocks again (real crypto round trip)', async () => {
    render(<App />)

    await createDraftThroughDialog('new-pass')

    fireEvent.change(screen.getByTestId('editor'), { target: { value: 'draft text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Home' }))
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }))

    // Locking lands on the home with the draft present.
    await findEditDraftButton()
    await unlockDraftThroughDialog('new-pass')

    expect((screen.getByTestId('editor') as HTMLTextAreaElement).value).toBe('draft text')
  })

  it('a normal (non-failed) lock scrubs plaintext from the DOM and requires the password to reopen', async () => {
    const secret = 'top-secret-lifecycle-plaintext-xyzzy'

    render(<App />)
    await createDraftThroughDialog('lock-pass')
    fireEvent.change(screen.getByTestId('editor'), { target: { value: secret } })

    // Voluntary Home → confirm: a successful final save, then a hard lock.
    fireEvent.click(screen.getByRole('button', { name: 'Home' }))
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }))

    // Editor is gone AND the secret text is nowhere in the DOM (SPEC §5).
    await findEditDraftButton()
    expect(screen.queryByTestId('editor')).toBeNull()
    expect(document.body.textContent).not.toContain(secret)

    // The key/password references were cleared: reopening needs the password.
    await unlockDraftThroughDialog('lock-pass')
    expect((screen.getByTestId('editor') as HTMLTextAreaElement).value).toBe(secret)
  })

  it('backgrounding (visibilitychange hidden + pagehide) autosaves but keeps the session unlocked', async () => {
    const { getProviderState } = await import('./App.vaultHome.testkit')
    const providerState = getProviderState()

    render(<App />)
    await createDraftThroughDialog('bg-pass')
    fireEvent.change(screen.getByTestId('editor'), { target: { value: 'edited before backgrounding' } })

    providerState.save.mockClear()

    try {
      // Simulate the OS/browser backgrounding the page.
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('pagehide'))

      // It MUST attempt an encrypted save. Both `visibilitychange` and `pagehide`
      // are save triggers, so `save` may be called more than once — assert it was
      // called AT LEAST once (`toHaveBeenCalled`), never `toHaveBeenCalledTimes(1)`.
      await waitFor(() => expect(providerState.save).toHaveBeenCalled())

      // …and MUST NOT lock or clear: editor still mounted, text intact, not on home.
      expect(screen.getByTestId('editor')).not.toBeNull()
      expect((screen.getByTestId('editor') as HTMLTextAreaElement).value).toBe(
        'edited before backgrounding',
      )
      expect(screen.queryByRole('button', { name: 'Edit draft' })).toBeNull()
      expect(screen.queryByLabelText('Password')).toBeNull()
    } finally {
      // Always restore visibilityState so a thrown assertion can't leak 'hidden' into later tests.
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    }
  })

  it('opens a Dropbox-mode draft with Dropbox draft actions', async () => {
    render(<App />)

    await createDraftThroughDialog('new-pass')

    expect(screen.getByRole('button', { name: 'Save to Dropbox' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Export to Files' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Save As…' })).toBeNull()
    // No Save button in any session.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('Delete draft confirms, deletes, and returns to the no-draft state', async () => {
    await seedDraft(await CryptoService.encrypt('to delete', 'pass', fastKdf))

    render(<App />)
    await findEditDraftButton()

    fireEvent.click(screen.getByRole('button', { name: 'Delete draft' }))
    expect(await screen.findByText('Delete the draft?')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))

    expect(await screen.findByText('Draft deleted.')).not.toBeNull()
    expect(await screen.findByRole('button', { name: 'New draft' })).not.toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Delete draft' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('Delete draft Cancel keeps the draft', async () => {
    await seedDraft(await CryptoService.encrypt('kept', 'pass', fastKdf))

    render(<App />)
    await findEditDraftButton()

    fireEvent.click(screen.getByRole('button', { name: 'Delete draft' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

    expect(screen.queryByText('Delete the draft?')).toBeNull()
    expect((await findEditDraftButton()).disabled).toBe(false)
  })

  it('grays out the Local files provider option on platforms without the File System Access API', async () => {
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))

    const localFileOption = (await screen.findByRole('option', {
      name: 'Local files',
    })) as HTMLOptionElement

    // jsdom has no showOpenFilePicker/showSaveFilePicker, like Firefox.
    expect(localFileOption.disabled).toBe(true)
    expect(
      (screen.getByRole('option', { name: 'Dropbox' }) as HTMLOptionElement).disabled,
    ).toBe(false)
    // Draft is not a selectable storage mode (SPEC §2): the provider dropdown
    // holds exactly the two modes. (Scoped to the select — the Settings dialog
    // has other dropdowns.)
    const providerSelect = localFileOption.closest('select') as HTMLSelectElement

    expect(providerSelect.options).toHaveLength(2)
  })

  it('opens Home Settings Help from the settings title row', async () => {
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
    const settingsDialog = screen.getByRole('dialog', { name: 'Settings' })

    fireEvent.click(within(settingsDialog).getByRole('button', { name: 'Help' }))

    const helpDialog = await screen.findByRole('dialog', { name: 'Help' })
    const helpScroll = helpDialog.querySelector('.help-scroll') as HTMLDivElement
    const helpScrollTo = vi.fn()

    helpScroll.scrollTo = helpScrollTo as unknown as HTMLDivElement['scrollTo']
    helpScroll.scrollTop = 128

    expect(within(helpDialog).getByText('Contents')).not.toBeNull()
    const homeFilesLink = within(helpDialog).getByRole('link', { name: 'Home File Lists' })
    const passwordHardeningLink = within(helpDialog).getByRole('link', {
      name: 'Password hardening',
    })
    const backButton = within(helpDialog).getByRole('button', { name: 'Back' }) as HTMLButtonElement

    expect(homeFilesLink.getAttribute('href')).toBe('#home-file-lists')
    expect(homeFilesLink.getAttribute('target')).toBeNull()
    expect(passwordHardeningLink.getAttribute('href')).toBe('#password-hardening')
    expect(passwordHardeningLink.getAttribute('target')).toBeNull()
    expect(passwordHardeningLink.getAttribute('rel')).toBeNull()
    expect(backButton.disabled).toBe(true)
    expect(backButton.classList.contains('help-back-button')).toBe(true)
    expect(backButton.closest('.dialog-actions')?.classList.contains('help-dialog-actions')).toBe(
      true,
    )
    expect(
      within(helpDialog).getByRole('heading', { name: 'Home Screen and Home Settings' }),
    ).not.toBeNull()
    expect(within(helpDialog).getByRole('heading', { name: 'Home File Lists' })).not.toBeNull()
    expect(
      within(helpDialog).getByRole('heading', { name: 'Password hardening' }),
    ).not.toBeNull()
    expect(
      within(helpDialog).getByRole('heading', { name: 'License and Warranty' }),
    ).not.toBeNull()
    expect(within(helpDialog).queryByText('Editor Settings')).toBeNull()
    expect(within(helpDialog).queryByText(/Embedding note/)).toBeNull()

    fireEvent.click(passwordHardeningLink)
    expect(helpScrollTo).toHaveBeenCalled()
    expect(backButton.disabled).toBe(false)

    helpScroll.scrollTop = 512
    fireEvent.click(backButton)
    expect(helpScrollTo).toHaveBeenLastCalledWith({ top: 128, behavior: 'auto' })
    expect(backButton.disabled).toBe(true)

    helpScrollTo.mockClear()
    helpScroll.scrollTop = 256
    const refreshedHomeFilesLink = within(helpDialog).getByRole('link', { name: 'Home File Lists' })

    fireEvent.click(refreshedHomeFilesLink)
    expect(helpScrollTo).toHaveBeenCalled()
    expect(backButton.disabled).toBe(false)

    fireEvent.click(within(helpDialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: 'Help' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Settings' })).not.toBeNull()
  })
})
