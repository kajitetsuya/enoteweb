import {
  SECRET_KEY_AUTH_FAILURE_MESSAGE,
  SECRET_KEY_REQUIRED_UNLOCK_MESSAGE,
  getProviderState,
  openAdvancedHomeSettings,
  seedDraft,
} from './App.vaultHome.testkit'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import App from './App'
import {
  CryptoService,
  SECRET_KEY_MODE_REQUIRED,
  getEnvelopeSecretKeyMode,
  parseEnvelope,
} from './crypto/cryptoService'
import {
  SECRET_KEY_STRING_LENGTH,
  generateSecretKeyString,
  parseSecretKeyString,
} from './crypto/secretKey'
import encodeQR from 'qr'
import {
  createDraftThroughDialog,
  fastKdf,
  findEditDraftButton,
  installClipboard,
  unlockDraftThroughDialog,
} from './test/appHarness'

const providerState = getProviderState()

const installNavigatorStorage = (storage: Partial<StorageManager>) => {
  const originalStorage = navigator.storage
  Object.defineProperty(navigator, 'storage', {
    value: storage,
    configurable: true,
    writable: true,
  })

  return () => {
    Object.defineProperty(navigator, 'storage', {
      value: originalStorage,
      configurable: true,
      writable: true,
    })
  }
}

