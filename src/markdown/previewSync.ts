import { RENDER_KEY_ATTR, SOURCE_LINE_ATTR } from './previewAnchors'

// One rendered block that maps back to a Markdown source line.
export type PreviewAnchor = {
  line: number
  element: HTMLElement
}

// Anchors are aligned to just below the preview's top padding, not its border box,
// so an aligned block's first line sits where reading resumes.
const contentTopPadding = (root: HTMLElement): number =>
  Number.parseFloat(getComputedStyle(root).paddingTop) || 0

// Collects the source-line anchors the current render stamped, in ascending line
// order. Only elements carrying the matching render key are trusted, so a stale
// anchor from a previous render or one forged in a note's raw HTML is ignored.
export const collectPreviewAnchors = (root: HTMLElement, renderKey: string): PreviewAnchor[] => {
  if (!renderKey) {
    return []
  }

  const selector = `[${SOURCE_LINE_ATTR}][${RENDER_KEY_ATTR}="${CSS.escape(renderKey)}"]`
  const anchors: PreviewAnchor[] = []

  for (const element of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
    const line = Number.parseInt(element.getAttribute(SOURCE_LINE_ATTR) ?? '', 10)

    if (Number.isFinite(line)) {
      anchors.push({ line, element })
    }
  }

  return anchors.sort((a, b) => a.line - b.line)
}

// The anchored block that contains (or most closely precedes) `line` — the block
// the editor's top line falls within. Returns null when there are no anchors.
const blockContaining = (anchors: PreviewAnchor[], line: number): PreviewAnchor | null => {
  let chosen: PreviewAnchor | null = null

  for (const anchor of anchors) {
    if (anchor.line <= line) {
      chosen = anchor
    } else {
      break
    }
  }

  // Before the first anchor, fall back to it so alignment still does something
  // sensible (scrolls to the top of the document).
  return chosen ?? anchors[0] ?? null
}

// Button A: scroll the preview so the block holding the editor's top source line
// sits at the top of the preview's content area.
export const alignPreviewToSourceLine = (
  root: HTMLElement,
  renderKey: string,
  line: number,
): void => {
  const target = blockContaining(collectPreviewAnchors(root, renderKey), line)

  if (!target) {
    return
  }

  const rootRect = root.getBoundingClientRect()
  const elementRect = target.element.getBoundingClientRect()

  root.scrollTop += elementRect.top - rootRect.top - contentTopPadding(root)
}

// Button B: the source line of the block currently at the top of the preview —
// the last anchor whose top is at or above the preview's content top (the
// current / partially scrolled-past block). Returns null when there are no
// anchors. `tolerancePx` absorbs sub-pixel rounding at the viewport edge.
export const sourceLineAtPreviewTop = (
  root: HTMLElement,
  renderKey: string,
  tolerancePx = 4,
): number | null => {
  const anchors = collectPreviewAnchors(root, renderKey)
  const first = anchors[0]

  if (!first) {
    return null
  }

  const viewportTop = root.getBoundingClientRect().top + contentTopPadding(root)
  let chosen = first

  for (const anchor of anchors) {
    if (anchor.element.getBoundingClientRect().top <= viewportTop + tolerancePx) {
      chosen = anchor
    } else {
      break
    }
  }

  return chosen.line
}
