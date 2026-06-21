import { CryptoService } from '../crypto/cryptoService'
import { threeWayMerge, type MergeRegion } from '../merge/threeWayMerge'
import type { ConflictEnvelopes } from '../storage/storageProvider'

// Why a conflict cannot be merged: the remote was never captured, or a needed
// side cannot be decrypted with the current password.
export type NonMergeableReason = 'no-remote' | 'remote-undecryptable' | 'local-undecryptable'

// The outcome of decrypting the three sides and running the three-way merge.
// `localText` is carried so the controller can use it as the race snapshot
// (the editor's local text must still match it before a commit).
// When the remote is captured (we have a rev) but unreadable, the user can still
// keep their local version, overwriting the unreadable remote — but only
// revision-conditionally. `keepLocal` carries exactly what that needs.
export type KeepLocalOption = { localEnvelope: string; remoteConflictRev: string }
export type KeepRemoteOption = { remoteEnvelope: string; remoteConflictRev: string }

export type ConflictPrep =
  | { kind: 'clean'; mergedText: string; localText: string; remoteConflictRev: string }
  | { kind: 'conflict'; regions: MergeRegion[]; localText: string; remoteConflictRev: string }
  | {
      kind: 'non-mergeable'
      reason: NonMergeableReason
      keepLocal?: KeepLocalOption
      keepRemote?: KeepRemoteOption
    }

export type Decryptor = (envelope: string, password: string) => Promise<string>

const defaultDecrypt: Decryptor = (envelope, password) => CryptoService.decrypt(envelope, password)

const tryDecrypt = async (
  decrypt: Decryptor,
  envelope: string,
  password: string,
): Promise<{ ok: true; text: string } | { ok: false }> => {
  try {
    return { ok: true, text: await decrypt(envelope, password) }
  } catch {
    return { ok: false }
  }
}

// Decrypts the conflict's three encrypted sides in memory and runs the three-way
// merge (SPEC §9). Pure with respect to its inputs (no I/O beyond the injected
// decryptor); the plaintext it produces stays in the caller's memory and is never
// persisted. `decrypt` is injectable for testing.
export const buildConflictResolution = async (
  envelopes: ConflictEnvelopes,
  password: string,
  decrypt: Decryptor = defaultDecrypt,
): Promise<ConflictPrep> => {
  const { baseEnvelope, localEnvelope, remoteEnvelope, remoteConflictRev } = envelopes

  if (!remoteEnvelope || !remoteConflictRev) {
    return { kind: 'non-mergeable', reason: 'no-remote' }
  }

  const local = await tryDecrypt(decrypt, localEnvelope, password)
  if (!local.ok) {
    return {
      kind: 'non-mergeable',
      reason: 'local-undecryptable',
      keepRemote: { remoteEnvelope, remoteConflictRev },
    }
  }

  const remote = await tryDecrypt(decrypt, remoteEnvelope, password)
  if (!remote.ok) {
    // The remote is present (we have a rev) but unreadable. Offer the user a
    // revision-conditional "keep local" escape so they are not stuck.
    return {
      kind: 'non-mergeable',
      reason: 'remote-undecryptable',
      keepLocal: { localEnvelope, remoteConflictRev },
      keepRemote: { remoteEnvelope, remoteConflictRev },
    }
  }

  // An absent OR undecryptable base means "no usable base snapshot": the merge
  // then surfaces every difference as a conflict rather than guessing a side.
  // (An unrecognized baseRev still has a decryptable lastSyncedEnvelope here; the
  // base text is what matters for the merge, not whether Dropbox still knows it.)
  let base: string | null = null
  if (baseEnvelope) {
    const decoded = await tryDecrypt(decrypt, baseEnvelope, password)
    base = decoded.ok ? decoded.text : null
  }

  const merged = threeWayMerge(base, local.text, remote.text)

  if (merged.clean) {
    return {
      kind: 'clean',
      mergedText: merged.cleanText ?? '',
      localText: local.text,
      remoteConflictRev,
    }
  }

  return {
    kind: 'conflict',
    regions: merged.regions,
    localText: local.text,
    remoteConflictRev,
  }
}
