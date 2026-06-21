import {
  expect,
  test,
  dumpVaultRecords,
  forceBrowserVaultMode,
  createDraftThroughDialog,
  unlockDraftThroughDialog,
} from './editorKit'

test('edits, exports, imports, and saves as a separate encrypted file', async ({
  browser,
  page,
}) => {
  test.setTimeout(90_000)

  const oldPassword = 'correct horse battery staple'
  const marker = 'PLAINTEXT_MARKER_BROWSER_STORAGE_CHECK'
  const pagehideMarker = '_PAGEHIDE_FLUSH_CHECK'
  const undoMarker = 'UNDO_REDO_CHECK'
  const searchSource = '\nalpha 12 beta 34 alpha 56\n'
  const regexWholeWordSource = '\nthis t h\n'
  const markdownSource = '\n# Markdown heading\n\n**bold source stays source**\n'
  const scrollSource = `\n${Array.from({ length: 80 }, (_, index) => `scroll line ${index + 1}`).join('\n')}\n`

  await page.addInitScript(forceBrowserVaultMode)
  await page.goto('/')
  await createDraftThroughDialog(page, oldPassword)

  const editor = page.locator('.cm-content')

  const toolbarControlNames = await page
    .locator('.toolbar-actions > *')
    .evaluateAll((elements) =>
      elements.map((element) =>
        element.classList.contains('toolbar-separator')
          ? 'separator'
          : (element.getAttribute('aria-label') ?? element.textContent?.trim() ?? ''),
      ),
    )

  // A Dropbox-mode draft session's storage actions:
  // Save to Dropbox (the promotion) + Export to Files — no Save button; the
  // draft persists via autosave. Search sits at the far right of the row, after
  // a separator following the save-related buttons.
  expect(toolbarControlNames).toEqual([
    'Undo',
    'Redo',
    'separator',
    'Insert random string',
    'Change password',
    'separator',
    'Save to Dropbox',
    'Export to Files',
    'separator',
    'Search',
  ])
  // Home sits left of the status text; Read-only and Settings form the corner
  // group. At desktop width all three toolbar groups share one row.
  await expect(page.locator('.toolbar-status button[aria-label="Home"]')).toBeVisible()
  await expect(page.locator('.toolbar-corner button[aria-label="Read-only"]')).toBeVisible()
  await expect(page.locator('.toolbar-corner button[aria-label="Settings"]')).toBeVisible()
  const wideStatusBox = await page.locator('.toolbar-status').boundingBox()
  const wideActionsBox = await page.locator('.toolbar-actions').boundingBox()
  expect(Math.abs((wideStatusBox?.y ?? 0) - (wideActionsBox?.y ?? -99))).toBeLessThanOrEqual(20)
  const undoButton = page.getByRole('button', { name: 'Undo' })
  const redoButton = page.getByRole('button', { name: 'Redo' })
  const searchButton = page.getByRole('button', { name: 'Search' })
  const settingsButton = page.getByRole('button', { name: 'Settings' })
  const findPreviousButton = page.getByRole('button', { name: 'Find previous' })
  const findNextButton = page.getByRole('button', { name: 'Find next' })
  const replacePreviousButton = page.getByRole('button', { name: 'Replace previous' })
  const replaceNextButton = page.getByRole('button', { name: 'Replace next' })
  const replaceAllButton = page.getByRole('button', { name: 'Replace all' })
  const caseSensitiveButton = page.getByRole('button', { name: 'Case sensitive' })
  const wholeWordButton = page.getByRole('button', { name: 'Whole word' })
  const regexButton = page.getByRole('button', { name: 'Regex' })

  await expect(undoButton).toBeDisabled()
  await expect(redoButton).toBeDisabled()
  // Line wrap moved to the editor Settings dialog (no toolbar button).
  await settingsButton.click()
  const lineWrapCheckbox = page.getByLabel('Line wrap')
  await expect(lineWrapCheckbox).toBeChecked()
  await lineWrapCheckbox.click()
  await expect(lineWrapCheckbox).not.toBeChecked()
  await lineWrapCheckbox.click()
  await expect(lineWrapCheckbox).toBeChecked()
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(searchButton).toHaveAttribute('aria-expanded', 'false')
  await expect(settingsButton).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.search-panel')).toHaveCount(0)
  await searchButton.click()
  await expect(searchButton).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByLabel('Find text')).toBeVisible()
  await expect(page.getByLabel('Replace text')).toBeVisible()
  await expect(findPreviousButton).toBeDisabled()
  await expect(findNextButton).toBeDisabled()
  await expect(replacePreviousButton).toBeDisabled()
  await expect(replaceNextButton).toBeDisabled()
  await expect(replaceAllButton).toBeDisabled()
  await expect(caseSensitiveButton).toHaveAttribute('aria-pressed', 'false')
  await expect(wholeWordButton).toHaveAttribute('aria-pressed', 'false')
  await expect(regexButton).toHaveAttribute('aria-pressed', 'false')

  await page.getByLabel('Find text').fill('(')
  await regexButton.click()
  await expect(page.getByText('Invalid regex.')).toBeVisible()
  // Errors (red) stay in the message area below the toolbar, not the status bar.
  await expect(page.locator('.editor-messages').getByText('Invalid regex.')).toBeVisible()
  await expect(page.locator('.editor-statusbar').getByText('Invalid regex.')).toHaveCount(0)
  await expect(findPreviousButton).toBeDisabled()
  await expect(findNextButton).toBeDisabled()
  await expect(replacePreviousButton).toBeDisabled()
  await expect(replaceNextButton).toBeDisabled()
  await expect(replaceAllButton).toBeDisabled()
  // Turning regex off makes the same non-empty query "(" a valid literal: the
  // derived invalid-query message must clear immediately (it is computed during
  // render, not pushed from the search effect).
  await regexButton.click()
  await expect(page.getByText('Invalid regex.')).toBeHidden()
  await page.getByLabel('Find text').fill('')

  await settingsButton.click()
  await expect(settingsButton).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  await expect(page.locator('#theme-setting')).toHaveValue('system')
  await expect(page.locator('#font-setting')).toHaveValue(
    "ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace",
  )
  await expect(page.locator('#font-size-setting')).toHaveValue('16')
  await expect(page.locator('#random-string-length-setting')).toHaveValue('12')
  await expect(page.locator('#editor-mode-setting')).toHaveValue('plain')
  await expect(page.locator('#line-wrap-setting')).toBeChecked()
  await expect(page.locator('#spellcheck-setting')).toBeChecked()
  await expect(page.locator('#autocorrect-setting')).toBeChecked()
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0)
  await expect(settingsButton).toHaveAttribute('aria-expanded', 'false')

  await page.setViewportSize({ width: 517, height: 572 })
  const findInputBox = await page.getByLabel('Find text').boundingBox()
  const findPreviousBox = await findPreviousButton.boundingBox()
  const replaceInputBox = await page.getByLabel('Replace text').boundingBox()
  const replacePreviousBox = await replacePreviousButton.boundingBox()

  expect(findInputBox).not.toBeNull()
  expect(findPreviousBox).not.toBeNull()
  expect(replaceInputBox).not.toBeNull()
  expect(replacePreviousBox).not.toBeNull()
  expect(findPreviousBox?.y).toBeCloseTo(findInputBox?.y ?? 0, 0)
  expect(replacePreviousBox?.y).toBeCloseTo(replaceInputBox?.y ?? 0, 0)
  await page.setViewportSize({ width: 1280, height: 720 })

  await editor.click()
  await page.keyboard.type(undoMarker)
  await expect(editor).toContainText(undoMarker)
  await expect(undoButton).toBeEnabled()
  await expect(redoButton).toBeDisabled()
  await undoButton.click()
  await expect(editor).not.toContainText(undoMarker)
  await expect(redoButton).toBeEnabled()
  await redoButton.click()
  await expect(editor).toContainText(undoMarker)

  await editor.click()
  await page.keyboard.insertText(
    `${marker}${searchSource}${regexWholeWordSource}${markdownSource}${scrollSource}`,
  )
  await expect(page.getByText('Unsaved changes')).toBeVisible()
  await expect(page.getByText('Autosaved')).toBeVisible({
    timeout: 30_000,
  })

  const toolbarBoxBefore = await page.locator('.editor-toolbar').boundingBox()
  const searchBoxBefore = await page.locator('.search-panel').boundingBox()
  const editorScroller = page.locator('.cm-scroller')

  expect(toolbarBoxBefore).not.toBeNull()
  expect(searchBoxBefore).not.toBeNull()
  await editorScroller.evaluate((element) => {
    element.scrollTop = 0
  })
  await editorScroller.hover()
  await page.mouse.wheel(0, 1200)
  await expect.poll(() => editorScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)

  const toolbarBoxAfter = await page.locator('.editor-toolbar').boundingBox()
  const searchBoxAfter = await page.locator('.search-panel').boundingBox()

  expect(toolbarBoxAfter?.y).toBeCloseTo(toolbarBoxBefore?.y ?? 0, 0)
  expect(searchBoxAfter?.y).toBeCloseTo(searchBoxBefore?.y ?? 0, 0)

  await page.getByLabel('Find text').fill('alpha')
  await expect(page.locator('.cm-search-match')).toHaveCount(2)
  await expect(page.locator('.cm-search-match-selected')).toHaveCount(0)
  await expect(findPreviousButton).toBeEnabled()
  await expect(findNextButton).toBeEnabled()
  await findNextButton.click()
  await expect(page.getByText('1 of 2')).toBeVisible()
  // The green match summary shows in the status bar, not the message area.
  await expect(page.locator('.editor-statusbar').getByText('1 of 2')).toBeVisible()
  await expect(page.locator('.editor-messages').getByText('1 of 2')).toHaveCount(0)
  await expect(page.locator('.cm-search-match')).toHaveCount(1)
  await expect(page.locator('.cm-search-match-selected')).toHaveCount(1)
  await expect(page.locator('.cm-selectionMatch:not(.cm-selectionMatch-main)')).toHaveCount(1)
  await expect
    .poll(() =>
      page
        .locator('.cm-selectionMatch:not(.cm-selectionMatch-main)')
        .evaluateAll((elements) =>
          elements.map((element) => getComputedStyle(element).backgroundColor),
        ),
    )
    .toEqual(['rgba(0, 0, 0, 0)'])
  await findPreviousButton.click()
  await expect(page.getByText('2 of 2')).toBeVisible()
  await expect(page.locator('.cm-search-match')).toHaveCount(1)
  await expect(page.locator('.cm-search-match-selected')).toHaveCount(1)

  await page.getByLabel('Find text').fill('[ths]')
  await wholeWordButton.click()
  await regexButton.click()
  await expect(wholeWordButton).toHaveAttribute('aria-pressed', 'true')
  await expect(regexButton).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.cm-search-match')).toHaveCount(2)
  await expect(page.locator('.cm-search-match-selected')).toHaveCount(0)
  await findNextButton.click()
  await expect(page.getByText('1 of 2')).toBeVisible()
  await expect(page.locator('.cm-search-match')).toHaveCount(1)
  await expect(page.locator('.cm-search-match-selected')).toHaveCount(1)
  await expect
    .poll(() =>
      page
        .locator('.cm-selectionMatch:not(.cm-selectionMatch-main)')
        .evaluateAll((elements) =>
          elements.map((element) => getComputedStyle(element).backgroundColor),
        )
        .then(
          (colors) =>
            colors.length > 0 && colors.every((color) => color === 'rgba(0, 0, 0, 0)'),
        ),
    )
    .toBe(true)
  await wholeWordButton.click()
  await regexButton.click()
  await expect(wholeWordButton).toHaveAttribute('aria-pressed', 'false')
  await expect(regexButton).toHaveAttribute('aria-pressed', 'false')

  await page.getByLabel('Find text').fill('beta')
  await page.getByLabel('Replace text').fill('gamma')
  await replaceNextButton.click()
  await expect(page.getByText('1 of 1')).toBeVisible()
  await expect(editor).toContainText('beta 34')
  await replaceNextButton.click()
  await expect(page.getByText('Replaced 1 of 1.')).toBeVisible()
  await expect(editor).toContainText('gamma 34')
  await page.getByLabel('Find text').fill('gamma')
  await page.getByLabel('Replace text').fill('beta')
  await replacePreviousButton.click()
  await expect(page.getByText('1 of 1')).toBeVisible()
  await expect(editor).toContainText('gamma 34')
  await replacePreviousButton.click()
  await expect(page.getByText('Replaced 1 of 1.')).toBeVisible()
  await expect(editor).toContainText('beta 34')

  await page.getByLabel('Find text').fill('alpha \\d+')
  await page.getByLabel('Replace text').fill('item')
  await regexButton.click()
  await expect(regexButton).toHaveAttribute('aria-pressed', 'true')
  await replaceAllButton.click()
  await expect(page.getByText('Replaced 2 matches.')).toBeVisible()
  await expect(editor).toContainText('item beta 34 item')
  await expect(page.getByText('Autosaved')).toBeVisible({
    timeout: 30_000,
  })

  await editor.click()
  await page.keyboard.insertText(pagehideMarker)
  await expect(page.getByText('Unsaved changes')).toBeVisible()
  // A draft session persists via autosave; it has no Save button (SPEC §4).
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
  await expect(page.getByText('Autosaved')).toBeVisible({ timeout: 30_000 })

  const serializedVault = JSON.stringify(await page.evaluate(dumpVaultRecords))

  expect(serializedVault).toContain('ciphertext')
  expect(serializedVault).not.toContain(marker)
  expect(serializedVault).not.toContain(pagehideMarker)
  expect(await page.evaluate(() => localStorage.length)).toBe(0)
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0)

  // Export to Files exports the current document (current password) as a one-shot
  // encrypted copy downloaded under the suggested default filename — no filename
  // prompt and no password dialog (this forced browser-vault page has no save
  // picker, so the export takes the anchor-download branch).
  const saveAsDownloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export to Files' }).click()
  const saveAsDownload = await saveAsDownloadPromise
  const saveAsDownloadPath = await saveAsDownload.path()

  expect(saveAsDownloadPath).toBeTruthy()
  expect(saveAsDownload.suggestedFilename()).toBe('enote.txt')
  await expect(page.getByText('Encrypted copy downloaded. Save it to Files.')).toHaveCount(0)

  await page.getByRole('button', { name: 'Home' }).click()
  // Home asks for confirmation before leaving the editor.
  await page.getByRole('button', { name: 'OK' }).click()
  await expect(page.getByRole('button', { name: 'Edit draft' })).toBeVisible()

  // A wrong password keeps the unlock dialog open with an inline error.
  await page.getByRole('button', { name: 'Edit draft' }).click()

  const unlockDialog = page.getByRole('dialog').filter({ hasText: 'Unlock draft' })

  await unlockDialog.getByLabel('Password', { exact: true }).fill('wrong password')
  await unlockDialog.getByRole('button', { name: 'Unlock' }).click()
  await expect(page.getByText('Could not unlock. Check the password or file.')).toBeVisible()
  await expect(page.getByText(marker)).not.toBeVisible()

  await unlockDialog.getByLabel('Password', { exact: true }).fill(oldPassword)
  await unlockDialog.getByRole('button', { name: 'Unlock' }).click()
  await expect(editor).toContainText(marker, { timeout: 30_000 })

  await expect(editor).toContainText('# Markdown heading', { timeout: 30_000 })
  await expect(editor).toContainText('**bold source stays source**', { timeout: 30_000 })
  await expect(editor).toContainText(pagehideMarker, { timeout: 30_000 })

  await page.reload()
  await unlockDraftThroughDialog(page, oldPassword)
  await expect(editor).toContainText(marker, { timeout: 30_000 })
  await expect(editor).toContainText('# Markdown heading', { timeout: 30_000 })
  await expect(editor).toContainText('**bold source stays source**', { timeout: 30_000 })
  await expect(page.locator('h1')).toHaveCount(0)

  const freshContext = await browser.newContext()
  await freshContext.addInitScript(forceBrowserVaultMode)
  const freshPage = await freshContext.newPage()

  try {
    await freshPage.goto('http://127.0.0.1:4173/')
    await freshPage.setInputFiles('#encrypted-file-import', saveAsDownloadPath ?? '')

    // Import opens the unlock dialog for the imported draft directly
    // (SPEC §10) — no toast-then-Edit-draft detour.
    const importUnlockDialog = freshPage.getByRole('dialog').filter({ hasText: 'Unlock draft' })

    await importUnlockDialog.getByLabel('Password', { exact: true }).fill(oldPassword)
    await importUnlockDialog.getByRole('button', { name: 'Unlock' }).click()
    await expect(freshPage.locator('.cm-content')).toContainText(marker, {
      timeout: 30_000,
    })
    await expect(freshPage.locator('.cm-content')).toContainText('# Markdown heading')
  } finally {
    await freshContext.close()
  }
})

