import { expect, test } from '@playwright/test'
export { expect, test }

export const dumpVaultRecords = () =>
  new Promise<unknown[]>((resolve, reject) => {
    const openRequest = indexedDB.open('enoteweb')

    openRequest.onerror = () => reject(openRequest.error)
    openRequest.onsuccess = () => {
      const db = openRequest.result
      const transaction = db.transaction('vault', 'readonly')
      const getAllRequest = transaction.objectStore('vault').getAll()

      getAllRequest.onerror = () => reject(getAllRequest.error)
      getAllRequest.onsuccess = () => resolve(getAllRequest.result)
    }
  })

export const forceBrowserVaultMode = () => {
  const testGlobal = globalThis as typeof globalThis & {
    __ENOTEWEB_TEST_BROWSER_VAULT__?: boolean
  }

  testGlobal.__ENOTEWEB_TEST_BROWSER_VAULT__ = true
  Object.defineProperty(globalThis, 'showOpenFilePicker', {
    value: undefined,
    configurable: true,
  })
  Object.defineProperty(globalThis, 'showSaveFilePicker', {
    value: undefined,
    configurable: true,
  })
}

// No on-screen password form: creation runs through the New draft
// two-field dialog, unlock through the Edit draft single-field dialog.
export const createDraftThroughDialog = async (
  page: import('@playwright/test').Page,
  password: string,
) => {
  await page.getByRole('button', { name: 'New draft' }).click()

  const dialog = page.getByRole('dialog').filter({ hasText: 'Set a password for the new draft' })

  await dialog.getByLabel('Password', { exact: true }).fill(password)
  await dialog.getByLabel('Confirm password').fill(password)
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByTestId('editor')).toBeVisible({ timeout: 30_000 })
}

export const unlockDraftThroughDialog = async (
  page: import('@playwright/test').Page,
  password: string,
) => {
  await page.getByRole('button', { name: 'Edit draft' }).click()

  const dialog = page.getByRole('dialog').filter({ hasText: 'Unlock draft' })

  await dialog.getByLabel('Password', { exact: true }).fill(password)
  await dialog.getByRole('button', { name: 'Unlock' }).click()
}

// ── Scroll confinement (page lock + inner scrollers) ────────────────────────
// The document is pinned to the viewport while the editor is mounted, so only
// the inner scrollers move: the CodeMirror scroller (vertical + wrap-off
// horizontal) and the toolbar action row (horizontal). These tests separate the
// concerns: page lock, editor vertical scroll, editor horizontal scroll, and
// toolbar horizontal scroll. The iOS keyboard / landscape-panning case is
// on-device QA (VisualViewport) and is intentionally not asserted here.
export const EDITOR_PASSWORD = 'correct horse battery staple'

export const openUnlockedEditor = async (
  page: import('@playwright/test').Page,
  width: number,
  height: number,
) => {
  await page.setViewportSize({ width, height })
  await page.addInitScript(forceBrowserVaultMode)
  await page.goto('/')
  await createDraftThroughDialog(page, EDITOR_PASSWORD)
}

export const insertEditorText = async (page: import('@playwright/test').Page, text: string) => {
  await page.locator('.cm-content').click()
  await page.keyboard.insertText(text)
}

// Markdown is no longer the default editor mode (the default is now plain), so
// preview-dependent tests opt into it explicitly through Settings.
export const enableMarkdownMode = async (page: import('@playwright/test').Page) => {
  await page.getByRole('button', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByLabel('Editor mode').selectOption('markdown')
  await dialog.getByRole('button', { name: 'Close' }).click()
}

export const manyLines = Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n')

// Markdown of N sections, each 6 source lines: heading, blank, a 3-line paragraph,
// blank. Section i's heading is at line (i-1)*6 + 1; its paragraph starts at +2.
export const markdownSections = (count: number) =>
  Array.from({ length: count }, (_, index) => {
    const n = index + 1
    return `# Section ${n}\n\nBody ${n} line one\nBody ${n} line two\nBody ${n} line three\n`
  }).join('\n')

// 1-based source line at the top of the editor viewport, read from the gutter.
export const editorTopLine = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const scroller = document.querySelector('.cm-scroller')
    if (!scroller) return 0
    const top = scroller.getBoundingClientRect().top
    for (const element of Array.from(
      document.querySelectorAll('.cm-lineNumbers .cm-gutterElement'),
    )) {
      const text = element.textContent?.trim() ?? ''
      if (/^\d+$/.test(text) && element.getBoundingClientRect().bottom > top + 1) {
        return Number.parseInt(text, 10)
      }
    }
    return 0
  })

// Source line of the anchored block currently at the top of the preview.
export const previewTopLine = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const root = document.querySelector('.markdown-preview')
    if (!root) return null
    const key = root.getAttribute('data-enote-render-key') ?? ''
    const top =
      root.getBoundingClientRect().top + (Number.parseFloat(getComputedStyle(root).paddingTop) || 0)
    const anchors = Array.from(
      root.querySelectorAll(`[data-enote-source-line][data-enote-render-key="${key}"]`),
    )
    let chosen: Element | null = null
    for (const anchor of anchors) {
      if (anchor.getBoundingClientRect().top <= top + 4) chosen = anchor
      else break
    }
    return chosen ? Number.parseInt(chosen.getAttribute('data-enote-source-line') ?? '', 10) : null
  })

export const previewAnchorLines = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const root = document.querySelector('.markdown-preview')
    if (!root) return [] as number[]
    const key = root.getAttribute('data-enote-render-key') ?? ''
    return Array.from(
      root.querySelectorAll(`[data-enote-source-line][data-enote-render-key="${key}"]`),
    )
      .map((anchor) => Number.parseInt(anchor.getAttribute('data-enote-source-line') ?? '', 10))
      .sort((a, b) => a - b)
  })

// Scrolls the preview so the block anchored at `line` sits at its content top.
export const scrollPreviewToLine = (page: import('@playwright/test').Page, line: number) =>
  page.evaluate((targetLine) => {
    const root = document.querySelector('.markdown-preview')
    if (!root) return
    const key = root.getAttribute('data-enote-render-key') ?? ''
    const element = root.querySelector(
      `[data-enote-source-line="${targetLine}"][data-enote-render-key="${key}"]`,
    )
    if (!element) return
    const top =
      root.getBoundingClientRect().top + (Number.parseFloat(getComputedStyle(root).paddingTop) || 0)
    root.scrollTop += element.getBoundingClientRect().top - top
  }, line)

// Nearest preceding anchor: the greatest anchored line <= `line` (block-anchor
// semantics — the block that contains the queried line).
export const nearestAnchorAtOrBefore = (lines: number[], line: number) =>
  Math.max(...lines.filter((candidate) => candidate <= line))
