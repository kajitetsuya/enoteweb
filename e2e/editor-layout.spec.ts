import {
  expect,
  test,
  forceBrowserVaultMode,
  createDraftThroughDialog,
  openUnlockedEditor,
  insertEditorText,
  enableMarkdownMode,
  manyLines,
  markdownSections,
  editorTopLine,
  previewTopLine,
  previewAnchorLines,
  scrollPreviewToLine,
  nearestAnchorAtOrBefore,
} from './editorKit'

test('keeps the editor within the viewport and the toolbar scrollable at mobile width', async ({
  page,
}) => {
  test.setTimeout(60_000)

  // Narrow portrait viewport (iPhone-SE-class; the app's layout minimum is
  // 320px). The draft session's action row lost the Save button (SPEC §4)
  // and no longer overflows 320 on its own, so markdown mode adds its
  // preview toggle back to the row — overflow scrollability stays under test.
  await page.setViewportSize({ width: 320, height: 568 })
  await page.addInitScript(forceBrowserVaultMode)
  await page.goto('/')
  await createDraftThroughDialog(page, 'correct horse battery staple')
  await enableMarkdownMode(page)

  const viewportWidth = page.viewportSize()?.width ?? 0
  expect(viewportWidth).toBeGreaterThan(0)

  // Fix A (.editor-shell grid column = minmax(0, 1fr)): with wrap on (the default),
  // the editor must never lay out wider than the viewport — otherwise wrapped lines
  // are clipped on the right with no horizontal scroll. Also assert no page-level
  // horizontal overflow.
  for (const selector of ['.editor-region', '.cm-editor', '.cm-content']) {
    const box = await page.locator(selector).boundingBox()
    expect(box, selector).not.toBeNull()
    expect(box?.width ?? 0).toBeLessThanOrEqual(viewportWidth + 1)
  }
  const documentOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(documentOverflow).toBeLessThanOrEqual(1)

  // Fix B (.toolbar-actions min-width: 0 + justify-content: flex-start): the action
  // row overflows at this width and must be horizontally scrollable, with BOTH the
  // pinned Home button (status group) and the last actions reachable. flex-start
  // keeps the overflow on the scrollable end side; flex-end would orphan the
  // start-side buttons.
  const overflow = await page
    .locator('.toolbar-actions')
    .evaluate((element) => element.scrollWidth - element.clientWidth)
  expect(overflow).toBeGreaterThan(0)

  // Two-row layout on narrow screens: the action row sits below the
  // status/corner row.
  const narrowStatusBox = await page.locator('.toolbar-status').boundingBox()
  const narrowActionsBox = await page.locator('.toolbar-actions').boundingBox()
  expect(narrowActionsBox?.y ?? 0).toBeGreaterThan((narrowStatusBox?.y ?? 0) + 10)

  // Status bar wraps to two lines at this width, and the mode/storage group
  // must stay right-aligned on its own line.
  // The Draft labels are shorter than the old Browser-vault ones, so a
  // selection lengthens the counts ("(N selected)") to force the wrap.
  await insertEditorText(page, 'wrap check text for the selected counts')
  await page.keyboard.press('Control+a')

  const statusbarBox = await page.locator('.editor-statusbar').boundingBox()
  const positionBox = await page.locator('.statusbar-position').boundingBox()
  const metaBox = await page.locator('.statusbar-meta').boundingBox()
  expect(metaBox?.y ?? 0).toBeGreaterThan((positionBox?.y ?? 0) + 5)
  const statusbarRight = (statusbarBox?.x ?? 0) + (statusbarBox?.width ?? 0)
  const metaRight = (metaBox?.x ?? 0) + (metaBox?.width ?? 0)
  expect(statusbarRight - metaRight).toBeLessThanOrEqual(20)

  const homeButton = page.getByRole('button', { name: 'Home' })
  const searchButton = page.getByRole('button', { name: 'Search' })
  await searchButton.scrollIntoViewIfNeeded()
  await expect(searchButton).toBeInViewport()
  await homeButton.scrollIntoViewIfNeeded()
  await expect(homeButton).toBeInViewport()
})

