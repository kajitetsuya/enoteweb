import {
  buildConflictResolution,
  type Decryptor,
  type KeepLocalOption,
  type KeepRemoteOption,
  type NonMergeableReason,
} from './buildConflictResolution'
import { composeRegions, type ConflictRegion, type MergeRegion } from '../merge/threeWayMerge'
import type { SyncStorageProvider } from '../storage/storageProvider'

// How a single conflict region is resolved. `both` keeps both sides, local lines
// followed by remote lines. `edited` carries already-split lines (the editor
// splits its textarea on '\n' to match composeRegions/threeWayMerge).
export type ConflictResolutionChoice =
  | { kind: 'local' }
  | { kind: 'remote' }
  | { kind: 'both' }
  | { kind: 'edited'; lines: string[] }

export type ConflictResolutions = Map<number, ConflictResolutionChoice>

// The conflict modal's mode. App renders from this; the controller is the only
// thing that drives the transitions for the risky async paths.
export type ConflictModalState =
  | { mode: 'closed' }
  | { mode: 'loading' }
  | { mode: 'editing'; regions: MergeRegion[]; remoteConflictRev: string }
  | {
      mode: 'non-mergeable'
      reason: NonMergeableReason
      keepLocal?: KeepLocalOption
      keepRemote?: KeepRemoteOption
    }
  | { mode: 'committing' }

// Dependencies are passed to each method call (not captured), so the caller can
// build them inside an event handler — keeping React render free of ref access
// while the controller's run state stays stable across calls.
export type ConflictControllerDeps = {
  getProvider: () => SyncStorageProvider | null
  getPassword: () => string
  // Flush the latest editor text to the encrypted pending-local envelope (during
  // a conflict this updates the local cache only; it never uploads). Returns
  // false if the save failed, so the flow can abort rather than merge against a
  // stale pending envelope.
  flushLocal: () => Promise<boolean>
  // The editor's current plaintext (for the race snapshot check).
  getPlaintext: () => string
  encrypt: (plaintext: string, password: string) => Promise<string>
  // Omitted/undefined uses the default (real CryptoService) decryptor.
  decrypt?: Decryptor | undefined
  // Apply a committed resolution to the editor + save bookkeeping coherently.
  applyCommittedPlaintext: (text: string, envelope: string) => void | Promise<void>
  // Applies a ciphertext-only "keep remote" result. The remote copy cannot be
  // decrypted with the current password, so App must leave the editor session
  // instead of pretending the shown local plaintext is the saved remote document.
  applyKeptRemoteEnvelope: () => void | Promise<void>
  setModalState: (state: ConflictModalState) => void
  showMessage: (text: string, tone?: 'info' | 'error') => void
  refreshStatus: () => Promise<unknown>
}

const isConflictError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 'conflict'

const resolutionLines = (
  resolutions: ConflictResolutions,
  conflictIndex: number,
  region: ConflictRegion,
): string[] => {
  const choice = resolutions.get(conflictIndex)

  switch (choice?.kind) {
    case undefined:
    case 'local':
      return region.local
    case 'remote':
      return region.remote
    case 'both':
      return [...region.local, ...region.remote]
    case 'edited':
      return choice.lines
    default: {
      const exhaustive: never = choice
      return exhaustive
    }
  }
}

/**
 * Orchestrates the Dropbox conflict-resolution flow (SPEC §9), isolated from
 * React so it can be unit-tested with a fake provider. Every async path is
 * stamped with a run id; after each await it bails if the run is no longer
 * current, so a lock (`dispose()`), cancel, or a second resolve can never let an
 * old run reopen the modal or repopulate plaintext.
 */