describe('Draft home actions', () => {
  it('manages the local Secret key from Home Settings', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    try {
      render(<App />)

      fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
      const dialog = screen.getByRole('dialog', { name: 'Settings' })

      expect(within(dialog).getByText('Advanced Settings')).not.toBeNull()
      expect(within(dialog).getByText('Show')).not.toBeNull()
      fireEvent.click(within(dialog).getByText('Advanced Settings'))
      expect(within(dialog).getByText('Hide')).not.toBeNull()
      expect(within(dialog).getByText('Secret key')).not.toBeNull()
      expect(within(dialog).getByDisplayValue('Not set')).not.toBeNull()

      fireEvent.click(within(dialog).getByRole('button', { name: 'Generate' }))

      const { vaultStore } = await import('./storage/vaultStore')

      await waitFor(async () => {
        const record = await vaultStore.getSetting('secretKey')

        expect(record?.value).toHaveLength(SECRET_KEY_STRING_LENGTH)
        expect(record?.value).toMatch(/^[A-Za-z0-9_-]+$/)
        expect(record?.value).not.toContain(':')
      })
      expect(within(dialog).getByText('Hide')).not.toBeNull()

      const generatedKey = (await vaultStore.getSetting('secretKey'))?.value

      expect(within(dialog).getByDisplayValue(generatedKey ?? '')).not.toBeNull()
      expect(within(dialog).queryByRole('button', { name: 'Copy' })).toBeNull()

      fireEvent.click(within(dialog).getByRole('button', { name: 'Clear' }))

      await waitFor(async () => {
        expect((await vaultStore.getSetting('secretKey'))?.value).toBeNull()
      })
      expect(within(dialog).getByText('Hide')).not.toBeNull()
      expect(within(dialog).getByDisplayValue('Not set')).not.toBeNull()
      expect(await screen.findByText('Secret key cleared.')).not.toBeNull()
      expect(confirmSpy).toHaveBeenCalledTimes(2)
    } finally {
      confirmSpy.mockRestore()
    }
  })

  it('a failed Secret key paste reports in the dialog and persists nothing (no false success)', async () => {
    const secretKey = await generateSecretKeyString()
    const readText = vi.fn(async () => secretKey)
    const restoreClipboard = installClipboard({ readText })
    const { vaultStore } = await import('./storage/vaultStore')
    // Fail ONLY the secretKey persist (the paste write). Mount-time storageProvider
    // writes must still succeed, so reject by key rather than by call order.
    const realSaveSetting = vaultStore.saveSetting.bind(vaultStore)
    const saveSpy = vi.spyOn(vaultStore, 'saveSetting').mockImplementation((record) => {
      if (record.key === 'secretKey') {
        return Promise.reject(new Error('write failed'))
      }
      return realSaveSetting(record)
    })

    try {
      render(<App />)
      const dialog = await openAdvancedHomeSettings()
      expect(within(dialog).getByDisplayValue('Not set')).not.toBeNull()

      fireEvent.click(within(dialog).getByRole('button', { name: 'Paste' }))

      // (a) failure surfaced inside the dialog
      expect(
        await within(dialog).findByText('Unable to save Secret key.'),
      ).not.toBeNull()
      // (b) the optimistic confirmation is NOT shown
      expect(within(dialog).queryByText('Secret key pasted.')).toBeNull()
      // (c) the key was never adopted in memory
      expect(within(dialog).getByDisplayValue('Not set')).not.toBeNull()
      // (d) nothing persisted
      expect((await vaultStore.getSetting('secretKey'))?.value ?? null).toBeNull()
    } finally {
      saveSpy.mockRestore()
      restoreClipboard()
    }
  })

  it('surfaces protected draft persistence below the home draft actions', async () => {
    const persistMock = vi.fn()
    const restoreStorage = installNavigatorStorage({
      persisted: vi.fn().mockResolvedValue(true),
      persist: persistMock,
    })

    try {
      render(<App />)

      const status = await screen.findByText('Draft is protected from automatic eviction.')
      expect(status.closest('.draft-persistence-status')).not.toBeNull()
      expect(status.previousElementSibling?.className ?? '').toContain('draft-actions')
      expect(persistMock).not.toHaveBeenCalled()

      fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
      const dialog = screen.getByRole('dialog', { name: 'Settings' })
      expect(within(dialog).queryByText('Storage durability')).toBeNull()
      expect(within(dialog).queryByText(/Draft is protected|Draft may be evicted/)).toBeNull()
    } finally {
      restoreStorage()
    }
  })

  it('surfaces evictable draft persistence below the home draft actions', async () => {
    const restoreStorage = installNavigatorStorage({
      persisted: vi.fn().mockResolvedValue(false),
      persist: vi.fn().mockResolvedValue(false),
    })

    try {
      render(<App />)
      expect(await screen.findByText('Draft may be evicted under storage pressure.')).not.toBeNull()
    } finally {
      restoreStorage()
    }
  })

  it('surfaces unavailable draft persistence below the home draft actions', async () => {
    const restoreStorage = installNavigatorStorage({})

    try {
      render(<App />)
      expect(
        await screen.findByText('This browser may clear drafts; keep a backup.'),
      ).not.toBeNull()
    } finally {
      restoreStorage()
    }
  })

  it('manages Password hardening from Home Advanced Settings', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm')
    const { vaultStore } = await import('./storage/vaultStore')

    try {
      render(<App />)
      const dialog = await openAdvancedHomeSettings()
      const policySelect = within(dialog).getByLabelText(
        'Password hardening',
      ) as HTMLSelectElement
      const policyField = policySelect.closest('.settings-field')
      const secretKeyField = within(dialog).getByText('Secret key').closest('.secret-key-setting')

      expect(policySelect.value).toBe('standard')
      if (!policyField || !secretKeyField) {
        throw new Error('Expected Password hardening and Secret key settings fields.')
      }
      expect(
        policyField.compareDocumentPosition(secretKeyField) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0)

      confirmSpy.mockReturnValueOnce(false)
      fireEvent.change(policySelect, { target: { value: 'strong' } })

      expect(confirmSpy).toHaveBeenCalledWith(
        'Strong password hardening uses more memory and may be slower or fail to open on older devices. Files saved with Strong require that memory on every device. Continue?',
      )
      expect(policySelect.value).toBe('standard')
      expect(await vaultStore.getSetting('kdfPolicy')).toBeNull()

      confirmSpy.mockReturnValueOnce(true)
      fireEvent.change(policySelect, { target: { value: 'strong' } })

      await waitFor(async () => {
        expect((await vaultStore.getSetting('kdfPolicy'))?.value).toBe('strong')
      })
      expect(policySelect.value).toBe('strong')

      cleanup()
      render(<App />)
      const reopenedDialog = await openAdvancedHomeSettings()
      const persistedSelect = within(reopenedDialog).getByLabelText(
        'Password hardening',
      ) as HTMLSelectElement

      expect(persistedSelect.value).toBe('strong')

      confirmSpy.mockClear()
      fireEvent.change(persistedSelect, { target: { value: 'standard' } })

      await waitFor(async () => {
        expect((await vaultStore.getSetting('kdfPolicy'))?.value).toBe('standard')
      })
      expect(confirmSpy).not.toHaveBeenCalled()
      expect(persistedSelect.value).toBe('standard')
    } finally {
      confirmSpy.mockRestore()
    }
  })

  it('sanitizes an unknown stored Password hardening value to Standard', async () => {
    const { vaultStore } = await import('./storage/vaultStore')

    await vaultStore.saveSetting({ key: 'kdfPolicy', value: 'future' as 'standard' })

    render(<App />)
    const dialog = await openAdvancedHomeSettings()
    const policySelect = within(dialog).getByLabelText(
      'Password hardening',
    ) as HTMLSelectElement

    expect(policySelect.value).toBe('standard')
  })

  it('opens editor Settings Help from the settings title row', async () => {
    render(<App />)

    await createDraftThroughDialog('help-pass')

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    const settingsDialog = screen.getByRole('dialog', { name: 'Settings' })

    fireEvent.click(within(settingsDialog).getByRole('button', { name: 'Help' }))

    const helpDialog = await screen.findByRole('dialog', { name: 'Help' })
    await waitFor(() => expect(document.activeElement).toBe(helpDialog))
    expect(within(helpDialog).getByText('Contents')).not.toBeNull()
    expect(within(helpDialog).getByRole('link', { name: 'Editor Settings' })).not.toBeNull()
    expect(within(helpDialog).getByRole('link', { name: 'Font' })).not.toBeNull()
    expect(within(helpDialog).getByRole('link', { name: 'Find options' })).not.toBeNull()
    expect(
      within(helpDialog).getByRole('heading', { name: 'Settings Dialog Map' }),
    ).not.toBeNull()
    expect(within(helpDialog).getByRole('heading', { name: 'Editor Settings' })).not.toBeNull()
    expect(within(helpDialog).getByRole('heading', { name: 'Find and Replace' })).not.toBeNull()
    expect(within(helpDialog).getByText('https://tc39.es/ecma262/#sec-patterns')).not.toBeNull()
    expect(
      within(helpDialog).getByRole('heading', { name: 'License and Warranty' }),
    ).not.toBeNull()
    expect(within(helpDialog).queryByText('Home File Lists')).toBeNull()
    expect(within(helpDialog).queryByText(/Embedding note/)).toBeNull()

    fireEvent.click(within(helpDialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: 'Help' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Settings' })).not.toBeNull()
  })

  it('cancelling Secret key Generate leaves the key unset', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    try {
      render(<App />)
      const dialog = await openAdvancedHomeSettings()

      fireEvent.click(within(dialog).getByRole('button', { name: 'Generate' }))

      const { vaultStore } = await import('./storage/vaultStore')

      await waitFor(async () => expect(await vaultStore.getSetting('secretKey')).toBeNull())
      expect(within(dialog).getByDisplayValue('Not set')).not.toBeNull()
      expect(confirmSpy).toHaveBeenCalledWith(
        'Files saved while Secret key is set require the same key on every device. Losing it can make those files unreadable. Continue?',
      )
    } finally {
      confirmSpy.mockRestore()
    }
  })

  it('cancelling Secret key replacement and Clear preserves the existing key', async () => {
    const existingKey = await generateSecretKeyString()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { vaultStore } = await import('./storage/vaultStore')

    await vaultStore.saveSetting({ key: 'secretKey', value: existingKey })

    try {
      render(<App />)
      const dialog = await openAdvancedHomeSettings()

      expect(await within(dialog).findByDisplayValue(existingKey)).not.toBeNull()

      fireEvent.click(within(dialog).getByRole('button', { name: 'Generate' }))
      fireEvent.click(within(dialog).getByRole('button', { name: 'Clear' }))

      await waitFor(async () => {
        expect((await vaultStore.getSetting('secretKey'))?.value).toBe(existingKey)
      })
      expect(within(dialog).getByDisplayValue(existingKey)).not.toBeNull()
      expect(screen.queryByText('Secret key cleared.')).toBeNull()
      expect(confirmSpy).toHaveBeenNthCalledWith(
        1,
        'Generate a new Secret key? Files saved with the current key cannot be opened unless you paste the current key again. Record the current key first if you need it.',
      )
      expect(confirmSpy).toHaveBeenNthCalledWith(
        2,
        'Clear Secret key? Files that require it cannot be opened on this device until you paste the same key again.',
      )
    } finally {
      confirmSpy.mockRestore()
    }
  })

  it('reports invalid Secret key text from clipboard paste without changing the setting', async () => {
    const readText = vi.fn(async () => 'not an enoteweb key')
    const restoreClipboard = installClipboard({ readText })

    try {
      render(<App />)
      const dialog = await openAdvancedHomeSettings()

      fireEvent.click(within(dialog).getByRole('button', { name: 'Paste' }))

      const { vaultStore } = await import('./storage/vaultStore')

      expect(await screen.findByText('Invalid Secret key.')).not.toBeNull()
      expect(await vaultStore.getSetting('secretKey')).toBeNull()
      expect(within(dialog).getByDisplayValue('Not set')).not.toBeNull()
    } finally {
      restoreClipboard()
    }
  })

  it('falls back to manual Secret key paste when clipboard read is unavailable', async () => {
    const secretKey = await generateSecretKeyString()
    const restoreClipboard = installClipboard({})

    try {
      render(<App />)
      const settingsDialog = await openAdvancedHomeSettings()

      fireEvent.click(within(settingsDialog).getByRole('button', { name: 'Paste' }))

      const pasteDialog = await screen.findByRole('dialog', { name: 'Paste Secret key' })

      fireEvent.change(within(pasteDialog).getByLabelText('Secret key'), {
        target: { value: 'invalid key' },
      })
      fireEvent.click(within(pasteDialog).getByRole('button', { name: 'Paste' }))
      expect(await within(pasteDialog).findByText('Invalid Secret key.')).not.toBeNull()

      fireEvent.change(within(pasteDialog).getByLabelText('Secret key'), {
        target: { value: ` ${secretKey}\n` },
      })
      fireEvent.click(within(pasteDialog).getByRole('button', { name: 'Paste' }))

      const { vaultStore } = await import('./storage/vaultStore')

      await waitFor(async () =>
        expect((await vaultStore.getSetting('secretKey'))?.value).toBe(secretKey),
      )
      expect(await screen.findByText('Secret key pasted.')).not.toBeNull()
      expect(screen.queryByRole('dialog', { name: 'Paste Secret key' })).toBeNull()
      expect(within(settingsDialog).getByDisplayValue(secretKey)).not.toBeNull()
    } finally {
      restoreClipboard()
    }
  })

  it('QR button is disabled until a Secret key is set', async () => {
    render(<App />)
    const settingsDialog = await openAdvancedHomeSettings()

    expect(
      (within(settingsDialog).getByRole('button', {
        name: 'Show Secret key QR',
      }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('QR opens a popup that encodes the exact key and discards it on close', async () => {
    const secretKey = await generateSecretKeyString()
    const { vaultStore } = await import('./storage/vaultStore')
    await vaultStore.saveSetting({ key: 'secretKey', value: secretKey })

    render(<App />)
    const settingsDialog = await openAdvancedHomeSettings()

    const qrButton = within(settingsDialog).getByRole('button', { name: 'Show Secret key QR' })
    expect((qrButton as HTMLButtonElement).disabled).toBe(false)

    vi.mocked(encodeQR).mockClear()
    fireEvent.click(qrButton)

    const qrDialog = await screen.findByRole('dialog', { name: 'Secret key QR' })

    // The popup renders a real QR (non-empty SVG path) without showing the key as text.
    // SecretKeyQr is lazy-loaded behind Suspense, so the SVG mounts a tick after the
    // dialog shell — await it instead of querying synchronously.
    await waitFor(() => {
      const svgPath = qrDialog.querySelector('svg.secret-key-qr path')
      expect(svgPath?.getAttribute('d')?.length).toBeGreaterThan(0)
    })
    expect(within(qrDialog).queryByDisplayValue(secretKey)).toBeNull()
    // The encoder was handed the EXACT configured key string — nothing more or less.
    expect(encodeQR).toHaveBeenCalledWith(secretKey, 'raw', expect.objectContaining({ border: 4 }))

    // Closing discards the rendered code (the SVG unmounts with the popup).
    fireEvent.click(within(qrDialog).getByRole('button', { name: 'Done' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Secret key QR' })).toBeNull(),
    )
    expect(document.querySelector('svg.secret-key-qr')).toBeNull()
  })

  it('opening the QR popup touches no network sink', async () => {
    const secretKey = await generateSecretKeyString()
    const { vaultStore } = await import('./storage/vaultStore')
    await vaultStore.saveSetting({ key: 'secretKey', value: secretKey })

    render(<App />)
    const settingsDialog = await openAdvancedHomeSettings()

    // Spy on the broad set of network sinks AFTER setup, so we measure only the
    // QR action: a remote-service encoder would trip one of these; a pure
    // on-device encoder touches none.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null))
    const xhrOpenSpy = vi.spyOn(XMLHttpRequest.prototype, 'open')
    const beaconSpy =
      typeof navigator.sendBeacon === 'function' ? vi.spyOn(navigator, 'sendBeacon') : null

    // WebSocket / EventSource / Image: swap the globals for counters (jsdom may
    // not provide all of them; only count the ones that exist).
    let constructorSinkCalls = 0
    const constructorRestores: Array<() => void> = []
    for (const name of ['WebSocket', 'EventSource', 'Image'] as const) {
      const host = globalThis as Record<string, unknown>
      const original = host[name]
      if (typeof original !== 'function') continue
      host[name] = () => {
        constructorSinkCalls += 1
      }
      constructorRestores.push(() => {
        host[name] = original
      })
    }

    try {
      fireEvent.click(
        within(settingsDialog).getByRole('button', { name: 'Show Secret key QR' }),
      )
      const qrDialog = await screen.findByRole('dialog', { name: 'Secret key QR' })
      // SecretKeyQr is lazy-loaded behind Suspense; await the SVG so the encoder
      // has actually run before we assert no network sink was touched.
      await waitFor(() =>
        expect(qrDialog.querySelector('svg.secret-key-qr')).not.toBeNull(),
      )

      expect(fetchSpy).not.toHaveBeenCalled()
      expect(xhrOpenSpy).not.toHaveBeenCalled()
      if (beaconSpy) expect(beaconSpy).not.toHaveBeenCalled()
      expect(constructorSinkCalls).toBe(0)
    } finally {
      fetchSpy.mockRestore()
      xhrOpenSpy.mockRestore()
      beaconSpy?.mockRestore()
      constructorRestores.forEach((restore) => restore())
    }
  })

  it('the bundled QR encoder source contains no network primitives', async () => {
    const { readFileSync } = await import('node:fs')
    // The encoder entry only (index.js, resolved from the project root) — not
    // decode.js or the camera helper dom.js, which we never import.
    const code = readFileSync('node_modules/qr/index.js', 'utf8')
      // Drop comments so license/source URLs do not false-positive.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')

    const forbidden = [
      'fetch(',
      'XMLHttpRequest',
      'sendBeacon',
      'WebSocket',
      'EventSource',
      'getUserMedia',
      'navigator',
      'createElement',
      'importScripts',
    ]
    expect(forbidden.filter((token) => code.includes(token))).toEqual([])

    // The only URLs the encoder legitimately carries are the SVG XML namespace.
    const externalUrls = [...code.matchAll(/https?:\/\/[^\s"'`)<>]+/g)]
      .map((match) => match[0])
      .filter((url) => !url.includes('w3.org'))
    expect(externalUrls).toEqual([])
  })

  it('Secret-key-protected drafts require the configured key before unlock', async () => {
    const secretKey = await generateSecretKeyString()
    const secretKeyBytes = await parseSecretKeyString(secretKey)
    const envelope = await CryptoService.encrypt('protected draft', 'pass', {
      ...fastKdf,
      secretKeyBytes,
    })

    expect(getEnvelopeSecretKeyMode(parseEnvelope(envelope))).toBe(SECRET_KEY_MODE_REQUIRED)
    await seedDraft(envelope)

    const readText = vi.fn(async () => secretKey)
    const restoreClipboard = installClipboard({ readText })

    try {
      render(<App />)
      fireEvent.click(await findEditDraftButton())
      await screen.findByText('Unlock draft')

      let dialog = screen.getByRole('dialog')

      fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'pass' } })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))
      expect(await within(dialog).findByText(SECRET_KEY_REQUIRED_UNLOCK_MESSAGE)).not.toBeNull()
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

      fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
      dialog = screen.getByRole('dialog', { name: 'Settings' })
      fireEvent.click(within(dialog).getByText('Advanced Settings'))
      fireEvent.click(within(dialog).getByRole('button', { name: 'Paste' }))
      expect(await screen.findByText('Secret key pasted.')).not.toBeNull()
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))

      await unlockDraftThroughDialog('pass')
      expect(screen.getByTestId('editor')).toHaveProperty('value', 'protected draft')
    } finally {
      restoreClipboard()
    }
  })

  it('New draft writes required-v1 when a Secret key is configured', async () => {
    const secretKey = await generateSecretKeyString()
    const secretKeyBytes = await parseSecretKeyString(secretKey)
    const { vaultStore } = await import('./storage/vaultStore')

    await vaultStore.saveSetting({ key: 'secretKey', value: secretKey })

    render(<App />)
    await createDraftThroughDialog('secret-pass')

    const envelope = providerState.envelope

    expect(envelope).toBeTruthy()
    expect(getEnvelopeSecretKeyMode(parseEnvelope(envelope ?? ''))).toBe(SECRET_KEY_MODE_REQUIRED)
    await expect(
      CryptoService.decrypt(envelope ?? '', 'secret-pass', { secretKeyBytes }),
    ).resolves.toBe('')
  })

  it('New draft with Strong Password hardening passes KDF params with Secret-key bytes', async () => {
    const secretKey = await generateSecretKeyString()
    const { vaultStore } = await import('./storage/vaultStore')
    const encryptSpy = vi.spyOn(CryptoService, 'encrypt').mockResolvedValue('strong envelope')
    const confirmSpy = vi.spyOn(window, 'confirm')

    await vaultStore.saveSetting({ key: 'secretKey', value: secretKey })
    await vaultStore.saveSetting({ key: 'kdfPolicy', value: 'strong' })

    try {
      render(<App />)
      await createDraftThroughDialog('strong-pass')

      await waitFor(() => expect(encryptSpy).toHaveBeenCalled())
      expect(confirmSpy).not.toHaveBeenCalled()
      const encryptOptions = encryptSpy.mock.calls.at(-1)?.[2] as
        | { memlimit?: number; opslimit?: number; secretKeyBytes?: Uint8Array }
        | undefined

      expect(encryptSpy).toHaveBeenCalledWith(
        '',
        'strong-pass',
        expect.objectContaining({
          memlimit: 134_217_728,
          opslimit: 4,
          secretKeyBytes: expect.any(Uint8Array),
        }),
      )
      expect(encryptOptions?.secretKeyBytes).toHaveLength(32)

      fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
      const dialog = await screen.findByRole('dialog')
      const hardeningToggle = within(dialog).getByRole('switch', {
        name: 'Use strong password hardening',
      }) as HTMLInputElement

      expect(hardeningToggle.checked).toBe(true)
    } finally {
      encryptSpy.mockRestore()
      confirmSpy.mockRestore()
    }
  })

  it('New draft warns before selecting Strong hardening from the Standard default', async () => {
    const encryptSpy = vi.spyOn(CryptoService, 'encrypt').mockResolvedValue('strong envelope')
    const confirmSpy = vi.spyOn(window, 'confirm')

    try {
      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: 'New draft' }))

      const dialog = await screen.findByRole('dialog')
      const hardeningToggle = within(dialog).getByRole('switch', {
        name: 'Use strong password hardening',
      }) as HTMLInputElement

      expect(hardeningToggle.checked).toBe(false)
      confirmSpy.mockReturnValueOnce(false)
      fireEvent.click(hardeningToggle)
      expect(hardeningToggle.checked).toBe(false)

      confirmSpy.mockReturnValueOnce(true)
      fireEvent.click(hardeningToggle)
      expect(hardeningToggle.checked).toBe(true)
      fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'p' } })
      fireEvent.change(within(dialog).getByLabelText('Confirm password'), {
        target: { value: 'p' },
      })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

      await waitFor(() => expect(encryptSpy).toHaveBeenCalled())
      expect(encryptSpy).toHaveBeenCalledWith(
        '',
        'p',
        expect.objectContaining({
          memlimit: 134_217_728,
          opslimit: 4,
        }),
      )
    } finally {
      encryptSpy.mockRestore()
      confirmSpy.mockRestore()
    }
  })

  it('autosave preserves the opened file KDF params when Settings is Strong', async () => {
    const { vaultStore } = await import('./storage/vaultStore')
    const openedEnvelope = await CryptoService.encrypt('policy target', 'pass', fastKdf)

    await vaultStore.saveSetting({ key: 'kdfPolicy', value: 'strong' })
    await seedDraft(openedEnvelope)

    render(<App />)
    await unlockDraftThroughDialog('pass')

    fireEvent.change(screen.getByTestId('editor'), {
      target: { value: 'edited policy target' },
    })

    await waitFor(
      async () => {
        const saved = providerState.envelope ?? ''
        const parsed = parseEnvelope(saved)

        expect(saved).not.toBe(openedEnvelope)
        expect(parsed.opslimit).toBe(fastKdf.opslimit)
        expect(parsed.memlimit).toBe(fastKdf.memlimit)
        await expect(CryptoService.decrypt(saved, 'pass')).resolves.toBe('edited policy target')
      },
      { timeout: 15_000 },
    )
  })

  it('Change Password refuses non-preset KDF params instead of mapping them', async () => {
    await seedDraft(await CryptoService.encrypt('custom policy', 'pass', fastKdf))

    render(<App />)
    await unlockDraftThroughDialog('pass')

    providerState.save.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))

    expect(await screen.findByText('Could not change the password.')).not.toBeNull()
    expect(screen.queryByText('Set a new password')).toBeNull()
    expect(providerState.save).not.toHaveBeenCalled()
  })

  it('an active required-v1 session keeps autosaving after the stored Secret key is cleared', async () => {
    const secretKey = await generateSecretKeyString()
    const secretKeyBytes = await parseSecretKeyString(secretKey)
    const envelope = await CryptoService.encrypt('protected draft', 'pass', {
      ...fastKdf,
      secretKeyBytes,
    })
    const { vaultStore } = await import('./storage/vaultStore')

    await vaultStore.saveSetting({ key: 'secretKey', value: secretKey })
    await seedDraft(envelope)

    render(<App />)
    await unlockDraftThroughDialog('pass')

    // Simulates another tab clearing the local Settings record. The active
    // session must already hold the decoded key bytes it needs for later saves.
    await vaultStore.saveSetting({ key: 'secretKey', value: null })

    fireEvent.change(screen.getByTestId('editor'), {
      target: { value: 'updated protected draft' },
    })

    await waitFor(
      async () => {
        const savedEnvelope = providerState.envelope ?? ''

        expect(getEnvelopeSecretKeyMode(parseEnvelope(savedEnvelope))).toBe(SECRET_KEY_MODE_REQUIRED)
        await expect(
          CryptoService.decrypt(savedEnvelope, 'pass', { secretKeyBytes }),
        ).resolves.toBe('updated protected draft')
      },
      { timeout: 15_000 },
    )
  })

  it('uses the generic password-or-Secret-key failure when a configured key is wrong', async () => {
    const secretKey = await generateSecretKeyString()
    const wrongSecretKey = await generateSecretKeyString()
    const envelope = await CryptoService.encrypt('wrong key draft', 'pass', {
      ...fastKdf,
      secretKeyBytes: await parseSecretKeyString(secretKey),
    })
    const { vaultStore } = await import('./storage/vaultStore')

    await vaultStore.saveSetting({ key: 'secretKey', value: wrongSecretKey })
    await seedDraft(envelope)

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
    let dialog = screen.getByRole('dialog', { name: 'Settings' })
    expect(await within(dialog).findByText('Show')).not.toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))

    fireEvent.click(await findEditDraftButton())
    await screen.findByText('Unlock draft')
    dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'pass' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))

    expect(await within(dialog).findByText(SECRET_KEY_AUTH_FAILURE_MESSAGE)).not.toBeNull()
  })

  it('New draft with the Secret key toggle off writes none even when a key is configured', async () => {
    const secretKey = await generateSecretKeyString()
    const { vaultStore } = await import('./storage/vaultStore')

    await vaultStore.saveSetting({ key: 'secretKey', value: secretKey })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'New draft' }))

    const dialog = await screen.findByRole('dialog')
    const toggle = within(dialog).getByRole('switch', { name: 'Use secret key' }) as HTMLInputElement

    // Defaults on when a key is configured; turn it off to write `none`.
    expect(toggle.checked).toBe(true)
    fireEvent.click(toggle)
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'p' } })
    fireEvent.change(within(dialog).getByLabelText('Confirm password'), { target: { value: 'p' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    await screen.findByTestId('editor', undefined, { timeout: 15_000 })

    expect(getEnvelopeSecretKeyMode(parseEnvelope(providerState.envelope ?? ''))).not.toBe(
      SECRET_KEY_MODE_REQUIRED,
    )
  })

  it('no auto-promotion: a none draft opened on a keyed device stays none after edits', async () => {
    const secretKey = await generateSecretKeyString()
    const { vaultStore } = await import('./storage/vaultStore')

    await vaultStore.saveSetting({ key: 'secretKey', value: secretKey })
    await seedDraft(await CryptoService.encrypt('plain draft', 'pass', fastKdf))

    render(<App />)
    await unlockDraftThroughDialog('pass')

    fireEvent.change(screen.getByTestId('editor'), { target: { value: 'edited plain' } })

    await waitFor(
      async () => {
        const saved = providerState.envelope ?? ''

        expect(getEnvelopeSecretKeyMode(parseEnvelope(saved))).not.toBe(SECRET_KEY_MODE_REQUIRED)
        await expect(CryptoService.decrypt(saved, 'pass')).resolves.toBe('edited plain')
      },
      { timeout: 15_000 },
    )
  })

  it('Change Password with the toggle on adds protection to a none draft', async () => {
    const secretKey = await generateSecretKeyString()
    const secretKeyBytes = await parseSecretKeyString(secretKey)
    const { vaultStore } = await import('./storage/vaultStore')

    await vaultStore.saveSetting({ key: 'secretKey', value: secretKey })
    await seedDraft(await CryptoService.encrypt('content', 'pass'))

    render(<App />)
    await unlockDraftThroughDialog('pass')

    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
    const dialog = await screen.findByRole('dialog')
    const toggle = within(dialog).getByRole('switch', { name: 'Use secret key' }) as HTMLInputElement

    // The file is `none`, so the toggle defaults off; turn it on, same password.
    expect(toggle.checked).toBe(false)
    fireEvent.click(toggle)
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'pass' } })
    fireEvent.change(within(dialog).getByLabelText('Confirm password'), { target: { value: 'pass' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }))

    await waitFor(
      async () => {
        const saved = providerState.envelope ?? ''

        expect(getEnvelopeSecretKeyMode(parseEnvelope(saved))).toBe(SECRET_KEY_MODE_REQUIRED)
        await expect(CryptoService.decrypt(saved, 'pass', { secretKeyBytes })).resolves.toBe(
          'content',
        )
      },
      { timeout: 15_000 },
    )
  })

  it('Change Password to the same value rewrites at the selected Strong KDF policy', async () => {
    const { vaultStore } = await import('./storage/vaultStore')

    await vaultStore.saveSetting({ key: 'kdfPolicy', value: 'strong' })
    await seedDraft(await CryptoService.encrypt('policy target', 'pass'))

    render(<App />)
    await unlockDraftThroughDialog('pass')

    const encryptSpy = vi.spyOn(CryptoService, 'encrypt').mockResolvedValue('rotated envelope')
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    try {
      fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
      const dialog = await screen.findByRole('dialog')
      const hardeningToggle = within(dialog).getByRole('switch', {
        name: 'Use strong password hardening',
      }) as HTMLInputElement

      // The local setting is Strong, but the opened file is Standard; Change
      // Password starts from the current file, not Settings.
      expect(hardeningToggle.checked).toBe(false)
      fireEvent.click(hardeningToggle)
      expect(confirmSpy).toHaveBeenCalledWith(
        'Strong password hardening uses more memory and may be slower or fail to open on older devices. Files saved with Strong require that memory on every device. Continue?',
      )
      expect(hardeningToggle.checked).toBe(true)
      fireEvent.change(within(dialog).getByLabelText('Password'), {
        target: { value: 'pass' },
      })
      fireEvent.change(within(dialog).getByLabelText('Confirm password'), {
        target: { value: 'pass' },
      })
      fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }))

      await waitFor(() => expect(encryptSpy).toHaveBeenCalled())
      expect(encryptSpy).toHaveBeenCalledWith(
        'policy target',
        'pass',
        expect.objectContaining({
          memlimit: 134_217_728,
          opslimit: 4,
        }),
      )
    } finally {
      encryptSpy.mockRestore()
      confirmSpy.mockRestore()
    }
  })

  it('Change Password with the toggle off removes protection (downgrade to none)', async () => {
    const secretKey = await generateSecretKeyString()
    const secretKeyBytes = await parseSecretKeyString(secretKey)
    const { vaultStore } = await import('./storage/vaultStore')

    await vaultStore.saveSetting({ key: 'secretKey', value: secretKey })
    await seedDraft(await CryptoService.encrypt('protected', 'pass', { secretKeyBytes }))

    render(<App />)
    await unlockDraftThroughDialog('pass')

    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
    const dialog = await screen.findByRole('dialog')
    const toggle = within(dialog).getByRole('switch', { name: 'Use secret key' }) as HTMLInputElement

    // The file is `required-v1`, so the toggle defaults on; turn it off to downgrade.
    expect(toggle.checked).toBe(true)
    fireEvent.click(toggle)
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'pass' } })
    fireEvent.change(within(dialog).getByLabelText('Confirm password'), { target: { value: 'pass' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }))

    await waitFor(
      async () => {
        const saved = providerState.envelope ?? ''

        expect(getEnvelopeSecretKeyMode(parseEnvelope(saved))).not.toBe(SECRET_KEY_MODE_REQUIRED)
        // Now decrypts with the password alone — protection removed.
        await expect(CryptoService.decrypt(saved, 'pass')).resolves.toBe('protected')
      },
      { timeout: 15_000 },
    )
  })

  it('opens a required-v1 draft on a keyless device via the inline Secret key field (session-only)', async () => {
    const secretKey = await generateSecretKeyString()
    const secretKeyBytes = await parseSecretKeyString(secretKey)
    const { vaultStore } = await import('./storage/vaultStore')

    // App Secret key is NOT configured.
    await seedDraft(await CryptoService.encrypt('inline open', 'pass', { ...fastKdf, secretKeyBytes }))

    render(<App />)
    fireEvent.click(await findEditDraftButton())
    await screen.findByText('Unlock draft')

    const dialog = screen.getByRole('dialog')
    // required-v1 + no Settings key → the inline field is expanded and empty.
    const keyField = within(dialog).getByLabelText('Secret key') as HTMLInputElement
    expect(keyField.value).toBe('')

    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'pass' } })
    fireEvent.change(keyField, { target: { value: secretKey } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))
    await screen.findByTestId('editor', undefined, { timeout: 15_000 })

    expect((screen.getByTestId('editor') as HTMLTextAreaElement).value).toBe('inline open')
    // The entered key stays session-only — Settings never gains a key.
    expect((await vaultStore.getSetting('secretKey'))?.value ?? null).toBeNull()
  })

  it('locking clears the session Secret key: relock requires the key again (keyless device)', async () => {
    const secretKey = await generateSecretKeyString()
    const secretKeyBytes = await parseSecretKeyString(secretKey)

    // Keyless device: the key entered at unlock lives only in the session ref.
    await seedDraft(await CryptoService.encrypt('relock guarded', 'pass', { ...fastKdf, secretKeyBytes }))

    render(<App />)
    fireEvent.click(await findEditDraftButton())
    await screen.findByText('Unlock draft')

    const firstDialog = screen.getByRole('dialog')
    fireEvent.change(within(firstDialog).getByLabelText('Password'), { target: { value: 'pass' } })
    fireEvent.change(within(firstDialog).getByLabelText('Secret key'), {
      target: { value: secretKey },
    })
    fireEvent.click(within(firstDialog).getByRole('button', { name: 'Unlock' }))
    await screen.findByTestId('editor', undefined, { timeout: 15_000 })
    expect((screen.getByTestId('editor') as HTMLTextAreaElement).value).toBe('relock guarded')

    // Lock the vault (Home → confirm). clearSecrets() must drop the session key.
    fireEvent.click(screen.getByRole('button', { name: 'Home' }))
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }))
    await findEditDraftButton()

    // The relock must require the key again: the inline field reappears empty
    // (the session retained nothing), and a password-only unlock is rejected.
    fireEvent.click(await findEditDraftButton())
    await screen.findByText('Unlock draft')

    const secondDialog = screen.getByRole('dialog')
    const keyField = within(secondDialog).getByLabelText('Secret key') as HTMLInputElement
    expect(keyField.value).toBe('')

    fireEvent.change(within(secondDialog).getByLabelText('Password'), { target: { value: 'pass' } })
    fireEvent.click(within(secondDialog).getByRole('button', { name: 'Unlock' }))
    expect(
      await within(secondDialog).findByText(SECRET_KEY_REQUIRED_UNLOCK_MESSAGE),
    ).not.toBeNull()
    expect(screen.queryByTestId('editor')).toBeNull()

    // Re-entering the key opens it again — confirming the lock cleared, not
    // corrupted, the key path.
    fireEvent.change(keyField, { target: { value: secretKey } })
    fireEvent.click(within(secondDialog).getByRole('button', { name: 'Unlock' }))
    await screen.findByTestId('editor', undefined, { timeout: 15_000 })
    expect((screen.getByTestId('editor') as HTMLTextAreaElement).value).toBe('relock guarded')
  })

  it('auto-lock while the Change Password dialog is open rewrites nothing and ends locked', async () => {
    // SPEC §10: changePassword re-checks passwordRef.current right after its
    // dialog resolves (the pre-await guard). If an auto-lock fired while the
    // create-password dialog was open, the rotation must abort there with
    // nothing rewritten. We fire the REAL idle auto-lock (fake timers) while the
    // dialog is open, then click OK; by the time the dialog's promise settles
    // passwordRef is already null, so control returns at the pre-await guard —
    // before getConfiguredSecretKeyBytes() is even reached. (The post-await
    // guard that follows that await is pinned by the next test.)
    const secretKey = await generateSecretKeyString()
    const { vaultStore } = await import('./storage/vaultStore')

    await vaultStore.saveSetting({ key: 'secretKey', value: secretKey })
    // Auto-lock after 1 minute of inactivity (the shortest selectable interval).
    await vaultStore.saveSetting({ key: 'autoLockMinutes', value: 1 })
    // A `none` draft so the toggle starts off; the precise mode is immaterial
    // here because the pre-await guard returns before any key path runs.
    await seedDraft(await CryptoService.encrypt('race target', 'pass'))

    render(<App />)
    await unlockDraftThroughDialog('pass')

    const envelopeBeforeRotation = providerState.envelope
    providerState.save.mockClear()

    // Open Change Password and arm the rotation (toggle on, matching password).
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
    const dialog = await screen.findByRole('dialog')
    const toggle = within(dialog).getByRole('switch', {
      name: 'Use secret key',
    }) as HTMLInputElement

    expect(toggle.checked).toBe(false)
    fireEvent.click(toggle)
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'newpass' } })
    fireEvent.change(within(dialog).getByLabelText('Confirm password'), {
      target: { value: 'newpass' },
    })

    // Fire the idle auto-lock while the dialog is open: clearSecrets() drops the
    // session password. The auto-lock timer scheduled at unlock used real timers,
    // so re-arm it under fake timers (a window activity event reschedules it via
    // the effect's listener), then advance past the 1-minute interval. No edits ⇒
    // lockVault('auto') goes straight to hardLockToHome (no async save).
    vi.useFakeTimers()
    try {
      fireEvent.keyDown(window, { key: 'a' })
      vi.advanceTimersByTime(60_000)
    } finally {
      vi.useRealTimers()
    }
    await findEditDraftButton()

    // Submit the still-open dialog: the dialog's promise resolves against an
    // already-locked session, so changePassword bails at the pre-await
    // passwordRef guard with no write.
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }))

    // Settle the rotation, then assert nothing was rewritten and the session
    // stayed locked (nothing revived). The pre-await guard returns before any
    // save, so providerState.save is never invoked and the editor never
    // re-mounts.
    await waitFor(() => expect(providerState.save).not.toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(providerState.save).not.toHaveBeenCalled()
    expect(providerState.envelope).toBe(envelopeBeforeRotation)
    expect(screen.queryByTestId('editor')).toBeNull()
    // Still on the home, locked: the Edit-draft entry is present.
    expect(await findEditDraftButton()).not.toBeNull()
    // The durable draft is untouched: still `none` under the ORIGINAL password
    // (no half-rotation to `newpass`/required-v1).
    const saved = providerState.envelope ?? ''
    expect(getEnvelopeSecretKeyMode(parseEnvelope(saved))).not.toBe(SECRET_KEY_MODE_REQUIRED)
    await expect(CryptoService.decrypt(saved, 'pass')).resolves.toBe('race target')
  })

  it('auto-lock DURING the Change Password key await rewrites nothing and ends locked (post-await guard)', async () => {
    // SPEC §10: the pre-await guard passes (password still
    // valid when OK is clicked), but auto-lock fires DURING
    // `await getConfiguredSecretKeyBytes()`. The post-await guard — the
    // `if (!passwordRef.current) return` immediately after that await — must
    // abort with nothing rewritten. We interpose on the single
    // parseSecretKeyString call that await makes and lock the session (real Home
    // lock) from inside it, so passwordRef clears before the post-await guard.
    const secretKey = await generateSecretKeyString()
    const { vaultStore } = await import('./storage/vaultStore')

    // A configured Settings key so getConfiguredSecretKeyBytes takes the
    // parseSecretKeyString path; a `none` draft so the session holds NO key and
    // the rotation actually awaits getConfiguredSecretKeyBytes() (rather than
    // reusing a session key).
    await vaultStore.saveSetting({ key: 'secretKey', value: secretKey })
    await seedDraft(await CryptoService.encrypt('await target', 'pass'))

    render(<App />)
    await unlockDraftThroughDialog('pass')

    const envelopeBeforeRotation = providerState.envelope
    providerState.save.mockClear()

    // Open Change Password and arm the rotation (toggle on, matching password).
    // Do NOT pre-lock: the pre-await guard must PASS.
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
    const dialog = await screen.findByRole('dialog')
    const toggle = within(dialog).getByRole('switch', {
      name: 'Use secret key',
    }) as HTMLInputElement

    expect(toggle.checked).toBe(false)
    fireEvent.click(toggle)
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'newpass' } })
    fireEvent.change(within(dialog).getByLabelText('Confirm password'), {
      target: { value: 'newpass' },
    })

    // The real parser, captured so the interposition still returns valid bytes.
    const realParse = (
      await vi.importActual<typeof import('./crypto/secretKey')>('./crypto/secretKey')
    ).parseSecretKeyString

    // Arm a one-shot interposition: when changePassword's
    // `await getConfiguredSecretKeyBytes()` calls parseSecretKeyString, we are
    // already past the pre-await guard. Lock the session NOW (Home → confirm,
    // the same lock the 'locking clears the session Secret key' test uses) so
    // passwordRef clears before the post-await guard runs, then delegate to the
    // real parser so the await resolves normally.
    vi.mocked(parseSecretKeyString).mockImplementationOnce(async (value) => {
      fireEvent.click(screen.getByRole('button', { name: 'Home' }))
      fireEvent.click(await screen.findByRole('button', { name: 'OK' }))
      return realParse(value)
    })

    // Start the rotation: the pre-await guard passes, the await above fires the
    // lock, and the post-await guard must bail with no write.
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }))

    // The post-await guard returns cleanly: the rotation never enters the
    // save/rollback path, so no failure notice is shown. THIS is what pins the
    // 3008 guard. Remove that guard and the rotation runs on: it sets the new
    // password, calls saveCurrentPlaintext (a no-op now the session is locked),
    // takes the failure branch, and surfaces this message. (providerState.save
    // alone does not discriminate — saveCurrentPlaintext's own `!isUnlocked`
    // backstop blocks the write either way; the notice is the observable that
    // flips.)
    await waitFor(() => expect(providerState.save).not.toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByText('Could not change the password.')).toBeNull()
    expect(providerState.save).not.toHaveBeenCalled()
    expect(providerState.envelope).toBe(envelopeBeforeRotation)
    expect(screen.queryByTestId('editor')).toBeNull()
    // Still on the home, locked: the Edit-draft entry is present.
    expect(await findEditDraftButton()).not.toBeNull()
    // The durable draft is untouched: still `none` under the ORIGINAL password
    // (no half-rotation to `newpass`/required-v1).
    const saved = providerState.envelope ?? ''
    expect(getEnvelopeSecretKeyMode(parseEnvelope(saved))).not.toBe(SECRET_KEY_MODE_REQUIRED)
    await expect(CryptoService.decrypt(saved, 'pass')).resolves.toBe('await target')
  })

  it('a failed Change Password write rolls back BOTH the password and the Secret-key mode', async () => {
    const secretKey = await generateSecretKeyString()
    const secretKeyBytes = await parseSecretKeyString(secretKey)
    const { vaultStore } = await import('./storage/vaultStore')

    await vaultStore.saveSetting({ key: 'secretKey', value: secretKey })
    await seedDraft(await CryptoService.encrypt('guarded', 'pass', { secretKeyBytes }))

    render(<App />)
    await unlockDraftThroughDialog('pass')

    // The forced Change Password write fails this once.
    providerState.save.mockRejectedValueOnce(new Error('write failed'))

    // Attempt to REMOVE protection AND change the password.
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Use secret key' }))
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'newpass' } })
    fireEvent.change(within(dialog).getByLabelText('Confirm password'), {
      target: { value: 'newpass' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }))

    await screen.findByText('Could not change the password.')

    // The durable file never adopted the change, so the session must still write
    // `required-v1` under the OLD password: a fresh edit autosaves accordingly.
    fireEvent.change(screen.getByTestId('editor'), { target: { value: 'still guarded' } })

    await waitFor(
      async () => {
        const saved = providerState.envelope ?? ''

        expect(getEnvelopeSecretKeyMode(parseEnvelope(saved))).toBe(SECRET_KEY_MODE_REQUIRED)
        await expect(CryptoService.decrypt(saved, 'pass', { secretKeyBytes })).resolves.toBe(
          'still guarded',
        )
      },
      { timeout: 15_000 },
    )
  })

  it('Change Password with a malformed stored Secret key reports failure and keeps the session intact', async () => {
    const { vaultStore } = await import('./storage/vaultStore')

    // A corrupt Settings key that survives load (non-empty, so the toggle is
    // available) but fails parseSecretKeyString when the rotation tries to use it.
    await vaultStore.saveSetting({ key: 'secretKey', value: 'not-a-valid-key' })
    // A `none` draft: the session holds NO key, so toggle-on forces the rotation
    // down the getConfiguredSecretKeyBytes() path that throws on the bad key.
    await seedDraft(await CryptoService.encrypt('safe', 'pass'))

    render(<App />)
    await unlockDraftThroughDialog('pass')

    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
    const dialog = await screen.findByRole('dialog')
    const toggle = within(dialog).getByRole('switch', {
      name: 'Use secret key',
    }) as HTMLInputElement

    expect(toggle.checked).toBe(false)
    fireEvent.click(toggle)
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'newpass' } })
    fireEvent.change(within(dialog).getByLabelText('Confirm password'), {
      target: { value: 'newpass' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }))

    // The corrupt-key parse rejects; the user sees a notice instead of an
    // unhandled rejection (the dialog has already closed).
    await screen.findByText('Could not change the password.')

    // The throw preceded the ref swap, so the session is intact: a fresh edit
    // still autosaves as `none` under the ORIGINAL password (no half-rotation).
    fireEvent.change(screen.getByTestId('editor'), { target: { value: 'still safe' } })

    await waitFor(
      async () => {
        const saved = providerState.envelope ?? ''

        expect(getEnvelopeSecretKeyMode(parseEnvelope(saved))).not.toBe(SECRET_KEY_MODE_REQUIRED)
        await expect(CryptoService.decrypt(saved, 'pass')).resolves.toBe('still safe')
      },
      { timeout: 15_000 },
    )
  })

  it('rejects a malformed inline Secret key with the Invalid Secret key message', async () => {
    const secretKeyBytes = await parseSecretKeyString(await generateSecretKeyString())

    // App Secret key NOT configured → the inline field is expanded.
    await seedDraft(await CryptoService.encrypt('z', 'pass', { ...fastKdf, secretKeyBytes }))

    render(<App />)
    fireEvent.click(await findEditDraftButton())
    await screen.findByText('Unlock draft')

    const dialog = screen.getByRole('dialog')

    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'pass' } })
    fireEvent.change(within(dialog).getByLabelText('Secret key'), {
      target: { value: 'not-a-valid-key' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))

    expect(await within(dialog).findByText('Invalid Secret key.')).not.toBeNull()
  })

  it('collapses and pre-fills the unlock Secret-key field when a Settings key is configured', async () => {
    const secretKey = await generateSecretKeyString()
    const secretKeyBytes = await parseSecretKeyString(secretKey)
    const { vaultStore } = await import('./storage/vaultStore')

    await vaultStore.saveSetting({ key: 'secretKey', value: secretKey })
    await seedDraft(await CryptoService.encrypt('keyed open', 'pass', { ...fastKdf, secretKeyBytes }))

    render(<App />)
    fireEvent.click(await findEditDraftButton())
    await screen.findByText('Unlock draft')

    const dialog = screen.getByRole('dialog')

    // The disclosure exists but is collapsed by default (field not rendered).
    expect(within(dialog).getByRole('button', { name: /Secret key/ })).not.toBeNull()
    expect(within(dialog).queryByLabelText('Secret key')).toBeNull()

    // Unlocking without expanding uses the pre-filled Settings key.
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'pass' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))
    await screen.findByTestId('editor', undefined, { timeout: 15_000 })
    expect((screen.getByTestId('editor') as HTMLTextAreaElement).value).toBe('keyed open')
  })

  it('disables and clears the create Secret-key toggle on a keyless device', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'New draft' }))

    const dialog = await screen.findByRole('dialog')
    const toggle = within(dialog).getByRole('switch', { name: 'Use secret key' }) as HTMLInputElement

    expect(toggle.disabled).toBe(true)
    expect(toggle.checked).toBe(false)
  })

  it('prompts to reopen when a concurrent write makes a none file required under the open dialog', async () => {
    // Open the unlock dialog over a `none` draft (no inline Secret-key field).
    await seedDraft(await CryptoService.encrypt('plain', 'pass', fastKdf))

    render(<App />)
    fireEvent.click(await findEditDraftButton())
    await screen.findByText('Unlock draft')

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).queryByLabelText('Secret key')).toBeNull()

    // A concurrent write turns the same draft `required-v1` while the dialog is
    // open; the attempt re-reads it at submit (SKT-4 P2).
    const secretKeyBytes = await parseSecretKeyString(await generateSecretKeyString())
    await seedDraft(await CryptoService.encrypt('plain', 'pass', { ...fastKdf, secretKeyBytes }))

    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'pass' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))

    // A clean reopen prompt, not a dead-end key prompt with no field.
    expect(
      await within(dialog).findByText(
        'This file changed and now needs a Secret key. Reopen it to continue.',
      ),
    ).not.toBeNull()
  })
})
