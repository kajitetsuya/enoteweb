import { expect, test } from '@playwright/test'

// Forces Browser Vault mode by removing the File System Access pickers so the
// editor opens without a real file handle (mirrors the editor e2e helper).
const forceBrowserVaultMode = () => {
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

const unlockNewVault = async (page: import('@playwright/test').Page) => {
  await page.addInitScript(forceBrowserVaultMode)
  await page.goto('/')

  // Home: creation runs through the New draft two-field dialog.
  await page.getByRole('button', { name: 'New draft' }).click()

  const dialog = page.getByRole('dialog').filter({ hasText: 'Set a password for the new draft' })

  await dialog.getByLabel('Password', { exact: true }).fill('correct horse battery staple')
  await dialog.getByLabel('Confirm password').fill('correct horse battery staple')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByTestId('editor')).toBeVisible({ timeout: 30_000 })
}

// Plain is the default editor mode, so the preview toggle only appears after
// switching to markdown via Settings.
const enableMarkdownMode = async (page: import('@playwright/test').Page) => {
  await page.getByRole('button', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByLabel('Editor mode').selectOption('markdown')
  await dialog.getByRole('button', { name: 'Close' }).click()
}

// SPEC Section 13 / 17: the Markdown preview renders in-memory plaintext and must
// not request remote resources. The sanitizer (not the CSP) is the boundary, so
// this asserts both that no remote request is issued and that the rendered DOM
// carries no remote source.
test('Markdown preview renders content and does not request remote resources', async ({
  page,
}) => {
  test.setTimeout(60_000)

  const remoteRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('tracker.example')) {
      remoteRequests.push(request.url())
    }
  })

  await unlockNewVault(page)
  await enableMarkdownMode(page)

  const editor = page.locator('.cm-content')
  await editor.click()
  await page.keyboard.type(
    '# Preview heading\n\nSome **bold** text and a [link](https://example.com).\n\n![pixel](https://tracker.example/p.gif)\n',
  )

  // The toggle is present in markdown mode.
  await page.getByRole('button', { name: 'Preview' }).click()

  const preview = page.getByTestId('markdown-preview')
  await expect(preview).toBeVisible()

  // Markdown is rendered to safe HTML.
  await expect(preview.locator('h1')).toHaveText('Preview heading')
  await expect(preview.locator('strong')).toHaveText('bold')

  // Links are kept but severed from the opener and opened explicitly.
  const link = preview.locator('a')
  await expect(link).toHaveAttribute('href', 'https://example.com')
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer')

  // The remote image element survives but its remote src is stripped, so the
  // browser never fetches it.
  const image = preview.locator('img')
  await expect(image).toHaveCount(1)
  expect(await image.getAttribute('src')).toBeNull()

  await page.waitForTimeout(500)
  expect(remoteRequests).toEqual([])
})

test('preview toggle is hidden in plain mode and the pane closes', async ({ page }) => {
  await unlockNewVault(page)
  await enableMarkdownMode(page)

  const previewToggle = page.getByRole('button', { name: 'Preview' })
  await previewToggle.click()
  await expect(page.getByTestId('markdown-preview')).toBeVisible()

  // Switch to plain mode: the toggle disappears and the pane is removed.
  await page.getByRole('button', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByLabel('Editor mode').selectOption('plain')
  await dialog.getByRole('button', { name: 'Close' }).click()

  await expect(previewToggle).toBeHidden()
  await expect(page.getByTestId('markdown-preview')).toBeHidden()
})
