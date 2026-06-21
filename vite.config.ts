import { execSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import type { Plugin, ResolvedConfig } from 'vite'
import { headersFileContent, metaCsp } from './csp.config'

// Build provenance embedded in the app bundle, the service worker, and
// `version.json` (SPEC Section 14). Computed once per invocation so all three
// copies are guaranteed identical. Non-sensitive: a git short hash plus a build
// timestamp, unique per build so two builds at the same commit still differ.
const builtAt = new Date().toISOString()
const gitShortHash = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return 'nogit'
  }
})()
// Keep milliseconds: two builds at the same commit within the same second must
// not collide, or a staged build would reuse the pinned build's asset-cache name
// and overwrite it, defeating version-pinned isolation.
const compactStamp = builtAt.replace(/[-:.]/g, '')
const buildVersion = `${gitShortHash}.${compactStamp}`

// The directive list lives in csp.config.ts — the single canonical source
// shared with the emitted `_headers` file and the e2e assertions (SPEC §16).
const contentSecurityPolicy = metaCsp

// Deployed base path (SPEC §14 "App base path"). Default `/` keeps a domain-root
// or custom-domain deploy unchanged; a GitHub *project* Pages site serves from a
// subpath and sets `BASE_PATH` (e.g. `/enoteweb/`). Normalized so it always
// starts and ends with `/`, which is what Vite's `base` and the service-worker
// scope both expect. Baked into the bundle at build time, so each deployment base
// needs its own build (the registration scope must match this `base`).
const normalizeBase = (raw: string | undefined): string => {
  if (!raw || raw === '/') {
    return '/'
  }
  const withLeading = raw.startsWith('/') ? raw : `/${raw}`
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`
}
const base = normalizeBase(process.env.BASE_PATH)

const cspMetaPlugin = {
  name: 'enoteweb-csp-meta',
  transformIndexHtml(html: string) {
    const anchor = '<meta name="viewport"'

    // Fail the build rather than silently shipping without a CSP: on GitHub
    // Pages the meta tag is the only enforced policy (no response headers), so
    // a missed anchor must be a build error, mirroring the SW plugin's
    // placeholder checks.
    if (!html.includes(anchor)) {
      throw new Error('CSP injection anchor (<meta name="viewport") was not found in index.html.')
    }

    return html.replace(
      anchor,
      `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}" />\n    ${anchor}`,
    )
  },
}

const PRECACHE_MANIFEST_PLACEHOLDER = '/* __ENOTEWEB_PRECACHE_URLS__ */'
const BUILD_VERSION_PLACEHOLDER = "'__ENOTEWEB_BUILD_VERSION__'"

const listFiles = (directory: string, root = directory): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(directory, entry.name)

    if (entry.isDirectory()) {
      return listFiles(fullPath, root)
    }

    if (!entry.isFile()) {
      return []
    }

    return [`/${relative(root, fullPath).replaceAll('\\', '/')}`]
  })

// Files in dist that are not app-shell assets and must not be precached:
// version.json is always fetched from the network; _headers is a host
// configuration file (404s on hosts that don't recognize it — e.g.
// Jekyll-default GitHub Pages — and a single failed fetch fails the whole
// cache.addAll, killing SW install); sw.js is the worker script itself,
// fetched and cached by the browser's own SW machinery.
const PRECACHE_EXCLUDED_URLS = new Set(['/version.json', '/_headers', '/sw.js'])

