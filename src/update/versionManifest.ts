// Pure helpers for the user-initiated update check (SPEC Section 14).
//
// `version.json` is a tiny, non-sensitive manifest served from the app's own
// origin next to `index.html`: { "version": "<id>", "builtAt": "<iso8601>" }.
// These functions are side-effect free so the update decision can be unit
// tested without a service worker or network.

export type VersionManifest = {
  version: string
  builtAt: string
}

// Strict ISO-8601 UTC, e.g. 2026-06-03T15:14:34.604Z. A malformed builtAt must
// make the manifest invalid (→ "could not check") rather than sort above a real
// date and produce a phantom "update available".
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

const isValidBuiltAt = (value: string): boolean =>
  ISO_UTC.test(value) && !Number.isNaN(Date.parse(value))

// Parse and validate a fetched manifest body. Returns null for anything that is
// not a well-formed manifest (so a malformed/404 body becomes a "could not
// check" outcome rather than a false "up to date" or "update available").
export const parseVersionManifest = (raw: unknown): VersionManifest | null => {
  let value: unknown = raw

  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return null
    }
  }

  if (typeof value !== 'object' || value === null) {
    return null
  }

  const candidate = value as Record<string, unknown>

  if (typeof candidate.version !== 'string' || candidate.version.length === 0) {
    return null
  }

  if (typeof candidate.builtAt !== 'string' || !isValidBuiltAt(candidate.builtAt)) {
    return null
  }

  return { version: candidate.version, builtAt: candidate.builtAt }
}

// Decide whether a published manifest represents a build newer than the one the
// app is currently running. Build identifiers are not ordered, so the published
// build time is the authority: a strictly later `builtAt` (ISO-8601 UTC, which
// sorts lexicographically) is newer. When timestamps tie we fall back to a
// version-string difference, so a republish at the same instant still surfaces.
export const isManifestNewer = (
  running: { version: string; builtAt: string },
  published: VersionManifest,
): boolean => {
  const publishedTime = Date.parse(published.builtAt)
  const runningTime = Date.parse(running.builtAt)

  // If the running build's timestamp is unknown/unparseable (e.g. a dev build),
  // fall back to treating any version difference as newer.
  if (Number.isNaN(runningTime) || Number.isNaN(publishedTime)) {
    return published.version !== running.version
  }

  if (publishedTime > runningTime) {
    return true
  }

  if (publishedTime < runningTime) {
    return false
  }

  return published.version !== running.version
}
