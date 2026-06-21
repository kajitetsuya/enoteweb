import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestPersistentStorage } from './persistStorage'

describe('requestPersistentStorage', () => {
  let originalStorage: StorageManager | undefined

  beforeEach(() => {
    originalStorage = navigator.storage
  })

  afterEach(() => {
    Object.defineProperty(navigator, 'storage', {
      value: originalStorage,
      configurable: true,
      writable: true,
    })
    vi.restoreAllMocks()
  })

  it('returns null when navigator.storage.persist is absent', async () => {
    Object.defineProperty(navigator, 'storage', {
      value: { persisted: undefined, persist: undefined },
      configurable: true,
      writable: true,
    })
    const result = await requestPersistentStorage()
    expect(result).toBeNull()
  })

  it('returns true without calling persist() when already persisted', async () => {
    const persistMock = vi.fn()
    Object.defineProperty(navigator, 'storage', {
      value: {
        persisted: vi.fn().mockResolvedValue(true),
        persist: persistMock,
      },
      configurable: true,
      writable: true,
    })
    const result = await requestPersistentStorage()
    expect(result).toBe(true)
    expect(persistMock).not.toHaveBeenCalled()
  })

  it('returns true when persisted() is false and persist() grants', async () => {
    Object.defineProperty(navigator, 'storage', {
      value: {
        persisted: vi.fn().mockResolvedValue(false),
        persist: vi.fn().mockResolvedValue(true),
      },
      configurable: true,
      writable: true,
    })
    const result = await requestPersistentStorage()
    expect(result).toBe(true)
  })

  it('returns null when persist() throws', async () => {
    Object.defineProperty(navigator, 'storage', {
      value: {
        persisted: vi.fn().mockResolvedValue(false),
        persist: vi.fn().mockRejectedValue(new Error('denied')),
      },
      configurable: true,
      writable: true,
    })
    const result = await requestPersistentStorage()
    expect(result).toBeNull()
  })
})