test('inserts a configurable-length random string from the toolbar button', async ({ page }) => {
  test.setTimeout(60_000)

  await page.addInitScript(forceBrowserVaultMode)
  await page.goto('/')
  await createDraftThroughDialog(page, 'correct horse battery staple')

  const editor = page.locator('.cm-content')
  const randomButton = page.getByRole('button', { name: 'Insert random string' })

  // Default length is 12.
  await randomButton.click()
  await expect(editor).toHaveText(/^[A-Za-z0-9]{12}$/, { timeout: 10_000 })

  // Reconfigure the length in the editor Settings dialog; the next insert uses it.
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.locator('#random-string-length-setting').fill('24')
  await page.getByRole('button', { name: 'Close' }).click()

  await randomButton.click()
  // 12 (first insert) + 24 (configured) appended at the cursor = 36 characters.
  await expect(editor).toHaveText(/^[A-Za-z0-9]{36}$/, { timeout: 10_000 })
})

test('Replace All keeps the caret near its pre-replace position', async ({ page }) => {
  await page.addInitScript(forceBrowserVaultMode)
  await page.goto('/')
  await createDraftThroughDialog(page, 'correct horse battery staple')

  const editor = page.locator('.cm-content')
  await editor.click()
  await page.keyboard.type('xx one\nxx two\nxx three')
  await expect(page.getByText('Ln 3, Col 9')).toBeVisible()

  await page.getByRole('button', { name: 'Search' }).click()
  await page.getByLabel('Find text').fill('xx')
  await page.getByLabel('Replace text').fill('yyyy')
  await page.getByRole('button', { name: 'Replace all' }).click()
  await expect(page.getByText('Replaced 3 matches.')).toBeVisible()
  await expect(editor).toContainText('yyyy three')

  // The caret stays anchored to its line (and clamped column) instead of
  // jumping to the document start.
  await expect(page.getByText(/^Ln 3, Col/)).toBeVisible()
})

