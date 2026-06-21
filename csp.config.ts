// THE canonical Content-Security-Policy directive list (SPEC §16): the CSP
// meta tag injected into index.html at build, the static-host `_headers` file
// emitted into dist, and the e2e assertions all derive from this module, so
// the three can never drift. Edit policy here and only here.

export const metaCspDirectives = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self' https://api.dropboxapi.com https://content.dropboxapi.com",
  "font-src 'self'",
  "form-action 'none'",
  "frame-src 'none'",
  "img-src 'self' data:",
  "manifest-src 'self'",
  "media-src 'none'",
  "object-src 'none'",
  // libsodium-wrappers-sumo embeds its WASM as Base64 in the JS bundle and
  // instantiates it via WebAssembly.instantiate(<ArrayBuffer>) (compile-from-
  // buffer, not instantiateStreaming), which requires 'wasm-unsafe-eval'.
  "script-src 'self' 'wasm-unsafe-eval'",
  // React and CodeMirror currently use inline style attributes/runtime styles.
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self'",
]

// Directives a <meta> CSP cannot express (ignored there per spec); the
// response-header copy in `_headers` carries them in addition.
export const headerOnlyCspDirectives = ["frame-ancestors 'none'"]

export const metaCsp = metaCspDirectives.join('; ')

export const headerCsp = [...metaCspDirectives, ...headerOnlyCspDirectives].join('; ')

// Full `_headers` file content for static hosts that honor it (Cloudflare
// Pages; ignored elsewhere). Emitted into dist at build.
export const headersFileContent = `/*\n  Content-Security-Policy: ${headerCsp}\n`
