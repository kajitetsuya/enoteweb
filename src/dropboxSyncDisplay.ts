import type { StorageStatus } from './storage/storageProvider'

// Local autosave lifecycle (the "save" indicator, distinct from Dropbox "sync").
export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

// Single source of truth for the Dropbox sync indicators (SPEC §9). The toolbar
// pill, the footer status label, and the editor Sync icon must all agree on
// whether the current document is fully synced to Dropbox. The document is
// "Synced" (icon greyed) only when the Dropbox state is `ready` AND the local
// save state is settled (not dirty/saving/error). Any unsynced-but-otherwise-
// normal state — a just-typed edit not yet uploaded, an autosave failure, or a
// queued `pending-sync` — reads "Unsynced". Blocked states keep their specific
// labels so the user still sees *why* sync is paused.
export type DropboxSyncDisplay =
  | { kind: 'synced' }
  | { kind: 'unsynced' }
  | { kind: 'offline' }
  | { kind: 'conflict' }
  | { kind: 'attention'; linked: boolean }

export const deriveDropboxSyncDisplay = (
  status: StorageStatus | null,
  saveStatus: SaveStatus,
  linked: boolean,
): DropboxSyncDisplay => {
  const savePending = saveStatus === 'dirty' || saveStatus === 'saving' || saveStatus === 'error'

  switch (status?.state) {
    case 'ready':
      return savePending ? { kind: 'unsynced' } : { kind: 'synced' }
    case 'pending-sync':
      return { kind: 'unsynced' }
    case 'offline':
      return { kind: 'offline' }
    case 'conflict':
      return { kind: 'conflict' }
    // 'needs-user-action', 'error', or no status loaded yet: a blocked or initial
    // state the user must act on; keep the specific attention/link wording.
    default:
      return { kind: 'attention', linked }
  }
}

// CSS modifier suffix for `.storage-inline-status-*`. 'synced' is the green base
// (`ready`); 'unsynced' reuses the amber `pending-sync` tone; blocked states keep
// the class of their underlying status so their existing colours are preserved.
export const dropboxSyncToneSuffix = (
  display: DropboxSyncDisplay,
  status: StorageStatus | null,
): string => {
  switch (display.kind) {
    case 'synced':
      return 'ready'
    case 'unsynced':
      return 'pending-sync'
    case 'offline':
      return 'offline'
    case 'conflict':
      return 'conflict'
    default:
      return status?.state ?? 'ready'
  }
}
