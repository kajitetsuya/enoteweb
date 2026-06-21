import { expect, test } from '@playwright/test'
import { BASE, basePath } from './base'

test('loads the app shell offline after first load', async ({ context, page }) => {
  await page.goto(BASE)
  await expect(page.getByRole('heading', { name: 'eNoteWeb' })).toBeVisible()

  const precacheUrls = await page.evaluate(async (swUrl) => {
    const serviceWorker = await fetch(swUrl, { cache: 'no-store' }).then((response) =>
      response.text(),
    )
    const match = /const PRECACHE_URLS = (\[[\s\S]*?\])/.exec(serviceWorker)

    if (!match?.[1]) {
      throw new Error('Service worker precache manifest was not found.')
    }

    return JSON.parse(match[1]) as string[]
  }, basePath('sw.js'))

  // Under a subpath build every precache entry carries the deploy base, including
  // the app-shell entry (BASE itself, not '/') — SPEC §14.
  expect(precacheUrls).toContain(BASE)
  expect(precacheUrls).toContain(basePath('index.html'))
  expect(precacheUrls).toContain(basePath('manifest.webmanifest'))
  expect(precacheUrls).toContain(basePath('icon.svg'))
  const assets = `${BASE}assets/`
  expect(precacheUrls.some((url) => url.startsWith(assets) && /index-.*\.js$/.test(url))).toBe(true)
  expect(precacheUrls.some((url) => url.startsWith(assets) && /index-.*\.css$/.test(url))).toBe(true)
  expect(
    precacheUrls.some((url) => url.startsWith(assets) && /searchWorker-.*\.js$/.test(url)),
  ).toBe(true)

  await page.waitForFunction(
    () => window.__ENOTEWEB_SW_READY_STATE__ === 'ready' && navigator.serviceWorker.controller,
  )
  await page.waitForFunction(async (expectedPaths) => {
    const cachedPaths = new Set<string>()

    for (const cacheName of await caches.keys()) {
      const cache = await caches.open(cacheName)

      for (const request of await cache.keys()) {
        cachedPaths.add(new URL(request.url).pathname)
      }
    }

    return expectedPaths.every((path) => cachedPaths.has(path))
  }, precacheUrls)

  await context.setOffline(true)
  await page.goto(BASE)

  await expect(page.getByRole('heading', { name: 'eNoteWeb' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'New' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Browse' })).toBeVisible()
})