test('confines vertical scrolling to the editor, not the page (portrait)', async ({ page }) => {
  test.setTimeout(60_000)
  await openUnlockedEditor(page, 390, 844)
  await insertEditorText(page, manyLines)

  // The document is locked to the viewport: no page-level overflow either axis.
  const pageOverflow = await page.evaluate(() => ({
    vertical: document.documentElement.scrollHeight - window.innerHeight,
    horizontal: document.documentElement.scrollWidth - window.innerWidth,
  }))
  expect(pageOverflow.vertical).toBeLessThanOrEqual(1)
  expect(pageOverflow.horizontal).toBeLessThanOrEqual(1)

  // Attempts to move the window leave it pinned at the origin...
  await page.evaluate(() => window.scrollTo(0, 1000))
  await page.mouse.move(195, 500)
  await page.mouse.wheel(0, 1000)
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  expect(await page.evaluate(() => window.scrollX)).toBe(0)

  // ...while the editor's own scroller moves.
  const scrollTop = await page
    .locator('.cm-scroller')
    .evaluate((element) => {
      element.scrollTop = 600
      return element.scrollTop
    })
  expect(scrollTop).toBeGreaterThan(0)
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
})

test('keeps the editor usable and scroll confined in landscape', async ({ page }) => {
  test.setTimeout(60_000)
  await openUnlockedEditor(page, 844, 390)
  await insertEditorText(page, manyLines)

  // The short landscape height must not collapse the editor row to nothing.
  const scrollerBox = await page.locator('.cm-scroller').boundingBox()
  expect(scrollerBox?.height ?? 0).toBeGreaterThan(80)

  const verticalOverflow = await page.evaluate(
    () => document.documentElement.scrollHeight - window.innerHeight,
  )
  expect(verticalOverflow).toBeLessThanOrEqual(1)

  await page.evaluate(() => window.scrollTo(0, 1000))
  expect(await page.evaluate(() => window.scrollY)).toBe(0)

  const scrollTop = await page
    .locator('.cm-scroller')
    .evaluate((element) => {
      element.scrollTop = 400
      return element.scrollTop
    })
  expect(scrollTop).toBeGreaterThan(0)
})

test('scrolls long lines horizontally inside the editor (wrap off), not the page', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await openUnlockedEditor(page, 390, 844)
  // Default wrap is on; toggle it off in Settings so a long line overflows
  // horizontally (wrap has no toolbar button).
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByLabel('Line wrap').click()
  await page.getByRole('button', { name: 'Close' }).click()
  await insertEditorText(page, 'word '.repeat(400))

  const scrollLeft = await page
    .locator('.cm-scroller')
    .evaluate((element) => {
      element.scrollLeft = 800
      return element.scrollLeft
    })
  expect(scrollLeft).toBeGreaterThan(0)

  // The page itself never scrolls horizontally.
  expect(await page.evaluate(() => window.scrollX)).toBe(0)
  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(horizontalOverflow).toBeLessThanOrEqual(1)
})

test('scrolls the toolbar action row horizontally without scrolling the page', async ({ page }) => {
  test.setTimeout(60_000)
  // 320px (the layout minimum). The draft session's action row lost the
  // Save button (SPEC §4) and fits on its own, so markdown mode adds its
  // preview toggle — the row overflows and the scroll confinement stays
  // under test.
  await openUnlockedEditor(page, 320, 568)
  await enableMarkdownMode(page)

  const toolbar = page.locator('.toolbar-actions')
  const overflow = await toolbar.evaluate((element) => element.scrollWidth - element.clientWidth)
  expect(overflow).toBeGreaterThan(0)

  const scrollLeft = await toolbar.evaluate((element) => {
    element.scrollLeft = element.scrollWidth
    return element.scrollLeft
  })
  expect(scrollLeft).toBeGreaterThan(0)
  expect(await page.evaluate(() => window.scrollX)).toBe(0)
})

// Synthetic safe-area check: Chromium can't emulate iOS insets, but since every
// inset routes through the --safe-* variables we can override them and assert
// the values actually fold into the content padding — including the iPhone-width
// mobile override that resets the toolbar/search shorthands. This catches a
// cascade mistake (e.g. a mobile `padding:` shorthand wiping the inset) without
// needing a device. It does NOT prove on-device iOS behavior.

