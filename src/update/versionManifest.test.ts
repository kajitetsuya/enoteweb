import { describe, expect, it } from 'vitest'
import { isManifestNewer, parseVersionManifest } from './versionManifest'

describe('parseVersionManifest', () => {
  it('parses a well-formed manifest from a JSON string', () => {
    expect(parseVersionManifest('{"version":"abc.1","builtAt":"2026-06-03T10:00:00Z"}')).toEqual({
      version: 'abc.1',
      builtAt: '2026-06-03T10:00:00Z',
    })
  })

  it('parses an already-parsed object', () => {
    expect(parseVersionManifest({ version: 'abc.1', builtAt: '2026-06-03T10:00:00Z' })).toEqual({
      version: 'abc.1',
      builtAt: '2026-06-03T10:00:00Z',
    })
  })

  it('rejects invalid JSON', () => {
    expect(parseVersionManifest('{not json')).toBeNull()
  })

  it('rejects a non-object body', () => {
    expect(parseVersionManifest('42')).toBeNull()
    expect(parseVersionManifest('null')).toBeNull()
    expect(parseVersionManifest('"abc"')).toBeNull()
  })

  it('rejects a manifest missing required fields', () => {
    expect(parseVersionManifest('{"version":"abc.1"}')).toBeNull()
    expect(parseVersionManifest('{"builtAt":"2026-06-03T10:00:00Z"}')).toBeNull()
    expect(parseVersionManifest('{"version":"","builtAt":"2026-06-03T10:00:00Z"}')).toBeNull()
    expect(parseVersionManifest('{"version":"abc.1","builtAt":""}')).toBeNull()
  })

  it('rejects fields of the wrong type', () => {
    expect(parseVersionManifest('{"version":1,"builtAt":"2026-06-03T10:00:00Z"}')).toBeNull()
  })

  it('rejects a non-ISO-UTC builtAt (so a malformed manifest is "could not check")', () => {
    expect(parseVersionManifest('{"version":"abc.1","builtAt":"zzz"}')).toBeNull()
    expect(parseVersionManifest('{"version":"abc.1","builtAt":"2026-06-03"}')).toBeNull()
    expect(parseVersionManifest('{"version":"abc.1","builtAt":"2026-06-03T10:00:00"}')).toBeNull()
    expect(parseVersionManifest('{"version":"abc.1","builtAt":"2026-13-03T10:00:00Z"}')).toBeNull()
  })

  it('accepts ISO-UTC builtAt with and without milliseconds', () => {
    expect(parseVersionManifest('{"version":"abc.1","builtAt":"2026-06-03T10:00:00.604Z"}')).toEqual(
      { version: 'abc.1', builtAt: '2026-06-03T10:00:00.604Z' },
    )
  })
})

describe('isManifestNewer', () => {
  const running = { version: 'old.1', builtAt: '2026-06-03T10:00:00Z' }

  it('is newer when builtAt is strictly later', () => {
    expect(isManifestNewer(running, { version: 'new.1', builtAt: '2026-06-03T11:00:00Z' })).toBe(
      true,
    )
  })

  it('is not newer when builtAt is earlier', () => {
    expect(isManifestNewer(running, { version: 'new.1', builtAt: '2026-06-03T09:00:00Z' })).toBe(
      false,
    )
  })

  it('is not newer when builtAt and version are identical', () => {
    expect(isManifestNewer(running, { version: 'old.1', builtAt: '2026-06-03T10:00:00Z' })).toBe(
      false,
    )
  })

  it('treats a same-instant republish with a different version as newer', () => {
    expect(isManifestNewer(running, { version: 'old.2', builtAt: '2026-06-03T10:00:00Z' })).toBe(
      true,
    )
  })

  it('falls back to a version difference when the running build has no parseable timestamp', () => {
    const devRunning = { version: 'dev', builtAt: '' }
    expect(isManifestNewer(devRunning, { version: 'old.1', builtAt: '2026-06-03T10:00:00Z' })).toBe(
      true,
    )
    expect(isManifestNewer(devRunning, { version: 'dev', builtAt: '2026-06-03T10:00:00Z' })).toBe(
      false,
    )
  })
})
