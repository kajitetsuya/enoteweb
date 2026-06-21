import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { headersFileContent, metaCsp } from '../csp.config'

// The expectations import the SAME canonical directive list (csp.config.ts)
// the build derives the meta tag and `_headers` from, and assert EXACT
// equality — containment checks let an extra or reordered directive drift
// through unnoticed (SPEC §16: one canonical list).

test('production build includes the content security policy', async ({ page }) => {
  await page.goto('/')

  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content')

  expect(csp).toBe(metaCsp)
  expect(csp).not.toContain('frame-ancestors')
})

test('built index.html contains the expected production CSP meta tag', () => {
  const html = readFileSync(resolve(process.cwd(), 'dist/index.html'), 'utf8')
  const csp = html.match(
    /<meta http-equiv="Content-Security-Policy" content="([^"]+)" \/>/,
  )?.[1]

  expect(csp).toBe(metaCsp)
  expect(csp).not.toContain('frame-ancestors')
})

test('production build includes a stricter static-host CSP header fallback', () => {
  const headers = readFileSync(resolve(process.cwd(), 'dist/_headers'), 'utf8')

  expect(headers).toBe(headersFileContent)
  expect(headers).toContain("frame-ancestors 'none'")
})

test('source index.html keeps dev mode CSP-free', () => {
  const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')

  expect(html).not.toContain('Content-Security-Policy')
})

test('production app does not request remote resources before Dropbox is linked', async ({ page }) => {
  const externalRequests: string[] = []

  page.on('request', (request) => {
    const url = new URL(request.url())

    if (url.origin !== 'http://127.0.0.1:4173') {
      externalRequests.push(request.url())
    }
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'eNoteWeb' })).toBeVisible()
  await page.waitForLoadState('networkidle')

  expect(externalRequests).toEqual([])
})
