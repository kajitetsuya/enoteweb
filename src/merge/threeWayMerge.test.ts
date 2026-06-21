import { describe, expect, it } from 'vitest'
import {
  composeRegions,
  threeWayMerge,
  type ConflictRegion,
  type MergeRegion,
} from './threeWayMerge'

const conflicts = (regions: MergeRegion[]): ConflictRegion[] =>
  regions.filter((region): region is ConflictRegion => region.type === 'conflict')

const takeLocal = (region: ConflictRegion) => region.local
const takeRemote = (region: ConflictRegion) => region.remote

describe('threeWayMerge', () => {
  describe('with a real base', () => {
    it('auto-merges non-overlapping changes cleanly', () => {
      const result = threeWayMerge('a\nb\nc', 'A\nb\nc', 'a\nb\nC')

      expect(result.clean).toBe(true)
      expect(result.cleanText).toBe('A\nb\nC')
    })

    it('reports a conflict for overlapping changes to the same line', () => {
      const result = threeWayMerge('a\nb\nc', 'a\nLOCAL\nc', 'a\nREMOTE\nc')

      expect(result.clean).toBe(false)
      expect(result.cleanText).toBeNull()

      const conflictRegions = conflicts(result.regions)
      expect(conflictRegions).toHaveLength(1)
      expect(conflictRegions[0]).toEqual({
        type: 'conflict',
        local: ['LOCAL'],
        base: ['b'],
        remote: ['REMOTE'],
      })

      expect(composeRegions(result.regions, takeLocal)).toBe('a\nLOCAL\nc')
      expect(composeRegions(result.regions, takeRemote)).toBe('a\nREMOTE\nc')
      expect(composeRegions(result.regions, () => ['MERGED'])).toBe('a\nMERGED\nc')
    })

    it('treats an identical change on both sides as a (false) clean merge', () => {
      const result = threeWayMerge('a\nb\nc', 'a\nX\nc', 'a\nX\nc')

      expect(result.clean).toBe(true)
      expect(result.cleanText).toBe('a\nX\nc')
    })

    it('takes the remote side when only remote changed', () => {
      const result = threeWayMerge('a\nb', 'a\nb', 'a\nB')

      expect(result.clean).toBe(true)
      expect(result.cleanText).toBe('a\nB')
    })

    it('takes the local side when only local changed', () => {
      const result = threeWayMerge('a\nb', 'A\nb', 'a\nb')

      expect(result.clean).toBe(true)
      expect(result.cleanText).toBe('A\nb')
    })

    it('returns the unchanged document when all three are equal', () => {
      const result = threeWayMerge('x\ny', 'x\ny', 'x\ny')

      expect(result.clean).toBe(true)
      expect(result.cleanText).toBe('x\ny')
    })

    it('conflicts when one side deletes a line the other edits', () => {
      const result = threeWayMerge('a\nb\nc', 'a\nc', 'a\nB\nc')

      expect(result.clean).toBe(false)
      expect(composeRegions(result.regions, takeLocal)).toBe('a\nc')
      expect(composeRegions(result.regions, takeRemote)).toBe('a\nB\nc')
    })

    it('cleanly applies a one-sided deletion', () => {
      const result = threeWayMerge('a\nb\nc', 'a\nc', 'a\nb\nc')

      expect(result.clean).toBe(true)
      expect(result.cleanText).toBe('a\nc')
    })

    it('surfaces multiple independent conflicts in document order', () => {
      const result = threeWayMerge('a\nb\nc\nd\ne', 'A1\nb\nc\nd\nE1', 'A2\nb\nc\nd\nE2')

      expect(conflicts(result.regions)).toHaveLength(2)
      // First conflict resolved to local, second to remote.
      const mixed = composeRegions(result.regions, (region, index) =>
        index === 0 ? region.local : region.remote,
      )
      expect(mixed).toBe('A1\nb\nc\nd\nE2')
    })
  })

  describe('byte preservation', () => {
    it('preserves a trailing newline', () => {
      const result = threeWayMerge('a\nb\n', 'A\nb\n', 'a\nb\n')

      expect(result.clean).toBe(true)
      expect(result.cleanText).toBe('A\nb\n')
    })

    it('preserves CRLF line endings (no normalization)', () => {
      const result = threeWayMerge('a\r\nb', 'A\r\nb', 'a\r\nb')

      expect(result.clean).toBe(true)
      expect(result.cleanText).toBe('A\r\nb')
    })
  })

  describe('no usable base (base === null)', () => {
    it('surfaces a single whole-document conflict when the sides differ', () => {
      const result = threeWayMerge(null, 'local text', 'remote text')

      expect(result.clean).toBe(false)
      expect(result.regions).toEqual([
        { type: 'conflict', local: ['local text'], base: [], remote: ['remote text'] },
      ])
      expect(composeRegions(result.regions, takeLocal)).toBe('local text')
      expect(composeRegions(result.regions, takeRemote)).toBe('remote text')
    })

    it('is clean when the sides happen to be identical', () => {
      const result = threeWayMerge(null, 'same', 'same')

      expect(result.clean).toBe(true)
      expect(result.cleanText).toBe('same')
    })

    it('does NOT auto-combine disjoint insertions — it is one conflict', () => {
      const result = threeWayMerge(null, 'x\ny', 'p\nq')

      expect(conflicts(result.regions)).toHaveLength(1)
      expect(conflicts(result.regions)[0]).toEqual({
        type: 'conflict',
        local: ['x', 'y'],
        base: [],
        remote: ['p', 'q'],
      })
    })
  })

  describe('genuinely empty base (base === "") is distinct from null', () => {
    it('merges cleanly when only local changed (regression guard)', () => {
      const result = threeWayMerge('', 'x', '')

      expect(result.clean).toBe(true)
      expect(result.cleanText).toBe('x')
    })

    it('merges cleanly when only remote changed', () => {
      const result = threeWayMerge('', '', 'y')

      expect(result.clean).toBe(true)
      expect(result.cleanText).toBe('y')
    })

    it('conflicts when both sides add different content', () => {
      const result = threeWayMerge('', 'x', 'y')

      expect(result.clean).toBe(false)
    })

    it('is clean and empty when nothing changed', () => {
      const result = threeWayMerge('', '', '')

      expect(result.clean).toBe(true)
      expect(result.cleanText).toBe('')
    })
  })

  describe('composeRegions', () => {
    it('reproduces cleanText and never calls the resolver when there are no conflicts', () => {
      const result = threeWayMerge('a\nb\nc', 'A\nb\nc', 'a\nb\nC')

      const composed = composeRegions(result.regions, () => {
        throw new Error('resolver must not be called for a clean merge')
      })
      expect(composed).toBe(result.cleanText)
    })
  })
})