test('safe-area insets fold into content padding, including the mobile override', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await openUnlockedEditor(page, 390, 844)
  await page.addStyleTag({
    content: ':root{--safe-top:30px;--safe-right:30px;--safe-bottom:30px;--safe-left:30px;}',
  })

  const padding = (selector: string) =>
    page.locator(selector).evaluate((element) => {
      const s = getComputedStyle(element)
      return {
        top: parseFloat(s.paddingTop),
        right: parseFloat(s.paddingRight),
        bottom: parseFloat(s.paddingBottom),
        left: parseFloat(s.paddingLeft),
      }
    })

  // Toolbar: the mobile rule is a `12px` shorthand, yet the inset must persist.
  const toolbar = await padding('.editor-toolbar')
  expect(toolbar.top).toBeGreaterThanOrEqual(30)
  expect(toolbar.left).toBeGreaterThanOrEqual(30)
  expect(toolbar.right).toBeGreaterThanOrEqual(30)

  // Editor region carries the raw side insets so the gutter/text clear a notch.
  const region = await padding('.editor-region')
  expect(region.left).toBeGreaterThanOrEqual(30)
  expect(region.right).toBeGreaterThanOrEqual(30)

  // Status bar: sides plus the bottom home-indicator inset.
  const status = await padding('.editor-statusbar')
  expect(status.left).toBeGreaterThanOrEqual(30)
  expect(status.right).toBeGreaterThanOrEqual(30)
  expect(status.bottom).toBeGreaterThanOrEqual(30)

  // The insets must not introduce horizontal page overflow.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(overflow).toBeLessThanOrEqual(1)
})

// Side-by-side search layout, worst case for width. The find row and replace row
// sit side by side as two roughly-equal halves on one line whenever the viewport is
// wider than 640px (the same breakpoint at which the Markdown preview goes
// side-by-side). 667x375 plus asymmetric side safe-area insets is the narrowest
// realistic device case — the smallest current iPhone held sideways with a notch —
// so it guards the layout and that nothing overflows or shrinks below a usable size.

test('lays the search panel out as side-by-side halves in landscape (worst case)', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await openUnlockedEditor(page, 667, 375)
  // Asymmetric side insets like an iPhone notch/home-indicator held sideways.
  await page.addStyleTag({
    content: ':root{--safe-top:21px;--safe-right:21px;--safe-bottom:21px;--safe-left:44px;}',
  })

  await page.getByRole('button', { name: 'Search' }).click()
  const panel = page.locator('.search-panel')
  await expect(panel).toBeVisible()

  const findRow = page.locator('.find-panel-row')
  const replaceRow = page.locator('.replace-panel-row')

  // Same line: the two rows share a top edge.
  const tops = await page.evaluate(() => {
    const find = document.querySelector('.find-panel-row') as HTMLElement
    const replace = document.querySelector('.replace-panel-row') as HTMLElement
    return { find: find.offsetTop, replace: replace.offsetTop }
  })
  expect(Math.abs(tops.find - tops.replace)).toBeLessThanOrEqual(1)

  // Roughly equal halves (minmax(0,1fr) tracks split the content area evenly).
  const findBox = await findRow.boundingBox()
  const replaceBox = await replaceRow.boundingBox()
  expect(Math.abs((findBox?.width ?? 0) - (replaceBox?.width ?? 0))).toBeLessThanOrEqual(2)

  // A vertical divider separates the two halves (left border on the replace row).
  const dividerWidth = await replaceRow.evaluate((el) =>
    parseFloat(getComputedStyle(el).borderLeftWidth),
  )
  expect(dividerWidth).toBeGreaterThanOrEqual(1)

  // Nothing overflows: the page, the rows themselves, and the button groups.
  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(pageOverflow).toBeLessThanOrEqual(1)

  const noScrollOverflow = (selector: string) =>
    page.locator(selector).evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(await noScrollOverflow('.find-panel-row')).toBeLessThanOrEqual(1)
  expect(await noScrollOverflow('.replace-panel-row')).toBeLessThanOrEqual(1)
  expect(await noScrollOverflow('.find-panel-row .search-actions')).toBeLessThanOrEqual(1)
  expect(await noScrollOverflow('.replace-panel-row .search-actions')).toBeLessThanOrEqual(1)

  // Both inputs stay above a usable minimum (~79px measured at this worst case).
  const findInput = await page.locator('#find-text').boundingBox()
  const replaceInput = await page.locator('#replace-with').boundingBox()
  expect(findInput?.width ?? 0).toBeGreaterThanOrEqual(70)
  expect(replaceInput?.width ?? 0).toBeGreaterThanOrEqual(70)

  // Every find/replace button stays within the viewport (reachable, not clipped).
  const buttons = panel.locator('button')
  const count = await buttons.count()
  // 5 find buttons (< > Aa "" .*) + 3 replace buttons (< > All).
  expect(count).toBe(8)
  for (let i = 0; i < count; i += 1) {
    const box = await buttons.nth(i).boundingBox()
    expect(box).not.toBeNull()
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(-0.5)
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(667 + 0.5)
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(-0.5)
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(375 + 0.5)
  }
})