test('flushes an unsaved edit when the tab is hidden before the autosave debounce', async ({
  page,
}) => {
  test.setTimeout(60_000)

  await page.addInitScript(forceBrowserVaultMode)
  await page.goto('/')
  await createDraftThroughDialog(page, 'correct horse battery staple')

  const marker = 'BACKGROUND_FLUSH_MARKER'
  await page.locator('.cm-content').click()
  await page.keyboard.type(marker)
  await expect(page.getByText('Unsaved changes')).toBeVisible()

  // Background the tab (device lock / app switch) immediately, well before the
  // 750ms debounce. The save must start from the visibility flush, not the
  // debounce: the dirty state must clear within 500ms of backgrounding (before
  // the debounce could have fired). Asserting the transient "Encrypting
  // autosave..." text directly is flaky on fast machines where the encrypt
  // settles within a frame, so assert the dirty state clears instead.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(page.getByText('Unsaved changes')).toBeHidden({ timeout: 500 })
  await expect(page.getByText('Autosaved')).toBeVisible({ timeout: 30_000 })

  // The flushed edit must survive a reload.
  await page.reload()
  await unlockDraftThroughDialog(page, 'correct horse battery staple')
  await expect(page.locator('.cm-content')).toContainText(marker, { timeout: 30_000 })
})

