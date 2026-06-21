import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from './clipboard'

describe('copyText', () => {
  // jsdom has no document.execCommand; the fallback test defines it, so capture
  // the original descriptor up front and restore it after each test.
  const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand')

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()

    if (originalExecCommand) {
      Object.defineProperty(document, 'execCommand', originalExecCommand)
    } else {
      delete (document as { execCommand?: unknown }).execCommand
    }
  })

  it('uses the async Clipboard API when available', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    copyText('hello')

    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('swallows a Clipboard API rejection without throwing', () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    expect(() => copyText('hello')).not.toThrow()
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('falls back to execCommand when the Clipboard API is unavailable', () => {
    // Non-secure context: navigator.clipboard is undefined. The temporary
    // execCommand fallback must run.
    vi.stubGlobal('navigator', {})
    const execCommand = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true })

    copyText('world')

    expect(execCommand).toHaveBeenCalledWith('copy')
  })
})
