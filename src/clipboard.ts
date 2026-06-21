// System-clipboard write used by the line-number "copy last word" action
// (Section 11). This deliberately places plaintext on the OS clipboard; it is
// always user-initiated (a gutter click), and the exposure is documented as an
// accepted residual risk in SPEC.md.

/**
 * Copies `text` to the system clipboard.
 *
 * Permanent production path: the asynchronous Clipboard API. It is available in
 * every real deployment environment because they are all secure contexts —
 * HTTPS, an installed PWA ("Add to Home Screen"), or `localhost`. It must be
 * invoked synchronously from within the user-gesture handler (no awaited work
 * before the write) so the browser still sees transient activation; the write
 * itself is fire-and-forget and its promise rejection (focus/permission policy)
 * is swallowed.
 */
export function copyText(text: string): void {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => {
      // Best effort: a rejection here means the platform refused the write
      // (focus/permission/policy). The gutter handler confirms optimistically
      // through its callback (SPEC Section 11), so a rare refused write can
      // show a confirmation without a copy — accepted.
    })
    return
  }

  // Non-secure contexts have no async Clipboard API. Real deployments are
  // secure contexts, but this fallback keeps local HTTP preview copies usable.
  legacyCopyText(text)
}

// execCommand-based clipboard write for non-secure contexts. Kept isolated from
// the production Clipboard API path.
// Uses the iOS Safari selection dance (a real Range + setSelectionRange), which
// is more reliable than textarea.select() alone on iOS.
function legacyCopyText(text: string): void {
  if (typeof document === 'undefined') {
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.contentEditable = 'true'
  textarea.readOnly = false
  // Keep it visually inert and out of the layout flow so selecting it does not
  // scroll the page or trigger iOS auto-zoom.
  textarea.style.position = 'fixed'
  textarea.style.top = '0'
  textarea.style.left = '0'
  textarea.style.width = '1px'
  textarea.style.height = '1px'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'

  const previouslyFocused = document.activeElement as HTMLElement | null
  document.body.appendChild(textarea)

  try {
    const range = document.createRange()
    range.selectNodeContents(textarea)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    textarea.setSelectionRange(0, text.length)
  } catch {
    // Selection is best-effort; still attempt the copy below.
  }

  try {
    document.execCommand('copy')
  } catch {
    // Best effort only.
  }

  textarea.remove()
  // Restore focus so the editor is unaffected by the transient textarea.
  previouslyFocused?.focus()
}