// Breakpoint coincidence with the Markdown preview: the search panel switches at the
// same 640px boundary the preview uses. At 640px wide (preview overlay) the find and
// replace rows stack with no divider; at 660px (preview side-by-side) they sit on one
// line with the divider. Width-driven and orientation-independent — the 660 case is a
// tall (portrait-shaped) viewport, proving the old landscape/height heuristic is gone.

test('search panel restacks at the 640px breakpoint and splits above it', async ({ page }) => {
  test.setTimeout(60_000)
  await openUnlockedEditor(page, 640, 900)
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page.locator('.search-panel')).toBeVisible()

  const layout = async () =>
    page.evaluate(() => {
      const find = document.querySelector('.find-panel-row') as HTMLElement
      const replace = document.querySelector('.replace-panel-row') as HTMLElement
      return {
        sameLine: Math.abs(find.offsetTop - replace.offsetTop) <= 1,
        dividerWidth: parseFloat(getComputedStyle(replace).borderLeftWidth) || 0,
      }
    })

  // At exactly 640px the preview is overlay, so the search panel is stacked.
  const stacked = await layout()
  expect(stacked.sameLine).toBe(false)
  expect(stacked.dividerWidth).toBeLessThan(1)

  // 20px wider crosses the breakpoint: side-by-side with the divider drawn.
  await page.setViewportSize({ width: 660, height: 900 })
  const split = await layout()
  expect(split.sameLine).toBe(true)
  expect(split.dividerWidth).toBeGreaterThanOrEqual(1)
})

// Keyboard-driven chrome retraction. A real on-screen keyboard cannot run in
// Playwright, so a fake visualViewport (installed before the app loads) stands
// in: the app reads "visual viewport much shorter than the window" as
// keyboard-up. Gating: chrome retracts only while the EDITOR owns the
// keyboard — the status bar in every orientation, the toolbar additionally on
// short screens (max-height 500px, landscape phones). Focus in the find box
// must retract nothing (the toolbar and the "x of X" summary stay).

test('keyboard-up chrome retraction follows editor focus', async ({ page }) => {
  test.setTimeout(60_000)
  await page.addInitScript(() => {
    class FakeViewport extends EventTarget {
      height = window.innerHeight
      offsetTop = 0
      scale = 1
    }
    const fake = new FakeViewport()
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: fake })
    ;(window as unknown as { __fakeViewport: FakeViewport }).__fakeViewport = fake
  })
  await openUnlockedEditor(page, 800, 600)

  const statusbar = page.locator('.editor-statusbar')
  const toolbar = page.locator('.editor-toolbar')
  const setKeyboard = (up: boolean) =>
    page.evaluate((isUp) => {
      const fake = (window as unknown as { __fakeViewport: { height: number } & EventTarget })
        .__fakeViewport
      fake.height = isUp ? window.innerHeight - 300 : window.innerHeight
      fake.dispatchEvent(new Event('resize'))
    }, up)

  // Editor focused + keyboard up: the status bar hides; the toolbar stays on
  // a tall screen.
  await page.locator('.cm-content').click()
  await setKeyboard(true)
  await expect(statusbar).toBeHidden()
  await expect(toolbar).toBeVisible()

  // Keyboard down: the status bar returns.
  await setKeyboard(false)
  await expect(statusbar).toBeVisible()

  // Keyboard up FOR THE FIND BOX: nothing retracts.
  await page.getByRole('button', { name: 'Search' }).click()
  await page.getByLabel('Find text').click()
  await setKeyboard(true)
  await expect(statusbar).toBeVisible()
  await expect(toolbar).toBeVisible()
  await setKeyboard(false)

  // Short screen (landscape phone): editor focus also hides the toolbar.
  await page.setViewportSize({ width: 667, height: 375 })
  await page.locator('.cm-content').click()
  await setKeyboard(true)
  await expect(statusbar).toBeHidden()
  await expect(toolbar).toBeHidden()

  // Keyboard down again: everything returns.
  await setKeyboard(false)
  await expect(statusbar).toBeVisible()
  await expect(toolbar).toBeVisible()
})

