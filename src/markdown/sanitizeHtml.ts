import DOMPurify from 'dompurify'
import { RENDER_KEY_ATTR, SOURCE_LINE_ATTR } from './previewAnchors'

// A module-private DOMPurify instance carries this module's hooks and policy so a
// future DOMPurify caller elsewhere cannot inherit them off the shared global
// purifier. The instance API is identical to the default export.
const purifier = DOMPurify(window)

// SPEC Section 13: Markdown preview HTML is sanitized by an ALLOWLIST, not a
// blocklist. Only the fixed set of elements/attributes below survives; anything
// not explicitly allowed is dropped. This is the in-app security layer and must
// stand on its own even if the production CSP were ever absent (for example on a
// header-only host), so it — not the CSP — is the authoritative XSS and
// remote-resource boundary for rendered note content.

// Safe, presentational elements only. No script/iframe/object/embed/link/meta/
// style/base, and no <svg>/<math> (foreign content is the classic mutation-XSS
// vector). No form controls (e.g. <input>): the preview is strictly read-only,
// so even a disabled checkbox is dropped rather than risk a raw-HTML enabled
// control. Anything outside this list is removed by DOMPurify's allowlist gate.
const ALLOWED_TAGS = [
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'img',
  'kbd',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
]

// Note the absence of `src`: no resource-loading attribute is allowed, so the
// preview never performs an automatic fetch from document content — not even a
// same-origin one that could carry plaintext in the URL into server/CDN logs
// (SPEC Section 13). `<img>` survives only to render its `alt` text.
const ALLOWED_ATTR = [
  'href',
  'alt',
  'title',
  'start',
  'colspan',
  'rowspan',
  'align',
  // Injected by the post-sanitize hook below for links; listed so they are not
  // stripped if they ever arrive on the input as well.
  'target',
  'rel',
]

// URL-scheme allowlist for the one URL-bearing attribute that survives (href).
// Permits http:, https:, mailto:, and relative URLs; rejects javascript:, data:,
// and every other absolute scheme (tel:, sms:, vbscript:, ...). This is
// DOMPurify's default shape narrowed so only http(s) and mailto are accepted as
// absolute schemes. The relative-URL alternative requires a leading letter and
// includes digits in the scheme-character class: without the digits, a scheme
// containing one (s3:, web2:) would slip through as a "relative" URL, because
// the URL Standard allows digits in a scheme after the first letter.
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto):|[^a-z]|[a-z][a-z0-9+.-]*(?:[^a-z0-9+.\-:]|$))/i

// Same href-scheme gate the sanitizer applies, exposed so other entry points
// (the paste handler that writes a markdown link into the document) reject the
// same schemes for consistency/defense-in-depth — even though the preview
// sanitizer remains the authoritative boundary. Accepts http(s)/mailto, relative
// URLs, and `#`/`/` references; rejects javascript:, data:, vbscript:, and other
// absolute schemes.
//
// DOMPurify normalizes an attribute value with String.prototype.trim() FIRST,
// then strips this whitespace/control set (its ATTR_WHITESPACE) before applying
// ALLOWED_URI_REGEXP. Mirror BOTH steps here so a paste with leading/embedded
// whitespace before the scheme (e.g. " javascript:", "\tdata:") is rejected the
// same way the preview sanitizer rejects it — otherwise the raw regex matches the
// leading space via its relative-URL branch and wrongly accepts it. The trim()
// step matters independently: it removes U+FEFF (ECMAScript <ZWNBSP>), which is
// NOT in ATTR_WHITESPACE, so without trimming a U+FEFF-prefixed "javascript:"
// paste would slip through here while DOMPurify rejects it. ATTR_WHITESPACE is
// written with code-point escapes so it is unambiguous; DOMPurify's exact set.
// eslint-disable-next-line no-control-regex
const ATTR_WHITESPACE = /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g
export const isAllowedHref = (href: string): boolean =>
  ALLOWED_URI_REGEXP.test(href.trim().replace(ATTR_WHITESPACE, ''))

let hooksInstalled = false

// The render key the current sanitize() call will trust on `data-enote-render-key`.
// Set immediately before each (synchronous) DOMPurify.sanitize call; the attribute
// hook reads it to admit only anchors stamped by the matching render.
let expectedRenderKey = ''

const installHooks = (): void => {
  if (hooksInstalled) {
    return
  }
  hooksInstalled = true

  purifier.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof Element)) {
      return
    }

    // Links open in a separate context only on an explicit user click, and are
    // severed from the opener window (SPEC Section 13: links open only after
    // explicit user action; never expose `window.opener`).
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }

    // The sync anchors are the only data-* attributes admitted (ADD_ATTR below),
    // and only as a matched pair carrying app-controlled values: a numeric source
    // line AND the exact render key of the in-progress render. They are validated
    // together so an element can never keep one anchor attribute without the other
    // — a copy typed into a note's raw HTML (a lone line, or a stale/forged key)
    // has BOTH dropped here and can never become a false sync anchor. The
    // allowlist (ALLOW_DATA_ATTR stays false) remains the security boundary; this
    // pair gate is correctness only, since the attributes are inert.
    const sourceLine = node.getAttribute(SOURCE_LINE_ATTR)
    const renderKey = node.getAttribute(RENDER_KEY_ATTR)

    if (sourceLine !== null || renderKey !== null) {
      const isAppAnchor =
        sourceLine !== null && /^\d+$/.test(sourceLine) && renderKey === expectedRenderKey

      if (!isAppAnchor) {
        node.removeAttribute(SOURCE_LINE_ATTR)
        node.removeAttribute(RENDER_KEY_ATTR)
      }
    }
  })
}

// Sanitizes already-rendered HTML against the SPEC Section 13 allowlist. The
// input is expected to come from the Markdown renderer; the output is safe to
// insert into the live preview DOM. `renderKey` is the value the renderer stamped
// on this render's anchors; only attributes carrying it are kept (see hook above).
export const sanitizeMarkdownHtml = (html: string, renderKey: string): string => {
  installHooks()
  expectedRenderKey = renderKey

  return purifier.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    // The two sync anchors are admitted by name (then value-checked in the hook);
    // ALLOW_DATA_ATTR stays false so no other data-* attribute survives.
    ADD_ATTR: [SOURCE_LINE_ATTR, RENDER_KEY_ATTR],
    // Defense in depth: even if the allowlist above were ever widened, these
    // active/embedded/foreign-content elements and resource attributes must
    // never survive.
    FORBID_TAGS: ['style', 'svg', 'math', 'script', 'iframe', 'object', 'embed', 'link', 'meta', 'base'],
    FORBID_ATTR: ['style', 'srcset'],
  })
}
