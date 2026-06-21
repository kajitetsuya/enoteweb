// Build provenance, injected at compile time by Vite `define` (see vite.config.ts).
// These are non-sensitive identifiers (git short hash + build timestamp) surfaced
// read-only in the Settings dialogs and written to `version.json` for the
// user-initiated update check (SPEC Section 14). They carry no plaintext, key,
// token, or document data.

declare const __ENOTEWEB_BUILD_VERSION__: string
declare const __ENOTEWEB_BUILT_AT__: string

export const BUILD_VERSION: string =
  typeof __ENOTEWEB_BUILD_VERSION__ === 'string' ? __ENOTEWEB_BUILD_VERSION__ : 'dev'

export const BUILT_AT: string =
  typeof __ENOTEWEB_BUILT_AT__ === 'string' ? __ENOTEWEB_BUILT_AT__ : ''

// A compact human-readable label for the Settings dialogs, e.g.
// "a1b2c3d.20260603T101530Z (2026-06-03 10:15 UTC)".
export const buildLabel = (): string => {
  if (!BUILT_AT) {
    return BUILD_VERSION
  }

  // Trim the ISO timestamp to minute precision for display; keep the full
  // identifier as the primary token so it can be matched to a source commit.
  const readable = BUILT_AT.replace('T', ' ').replace(/:\d\d\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC')
  return `${BUILD_VERSION} (${readable})`
}