export const createConflictController = () => {
  let runId = 0
  // The decrypted local text the current merge was built from; the editor must
  // still contain exactly this before a commit (SPEC §9 race guard).
  let mergedLocalSnapshot: string | null = null

  const bump = () => {
    runId += 1
    return runId
  }
  const current = (id: number) => id === runId

  // Drop all in-flight work and decrypted conflict state, and close the modal.
  // Shared by lock (clearSecrets) and Cancel, so neither leaves plaintext resident.
  function dispose(deps: ConflictControllerDeps): void {
    bump()
    mergedLocalSnapshot = null
    deps.setModalState({ mode: 'closed' })
  }

  // Make a committed-but-not-uploaded text the editor's local document and the
  // merge's local snapshot, on a failed upload. The editor must match the durable
  // pending local side, or a later flush would clobber the resolution with stale
  // editor text (SPEC §9: never lose the resolved text).
  //
  // Persist the envelope locally FIRST: the upload-failure paths already saved it
  // (durability before upload), but a precondition failure throws before any
  // write, so without this the text would be marked saved in App state while the
  // pending envelope still held the old text. `save()` during a conflict only
  // writes the local cache + pending envelope (it never uploads), and is
  // idempotent with the provider's own durability write.
  async function adoptLocal(
    deps: ConflictControllerDeps,
    text: string,
    envelope: string,
  ): Promise<void> {
    await deps.getProvider()?.save(envelope)
    await deps.applyCommittedPlaintext(text, envelope)
    mergedLocalSnapshot = text
  }

  // Load → decrypt → merge → route. Also used as Retry.
  async function resolve(deps: ConflictControllerDeps): Promise<void> {
    const id = bump()
    deps.setModalState({ mode: 'loading' })

    const provider = deps.getProvider()
    if (!provider) {
      if (current(id)) {
        deps.setModalState({ mode: 'closed' })
      }
      return
    }

    // Make the merge's local side reflect the latest keystrokes. Abort if the
    // save failed, so we never merge against a stale pending local envelope.
    const flushed = await deps.flushLocal()
    if (!current(id)) {
      return
    }
    if (!flushed) {
      deps.setModalState({ mode: 'closed' })
      deps.showMessage('Could not save your latest changes before resolving.', 'error')
      return
    }

    let envelopes
    try {
      // Re-fetch the remote on open so the merge targets the freshest Dropbox
      // copy whenever online (SPEC §9); offline falls back to the snapshot.
      envelopes = await provider.loadConflictEnvelopes({ refreshRemote: true })
    } catch {
      if (current(id)) {
        deps.setModalState({ mode: 'closed' })
        deps.showMessage('Could not load the Dropbox conflict.', 'error')
      }
      return
    }
    if (!current(id)) {
      return
    }

    if (!envelopes) {
      // No conflict after all (race): close and re-sync the status.
      deps.setModalState({ mode: 'closed' })
      await deps.refreshStatus()
      return
    }

    const prep = await buildConflictResolution(envelopes, deps.getPassword(), deps.decrypt)
    if (!current(id)) {
      return
    }

    if (prep.kind === 'non-mergeable') {
      deps.setModalState({
        mode: 'non-mergeable',
        reason: prep.reason,
        ...(prep.keepLocal ? { keepLocal: prep.keepLocal } : {}),
        ...(prep.keepRemote ? { keepRemote: prep.keepRemote } : {}),
      })
      return
    }

    mergedLocalSnapshot = prep.localText

    if (prep.kind === 'clean') {
      await commitClean(id, prep.mergedText, prep.remoteConflictRev, deps)
      return
    }

    deps.setModalState({
      mode: 'editing',
      regions: prep.regions,
      remoteConflictRev: prep.remoteConflictRev,
    })
  }

  // A clean three-way merge: committed conditionally without per-hunk review once
  // the user has entered the merge flow (SPEC §9).
  async function commitClean(
    id: number,
    text: string,
    remoteConflictRev: string,
    deps: ConflictControllerDeps,
  ): Promise<void> {
    if (mergedLocalSnapshot !== null && deps.getPlaintext() !== mergedLocalSnapshot) {
      // Keystrokes slipped in during the async merge: restart from the flush.
      await resolve(deps)
      return
    }

    const provider = deps.getProvider()
    const password = deps.getPassword()
    if (!provider || !password) {
      return
    }

    deps.setModalState({ mode: 'committing' })

    let envelope: string
    try {
      envelope = await deps.encrypt(text, password)
    } catch {
      if (current(id)) {
        deps.setModalState({ mode: 'closed' })
        deps.showMessage('Could not encrypt the merged text.', 'error')
      }
      return
    }
    if (!current(id)) {
      return
    }

    try {
      await provider.commitMergedEnvelope(envelope, remoteConflictRev)
      if (!current(id)) {
        return
      }
      await deps.applyCommittedPlaintext(text, envelope)
      mergedLocalSnapshot = null
      deps.setModalState({ mode: 'closed' })
      deps.showMessage('Dropbox changes merged automatically.', 'info')
    } catch (error) {
      if (!current(id)) {
        return
      }
      // The provider durably saved the merged envelope as the pending local side
      // before the upload failed; adopt it as the editor doc so the merge isn't
      // discarded by a later flush.
      await adoptLocal(deps, text, envelope)
      await deps.refreshStatus()
      // A clean merge has no editor to keep open; the conflict banner remains.
      deps.setModalState({ mode: 'closed' })
      deps.showMessage(
        isConflictError(error)
          ? 'Dropbox changed again. Open Resolve to review.'
          : 'Could not save the merge to Dropbox. Try again.',
        'error',
      )
    }
  }

  // Commit the user's per-hunk resolution.
  async function commitResolved(
    deps: ConflictControllerDeps,
    input: {
      regions: MergeRegion[]
      resolutions: ConflictResolutions
      remoteConflictRev: string
    },
  ): Promise<void> {
    const id = bump()

    const text = composeRegions(input.regions, (region, index) =>
      resolutionLines(input.resolutions, index, region),
    )

    if (mergedLocalSnapshot !== null && deps.getPlaintext() !== mergedLocalSnapshot) {
      await resolve(deps)
      return
    }

    const provider = deps.getProvider()
    const password = deps.getPassword()
    if (!provider || !password) {
      return
    }

    const editing: ConflictModalState = {
      mode: 'editing',
      regions: input.regions,
      remoteConflictRev: input.remoteConflictRev,
    }

    deps.setModalState({ mode: 'committing' })

    let envelope: string
    try {
      envelope = await deps.encrypt(text, password)
    } catch {
      if (current(id)) {
        deps.setModalState(editing)
        deps.showMessage('Could not encrypt the resolved text.', 'error')
      }
      return
    }
    if (!current(id)) {
      return
    }

    try {
      await provider.commitMergedEnvelope(envelope, input.remoteConflictRev)
      if (!current(id)) {
        return
      }
      await deps.applyCommittedPlaintext(text, envelope)
      mergedLocalSnapshot = null
      deps.setModalState({ mode: 'closed' })
      deps.showMessage('Dropbox conflict resolved.', 'info')
    } catch (error) {
      if (!current(id)) {
        return
      }
      // The provider durably saved this resolved envelope as the pending local
      // side before the upload failed. Adopt it as the editor doc so the
      // resolution is never lost — without this, the 409 re-resolve below (or a
      // later autosave) would flush stale editor text over the saved resolution.
      await adoptLocal(deps, text, envelope)
      await deps.refreshStatus()
      if (isConflictError(error)) {
        // 409 / precondition drift: the provider re-recorded against the fresh
        // remote — reopen the merge against it (now with the resolution as the
        // local side) instead of clobbering.
        deps.showMessage('Dropbox changed again. Re-review the conflict.', 'error')
        await resolve(deps)
      } else {
        // Non-409 failure: keep the editor open with the user's resolutions intact.
        deps.setModalState(editing)
        deps.showMessage('Could not save to Dropbox. Try again.', 'error')
      }
    }
  }

  // Non-mergeable escape: the remote is unreadable, so keep the local version,
  // overwriting the unreadable remote — but revision-conditionally, so a third
  // concurrent change re-conflicts rather than being clobbered.
  async function keepLocal(deps: ConflictControllerDeps, option: KeepLocalOption): Promise<void> {
    const id = bump()

    const provider = deps.getProvider()
    const password = deps.getPassword()
    if (!provider || !password) {
      return
    }

    deps.setModalState({ mode: 'committing' })

    try {
      await provider.commitMergedEnvelope(option.localEnvelope, option.remoteConflictRev)
      if (!current(id)) {
        return
      }
      // The local envelope decrypts to the editor's current text; keep it shown.
      await deps.applyCommittedPlaintext(deps.getPlaintext(), option.localEnvelope)
      mergedLocalSnapshot = null
      deps.setModalState({ mode: 'closed' })
      deps.showMessage('Kept your local version; Dropbox was overwritten.', 'info')
    } catch (error) {
      if (!current(id)) {
        return
      }
      await deps.refreshStatus()
      if (isConflictError(error)) {
        deps.showMessage('Dropbox changed again. Re-review the conflict.', 'error')
        await resolve(deps)
      } else {
        deps.setModalState({ mode: 'non-mergeable', reason: 'remote-undecryptable', keepLocal: option })
        deps.showMessage('Could not save to Dropbox. Try again.', 'error')
      }
    }
  }

  async function keepRemote(
    deps: ConflictControllerDeps,
    option: KeepRemoteOption,
  ): Promise<void> {
    const id = bump()

    const provider = deps.getProvider()
    if (!provider) {
      return
    }

    deps.setModalState({ mode: 'committing' })

    try {
      await provider.adoptRemoteConflictEnvelope(option.remoteEnvelope, option.remoteConflictRev)
      if (!current(id)) {
        return
      }
      mergedLocalSnapshot = null
      deps.setModalState({ mode: 'closed' })
      await deps.applyKeptRemoteEnvelope()
    } catch (error) {
      if (!current(id)) {
        return
      }
      await deps.refreshStatus()
      if (isConflictError(error)) {
        deps.showMessage('Dropbox changed again. Re-review the conflict.', 'error')
        await resolve(deps)
      } else {
        deps.setModalState({
          mode: 'non-mergeable',
          reason: 'remote-undecryptable',
          keepRemote: option,
        })
        deps.showMessage('Could not keep the Dropbox version. Try again.', 'error')
      }
    }
  }

  return { resolve, retry: resolve, commitResolved, keepLocal, keepRemote, dispose }
}

export type ConflictController = ReturnType<typeof createConflictController>
