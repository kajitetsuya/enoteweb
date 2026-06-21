import { Marked, Renderer } from 'marked'
import type { Tokens, TokensList } from 'marked'
import { RENDER_KEY_ATTR, SOURCE_LINE_ATTR } from './previewAnchors'
import { sanitizeMarkdownHtml } from './sanitizeHtml'

export type RenderedMarkdown = {
  html: string
  // Unique per render; sync code trusts only anchors stamped with this value.
  renderKey: string
}

// Minimal structural view of a marked token. We only read the fields needed for
// line mapping and stamp a private `__line` for the renderer to consume.
type LinedToken = {
  type: string
  raw: string
  items?: LinedToken[]
  __line?: number
}

// 1-based start offset of every source line, so an offset -> line lookup is a
// binary search rather than a re-scan per token.
const buildLineStarts = (source: string): number[] => {
  const starts = [0]

  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10 /* \n */) {
      starts.push(index + 1)
    }
  }

  return starts
}

const lineAtOffset = (lineStarts: number[], offset: number): number => {
  let low = 0
  let high = lineStarts.length - 1

  while (low < high) {
    const mid = (low + high + 1) >> 1

    if ((lineStarts[mid] ?? 0) <= offset) {
      low = mid
    } else {
      high = mid - 1
    }
  }

  return low + 1
}

// A top-level list's items carry verbatim source in `raw` (markers and
// indentation intact), so their start lines reconstruct by accumulation within
// the list's source span. Nested lists are intentionally not recursed into: marked
// strips the indentation from a nested list's `raw`, so its items cannot be located
// in the source reliably. They degrade to their containing item's anchor instead.
const assignItemLines = (
  lineStarts: number[],
  items: LinedToken[],
  baseOffset: number,
): void => {
  let offset = baseOffset

  for (const item of items) {
    item.__line = lineAtOffset(lineStarts, offset)
    offset += item.raw.length
  }
}

// Top-level block tokens (including `space`) carry verbatim `raw` that concatenates
// back to the source, so their start lines accumulate exactly. We descend into
// lists to line-map their items; blockquote inner blocks are intentionally left
// unanchored (their `>` is stripped, so they would not map reliably) and degrade
// to the blockquote container's line.
const assignLines = (lineStarts: number[], tokens: LinedToken[]): void => {
  let offset = 0

  for (const token of tokens) {
    token.__line = lineAtOffset(lineStarts, offset)

    if (token.type === 'list' && Array.isArray(token.items)) {
      assignItemLines(lineStarts, token.items, offset)
    }

    offset += token.raw.length
  }
}

const lineOf = (token: unknown): number | undefined => (token as LinedToken).__line

// Read by the renderer overrides at parse time; set immediately before the
// synchronous `parser()` call, so it always reflects the render in progress.
let currentRenderKey = ''

const base = new Renderer()

// Inserts the source-line and render-key attributes into the element's opening
// tag. No-op when the token was not line-mapped (e.g. a paragraph nested inside a
// blockquote), so such blocks degrade to their nearest anchored ancestor.
const withAnchor = (html: string, token: unknown): string => {
  const line = lineOf(token)

  if (line === undefined) {
    return html
  }

  return html.replace(
    /^(\s*<[a-zA-Z][a-zA-Z0-9]*)\b/,
    `$1 ${SOURCE_LINE_ATTR}="${line}" ${RENDER_KEY_ATTR}="${currentRenderKey}"`,
  )
}

// Anchored block types only. `list` (ul/ol) is deliberately not anchored: a list
// is represented by its item anchors, which avoids a container-vs-item ambiguity
// at the list's start line.
const anchoringRenderer = {
  heading(this: Renderer, token: Tokens.Heading) {
    return withAnchor(base.heading.call(this, token), token)
  },
  paragraph(this: Renderer, token: Tokens.Paragraph) {
    return withAnchor(base.paragraph.call(this, token), token)
  },
  blockquote(this: Renderer, token: Tokens.Blockquote) {
    return withAnchor(base.blockquote.call(this, token), token)
  },
  code(this: Renderer, token: Tokens.Code) {
    return withAnchor(base.code.call(this, token), token)
  },
  listitem(this: Renderer, token: Tokens.ListItem) {
    return withAnchor(base.listitem.call(this, token), token)
  },
  table(this: Renderer, token: Tokens.Table) {
    return withAnchor(base.table.call(this, token), token)
  },
  hr(this: Renderer, token: Tokens.Hr) {
    return withAnchor(base.hr.call(this, token), token)
  },
}

// GitHub-flavored Markdown, rendered synchronously. `breaks: false` keeps the
// standard "two trailing spaces or blank line" paragraph behavior so the preview
// matches how the source reads. A local instance (not the global `marked`) holds
// the anchoring renderer so module consumers cannot leak its config.
const markedInstance = new Marked({
  gfm: true,
  breaks: false,
  async: false,
  renderer: anchoringRenderer,
})

// Stable per-session prefix + monotonic counter make a render key that no note's
// raw HTML can collide with by accident, and that differs on every render so a
// stale anchor from a prior render is never trusted. getRandomValues (not the
// secure-context-gated crypto.subtle / randomUUID) keeps this working over plain
// LAN HTTP (a non-secure context).
const renderKeyPrefix = (() => {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
})()
let renderSequence = 0

// Renders Markdown source to sanitized, preview-safe HTML carrying source-line
// anchors. The plaintext stays in memory only; the returned HTML is never
// persisted (SPEC Sections 13/15). Every byte passes through the Section 13
// allowlist sanitizer before it can reach the DOM.
export const renderMarkdownToSafeHtml = (source: string): RenderedMarkdown => {
  renderSequence += 1
  const renderKey = `${renderKeyPrefix}.${renderSequence}`

  // marked has reachable throw paths from document content (e.g. the lexer's
  // infinite-loop guard). A throwing document must degrade to a placeholder
  // preview, never crash the preview component — or, before an error boundary
  // existed, the whole app — while the editor keeps the user's text.
  try {
    const tokens = markedInstance.lexer(source)
    const lineStarts = buildLineStarts(source)
    assignLines(lineStarts, tokens as unknown as LinedToken[])

    currentRenderKey = renderKey
    const rawHtml = markedInstance.parser(tokens as TokensList)
    const html = sanitizeMarkdownHtml(rawHtml, renderKey)

    return { html, renderKey }
  } catch {
    return { html: '<p>Preview unavailable for this document.</p>', renderKey }
  }
}
