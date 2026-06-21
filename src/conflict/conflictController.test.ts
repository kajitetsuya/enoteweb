import { describe, expect, it, vi } from 'vitest'
import {
  createConflictController,
  type ConflictControllerDeps,
  type ConflictModalState,
} from './conflictController'
import type { Decryptor } from './buildConflictResolution'
import type { ConflictEnvelopes, SyncStorageProvider } from '../storage/storageProvider'

const envelopes = (over: Partial<ConflictEnvelopes> = {}): ConflictEnvelopes => ({
  baseEnvelope: 'base-env',
  localEnvelope: 'local-env',
  remoteEnvelope: 'remote-env',
  remoteConflictRev: 'rev-remote',
  ...over,
})

const decryptMap =
  (map: Record<string, string>): Decryptor =>
  async (env) => {
    if (env in map) {
      return map[env] as string
    }
    throw new Error('nope')
  }

// A clean merge (only local changed) and a conflicting merge, as decrypt maps.
const CLEAN = decryptMap({ 'base-env': 'a\nb', 'local-env': 'A\nb', 'remote-env': 'a\nb' })
const CONFLICT = decryptMap({ 'base-env': 'a\nb', 'local-env': 'a\nL', 'remote-env': 'a\nR' })

const setup = (opts: {
  load?: () => Promise<ConflictEnvelopes | null>
  commit?: (...args: unknown[]) => Promise<unknown>
  decrypt?: Decryptor
  getPlaintext?: () => string
  flushLocal?: () => Promise<boolean>
}) => {
  const states: ConflictModalState[] = []
  const provider = {
    adoptRemoteConflictEnvelope: vi.fn(async () => undefined),
    loadConflictEnvelopes: vi.fn(opts.load ?? (async () => null)),
    commitMergedEnvelope: vi.fn(opts.commit ?? (async () => undefined)),
    save: vi.fn(async () => undefined),
  } as unknown as SyncStorageProvider
  const deps: ConflictControllerDeps = {
    getProvider: () => provider,
    getPassword: () => 'pw',
    flushLocal: vi.fn(opts.flushLocal ?? (async () => true)),
    getPlaintext: opts.getPlaintext ?? (() => ''),
    encrypt: vi.fn(async (text: string) => `enc(${text})`),
    decrypt: opts.decrypt,
    applyCommittedPlaintext: vi.fn(),
    applyKeptRemoteEnvelope: vi.fn(),
    setModalState: vi.fn((s: ConflictModalState) => {
      states.push(s)
    }),
    showMessage: vi.fn(),
    refreshStatus: vi.fn(async () => undefined),
  }
  return { controller: createConflictController(), deps, provider, states }
}

const lastMode = (states: ConflictModalState[]) => states[states.length - 1]?.mode

