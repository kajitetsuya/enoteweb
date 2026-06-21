import { defineConfig, devices } from '@playwright/test'

// Deploy base under test (SPEC §14). Default '/' exercises the domain-root build;
// set BASE_PATH=/enoteweb/ to build+preview+navigate under a subpath, which is the
// real acceptance gate for the offline/update flow on a project Pages site. The
// same value drives the build (vite.config.ts); specs read it back via E2E_BASE
// to form base-relative shell URLs. Normalized to always start and end with '/'.
const normalizeBase = (raw: string | undefined): string => {
  if (!raw || raw === '/') {
    return '/'
  }
  const withLeading = raw.startsWith('/') ? raw : `/${raw}`
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`
}
const base = normalizeBase(process.env.BASE_PATH)
process.env.E2E_BASE = base

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  webServer: {
    // Default root run keeps using `vite preview` (unchanged). For a SUBPATH run,
    // vite preview cannot emulate a project-Pages host — it serves dist root files
    // (sw.js, version.json, icons) at the domain root, not under the base — so a
    // faithful static server mounts the whole dist/ under the base instead, exactly
    // like GitHub Pages serving https://user.github.io/<repo>/ (SPEC §14).
    command:
      base === '/'
        ? 'npm run preview -- --host 127.0.0.1'
        : 'node e2e/static-base-server.mjs',
    url: `http://127.0.0.1:4173${base}`,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    // baseURL carries the deploy base so a spec's page.goto(BASE) lands on the app
    // shell under the subpath. In-page fetches use the absolute BASE path directly
    // (see e2e specs), since fetch() resolves against the document, not baseURL.
    baseURL: `http://127.0.0.1:4173${base}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
