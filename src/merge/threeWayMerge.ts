import { diff3Merge } from 'node-diff3'

// Three-way text merge for the Dropbox conflict flow (SPEC §9). This module is
// the ONLY import site for `node-diff3`: its library types never escape, so the
// dependency can be audited/swapped behind this small, well-tested surface. It is
// a pure function of its inputs — no I/O, no persistence, no logging — and the
// plaintext it operates on stays in the caller's memory.

// A merged document is an ordered list of regions that, concatenated, cover the
// whole document. A `clean` region is auto-merged text; a `conflict` region holds
// the two diverging sides (and the base, for context) for the user to resolve.
export type CleanRegion = { type: 'clean'; lines: string[] }
export type ConflictRegion = {
  type: 'conflict'
  local: string[]
  base: string[]
  remote: string[]
}
export type MergeRegion = CleanRegion | ConflictRegion

export type ThreeWayMergeResult = {
  // True iff there are zero conflict regions.
  clean: boolean
  // Regions in document order.
  regions: MergeRegion[]
  // The fully merged text when `clean`; null when there is at least one conflict
  // (the resolved text is then built from user choices via `composeRegions`).
  cleanText: string | null
}

// Byte-preserving line split/join: `'\n'` only, never normalizing CRLF or a
// trailing newline (a `'\r'` rides along on its line; a trailing newline becomes
// a trailing `''`). This guarantees the merged bytes round-trip exactly.
const splitLines = (text: string): string[] => text.split('\n')
const joinLines = (lines: string[]): string => lines.join('\n')

/**
 * Three-way merges `local` and `remote` against `base`.
 *
 * `base` is the last-synced ancestor text, or `null` when there is **no usable
 * base snapshot** (null/unrecognized `baseRev` and no decryptable
 * `lastSyncedEnvelope`). The two cases are deliberately distinct:
 *
 * - `base === null`: nothing relates the sides, so every difference is surfaced
 *   as a single whole-document conflict (SPEC §9) — disjoint insertions are never
 *   silently combined.
 * - `base` is a string (**including `''`** for a genuinely empty synced
 *   document): a normal three-way merge, so a change on only one side merges
 *   cleanly and divergent changes conflict.
 */
export const threeWayMerge = (
  base: string | null,
  local: string,
  remote: string,
): ThreeWayMergeResult => {
  if (base === null) {
    if (local === remote) {
      return { clean: true, regions: [{ type: 'clean', lines: splitLines(local) }], cleanText: local }
    }

    return {
      clean: false,
      regions: [{ type: 'conflict', local: splitLines(local), base: [], remote: splitLines(remote) }],
      cleanText: null,
    }
  }

  const merged = diff3Merge(splitLines(local), splitLines(base), splitLines(remote), {
    excludeFalseConflicts: true,
  })

  const regions: MergeRegion[] = merged.map((region) =>
    region.conflict
      ? {
          type: 'conflict',
          local: region.conflict.a,
          base: region.conflict.o,
          remote: region.conflict.b,
        }
      : { type: 'clean', lines: region.ok ?? [] },
  )

  const clean = regions.every((region) => region.type === 'clean')
  const cleanText = clean
    ? joinLines(regions.flatMap((region) => (region.type === 'clean' ? region.lines : [])))
    : null

  return { clean, regions, cleanText }
}

/**
 * Builds resolved text from merge regions. Clean regions contribute their merged
 * lines verbatim; each conflict region's lines come from `resolveConflict`, which
 * receives the conflict and its 0-based index among conflict regions (so a
 * caller tracking N conflicts can index them directly).
 *
 * When there are no conflicts the output equals `ThreeWayMergeResult.cleanText`.
 */
export const composeRegions = (
  regions: MergeRegion[],
  resolveConflict: (region: ConflictRegion, conflictIndex: number) => string[],
): string => {
  const lines: string[] = []
  let conflictIndex = 0

  for (const region of regions) {
    if (region.type === 'clean') {
      lines.push(...region.lines)
    } else {
      lines.push(...resolveConflict(region, conflictIndex))
      conflictIndex += 1
    }
  }

  return joinLines(lines)
}
