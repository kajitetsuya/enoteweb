import { describe, expect, it } from 'vitest'
import {
  deriveDropboxSyncDisplay,
  dropboxSyncToneSuffix,
  type SaveStatus,
} from './dropboxSyncDisplay'
import type { StorageStatus } from './storage/storageProvider'

const status = (state: StorageStatus['state']): StorageStatus => ({ state, detail: '' })

describe('deriveDropboxSyncDisplay', () => {
  // The only "Synced" case: Dropbox ready AND the local save settled. 'idle' and
  // 'saved' are both settled states.
  it('is synced when ready and the save state is settled', () => {
    for (const saveStatus of ['idle', 'saved'] as SaveStatus[]) {
      expect(deriveDropboxSyncDisplay(status('ready'), saveStatus, true)).toEqual({
        kind: 'synced',
      })
    }
  })

  // The transition the component tests cannot drive (the mocked editor never makes
  // saveStatus dirty): ready Dropbox state but an in-flight or failed local save is
  // still "Unsynced", because those edits are not yet on Dropbox.
  it('is unsynced when ready but the save is dirty, saving, or failed', () => {
    for (const saveStatus of ['dirty', 'saving', 'error'] as SaveStatus[]) {
      expect(deriveDropboxSyncDisplay(status('ready'), saveStatus, true)).toEqual({
        kind: 'unsynced',
      })
    }
  })

  it('folds a queued pending-sync into unsynced regardless of save state', () => {
    for (const saveStatus of ['idle', 'saved', 'dirty'] as SaveStatus[]) {
      expect(deriveDropboxSyncDisplay(status('pending-sync'), saveStatus, true)).toEqual({
        kind: 'unsynced',
      })
    }
  })

  it('keeps offline and conflict as distinct states', () => {
    expect(deriveDropboxSyncDisplay(status('offline'), 'saved', true)).toEqual({ kind: 'offline' })
    expect(deriveDropboxSyncDisplay(status('conflict'), 'saved', true)).toEqual({ kind: 'conflict' })
  })

  it('maps blocked/initial states to attention, carrying the linked flag', () => {
    expect(deriveDropboxSyncDisplay(status('needs-user-action'), 'saved', true)).toEqual({
      kind: 'attention',
      linked: true,
    })
    expect(deriveDropboxSyncDisplay(status('needs-user-action'), 'saved', false)).toEqual({
      kind: 'attention',
      linked: false,
    })
    expect(deriveDropboxSyncDisplay(status('error'), 'saved', true)).toEqual({
      kind: 'attention',
      linked: true,
    })
    // No status loaded yet (initial render) is also attention, never a false "Synced".
    expect(deriveDropboxSyncDisplay(null, 'saved', false)).toEqual({
      kind: 'attention',
      linked: false,
    })
  })
})

describe('dropboxSyncToneSuffix', () => {
  it('maps synced to the green ready tone and unsynced to the amber pending tone', () => {
    expect(dropboxSyncToneSuffix({ kind: 'synced' }, status('ready'))).toBe('ready')
    expect(dropboxSyncToneSuffix({ kind: 'unsynced' }, status('ready'))).toBe('pending-sync')
  })

  it('passes offline and conflict tones through', () => {
    expect(dropboxSyncToneSuffix({ kind: 'offline' }, status('offline'))).toBe('offline')
    expect(dropboxSyncToneSuffix({ kind: 'conflict' }, status('conflict'))).toBe('conflict')
  })

  it('preserves the underlying status class for attention so existing colours hold', () => {
    expect(dropboxSyncToneSuffix({ kind: 'attention', linked: true }, status('error'))).toBe('error')
    expect(
      dropboxSyncToneSuffix({ kind: 'attention', linked: true }, status('needs-user-action')),
    ).toBe('needs-user-action')
    // Null status falls back to the green base, matching the prior inline default.
    expect(dropboxSyncToneSuffix({ kind: 'attention', linked: false }, null)).toBe('ready')
  })
})