// The insertion point stays visible while the editor is unfocused: with chrome
// retraction the toolbar is used with the keyboard
// down — i.e. the editor blurred — and Insert Random String needs a visible
// target). A custom CodeMirror layer draws the caret exactly when unfocused;
// the native/drawn caret takes over with focus.

test('the caret stays visible while the editor is unfocused', async ({ page }) => {
  await openUnlockedEditor(page, 800, 600)
  const unfocusedCaret = page.locator('.cm-unfocused-caret')

  await insertEditorText(page, 'alpha beta')
  await expect(unfocusedCaret).toHaveCount(0)

  // Blur (as closing the iOS keyboard would): the parked caret appears where
  // typing stopped — after the text, not at column 0.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await expect(unfocusedCaret).toHaveCount(1)
  const caretBox = await unfocusedCaret.boundingBox()
  const lineBox = await page.locator('.cm-line').first().boundingBox()
  expect(caretBox?.x ?? 0).toBeGreaterThan((lineBox?.x ?? 0) + 10)

  // It blinks like the focused caret rather than sitting as a static bar.
  const animationName = await page
    .locator('.cm-unfocusedCaretLayer')
    .evaluate((element) => getComputedStyle(element).animationName)
  expect(animationName).toBe('enote-unfocused-caret-blink')

  // Refocusing swaps back to the regular caret.
  await page.locator('.cm-content').click()
  await expect(unfocusedCaret).toHaveCount(0)
})

// The status bar match summary is live: it tracks the query
// as it is typed or emptied with no navigation needed, and a navigation
// result ("1 of 2") takes over until the query changes again.

test('the status bar match count updates live while typing a query', async ({ page }) => {
  await openUnlockedEditor(page, 800, 600)
  await insertEditorText(page, 'alpha 12 beta 34 alpha 56')

  await page.getByRole('button', { name: 'Search' }).click()
  const summary = page.locator('.statusbar-search')

  await page.getByLabel('Find text').fill('alpha')
  await expect(summary).toHaveText('2 matches')

  await page.getByRole('button', { name: 'Find next' }).click()
  await expect(summary).toHaveText('1 of 2')

  // Editing the query switches back from the navigation result to the count.
  await page.getByLabel('Find text').fill('beta')
  await expect(summary).toHaveText('1 match')

  await page.getByLabel('Find text').fill('zzz')
  await expect(summary).toHaveText('0 matches')

  // An emptied query goes silent.
  await page.getByLabel('Find text').fill('')
  await expect(summary).toHaveCount(0)
})

// Preview position sync (A/B one-shot align). Block-anchor semantics: A aligns the
// preview to the *block* containing the editor's top line (nearest preceding
// anchor), and B aligns the editor to the block at the preview's top.

