import { forwardRef, useDeferredValue, useMemo } from 'react'
import type { CSSProperties } from 'react'
import { RENDER_KEY_ATTR } from './previewAnchors'
import { renderMarkdownToSafeHtml } from './renderMarkdown'

type MarkdownPreviewProps = {
  fontFamily: string
  fontSizePx: number
  source: string
}

// Read-only rendered view of the in-memory Markdown plaintext. The HTML is
// derived during render, sanitized against the SPEC Section 13 allowlist, and
// never persisted. Inserting pre-sanitized HTML is the whole purpose of this
// component, so the `dangerouslySetInnerHTML` here is intentional and safe.
//
// A ref is forwarded to the root so the position-sync feature can read the
// rendered source-line anchors; the current render key is stamped on the root
// (by React, outside the sanitizer) so sync trusts only this render's anchors.
export const MarkdownPreview = forwardRef<HTMLDivElement, MarkdownPreviewProps>(
  function MarkdownPreview({ fontFamily, fontSizePx, source }, ref) {
    // Re-rendering the preview is non-urgent relative to keystrokes: deferring the
    // (whole-document) parse + sanitize keeps typing responsive on large notes.
    const deferredSource = useDeferredValue(source)
    const { html, renderKey } = useMemo(
      () => renderMarkdownToSafeHtml(deferredSource),
      [deferredSource],
    )

    const style: CSSProperties = { fontFamily, fontSize: `${fontSizePx}px` }

    return (
      <div
        ref={ref}
        aria-label="Markdown preview"
        className="markdown-preview"
        data-testid="markdown-preview"
        style={style}
        {...{ [RENDER_KEY_ATTR]: renderKey }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  },
)
