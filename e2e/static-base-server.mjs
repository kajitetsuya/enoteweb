// Faithful subpath static host for the e2e harness (SPEC §14).
//
// vite preview applies `base` only to the HTML shell and hashed assets; it serves
// dist root files (sw.js, version.json, public/* icons) at the domain root, so it
// cannot emulate a GitHub *project* Pages deploy where the ENTIRE dist/ is mounted
// under the base (e.g. https://user.github.io/enoteweb/). This tiny server mounts
// dist/ at E2E_BASE exactly like such a host: every file resolves under the base,
// with an index.html SPA fallback for unknown sub-paths. Used only when E2E_BASE
// is a real subpath; the default '/' run keeps using `vite preview`.
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, normalize, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const distDir = fileURLToPath(new URL('../dist/', import.meta.url))
const base = process.env.E2E_BASE ?? '/'
const port = Number(process.env.E2E_PORT ?? '4173')

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
}

const sendFile = async (res, filePath, status = 200) => {
  const body = await readFile(filePath)
  res.writeHead(status, { 'content-type': TYPES[extname(filePath)] ?? 'application/octet-stream' })
  res.end(body)
}

// A request is a navigation (top-level document load) when the browser sends
// `sec-fetch-mode: navigate`; for older clients we fall back to the `accept`
// header advertising HTML. Asset/fetch/API requests (`no-cors`/`cors`/`*/*`)
// are NOT navigations and must 404 when their target is missing.
const isNavigation = (req) => {
  const mode = req.headers['sec-fetch-mode']
  if (mode) return mode === 'navigate'
  const accept = req.headers['accept'] ?? ''
  return accept.includes('text/html')
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost')

  // Out-of-base requests 404 like a real GitHub *project* Pages host: it serves
  // the app only under its subpath, never at the domain root. We deliberately do
  // NOT redirect to the base, so a root-absolute regression (e.g. an unbased
  // `/sw.js`, `/version.json`, or `/icon.svg`) fails the e2e instead of being
  // masked. No spec navigates to the bare root, so this breaks nothing real.
  if (base !== '/' && !pathname.startsWith(base)) {
    res.writeHead(404)
    res.end('Not Found')
    return
  }

  const relative = pathname.slice(base.length) || ''
  const candidate = normalize(join(distDir, relative))
  if (!candidate.startsWith(normalize(distDir))) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }

  try {
    const info = await stat(candidate)
    if (info.isDirectory()) {
      // A directory (notably the base itself, e.g. `/enoteweb/`) serves its shell.
      await sendFile(res, join(candidate, 'index.html'))
      return
    }
    await sendFile(res, candidate)
  } catch {
    // Missing in-base file: only a *navigation* falls back to the SPA shell, as a
    // real static host would. A missing/wrong asset request (e.g. a stale hashed
    // `/enoteweb/assets/wrong.js`) must 404 — not be masked with index.html — so a
    // wrong-asset regression fails the e2e.
    if (isNavigation(req)) {
      await sendFile(res, join(distDir, 'index.html'))
    } else {
      res.writeHead(404)
      res.end('Not Found')
    }
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`static-base-server: dist mounted at http://127.0.0.1:${port}${base}`)
})