test('one-shot buttons align the preview and editor by source-line anchors', async ({ page }) => {
  test.setTimeout(60_000)
  await openUnlockedEditor(page, 1100, 800)
  await enableMarkdownMode(page)

  await insertEditorText(page, markdownSections(30))

  await page.getByRole('button', { name: 'Preview' }).click()
  await expect(page.locator('.markdown-preview')).toBeVisible()
  await expect(page.locator('.markdown-preview [data-enote-source-line]').first()).toBeVisible()

  const syncA = page.getByRole('button', { name: 'Jump to Markdown' })
  const syncB = page.getByRole('button', { name: 'Jump to Editor' })
  await expect(syncA).toBeVisible()
  await expect(syncB).toBeVisible()

  // A: scroll the editor into the middle of the document (likely landing inside a
  // paragraph), align, and expect the preview at that block's nearest preceding
  // anchor — i.e. the greatest anchored line <= the editor's top line.
  await page.locator('.cm-scroller').evaluate((element) => {
    element.scrollTop = 1500
  })
  await page.waitForTimeout(150)
  const eLine = await editorTopLine(page)
  expect(eLine).toBeGreaterThan(0)
  const lines = await previewAnchorLines(page)
  await syncA.click()
  await expect.poll(() => previewTopLine(page)).toBe(nearestAnchorAtOrBefore(lines, eLine))

  // B: reset the editor to the top, scroll the preview so Section 15's heading
  // sits at the top, align, and expect the editor's top line to match it.
  await page.locator('.cm-scroller').evaluate((element) => {
    element.scrollTop = 0
  })
  const targetLine = 14 * 6 + 1 // Section 15 heading.
  await scrollPreviewToLine(page, targetLine)
  await page.waitForTimeout(150)
  expect(await previewTopLine(page)).toBe(targetLine)
  await syncB.click()
  await expect.poll(() => editorTopLine(page)).toBe(targetLine)

  // The sync row is meaningless in the <=640px overlay (preview is not beside the
  // editor there), so it is hidden.
  await page.setViewportSize({ width: 600, height: 800 })
  await expect(syncA).toBeHidden()
})

// Opening the preview shows it already aligned to the editor's position (as if
// "Jump to Markdown" were pressed), in both layouts.

test('opening the preview aligns it to the editor position (side-by-side)', async ({ page }) => {
  test.setTimeout(60_000)
  await openUnlockedEditor(page, 1100, 800)
  await enableMarkdownMode(page)
  await insertEditorText(page, markdownSections(30))

  // Scroll the editor down *before* opening the preview.
  await page.locator('.cm-scroller').evaluate((element) => {
    element.scrollTop = 1500
  })
  await page.waitForTimeout(150)
  const eLine = await editorTopLine(page)
  expect(eLine).toBeGreaterThan(1)

  await page.getByRole('button', { name: 'Preview' }).click()
  await expect(page.locator('.markdown-preview [data-enote-source-line]').first()).toBeVisible()

  const lines = await previewAnchorLines(page)
  await expect.poll(() => previewTopLine(page)).toBe(nearestAnchorAtOrBefore(lines, eLine))
})

// The overlay case is the regression guard for capture-before-hide: once the
// preview opens at <=640px the editor is display:none and would report line 1, so
// the editor's top line must have been captured at toggle time.

test('opening the preview aligns it to the editor position (overlay)', async ({ page }) => {
  test.setTimeout(60_000)
  await openUnlockedEditor(page, 600, 800)
  await enableMarkdownMode(page)
  await insertEditorText(page, markdownSections(30))

  await page.locator('.cm-scroller').evaluate((element) => {
    element.scrollTop = 1500
  })
  await page.waitForTimeout(150)
  const eLine = await editorTopLine(page)
  expect(eLine).toBeGreaterThan(1)

  await page.getByRole('button', { name: 'Preview' }).click()
  await expect(page.locator('.markdown-preview [data-enote-source-line]').first()).toBeVisible()

  // No reverse-align affordance exists in the overlay; the open-time alignment is
  // the only sync.
  await expect(page.getByRole('button', { name: 'Jump to Markdown' })).toBeHidden()

  const lines = await previewAnchorLines(page)
  await expect.poll(() => previewTopLine(page)).toBe(nearestAnchorAtOrBefore(lines, eLine))
})

// Real-CodeMirror guard for the remount-clears-history property that the Dropbox
// "Create file" (new blank document) flow relies on: after a lock/unlock the
// editor is a fresh instance with no undo history, so Ctrl+Z cannot resurrect the
// document from before the remount.