describe('conflictController', () => {
  it('flushes local edits before loading the conflict envelopes', async () => {
    const { controller, deps, provider } = setup({
      load: async () => envelopes(),
      decrypt: CLEAN,
      getPlaintext: () => 'A\nb',
    })

    await controller.resolve(deps)

    const flushOrder = (deps.flushLocal as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    const loadOrder = (provider.loadConflictEnvelopes as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0]
    expect(flushOrder).toBeLessThan(loadOrder as number)
  })

  it('auto-commits a clean merge and updates the editor + save bookkeeping', async () => {
    const { controller, deps, provider, states } = setup({
      load: async () => envelopes(),
      decrypt: CLEAN,
      getPlaintext: () => 'A\nb',
    })

    await controller.resolve(deps)

    expect(provider.commitMergedEnvelope).toHaveBeenCalledWith('enc(A\nb)', 'rev-remote')
    expect(deps.applyCommittedPlaintext).toHaveBeenCalledWith('A\nb', 'enc(A\nb)')
    expect(lastMode(states)).toBe('closed')
  })

  it('opens the editor for a real conflict without committing', async () => {
    const { controller, deps, provider, states } = setup({
      load: async () => envelopes(),
      decrypt: CONFLICT,
      getPlaintext: () => 'a\nL',
    })

    await controller.resolve(deps)

    const editing = states.find((s) => s.mode === 'editing')
    expect(editing).toBeTruthy()
    expect(provider.commitMergedEnvelope).not.toHaveBeenCalled()
  })

  it('shows the non-mergeable state when the remote was not captured', async () => {
    const { controller, deps, states } = setup({
      load: async () => envelopes({ remoteEnvelope: null, remoteConflictRev: null }),
    })

    await controller.resolve(deps)

    expect(states.at(-1)).toEqual({ mode: 'non-mergeable', reason: 'no-remote' })
  })

  it('commits a resolved merge with the composed text and closes', async () => {
    const { controller, deps, provider, states } = setup({
      load: async () => envelopes(),
      decrypt: CONFLICT,
      getPlaintext: () => 'a\nL',
    })

    await controller.resolve(deps)
    const editing = states.find((s) => s.mode === 'editing')
    if (editing?.mode !== 'editing') throw new Error('expected editing state')

    await controller.commitResolved(deps, {
      regions: editing.regions,
      resolutions: new Map([[0, { kind: 'remote' }]]),
      remoteConflictRev: editing.remoteConflictRev,
    })

    expect(provider.commitMergedEnvelope).toHaveBeenCalledWith('enc(a\nR)', 'rev-remote')
    expect(deps.applyCommittedPlaintext).toHaveBeenCalledWith('a\nR', 'enc(a\nR)')
    expect(lastMode(states)).toBe('closed')
  })

  it('commits a kept-both resolution as local lines followed by remote lines', async () => {
    const { controller, deps, provider, states } = setup({
      load: async () => envelopes(),
      decrypt: CONFLICT,
      getPlaintext: () => 'a\nL',
    })

    await controller.resolve(deps)
    const editing = states.find((s) => s.mode === 'editing')
    if (editing?.mode !== 'editing') throw new Error('expected editing state')

    await controller.commitResolved(deps, {
      regions: editing.regions,
      resolutions: new Map([[0, { kind: 'both' }]]),
      remoteConflictRev: editing.remoteConflictRev,
    })

    // The conflict region is L (local) then R (remote); the clean 'a' stays ahead.
    expect(provider.commitMergedEnvelope).toHaveBeenCalledWith('enc(a\nL\nR)', 'rev-remote')
    expect(deps.applyCommittedPlaintext).toHaveBeenCalledWith('a\nL\nR', 'enc(a\nL\nR)')
    expect(lastMode(states)).toBe('closed')
  })

  it('keeps both with an empty side yields just the non-empty side', async () => {
    const { controller, deps, provider } = setup({
      load: async () => envelopes(),
      decrypt: CONFLICT,
      getPlaintext: () => 'a\nL',
    })

    await controller.resolve(deps)

    // Remote side is a deletion (empty); keep-both therefore contributes only the
    // local lines. (The 'both' tag still distinguishes it in the UI.)
    await controller.commitResolved(deps, {
      regions: [{ type: 'conflict', local: ['keep'], base: ['x'], remote: [] }],
      resolutions: new Map([[0, { kind: 'both' }]]),
      remoteConflictRev: 'rev-remote',
    })

    expect(provider.commitMergedEnvelope).toHaveBeenCalledWith('enc(keep)', 'rev-remote')
    expect(deps.applyCommittedPlaintext).toHaveBeenCalledWith('keep', 'enc(keep)')
  })

  it('reopens the conflict (re-loads) when the resolved commit hits a 409', async () => {
    const { controller, provider, deps } = setup({
      load: async () => envelopes(),
      decrypt: CONFLICT,
      getPlaintext: () => 'a\nL',
      commit: vi.fn().mockRejectedValueOnce({ code: 'conflict' }),
    })

    await controller.resolve(deps)

    await controller.commitResolved(deps, {
      regions: [{ type: 'conflict', local: ['a\nL'], base: [], remote: ['a\nR'] }],
      resolutions: new Map([[0, { kind: 'local' }]]),
      remoteConflictRev: 'rev-remote',
    })

    // One load for the initial resolve, one for the post-409 reopen.
    expect(provider.loadConflictEnvelopes).toHaveBeenCalledTimes(2)
    expect(deps.refreshStatus).toHaveBeenCalled()
  })

  it('keeps the editor open and adopts the resolved text on a non-409 commit failure', async () => {
    const { controller, deps, states } = setup({
      load: async () => envelopes(),
      decrypt: CONFLICT,
      getPlaintext: () => 'a\nL',
      commit: vi.fn().mockRejectedValue({ code: 'offline' }),
    })

    await controller.resolve(deps)
    const editing = states.find((s) => s.mode === 'editing')
    if (editing?.mode !== 'editing') throw new Error('expected editing state')

    await controller.commitResolved(deps, {
      regions: editing.regions,
      resolutions: new Map([[0, { kind: 'remote' }]]),
      remoteConflictRev: editing.remoteConflictRev,
    })

    // The resolved text is adopted as the editor doc (so a later flush can't
    // clobber it), but the editor stays open and no success is reported.
    expect(deps.applyCommittedPlaintext).toHaveBeenCalledWith('a\nR', 'enc(a\nR)')
    expect(lastMode(states)).toBe('editing')
  })

  it('adopts the resolved text before re-resolving after a 409 (resolution differs from editor text)', async () => {
    const { controller, deps, provider } = setup({
      load: async () => envelopes(),
      decrypt: CONFLICT,
      getPlaintext: () => 'a\nL',
      commit: vi.fn().mockRejectedValueOnce({ code: 'conflict' }),
    })

    await controller.resolve(deps)

    // Resolve to REMOTE ('a\nR'), which differs from the editor text ('a\nL').
    await controller.commitResolved(deps, {
      regions: [{ type: 'conflict', local: ['a\nL'], base: [], remote: ['a\nR'] }],
      resolutions: new Map([[0, { kind: 'remote' }]]),
      remoteConflictRev: 'rev-remote',
    })

    // The resolved text becomes the editor doc BEFORE the re-resolve's flush, so
    // the resolution is not lost; then the conflict reopens against fresh remote.
    expect(deps.applyCommittedPlaintext).toHaveBeenCalledWith('a\nR', 'enc(a\nR)')
    expect(provider.loadConflictEnvelopes).toHaveBeenCalledTimes(2)
  })

  it('persists the resolved envelope locally before adopting it (covers a pre-durability precondition failure)', async () => {
    // A conflict-coded failure that wrote nothing durable (the mock never saves),
    // standing in for commitMergedEnvelope's precondition throw before its write.
    const { controller, deps, provider } = setup({
      load: async () => envelopes(),
      decrypt: CONFLICT,
      getPlaintext: () => 'a\nL',
      commit: vi.fn().mockRejectedValueOnce({ code: 'conflict' }),
    })

    await controller.resolve(deps)

    await controller.commitResolved(deps, {
      regions: [{ type: 'conflict', local: ['a\nL'], base: [], remote: ['a\nR'] }],
      resolutions: new Map([[0, { kind: 'remote' }]]),
      remoteConflictRev: 'rev-remote',
    })

    // The resolved envelope is persisted locally before being marked saved, so it
    // can't be lost even if the provider threw before its own durability write.
    const saveOrder = (provider.save as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    const applyOrder = (deps.applyCommittedPlaintext as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0]
    expect(provider.save).toHaveBeenCalledWith('enc(a\nR)')
    expect(saveOrder).toBeLessThan(applyOrder as number)
  })

  it('adopts the merged text when a clean-merge upload fails', async () => {
    const { controller, deps, states } = setup({
      load: async () => envelopes(),
      decrypt: CLEAN,
      getPlaintext: () => 'A\nb',
      commit: vi.fn().mockRejectedValue({ code: 'offline' }),
    })

    await controller.resolve(deps)

    // The clean merge ('A\nb') is adopted even though the upload failed, so the
    // merge isn't discarded by a later flush. The modal closes (banner remains).
    expect(deps.applyCommittedPlaintext).toHaveBeenCalledWith('A\nb', 'enc(A\nb)')
    expect(lastMode(states)).toBe('closed')
  })

  it('aborts the flow when the pre-merge flush fails (does not merge stale state)', async () => {
    const { controller, deps, provider, states } = setup({
      load: async () => envelopes(),
      decrypt: CONFLICT,
      getPlaintext: () => 'a\nL',
      flushLocal: async () => false,
    })

    await controller.resolve(deps)

    expect(provider.loadConflictEnvelopes).not.toHaveBeenCalled()
    expect(lastMode(states)).toBe('closed')
    expect(deps.showMessage).toHaveBeenCalled()
  })

  it('retry re-captures a missing remote and opens the editor', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(envelopes({ remoteEnvelope: null, remoteConflictRev: null }))
      .mockResolvedValueOnce(envelopes())
    const { controller, deps, states } = setup({
      load: load as () => Promise<ConflictEnvelopes | null>,
      decrypt: CONFLICT,
      getPlaintext: () => 'a\nL',
    })

    await controller.resolve(deps)
    expect(states.at(-1)).toMatchObject({ mode: 'non-mergeable' })

    await controller.retry(deps)
    expect(states.at(-1)).toMatchObject({ mode: 'editing' })
  })

  it('keepLocal commits the local envelope conditionally and applies it', async () => {
    const { controller, deps, provider, states } = setup({ getPlaintext: () => 'mine' })

    await controller.keepLocal(deps, { localEnvelope: 'local-env', remoteConflictRev: 'rev-remote' })

    expect(provider.commitMergedEnvelope).toHaveBeenCalledWith('local-env', 'rev-remote')
    expect(deps.applyCommittedPlaintext).toHaveBeenCalledWith('mine', 'local-env')
    expect(lastMode(states)).toBe('closed')
  })

  it('keepRemote adopts the captured remote envelope and leaves the editor session', async () => {
    const { controller, deps, provider, states } = setup({})

    await controller.keepRemote(deps, {
      remoteEnvelope: 'remote-env',
      remoteConflictRev: 'rev-remote',
    })

    expect(provider.adoptRemoteConflictEnvelope).toHaveBeenCalledWith(
      'remote-env',
      'rev-remote',
    )
    expect(deps.applyKeptRemoteEnvelope).toHaveBeenCalled()
    expect(lastMode(states)).toBe('closed')
  })

  it('a run made stale by dispose cannot reopen the modal or apply plaintext', async () => {
    let releaseLoad: (value: ConflictEnvelopes) => void = () => {}
    const loadPromise = new Promise<ConflictEnvelopes>((resolve) => {
      releaseLoad = resolve
    })
    const { controller, deps, states } = setup({
      load: () => loadPromise,
      decrypt: CONFLICT,
      getPlaintext: () => 'a\nL',
    })

    const running = controller.resolve(deps)
    controller.dispose(deps)
    releaseLoad(envelopes())
    await running

    expect(states.map((s) => s.mode)).not.toContain('editing')
    expect(lastMode(states)).toBe('closed')
    expect(deps.applyCommittedPlaintext).not.toHaveBeenCalled()
  })
})
