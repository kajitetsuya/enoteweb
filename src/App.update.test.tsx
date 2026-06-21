/// <reference types="node" />
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import { BUILD_VERSION } from './buildInfo'
import { CryptoService } from './crypto/cryptoService'
import { UpdateBlockedError, reloadOnce } from './registerServiceWorker'
import {
  createSeedDraft,
  fastKdf,
  findEditDraftButton,
  unlockDraftThroughDialog,
} from './test/appHarness'

const captured = vi.hoisted(() => ({
  cb: null as ((version: string) => void) | null,
  subscribeCount: 0,
}))

const swMock = vi.hoisted(() => ({
  applyUpdate: vi.fn(),
  checkForUpdates: vi.fn(),
}))

vi.mock('./registerServiceWorker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./registerServiceWorker')>()
  return {
    ...actual,
    applyUpdate: swMock.applyUpdate,
    checkForUpdates: swMock.checkForUpdates,
    reloadOnce: vi.fn(),
    subscribeVersionPinned: (listener: (version: string) => void) => {
      captured.cb = listener
      captured.subscribeCount += 1
      return () => {
        captured.cb = null
      }
    },
  }
})

const providerState = vi.hoisted(() => ({
  envelope: null as string | null,
  save: vi.fn(async (envelope: string) => {
    providerState.envelope = envelope
    const { vaultStore } = await import('./storage/vaultStore')
    await vaultStore.saveEnvelope(envelope, new Date(), 'draft')
  }),
}))

vi.mock('./storage/providerRegistry', () => ({
  getStorageProvider: (kind?: string) => ({
    kind: kind === 'local-file' ? 'local-file' : 'draft',
    load: async () => {
      if (!providerState.envelope) {
        throw new Error('No vault')
      }

      return providerState.envelope
    },
    save: providerState.save,
    status: async () => ({
      detail: providerState.envelope
        ? 'Draft is ready.'
        : 'No draft yet. Create one with New draft.',
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
          onFocusChange,
          value,
        }: {
          onChange: (value: string) => void
          onFocusChange?: (focused: boolean) => void
          value: string
        },
        ref,
      ) => {
        React.useImperativeHandle(ref, () => ({
          findNext: async () => ({
            currentIndex: -1,
            error: null,
            matchCount: 0,
            message: '',
            ok: false,
          }),
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
          onFocus: () => onFocusChange?.(true),
          onBlur: () => onFocusChange?.(false),
          value,
        })
      },
    ),
  }
})

// Keep the real Secret-key crypto; the home/unlock path imports it.
vi.mock('./crypto/secretKey', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./crypto/secretKey')>()
  return { ...actual, parseSecretKeyString: vi.fn(actual.parseSecretKeyString) }
})

const seedDraft = createSeedDraft(providerState)

const reloadOnceSpy = () => vi.mocked(reloadOnce)

// A build version that sorts strictly after the running build. Build versions
// are `<hash>.<UTC-timestamp>`; bumping the timestamp's first char to '9' makes
// the segment lexicographically greater, which is exactly isNewerBuildVersion's
// test.
const newerVersion = () => {
  const stamp = BUILD_VERSION.slice(BUILD_VERSION.indexOf('.') + 1)
  return `feedface.9${stamp.slice(1)}`
}

beforeEach(async () => {
  Object.defineProperty(globalThis, 'indexedDB', {
    value: new IDBFactory(),
    configurable: true,
  })
  const { vaultStore } = await import('./storage/vaultStore')
  vaultStore.close()
  providerState.envelope = null
  providerState.save.mockClear()
  captured.cb = null
  captured.subscribeCount = 0
  swMock.applyUpdate.mockReset()
  swMock.checkForUpdates.mockReset()
  reloadOnceSpy().mockClear()
  globalThis.showSaveFilePicker = undefined
})

afterEach(async () => {
  cleanup()
  const { vaultStore } = await import('./storage/vaultStore')
  vaultStore.close()
})

// Open Settings, check for updates, then apply the update, with checkForUpdates reporting a
// newer build and applyUpdate rejecting with `error`.
const driveApplyUpdate = async (error: unknown) => {
  swMock.checkForUpdates.mockResolvedValue({
    status: 'update-available',
    latest: { version: 'future.test', builtAt: '2099-01-01T00:00:00.000Z' },
  })
  swMock.applyUpdate.mockRejectedValue(error)

  fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
  const settings = screen.getByRole('dialog', { name: 'Settings' })
  fireEvent.click(within(settings).getByRole('button', { name: 'Check for updates' }))

  const available = await screen.findByRole('dialog', { name: 'Update available' })
  fireEvent.click(within(available).getByRole('button', { name: 'Update' }))
}

describe('handleApplyUpdate error surfacing', () => {
  it('shows the cross-window message and closes the dialog on UpdateBlockedError', async () => {
    render(<App />)
    await driveApplyUpdate(new UpdateBlockedError())

    expect(
      await screen.findByText('Close the document open in another window before updating.'),
    ).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: 'Update available' })).toBeNull()
    expect(screen.queryByRole('dialog', { name: 'Could not update' })).toBeNull()
  })

  it('falls back to the generic apply-error dialog for other failures', async () => {
    render(<App />)
    await driveApplyUpdate(new Error('boom'))

    expect(await screen.findByRole('dialog', { name: 'Could not update' })).toBeTruthy()
    expect(
      screen.queryByText('Close the document open in another window before updating.'),
    ).toBeNull()
  })
})

describe('App VERSION_PINNED reload guard', () => {
  it('an UNLOCKED window is NEVER auto-reloaded on a strictly-newer VERSION_PINNED', async () => {
    await seedDraft(await CryptoService.encrypt('secret plaintext', 'pass', fastKdf))

    render(<App />)
    await unlockDraftThroughDialog('pass')
    expect((screen.getByTestId('editor') as HTMLTextAreaElement).value).toBe('secret plaintext')

    const reload = reloadOnceSpy()
    expect(reload).not.toHaveBeenCalled()

    await waitFor(() => expect(captured.subscribeCount).toBeGreaterThanOrEqual(2))
    expect(typeof captured.cb).toBe('function')
    captured.cb?.(newerVersion())

    expect(reload).not.toHaveBeenCalled()
    expect(screen.queryByTestId('editor')).not.toBeNull()
    expect((screen.getByTestId('editor') as HTMLTextAreaElement).value).toBe('secret plaintext')
  })

  it('a LOCKED window IS reloaded onto the new pin on a strictly-newer VERSION_PINNED', async () => {
    await seedDraft(await CryptoService.encrypt('home only', 'pass', fastKdf))

    render(<App />)
    await findEditDraftButton()
    expect(screen.queryByTestId('editor')).toBeNull()

    const reload = reloadOnceSpy()
    expect(reload).not.toHaveBeenCalled()

    await waitFor(() => expect(captured.subscribeCount).toBeGreaterThanOrEqual(1))
    expect(typeof captured.cb).toBe('function')
    captured.cb?.(newerVersion())

    expect(reload).toHaveBeenCalledTimes(1)
  })
})
