import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXPORT_FILE_NAME,
  isEncryptedTextFileName,
  toSuggestedTxtName,
} from './exportFileNames'

describe('isEncryptedTextFileName', () => {
  it('accepts .txt and .text in any case', () => {
    expect(isEncryptedTextFileName('a.txt')).toBe(true)
    expect(isEncryptedTextFileName('a.TXT')).toBe(true)
    expect(isEncryptedTextFileName('a.text')).toBe(true)
    expect(isEncryptedTextFileName('a.TeXt')).toBe(true)
  })

  it('rejects other extensions', () => {
    expect(isEncryptedTextFileName('a.md')).toBe(false)
    expect(isEncryptedTextFileName('a.txt.bak')).toBe(false)
    expect(isEncryptedTextFileName('atxt')).toBe(false)
  })
})

describe('toSuggestedTxtName', () => {
  it('falls back to the default name when the input is missing or empty', () => {
    expect(toSuggestedTxtName(null)).toBe(DEFAULT_EXPORT_FILE_NAME)
    expect(toSuggestedTxtName(undefined)).toBe(DEFAULT_EXPORT_FILE_NAME)
    expect(toSuggestedTxtName('')).toBe(DEFAULT_EXPORT_FILE_NAME)
    expect(toSuggestedTxtName('   ')).toBe(DEFAULT_EXPORT_FILE_NAME)
  })

  it('keeps a plain .txt basename unchanged', () => {
    expect(toSuggestedTxtName('notes.txt')).toBe('notes.txt')
    expect(toSuggestedTxtName('Notes.TXT')).toBe('Notes.TXT')
  })

  it('keeps a .text basename unchanged', () => {
    expect(toSuggestedTxtName('notes.text')).toBe('notes.text')
    expect(toSuggestedTxtName('Notes.TEXT')).toBe('Notes.TEXT')
  })

  it('reduces a Dropbox path to its basename', () => {
    expect(toSuggestedTxtName('/Notes/foo.txt')).toBe('foo.txt')
    expect(toSuggestedTxtName('/foo.txt')).toBe('foo.txt')
  })

  it('reduces a Windows path to its basename', () => {
    expect(toSuggestedTxtName('C:\\Users\\username\\Documents\\note.txt')).toBe('note.txt')
  })

  it('appends .txt when the extension is missing', () => {
    expect(toSuggestedTxtName('notes')).toBe('notes.txt')
    expect(toSuggestedTxtName('notes.enote')).toBe('notes.enote.txt')
  })

  it('strips filesystem-unsafe characters', () => {
    expect(toSuggestedTxtName('a<b>c:d"e|f?g*h.txt')).toBe('abcdefgh.txt')
  })

  it('falls back when nothing usable remains after sanitization', () => {
    expect(toSuggestedTxtName('/Notes/')).toBe(DEFAULT_EXPORT_FILE_NAME)
    expect(toSuggestedTxtName('???.txt'.replace('.txt', ''))).toBe(DEFAULT_EXPORT_FILE_NAME)
    expect(toSuggestedTxtName('.txt')).toBe(DEFAULT_EXPORT_FILE_NAME)
    expect(toSuggestedTxtName('.text')).toBe(DEFAULT_EXPORT_FILE_NAME)
    expect(toSuggestedTxtName('".TXT"')).toBe(DEFAULT_EXPORT_FILE_NAME)
  })
})
