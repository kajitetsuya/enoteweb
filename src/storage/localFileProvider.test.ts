import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { CryptoService, parseEnvelope } from '../crypto/cryptoService'
import { LocalFileNotFoundError, LocalFileProvider } from './localFileProvider'
import { VaultStore } from './vaultStore'

const fastKdf = {
  opslimit: 2,
  memlimit: 8_388_608,
}

let dbCounter = 0

const testDbName = () => {
  dbCounter += 1
  return `enoteweb-local-file-test-${Date.now()}-${dbCounter}`
}

class MemoryFileHandle {
  readonly kind = 'file'

  content: string
  entryId: string
  lastModified: number
  name: string
  path?: string
  permissionState: PermissionState
  requestPermissionState: PermissionState

  constructor(
    name: string,
    content = '',
    permissionState: PermissionState = 'granted',
    requestPermissionState = permissionState,
    entryId = name,
    exposedPath?: string,
    lastModified = Date.UTC(2026, 5, 1, 12, 0, 0),
  ) {
    this.content = content
    this.entryId = entryId
    this.lastModified = lastModified
    this.name = name
    if (exposedPath !== undefined) {
      this.path = exposedPath
    }
    this.permissionState = permissionState
    this.requestPermissionState = requestPermissionState
  }

  async getFile() {
    return new File([this.content], this.name, {
      lastModified: this.lastModified,
      type: 'text/plain',
    })
  }

  async createWritable() {
    return {
      async close() {
        return undefined
      },
      write: async (data: unknown) => {
        if (typeof data !== 'string') {
          throw new Error('MemoryFileHandle only supports string writes.')
        }

        this.content = data
        this.lastModified += 1_000
      },
    } as FileSystemWritableFileStream
  }

  async queryPermission() {
    return this.permissionState
  }

  async requestPermission() {
    this.permissionState = this.requestPermissionState
    return this.permissionState
  }

  async isSameEntry(otherHandle: FileSystemHandle) {
    return (otherHandle as { entryId?: string }).entryId === this.entryId
  }
}

class MemoryDirectoryHandle {
  readonly kind = 'directory'

  name: string
  pathsByEntryId: Map<string, string[]>

  constructor(name: string, pathsByEntryId: Map<string, string[]>) {
    this.name = name
    this.pathsByEntryId = pathsByEntryId
  }

  async resolve(handle: FileSystemHandle) {
    return this.pathsByEntryId.get((handle as { entryId?: string }).entryId ?? '') ?? null
  }
}

const toNativeHandle = (handle: MemoryFileHandle) =>
  handle as unknown as FileSystemFileHandle

const toNativeDirectoryHandle = (handle: MemoryDirectoryHandle) =>
  handle as unknown as FileSystemDirectoryHandle

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', {
    value: new IDBFactory(),
    configurable: true,
  })
  Object.defineProperty(globalThis, 'showOpenFilePicker', {
    value: undefined,
    configurable: true,
    writable: true,
  })
  Object.defineProperty(globalThis, 'showSaveFilePicker', {
    value: undefined,
    configurable: true,
    writable: true,
  })
  Object.defineProperty(globalThis, 'showDirectoryPicker', {
    value: undefined,
    configurable: true,
    writable: true,
  })
})