// `base` is the normalized deploy base ('/' or '/sub/'). Every emitted file is
// listed root-relative (e.g. '/index.html'); the precache must store each under
// the deploy base so a subpath build precaches `${base}index.html`,
// `${base}assets/…`, and the app-shell entry `${base}` itself (SPEC §14). At the
// default base '/' this is a no-op and the entries stay root-absolute.
const buildPrecacheUrls = (distDir: string, base: string) => {
  const emittedFiles = listFiles(distDir).filter((url) => !PRECACHE_EXCLUDED_URLS.has(url))
  const urls = emittedFiles.includes('/index.html') ? ['/', ...emittedFiles] : emittedFiles

  const sorted = Array.from(new Set(urls)).sort((first, second) => {
    if (first === '/') {
      return -1
    }

    if (second === '/') {
      return 1
    }

    return first.localeCompare(second)
  })

  // `base` ends in '/', so dropping the leading '/' from each root-relative URL
  // yields `${base}index.html` etc.; the shell entry '/' maps to `base` itself.
  return sorted.map((url) => (url === '/' ? base : `${base}${url.slice(1)}`))
}

const precacheServiceWorkerPlugin = (): Plugin => {
  let resolvedConfig: ResolvedConfig

  return {
    name: 'enoteweb-precache-service-worker',
    apply: 'build',
    configResolved(config) {
      resolvedConfig = config
    },
    closeBundle() {
      const outDir = resolvedConfig.build.outDir
      const distDir = isAbsolute(outDir) ? outDir : resolve(resolvedConfig.root, outDir)
      const serviceWorkerPath = join(distDir, 'sw.js')
      const precacheUrls = buildPrecacheUrls(distDir, resolvedConfig.base)
      const precacheManifest = precacheUrls.map((url) => JSON.stringify(url)).join(',\n  ')
      const serviceWorker = readFileSync(serviceWorkerPath, 'utf8')

      if (!serviceWorker.includes(PRECACHE_MANIFEST_PLACEHOLDER)) {
        throw new Error('Service worker precache placeholder was not found.')
      }

      if (!serviceWorker.includes(BUILD_VERSION_PLACEHOLDER)) {
        throw new Error('Service worker build-version placeholder was not found.')
      }

      writeFileSync(
        serviceWorkerPath,
        serviceWorker
          .replace(PRECACHE_MANIFEST_PLACEHOLDER, precacheManifest)
          .replace(BUILD_VERSION_PLACEHOLDER, JSON.stringify(buildVersion)),
      )

      // Emit the update manifest next to index.html (SPEC Section 14). Same
      // build identifier as the bundle and the service worker.
      writeFileSync(
        join(distDir, 'version.json'),
        `${JSON.stringify({ version: buildVersion, builtAt }, null, 2)}\n`,
      )

      // Emit the static-host CSP header file from the same canonical
      // directive list as the meta tag (csp.config.ts) — previously a
      // hand-maintained copy in public/ that could drift. Excluded from the
      // SW precache above.
      writeFileSync(join(distDir, '_headers'), headersFileContent)
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  base,
  define: {
    __ENOTEWEB_BUILD_VERSION__: JSON.stringify(buildVersion),
    __ENOTEWEB_BUILT_AT__: JSON.stringify(builtAt),
  },
  plugins: [
    react(),
    ...(command === 'build' ? [cspMetaPlugin, precacheServiceWorkerPlugin()] : []),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id) => (id.includes('libsodium') ? 'libsodium' : undefined),
      },
    },
  },
  // Local preview only (no effect on the production build): allow Cloudflare
  // quick-tunnel hostnames so `vite preview` is reachable over an HTTPS tunnel
  // for on-device testing. The leading dot matches any subdomain;
  // `preview.allowedHosts` guards only the local preview server's Host header
  // (DNS-rebinding protection) and never ships in a build.
  preview: {
    allowedHosts: ['.trycloudflare.com'],
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/vitest.setup.ts'],
    // App-level tests run real Argon2id derivations (deliberately — the crypto
    // path is part of what they exercise); under full-suite parallelism those
    // can exceed vitest's 5s default, so give every test generous headroom.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.testkit.{ts,tsx}',
        'src/test/**',
        'src/vitest.setup.ts',
        'src/buildInfo.ts',
        'src/**/*.d.ts',
      ],
      // No thresholds: this is a visibility tool, not a gate.
    },
  },
}))