test('copies a line\'s last word to the clipboard when its line number is clicked', async ({
  page,
}) => {
  test.setTimeout(60_000)

  // Chromium over the dev server (a secure context: http://localhost) exercises
  // the permanent async-Clipboard-API path — the same path production uses. The
  // execCommand fallback is only reached in non-secure contexts (the LAN HTTP
  // device test) and is validated manually on the device, not here.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])

  await page.addInitScript(forceBrowserVaultMode)
  await page.goto('/')
  await createDraftThroughDialog(page, 'correct horse battery staple')

  // Two lines with distinct last words, plus trailing whitespace on the second
  // to prove it is ignored (the last non-whitespace run is copied).
  await page.locator('.cm-content').click()
  await page.keyboard.type('alpha bravo charlie\nfirst second third   ')

  const gutterLines = page.locator('.cm-lineNumbers .cm-gutterElement')

  // Click line 1's number; the clipboard should hold its last word, "charlie".
  // The first gutter element is the (hidden) spacer, so target by text content.
  await gutterLines.filter({ hasText: /^1$/ }).click()
  await expect
    .poll(async () => page.evaluate(() => navigator.clipboard.readText()), { timeout: 10_000 })
    .toBe('charlie')
  // The copy is confirmed with an auto-dismissing info message (SPEC §11).
  await expect(page.getByText('Last word copied.')).toBeVisible()
  // The copied word is also selected so the user sees exactly what was copied
  // (SPEC §11). A gutter tap leaves the editor unfocused, so CodeMirror draws
  // the selection in its own selection layer (not the native DOM selection):
  // assert that layer now shows a non-empty selection spanning one line.
  await expect(page.locator('.cm-selectionLayer .cm-selectionBackground')).toHaveCount(1)

  // Click line 2's number; trailing whitespace is excluded, so it copies "third".
  await gutterLines.filter({ hasText: /^2$/ }).click()
  await expect
    .poll(async () => page.evaluate(() => navigator.clipboard.readText()), { timeout: 10_000 })
    .toBe('third')
  await expect(page.getByText('Last word copied.')).toBeVisible()
  await expect(page.locator('.cm-selectionLayer .cm-selectionBackground')).toHaveCount(1)
})