describe('LocalFileProvider', () => {
  it('creates a selected encrypted .txt file and stores only encrypted metadata', async () => {
    const store = new VaultStore(testDbName())
    const provider = new LocalFileProvider(store)
    const handle = new MemoryFileHandle('note.txt')
    const envelope = await CryptoService.encrypt('local plaintext marker', 'password', fastKdf)

    globalThis.showSaveFilePicker = async () => toNativeHandle(handle)

    await provider.create(envelope)

    const parsed = parseEnvelope(handle.content)
    const rawRecoveryRecord = JSON.stringify(await store.getLocalFileRecovery())
    const fileRecord = await store.getActiveLocalFile()

    expect(parsed.ciphertext).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    expect(handle.content).toBe(`${envelope}\n`)
    // The recovery copy lives under its own vault key; the 'primary' working
    // copy (draft / Dropbox document) is never touched by Local File
    // Mode.
    expect(rawRecoveryRecord).toContain('ciphertext')
    expect(rawRecoveryRecord).not.toContain('local plaintext marker')
    expect(await store.getVault()).toBeNull()
    expect(fileRecord).toMatchObject({
      active: true,
      displayName: 'note.txt',
      displayPath: null,
      permissionState: 'granted',
    })
  })

  it('local-file use never overwrites an existing draft working copy', async () => {
    const store = new VaultStore(testDbName())
    const provider = new LocalFileProvider(store)
    const handle = new MemoryFileHandle('note.txt')
    const draftEnvelope = await CryptoService.encrypt('vault doc', 'password', fastKdf)
    const localFileEnvelope = await CryptoService.encrypt('file doc', 'password', fastKdf)

    // An un-exported Draft document already exists.
    await store.saveEnvelope(draftEnvelope, new Date(), 'draft')

    globalThis.showSaveFilePicker = async () => toNativeHandle(handle)
    await provider.create(localFileEnvelope)

    // The vault working copy survives; the recovery copy is separate.
    expect((await store.getVault())?.envelope).toBe(draftEnvelope)
    expect((await store.getLocalFileRecovery())?.envelope).toBe(localFileEnvelope)
  })

  it('passes the suggested default filename to the save picker on create', async () => {
    const store = new VaultStore(testDbName())
    const provider = new LocalFileProvider(store)
    const handle = new MemoryFileHandle('note.txt')
    const envelope = await CryptoService.encrypt('local plaintext marker', 'password', fastKdf)
    let receivedOptions: SaveFilePickerOptions | undefined

    globalThis.showSaveFilePicker = async (options?: SaveFilePickerOptions) => {
      receivedOptions = options
      return toNativeHandle(handle)
    }

    await provider.create(envelope)

    expect(receivedOptions).toMatchObject({
      excludeAcceptAllOption: true,
      suggestedName: 'enote.txt',
    })
  })

  it('rejects creation when the picked file name is not .txt or .text', async () => {
    const store = new VaultStore(testDbName())
    const provider = new LocalFileProvider(store)
    const handle = new MemoryFileHandle('note.enote')
    const envelope = await CryptoService.encrypt('local plaintext marker', 'password', fastKdf)

    globalThis.showSaveFilePicker = async () => toNativeHandle(handle)

    await expect(provider.create(envelope)).rejects.toThrow(
      'Encrypted file name must end in .txt or .text.',
    )
    expect(handle.content).toBe('')
    expect(await store.getActiveLocalFile()).toBeFalsy()
  })

  it('creates an encrypted .text file (officially supported extension)', async () => {
    const store = new VaultStore(testDbName())
    const provider = new LocalFileProvider(store)
    const handle = new MemoryFileHandle('note.text')
    const envelope = await CryptoService.encrypt('local plaintext marker', 'password', fastKdf)

    globalThis.showSaveFilePicker = async () => toNativeHandle(handle)

    await provider.create(envelope)

    expect(handle.content).toBe(`${envelope}\n`)
    expect(await store.getActiveLocalFile()).toMatchObject({ displayName: 'note.text' })
  })

  it('passes a caller-supplied suggested name to the save picker', async () => {
    const store = new VaultStore(testDbName())
    const provider = new LocalFileProvider(store)
    const handle = new MemoryFileHandle('renamed.txt')
    const envelope = await CryptoService.encrypt('local plaintext marker', 'password', fastKdf)
    let receivedOptions: SaveFilePickerOptions | undefined

    globalThis.showSaveFilePicker = async (options?: SaveFilePickerOptions) => {
      receivedOptions = options
      return toNativeHandle(handle)
    }

    await provider.create(envelope, { suggestedName: 'recent-note.txt' })

    expect(receivedOptions).toMatchObject({ suggestedName: 'recent-note.txt' })
  })

  it('passes a caller-supplied start handle to the save picker', async () => {
    const store = new VaultStore(testDbName())
    const provider = new LocalFileProvider(store)
    const handle = new MemoryFileHandle('renamed.txt')
    const startIn = toNativeHandle(new MemoryFileHandle('current.txt'))
    const envelope = await CryptoService.encrypt('local plaintext marker', 'password', fastKdf)
    let receivedOptions: SaveFilePickerOptions | undefined

    globalThis.showSaveFilePicker = async (options?: SaveFilePickerOptions) => {
      receivedOptions = options
      return toNativeHandle(handle)
    }

    await provider.create(envelope, { startIn, suggestedName: 'recent-note.txt' })

    expect(receivedOptions).toMatchObject({ startIn, suggestedName: 'recent-note.txt' })
  })

  it('rejects browsing to a file that is not .txt or .text', async () => {
    const store = new VaultStore(testDbName())
    const provider = new LocalFileProvider(store)
    const handle = new MemoryFileHandle('note.md', 'not an envelope')

    globalThis.showOpenFilePicker = async () => [toNativeHandle(handle)]

    await expect(provider.open()).rejects.toThrow(
      'Encrypted file name must end in .txt or .text.',
    )
    expect(await store.getLocalFiles()).toHaveLength(0)
  })

  it('stores an exposed full path when the runtime provides one', async () => {
    const store = new VaultStore(testDbName())
    const provider = new LocalFileProvider(store)
    const handle = new MemoryFileHandle(
      'note.txt',
      '',
      'granted',
      'granted',
      'note.txt',
      'C:\\Users\\username\\Documents\\note.txt',
    )
    const envelope = await CryptoService.encrypt('local plaintext marker', 'password', fastKdf)

    globalThis.showSaveFilePicker = async () => toNativeHandle(handle)

    await provider.create(envelope)

    expect(await store.getActiveLocalFile()).toMatchObject({
      displayName: 'note.txt',
      displayPath: 'C:\\Users\\username\\Documents\\note.txt',
    })
  })

  it('uses the selected path root to show a relative parent folder and last modified date', async () => {
    const store = new VaultStore(testDbName())
    const provider = new LocalFileProvider(store)
    const envelope = await CryptoService.encrypt('local plaintext marker', 'password', fastKdf)
    const lastModified = Date.UTC(2026, 5, 2, 3, 4, 5)
    const handle = new MemoryFileHandle(
      'note.txt',
      `${envelope}\n`,
      'granted',
      'granted',
      'workspace/projects/note.txt',
      undefined,
      lastModified,
    )
    const root = new MemoryDirectoryHandle(
      'workspace',
      new Map([['workspace/projects/note.txt', ['projects', 'note.txt']]]),
    )

    globalThis.showOpenFilePicker = async () => [toNativeHandle(handle)]

    await provider.open()

    globalThis.showDirectoryPicker = async () => toNativeDirectoryHandle(root)
    store.getLocalFilePathRoot = async () => ({
      handle: toNativeDirectoryHandle(root),
      key: 'localFilePathRoot',
      name: 'workspace',
      updatedAt: '2026-06-02T00:00:00.000Z',
    })

    await provider.setPathRoot()

    expect(await store.getActiveLocalFile()).toMatchObject({
      displayName: 'note.txt',
      displayPath: 'projects',
      lastModifiedAt: new Date(lastModified).toISOString(),
    })
  })

  it('preserves last modified metadata when a later save cannot refresh it', async () => {
    const store = new VaultStore(testDbName())
    const handle = new MemoryFileHandle('note.txt', '')
    const lastModifiedAt = '2026-06-02T03:04:05.000Z'

    await store.saveLocalFile({
      displayName: 'note.txt',
      displayPath: 'projects',
      handle: toNativeHandle(handle),
      key: 'primary',
      lastModifiedAt,
      lastSavedEnvelope: 'first-envelope',
      permissionState: 'granted',
      updatedAt: '2026-06-02T03:05:00.000Z',
    })

    await store.saveLocalFile({
      displayName: 'note.txt',
      displayPath: 'projects',
      handle: toNativeHandle(handle),
      key: 'primary',
      lastModifiedAt: null,
      lastSavedEnvelope: 'second-envelope',
      permissionState: 'denied',
      updatedAt: '2026-06-02T03:06:00.000Z',
    })

    expect(await store.getActiveLocalFile()).toMatchObject({
      lastModifiedAt,
      lastSavedEnvelope: 'second-envelope',
      permissionState: 'denied',
    })
  })

  it('opens an encrypted text file and then saves back to the same handle', async () => {
    const store = new VaultStore(testDbName())
    const provider = new LocalFileProvider(store)
    const firstEnvelope = await CryptoService.encrypt('first version', 'password', fastKdf)
    const secondEnvelope = await CryptoService.encrypt('second version', 'password', fastKdf)
    const handle = new MemoryFileHandle('opened.txt', `${firstEnvelope}\n`)

    globalThis.showOpenFilePicker = async () => [toNativeHandle(handle)]

    const openedEnvelope = await provider.open()

    expect(openedEnvelope.trim()).toBe(firstEnvelope)

    await provider.save(secondEnvelope)

    expect(handle.content).toBe(`${secondEnvelope}\n`)
    expect((await provider.loadWithPermission()).trim()).toBe(secondEnvelope)
    expect((await store.getActiveLocalFile())?.lastSavedEnvelope).toBe(secondEnvelope)
    expect(await store.getLocalFiles()).toHaveLength(1)
  })

  it('requests write permission while browsing so later autosave can save', async () => {
    const store = new VaultStore(testDbName())
    const provider = new LocalFileProvider(store)
    const envelope = await CryptoService.encrypt('read-only unlock', 'password', fastKdf)
    const permissionModes: string[] = []
    class TrackingFileHandle extends MemoryFileHandle {
      async queryPermission(options?: FileSystemHandlePermissionDescriptor) {
        permissionModes.push(`query:${options?.mode ?? 'read'}`)
        return super.queryPermission()
      }

      async requestPermission(options?: FileSystemHandlePermissionDescriptor) {
        permissionModes.push(`request:${options?.mode ?? 'read'}`)
        return super.requestPermission()
      }
    }
    const handle = new TrackingFileHandle('opened-read.txt', `${envelope}\n`)

    globalThis.showOpenFilePicker = async () => [toNativeHandle(handle)]

    await provider.open()

    expect(permissionModes).toEqual(['request:readwrite'])
  })

  it('still opens for reading when write permission is not granted', async () => {
    const store = new VaultStore(testDbName())
    const provider = new LocalFileProvider(store)
    const envelope = await CryptoService.encrypt('read-only fallback', 'password', fastKdf)
    const permissionModes: string[] = []
    class ReadOnlyFileHandle extends MemoryFileHandle {
      async queryPermission(options?: FileSystemHandlePermissionDescriptor) {
        permissionModes.push(`query:${options?.mode ?? 'read'}`)
        return options?.mode === 'readwrite' ? 'prompt' : 'granted'
      }

      async requestPermission(options?: FileSystemHandlePermissionDescriptor) {
        permissionModes.push(`request:${options?.mode ?? 'read'}`)
        return options?.mode === 'readwrite' ? 'denied' : 'granted'
      }
    }
    const handle = new ReadOnlyFileHandle('opened-read-only.txt', `${envelope}\n`)

    globalThis.showOpenFilePicker = async () => [toNativeHandle(handle)]

    const openedEnvelope = await provider.open()

    expect(openedEnvelope).toBe(envelope)
    expect(permissionModes).toEqual(['request:readwrite', 'query:readwrite', 'request:read'])
  })

  it('appends newly created and browsed files to the recent file list', async () => {
    const store = new VaultStore(testDbName())
    const provider = new LocalFileProvider(store)
    const firstEnvelope = await CryptoService.encrypt('first file', 'password', fastKdf)
    const secondEnvelope = await CryptoService.encrypt('second file', 'password', fastKdf)
    const thirdEnvelope = await CryptoService.encrypt('third file', 'password', fastKdf)
    const firstHandle = new MemoryFileHandle('first.txt')
    const secondHandle = new MemoryFileHandle('second.txt')
    const thirdHandle = new MemoryFileHandle('third.txt', `${thirdEnvelope}\n`)

    globalThis.showSaveFilePicker = async () => toNativeHandle(firstHandle)

    await provider.create(firstEnvelope)

    globalThis.showSaveFilePicker = async () => toNativeHandle(secondHandle)

    await provider.create(secondEnvelope)

    globalThis.showOpenFilePicker = async () => [toNativeHandle(thirdHandle)]

    await provider.open()

    const records = await store.getLocalFiles()

    expect(records.map((record) => record.displayName)).toEqual([
      'first.txt',
      'second.txt',
      'third.txt',
    ])
    expect(records.map((record) => record.active)).toEqual([false, false, true])
    expect((await store.getActiveLocalFile())?.displayName).toBe('third.txt')
  })

  it('replaces an older recent file record when creating the same file again', async () => {
    const store = new VaultStore(testDbName())
    const provider = new LocalFileProvider(store)
    const firstEnvelope = await CryptoService.encrypt('first overwrite version', 'password', fastKdf)
    const secondEnvelope = await CryptoService.encrypt('second overwrite version', 'password', fastKdf)
    const firstHandle = new MemoryFileHandle(
      'same-name.txt',
      '',
      'granted',
      'granted',
      'folder-a/same-name.txt',
    )
    const secondHandle = new MemoryFileHandle(
      'same-name.txt',
      '',
      'granted',
      'granted',
      'folder-a/same-name.txt',
    )

    globalThis.showSaveFilePicker = async () => toNativeHandle(firstHandle)

    await provider.create(firstEnvelope)

    const firstRecord = await store.getActiveLocalFile()

    globalThis.showSaveFilePicker = async () => toNativeHandle(secondHandle)

    await provider.create(secondEnvelope)

    const records = await store.getLocalFiles()

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      active: true,
      displayName: 'same-name.txt',
      lastSavedEnvelope: secondEnvelope,
    })
    expect(records[0]?.key).not.toBe(firstRecord?.key)
  })

  it('keeps files with the same name when their file entries differ', async () => {
    const store = new VaultStore(testDbName())
    const provider = new LocalFileProvider(store)
    const firstEnvelope = await CryptoService.encrypt('first folder', 'password', fastKdf)
    const secondEnvelope = await CryptoService.encrypt('second folder', 'password', fastKdf)
    const firstHandle = new MemoryFileHandle(
      'same-name.txt',
      '',
      'granted',
      'granted',
      'folder-a/same-name.txt',
    )
    const secondHandle = new MemoryFileHandle(
      'same-name.txt',
      '',
      'granted',
      'granted',
      'folder-b/same-name.txt',
    )

    globalThis.showSaveFilePicker = async () => toNativeHandle(firstHandle)

    await provider.create(firstEnvelope)

    globalThis.showSaveFilePicker = async () => toNativeHandle(secondHandle)

    await provider.create(secondEnvelope)

    const records = await store.getLocalFiles()

    expect(records).toHaveLength(2)
    expect(records.map((record) => record.displayName)).toEqual([
      'same-name.txt',
      'same-name.txt',
    ])
    expect(records.map((record) => record.lastSavedEnvelope)).toEqual([
      firstEnvelope,
      secondEnvelope,
    ])
  })

  it('opens a persisted record by requesting permission before IndexedDB selection', async () => {
    const store = new VaultStore(testDbName())
    const provider = new LocalFileProvider(store)
    const envelope = await CryptoService.encrypt('persisted file', 'password', fastKdf)
    const events: string[] = []
    class PromptGrantingFileHandle extends MemoryFileHandle {
      async queryPermission(options?: FileSystemHandlePermissionDescriptor) {
        events.push(`queryPermission:${options?.mode ?? 'read'}`)
        return super.queryPermission()
      }

      async requestPermission(options?: FileSystemHandlePermissionDescriptor) {
        events.push(`requestPermission:${options?.mode ?? 'read'}`)
        return super.requestPermission()
      }
    }
    const handle = new PromptGrantingFileHandle(
      'persisted.txt',
      `${envelope}\n`,
      'prompt',
      'granted',
    )
    const selectedRecord = {
      active: true,
      createdAt: '2026-06-01T00:00:00.000Z',
      displayName: 'persisted.txt',
      displayPath: null,
      handle: toNativeHandle(handle),
      key: 'primary',
      lastModifiedAt: null,
      lastSavedEnvelope: envelope,
      permissionState: 'prompt' as const,
      updatedAt: '2026-06-01T00:00:00.000Z',
    }
    const originalGetActiveLocalFile = store.getActiveLocalFile.bind(store)
    const originalSaveLocalFile = store.saveLocalFile.bind(store)

    store.getActiveLocalFile = async () => {
      events.push('getActiveLocalFile')
      return originalGetActiveLocalFile()
    }
    store.saveLocalFile = async (...args) => {
      events.push('saveLocalFile')
      return originalSaveLocalFile(...args)
    }
    const openedEnvelope = await provider.loadWithPermission(selectedRecord)

    expect(openedEnvelope).toBe(envelope)
    expect(events[0]).toBe('requestPermission:readwrite')
    expect(events).not.toContain('getActiveLocalFile')
    expect(events).toContain('saveLocalFile')
  })

  it('maps a missing recent file to LocalFileNotFoundError', async () => {
    const store = new VaultStore(testDbName())
    const provider = new LocalFileProvider(store)
    const envelope = await CryptoService.encrypt('moved away', 'password', fastKdf)
    class MissingFileHandle extends MemoryFileHandle {
      async getFile(): Promise<File> {
        throw new DOMException(
          'A requested file or directory could not be found.',
          'NotFoundError',
        )
      }
    }
    const handle = new MissingFileHandle('moved.txt', `${envelope}\n`)
    const selectedRecord = {
      active: true,
      createdAt: '2026-06-01T00:00:00.000Z',
      displayName: 'moved.txt',
      displayPath: null,
      handle: toNativeHandle(handle),
      key: 'primary',
      lastModifiedAt: null,
      lastSavedEnvelope: envelope,
      permissionState: 'granted' as const,
      updatedAt: '2026-06-01T00:00:00.000Z',
    }

    await expect(provider.loadWithPermission(selectedRecord)).rejects.toBeInstanceOf(
      LocalFileNotFoundError,
    )
  })

  it('forgets the recent file handle without changing the PC file content', async () => {
    const store = new VaultStore(testDbName())
    const provider = new LocalFileProvider(store)
    const envelope = await CryptoService.encrypt('kept on disk', 'password', fastKdf)
    const handle = new MemoryFileHandle('forget-me.txt', `${envelope}\n`)

    globalThis.showOpenFilePicker = async () => [toNativeHandle(handle)]

    await provider.open()
    await provider.forget()

    expect(handle.content).toBe(`${envelope}\n`)
    expect(await store.getActiveLocalFile()).toBeNull()
    expect(await store.getVault()).toBeNull()
  })

  it('Save As onto a file already in the recent list does not duplicate the entry', async () => {
    const store = new VaultStore(testDbName())
    const provider = new LocalFileProvider(store)
    const firstEnvelope = await CryptoService.encrypt('first', 'password', fastKdf)
    const secondEnvelope = await CryptoService.encrypt('second', 'password', fastKdf)

    // b.txt enters the recent list by being created once.
    const originalB = new MemoryFileHandle('b.txt', '', 'granted', 'granted', 'entry-b')
    globalThis.showSaveFilePicker = async () => toNativeHandle(originalB)
    await provider.create(firstEnvelope)

    // A second file becomes the active one.
    const fileA = new MemoryFileHandle('a.txt', `${firstEnvelope}\n`, 'granted', 'granted', 'entry-a')
    globalThis.showOpenFilePicker = async () => [toNativeHandle(fileA)]
    await provider.open()

    expect(await store.getLocalFiles()).toHaveLength(2)

    // Save As overwrites b.txt: the picker hands back a FRESH handle to the
    // same on-disk file, exactly as the native save dialog does.
    const freshB = new MemoryFileHandle('b.txt', originalB.content, 'granted', 'granted', 'entry-b')
    globalThis.showSaveFilePicker = async () => toNativeHandle(freshB)
    await provider.create(secondEnvelope)

    const records = await store.getLocalFiles()

    expect(records).toHaveLength(2)
    expect(records.filter((record) => record.displayName === 'b.txt')).toHaveLength(1)
  })

  it('a save collapses every duplicate record of the same file, not just one', async () => {
    const store = new VaultStore(testDbName())
    const provider = new LocalFileProvider(store)
    const envelope = await CryptoService.encrypt('text', 'password', fastKdf)

    const seedFirst = new MemoryFileHandle('b.txt', '', 'granted', 'granted', 'entry-b')
    globalThis.showSaveFilePicker = async () => toNativeHandle(seedFirst)
    await provider.create(envelope)

    // Simulate a duplicate left behind by an older build: same file, but its
    // handle refused the same-entry match at the time it was written. A
    // prototype override (not an own property) keeps the handle clonable.
    class NoMatchFileHandle extends MemoryFileHandle {
      override async isSameEntry() {
        return false
      }
    }
    const seedSecond = new NoMatchFileHandle('b.txt', '', 'granted', 'granted', 'entry-b')
    globalThis.showSaveFilePicker = async () => toNativeHandle(seedSecond)
    await provider.create(envelope)

    expect(await store.getLocalFiles()).toHaveLength(2)

    // The next save of the same file must converge the list to one entry.
    const freshB = new MemoryFileHandle('b.txt', '', 'granted', 'granted', 'entry-b')
    globalThis.showSaveFilePicker = async () => toNativeHandle(freshB)
    await provider.create(envelope)

    expect(await store.getLocalFiles()).toHaveLength(1)
  })

  it('status() reports a granted file as ready without mutating the file store', async () => {
    const store = new VaultStore(testDbName())
    const provider = new LocalFileProvider(store)
    const envelope = await CryptoService.encrypt('status probe', 'password', fastKdf)
    const handle = new MemoryFileHandle('status.txt', `${envelope}\n`, 'granted')

    globalThis.showOpenFilePicker = async () => [toNativeHandle(handle)]
    await provider.open()

    const before = JSON.stringify(await store.getActiveLocalFile())

    // Two reads in a row must leave the persisted record byte-identical: status()
    // is a pure read and must not race the save path by re-persisting a stale
    // lastSavedEnvelope.
    expect(await provider.status()).toEqual({
      detail: 'Local encrypted text file is ready.',
      state: 'ready',
    })
    expect(await provider.status()).toEqual({
      detail: 'Local encrypted text file is ready.',
      state: 'ready',
    })

    expect(JSON.stringify(await store.getActiveLocalFile())).toBe(before)
  })

  it('status() maps a denied permission state to error without writing', async () => {
    const store = new VaultStore(testDbName())
    const provider = new LocalFileProvider(store)
    const envelope = await CryptoService.encrypt('status denied', 'password', fastKdf)
    // Opens fine for reading, but write permission is denied; a later status()
    // refresh observes 'denied' for the readwrite mode.
    class DeniedWriteFileHandle extends MemoryFileHandle {
      async queryPermission(options?: FileSystemHandlePermissionDescriptor) {
        return options?.mode === 'readwrite' ? 'denied' : 'granted'
      }

      async requestPermission(options?: FileSystemHandlePermissionDescriptor) {
        return options?.mode === 'readwrite' ? 'denied' : 'granted'
      }
    }
    const handle = new DeniedWriteFileHandle('denied.txt', `${envelope}\n`)

    globalThis.showOpenFilePicker = async () => [toNativeHandle(handle)]
    await provider.open()

    const before = JSON.stringify(await store.getActiveLocalFile())

    expect(await provider.status()).toEqual({
      detail: 'Local file write permission was denied.',
      state: 'error',
    })

    // status() observed 'denied' but must not write that back over the persisted
    // record (the genuine save/open paths own that field).
    expect(JSON.stringify(await store.getActiveLocalFile())).toBe(before)
  })

  it('status() maps a prompt permission state to needs-user-action without writing', async () => {
    const store = new VaultStore(testDbName())
    const provider = new LocalFileProvider(store)
    const envelope = await CryptoService.encrypt('status prompt', 'password', fastKdf)
    // Opens for reading, but readwrite stays at 'prompt' (user has not granted
    // write yet).
    class PromptWriteFileHandle extends MemoryFileHandle {
      async queryPermission(options?: FileSystemHandlePermissionDescriptor) {
        return options?.mode === 'readwrite' ? 'prompt' : 'granted'
      }

      async requestPermission(options?: FileSystemHandlePermissionDescriptor) {
        return options?.mode === 'readwrite' ? 'prompt' : 'granted'
      }
    }
    const handle = new PromptWriteFileHandle('prompt.txt', `${envelope}\n`)

    globalThis.showOpenFilePicker = async () => [toNativeHandle(handle)]
    await provider.open()

    const before = JSON.stringify(await store.getActiveLocalFile())

    expect(await provider.status()).toEqual({
      detail: 'Open the local file and allow write permission to save.',
      state: 'needs-user-action',
    })
    expect(JSON.stringify(await store.getActiveLocalFile())).toBe(before)
  })

  it('status() asks the user to choose a file when none is selected', async () => {
    const store = new VaultStore(testDbName())
    const provider = new LocalFileProvider(store)

    expect(await provider.status()).toEqual({
      detail: 'Choose or create an encrypted text file.',
      state: 'needs-user-action',
    })
  })
})
