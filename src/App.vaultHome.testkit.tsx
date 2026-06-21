/// <reference types="node" />
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { createSeedDraft } from './test/appHarness'

export const SECRET_KEY_REQUIRED_UNLOCK_MESSAGE =
  "Enter this file's Secret key, or add it in Settings."
export const SECRET_KEY_AUTH_FAILURE_MESSAGE = 'Could not unlock. Check the password or Secret key.'

const providerState = vi.hoisted(() => ({
  envelope: null as string | null,
  save: vi.fn(async (envelope: string) => {
    providerState.envelope = envelope
    // Mirror into the REAL vaultStore: the home reads the draft
    // (hasDraft, Edit draft, Export) from the store, not the provider.
    const { vaultStore } = await import('./storage/vaultStore')
    await vaultStore.saveEnvelope(envelope, new Date(), 'draft')
  }),
}))

export const getProviderState = () => providerState

vi.mock('./storage/providerRegistry', () => ({
  // Honors a requested 'local-file' kind so the stored-override fallback test
  // can tell which home screen App resolved to. Every other request resolves
  // to the draft fake — including 'dropbox', so App's getDropboxProvider
  // helper sees a non-sync provider and returns null (no sync API to stub).
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
          onFocus: () => onFocusChange?.(true),
          onBlur: () => onFocusChange?.(false),
          value,
        })
      },
    ),
  }
})

// Spy on the QR encoder while keeping the real implementation, so the QR popup
// renders a real code AND tests can assert it was handed the exact key string.
vi.mock('qr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('qr')>()
  return { ...actual, default: vi.fn(actual.default) }
})

// Keep the real Secret-key crypto but make parseSecretKeyString a spy whose
// default delegates to the real implementation, so every other test is
// unaffected. The post-await auto-lock guard test interposes on ONE call (via
// mockImplementationOnce) to lock the session mid-await.
vi.mock('./crypto/secretKey', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./crypto/secretKey')>()
  return { ...actual, parseSecretKeyString: vi.fn(actual.parseSecretKeyString) }
})

beforeEach(async () => {
  Object.defineProperty(globalThis, 'indexedDB', {
    value: new IDBFactory(),
    configurable: true,
  })
  // The vaultStore singleton memoizes its IndexedDB connection; close it so
  // each test opens against ITS factory (the app itself reads the draft from
  // the store, so a stale connection would leak drafts across tests).
  const { vaultStore } = await import('./storage/vaultStore')
  vaultStore.close()
  providerState.envelope = null
  providerState.save.mockClear()
  globalThis.showSaveFilePicker = undefined
})

afterEach(() => {
  cleanup()
})

export const seedDraft = createSeedDraft(providerState)

export const openAdvancedHomeSettings = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
  const dialog = screen.getByRole('dialog', { name: 'Settings' })

  fireEvent.click(within(dialog).getByText('Advanced Settings'))
  expect(within(dialog).getByText('Hide')).not.toBeNull()
  return dialog
}
