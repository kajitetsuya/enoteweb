import { expect, test } from '@playwright/test'
import { BASE, basePath } from './base'

// SPEC Section 14 / 17: the app must not phone home for a version manifest on
// its own. version.json is fetched only when the user invokes "Check for
// updates" from the locked/home screen.
test('does not request version.json on launch', async ({ page }) => {
  const versionRequests: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === basePath('version.json')) {
      versionRequests.push(request.url())
    }
  })

  await page.goto(BASE)
  await expect(page.getByRole('heading', { name: 'eNoteWeb' })).toBeVisible()
  await page.waitForTimeout(1_000)

  expect(versionRequests).toHaveLength(0)
})

test('shows the embedded build version and an up-to-date result against the served manifest', async ({
  page,
}) => {
  await page.goto(BASE)
  await expect(page.getByRole('heading', { name: 'eNoteWeb' })).toBeVisible()

  const manifest = await page.evaluate(async (versionUrl) => {
    const response = await fetch(versionUrl, { cache: 'no-store' })
    return (await response.json()) as { version: string; builtAt: string }
  }, basePath('version.json'))

  await page.getByRole('button', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()

  // The read-only build identifier is shown for provenance and matches the
  // published manifest version.
  await expect(dialog.getByText(manifest.version, { exact: false })).toBeVisible()

  // The running build is the one that was just published, so the on-demand
  // check reports up to date.
  await dialog.getByRole('button', { name: 'Check for updates' }).click()
  await expect(page.getByRole('dialog', { name: 'Up to date' })).toBeVisible()
})

test('offers an update for a newer manifest and Cancel leaves the running build unchanged', async ({
  page,
}) => {
  // context.route (not page.route) so the mock also covers the fetch the service
  // worker makes for /version.json.
  await page.context().route('**/version.json', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ version: 'future.test', builtAt: '2099-01-01T00:00:00.000Z' }),
    }),
  )

  await page.goto(BASE)
  await expect(page.getByRole('heading', { name: 'eNoteWeb' })).toBeVisible()

  await page.getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Check for updates' }).click()

  const updateDialog = page.getByRole('dialog', { name: 'Update available' })
  await expect(updateDialog).toBeVisible()
  await expect(updateDialog.getByText('future.test', { exact: false })).toBeVisible()

  // Cancel must not activate anything. Starting the check closes the home
  // Settings dialog (so only one modal is ever mounted), so reopen Settings and
  // confirm the build shown is still the real running build, not "future".
  await updateDialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(updateDialog).toBeHidden()
  await page.getByRole('button', { name: 'Settings' }).click()
  const settingsAfterCancel = page.getByRole('dialog', { name: 'Settings' })
  await expect(settingsAfterCancel.locator('.build-version')).not.toContainText('future.test')
})

test('shows "could not check" for a missing manifest', async ({ page }) => {
  await page.goto(BASE)
  await expect(page.getByRole('heading', { name: 'eNoteWeb' })).toBeVisible()

  // Route only after first load so the app shell still installs normally.
  // context.route also covers the service worker's fetch for /version.json.
  await page
    .context()
    .route('**/version.json', (route) => route.fulfill({ status: 404, body: 'Not found' }))

  await page.getByRole('button', { name: 'Settings' }).click()
  await page
    .getByRole('dialog', { name: 'Settings' })
    .getByRole('button', { name: 'Check for updates' })
    .click()

  await expect(page.getByRole('dialog', { name: 'Could not check for updates' })).toBeVisible()
})

// The failure mode behind the unclosable modal: a request that never responds
// (stalled origin), not a fast 404. The client timeout must convert it to the
// error dialog rather than leaving "Checking…" stuck open.
test('a stalled manifest fetch ends in "could not check" instead of hanging', async ({ page }) => {
  test.setTimeout(30_000)
  await page.goto(BASE)
  await expect(page.getByRole('heading', { name: 'eNoteWeb' })).toBeVisible()

  // Take the route over but never respond, so the browser fetch stays pending.
  await page.context().route('**/version.json', () => {
    /* intentionally never fulfilled */
  })

  await page.getByRole('button', { name: 'Settings' }).click()
  await page
    .getByRole('dialog', { name: 'Settings' })
    .getByRole('button', { name: 'Check for updates' })
    .click()

  // It shows "Checking…" first, then the ~8s timeout flips it to the error.
  await expect(page.getByRole('dialog', { name: 'Checking for updates' })).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Could not check for updates' })).toBeVisible({
    timeout: 15_000,
  })
})

// Cancel must escape immediately and stay escaped: the aborted check resolves to
// an error, but that late result must not reopen the modal.
test('Cancel during a stalled check closes the dialog and nothing reopens it', async ({ page }) => {
  test.setTimeout(30_000)
  await page.goto(BASE)
  await expect(page.getByRole('heading', { name: 'eNoteWeb' })).toBeVisible()

  await page.context().route('**/version.json', () => {
    /* intentionally never fulfilled */
  })

  await page.getByRole('button', { name: 'Settings' }).click()
  await page
    .getByRole('dialog', { name: 'Settings' })
    .getByRole('button', { name: 'Check for updates' })
    .click()

  const checking = page.getByRole('dialog', { name: 'Checking for updates' })
  await expect(checking).toBeVisible()
  await checking.getByRole('button', { name: 'Cancel' }).click()
  await expect(checking).toBeHidden()

  // Past the timeout window: neither the error nor the checking dialog returns.
  await page.waitForTimeout(10_000)
  await expect(page.getByRole('dialog', { name: 'Could not check for updates' })).toBeHidden()
  await expect(checking).toBeHidden()
})
