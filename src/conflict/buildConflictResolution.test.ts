import { describe, expect, it } from 'vitest'
import { buildConflictResolution, type Decryptor } from './buildConflictResolution'
import type { ConflictEnvelopes } from '../storage/storageProvider'

// A fake decryptor mapping known envelope strings to plaintext; anything not in
// the map "fails to decrypt" (wrong password / corruption / wrong file).
const fakeDecrypt =
  (map: Record<string, string>): Decryptor =>
  async (envelope) => {
    if (envelope in map) {
      return map[envelope] as string
    }
    throw new Error('cannot decrypt')
  }

const envelopes = (over: Partial<ConflictEnvelopes> = {}): ConflictEnvelopes => ({
  baseEnvelope: 'base-env',
  localEnvelope: 'local-env',
  remoteEnvelope: 'remote-env',
  remoteConflictRev: 'rev-remote',
  ...over,
})

describe('buildConflictResolution', () => {
  it('returns a clean merge when only one side changed', async () => {
    const prep = await buildConflictResolution(
      envelopes(),
      'pw',
      fakeDecrypt({ 'base-env': 'a\nb', 'local-env': 'A\nb', 'remote-env': 'a\nb' }),
    )

    expect(prep).toEqual({
      kind: 'clean',
      mergedText: 'A\nb',
      localText: 'A\nb',
      remoteConflictRev: 'rev-remote',
    })
  })

  it('returns conflict regions when both sides changed the same place', async () => {
    const prep = await buildConflictResolution(
      envelopes(),
      'pw',
      fakeDecrypt({ 'base-env': 'a\nb', 'local-env': 'a\nLOCAL', 'remote-env': 'a\nREMOTE' }),
    )

    expect(prep.kind).toBe('conflict')
    if (prep.kind === 'conflict') {
      expect(prep.localText).toBe('a\nLOCAL')
      expect(prep.remoteConflictRev).toBe('rev-remote')
      expect(prep.regions.some((r) => r.type === 'conflict')).toBe(true)
    }
  })

  it('is non-mergeable when the remote was never captured', async () => {
    expect(
      await buildConflictResolution(envelopes({ remoteEnvelope: null }), 'pw', fakeDecrypt({})),
    ).toEqual({ kind: 'non-mergeable', reason: 'no-remote' })

    expect(
      await buildConflictResolution(envelopes({ remoteConflictRev: null }), 'pw', fakeDecrypt({})),
    ).toEqual({ kind: 'non-mergeable', reason: 'no-remote' })
  })

  it('is non-mergeable when the local envelope cannot be decrypted', async () => {
    const prep = await buildConflictResolution(
      envelopes(),
      'pw',
      fakeDecrypt({ 'remote-env': 'x' }),
    )
    expect(prep).toEqual({
      kind: 'non-mergeable',
      reason: 'local-undecryptable',
      keepRemote: { remoteEnvelope: 'remote-env', remoteConflictRev: 'rev-remote' },
    })
  })

  it('is non-mergeable when the remote envelope cannot be decrypted', async () => {
    const prep = await buildConflictResolution(
      envelopes(),
      'pw',
      fakeDecrypt({ 'local-env': 'x' }),
    )
    expect(prep).toEqual({
      kind: 'non-mergeable',
      reason: 'remote-undecryptable',
      keepLocal: { localEnvelope: 'local-env', remoteConflictRev: 'rev-remote' },
      keepRemote: { remoteEnvelope: 'remote-env', remoteConflictRev: 'rev-remote' },
    })
  })

  it('treats an undecryptable base as no base (everything conflicts), not an error', async () => {
    const prep = await buildConflictResolution(
      envelopes(),
      'pw',
      // base-env not in the map → base decrypt fails → base treated as null.
      fakeDecrypt({ 'local-env': 'x', 'remote-env': 'y' }),
    )

    expect(prep.kind).toBe('conflict')
    if (prep.kind === 'conflict') {
      expect(prep.regions).toEqual([
        { type: 'conflict', local: ['x'], base: [], remote: ['y'] },
      ])
    }
  })

  it('treats an absent base (null) as no usable base', async () => {
    const conflict = await buildConflictResolution(
      envelopes({ baseEnvelope: null }),
      'pw',
      fakeDecrypt({ 'local-env': 'x', 'remote-env': 'y' }),
    )
    expect(conflict.kind).toBe('conflict')

    const clean = await buildConflictResolution(
      envelopes({ baseEnvelope: null }),
      'pw',
      fakeDecrypt({ 'local-env': 'same', 'remote-env': 'same' }),
    )
    expect(clean).toMatchObject({ kind: 'clean', mergedText: 'same' })
  })
})