test('a match in the lines covered by the search panel scrolls below it', async ({ page }) => {
  test.setTimeout(60_000)

  await page.addInitScript(forceBrowserVaultMode)
  await page.goto('/')
  await createDraftThroughDialog(page, 'correct horse battery staple')

  // The only match sits on line 1; the caret ends up at the bottom, so the
  // navigation must scroll back up — and must NOT leave the match hidden
  // under the panel overlay (SPEC §12 scroll margin).
  const editor = page.locator('.cm-content')
  await editor.click()
  await page.keyboard.type(`needle on line one\n${'filler\n'.repeat(30)}end`)

  await page.getByRole('button', { name: 'Search' }).click()
  await page.getByLabel('Find text').fill('needle')
  await page.getByRole('button', { name: 'Find next' }).click()
  await expect(page.getByText('1 of 1')).toBeVisible()

  const panelBox = await page.locator('.search-panel').boundingBox()
  const matchBox = await page.locator('.cm-search-match-selected').boundingBox()

  expect(panelBox).not.toBeNull()
  expect(matchBox).not.toBeNull()
  expect(matchBox?.y ?? 0).toBeGreaterThanOrEqual((panelBox?.y ?? 0) + (panelBox?.height ?? 0) - 1)
})

test('undo cannot restore content across a lock/unlock editor remount', async ({ page }) => {
  test.setTimeout(60_000)
  const password = 'correct horse battery staple'
  const marker = 'REMOUNT_UNDO_CHECK'

  await page.addInitScript(forceBrowserVaultMode)
  await page.goto('/')
  await createDraftThroughDialog(page, password)

  const editor = page.locator('.cm-content')
  await editor.click()
  await page.keyboard.type(marker)
  await expect(editor).toContainText(marker)

  // lockVault flushes the pending edit before clearing, so the content reloads
  // on unlock without a save-button race. Cancel first: the editor must stay
  // unlocked and untouched, then OK actually exits.
  await page.getByRole('button', { name: 'Home' }).click()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(editor).toContainText(marker)
  await page.getByRole('button', { name: 'Home' }).click()
  await page.getByRole('button', { name: 'OK' }).click()
  await expect(page.getByRole('button', { name: 'Edit draft' })).toBeVisible()
  await unlockDraftThroughDialog(page, password)
  await expect(editor).toContainText(marker, { timeout: 30_000 })

  // The freshly mounted editor has no undo history: Undo is disabled and Ctrl+Z
  // leaves the loaded document intact (cannot revert to the pre-lock or empty doc).
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled()
  await editor.click()
  await page.keyboard.press('Control+z')
  await expect(editor).toContainText(marker)
})
