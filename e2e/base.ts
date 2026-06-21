// Deploy base under test (SPEC §14). playwright.config.ts normalizes BASE_PATH
// and re-exports it as E2E_BASE so the specs can form base-relative shell URLs
// (sw.js, version.json, the precache entries) that match a subpath build. Default
// '/' keeps the domain-root build's URLs unchanged.
export const BASE = process.env.E2E_BASE ?? '/'

// Absolute path under the deploy base, e.g. basePath('sw.js') -> '/enoteweb/sw.js'
// (or '/sw.js' at the default base). Used for in-page fetches and precache
// assertions, where leading-slash paths would escape the base back to the root.
export const basePath = (relative = ''): string => `${BASE}${relative}`
