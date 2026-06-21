import { describe, expect, it } from 'vitest'
import { RENDER_KEY_ATTR, SOURCE_LINE_ATTR } from './previewAnchors'
import { isAllowedHref, sanitizeMarkdownHtml } from './sanitizeHtml'

// The existing policy tests do not exercise the sync anchors, so they pass a
// fixed render key; the anchor-gating block below varies it deliberately.
const TEST_KEY = 'render-key-test'
const sanitize = (html: string): string => sanitizeMarkdownHtml(html, TEST_KEY)

// SPEC Section 13: the sanitizer is an allowlist and is the authoritative XSS /
// remote-resource boundary for rendered note content — it must hold even if the
// production CSP were absent. These tests exercise each policy clause directly
// against the sanitizer (not via the renderer) so a regression is unambiguous.
describe('sanitizeMarkdownHtml', () => {
  describe('active content is removed', () => {
    it('drops <script> elements and their contents', () => {
      const out = sanitize('<p>ok</p><script>alert(1)</script>')
      expect(out).toContain('<p>ok</p>')
      expect(out).not.toContain('script')
      expect(out).not.toContain('alert(1)')
    })

    it('strips inline event-handler attributes', () => {
      const out = sanitize('<img src="x.png" alt="a" onerror="alert(1)">')
      expect(out).not.toContain('onerror')
      expect(out).not.toContain('alert')
    })

    it.each([
      ['iframe', '<iframe src="https://evil.example"></iframe>'],
      ['object', '<object data="evil.swf"></object>'],
      ['embed', '<embed src="evil.swf">'],
      ['link', '<link rel="stylesheet" href="https://evil.example/x.css">'],
      ['meta', '<meta http-equiv="refresh" content="0;url=https://evil.example">'],
      ['style', '<style>body{display:none}</style>'],
      ['base', '<base href="https://evil.example/">'],
      ['svg', '<svg><use href="#x"/></svg>'],
      ['math', '<math><mtext>x</mtext></math>'],
    ])('removes <%s>', (tag, html) => {
      const out = sanitize(html)
      expect(out.toLowerCase()).not.toContain(`<${tag}`)
      expect(out).not.toContain('evil.example')
    })
  })

  describe('URL-bearing attributes', () => {
    it('removes javascript: hrefs (and does not decorate the dead link)', () => {
      const out = sanitize('<a href="javascript:alert(1)">x</a>')
      expect(out).not.toContain('javascript')
      expect(out).not.toContain('alert')
      // No href survived, so the link is not turned into a target=_blank link.
      expect(out).not.toContain('target')
    })

    it('removes data: hrefs', () => {
      const out = sanitize('<a href="data:text/html,<b>x</b>">x</a>')
      expect(out).not.toContain('data:')
    })

    it('keeps http(s) and mailto hrefs and forces a safe link target', () => {
      const https = sanitize('<a href="https://example.com/page">x</a>')
      expect(https).toContain('href="https://example.com/page"')
      expect(https).toContain('target="_blank"')
      expect(https).toContain('rel="noopener noreferrer"')

      const mail = sanitize('<a href="mailto:a@example.com">mail</a>')
      expect(mail).toContain('href="mailto:a@example.com"')
    })

    it('keeps relative hrefs', () => {
      const out = sanitize('<a href="notes/page.md">x</a>')
      expect(out).toContain('href="notes/page.md"')
    })

    it('removes hrefs with digit-containing schemes (s3:, web2:)', () => {
      // Digits are valid in a URL scheme after the first letter, so without
      // digits in the allowlist's scheme class these would be misread as
      // relative URLs and survive.
      const s3 = sanitize('<a href="s3:leak">x</a>')
      expect(s3).not.toContain('href')
      expect(s3).not.toContain('s3:')

      const web2 = sanitize('<a href="web2:payload">x</a>')
      expect(web2).not.toContain('href')
    })

    it('still keeps relative URLs that merely contain digits', () => {
      expect(sanitize('<a href="notes2/page.md">x</a>')).toContain('href="notes2/page.md"')
      expect(sanitize('<a href="2024/diary.md">x</a>')).toContain('href="2024/diary.md"')
      expect(sanitize('<a href="./a2.txt">x</a>')).toContain('href="./a2.txt"')
      expect(sanitize('<a href="#sec2">x</a>')).toContain('href="#sec2"')
    })

    it('still removes all-letter non-allowlisted schemes (tel:, vbscript:)', () => {
      expect(sanitize('<a href="tel:+1234567">x</a>')).not.toContain('href')
      expect(sanitize('<a href="vbscript:msgbox(1)">x</a>')).not.toContain('href')
    })
  })

  describe('no resource is ever auto-loaded (no src survives)', () => {
    it('strips remote (http/https) image sources but keeps the element and alt', () => {
      const out = sanitize('<img src="https://tracker.example/p.gif" alt="pixel">')
      expect(out).toContain('alt="pixel"')
      expect(out).not.toContain('tracker.example')
      expect(out).not.toContain('src=')
    })

    it('strips protocol-relative image sources', () => {
      const out = sanitize('<img src="//tracker.example/p.gif" alt="x">')
      expect(out).not.toContain('tracker.example')
      expect(out).not.toContain('src=')
    })

    it('strips data: image sources', () => {
      const out = sanitize('<img src="data:image/png;base64,AAAA" alt="x">')
      expect(out).not.toContain('data:')
      expect(out).not.toContain('src=')
    })

    it('strips same-origin/relative sources too — a relative src would still leak plaintext in the request URL', () => {
      const out = sanitize('<img src="/PLAINTEXT.png?secret=value" alt="x">')
      expect(out).toContain('alt="x"')
      expect(out).not.toContain('src=')
      expect(out).not.toContain('PLAINTEXT')
    })

    it('drops inline style and srcset', () => {
      const out = sanitize('<img src="a.png" alt="x" srcset="b.png 2x" style="position:absolute">')
      expect(out).not.toContain('srcset')
      expect(out).not.toContain('style')
    })
  })

  describe('the preview is read-only', () => {
    it('removes form controls, including raw <input>', () => {
      const out = sanitize('<p>x</p><input type="text" value="y"><input type="checkbox" checked>')
      expect(out).toContain('<p>x</p>')
      expect(out.toLowerCase()).not.toContain('<input')
    })
  })

  describe('safe presentational content survives', () => {
    it('keeps headings, emphasis, lists, code, and tables', () => {
      const out = sanitize(
        '<h1>Title</h1><p><strong>bold</strong> <em>italic</em> <code>x</code></p>' +
          '<ul><li>one</li></ul><table><tbody><tr><td>c</td></tr></tbody></table>',
      )
      expect(out).toContain('<h1>Title</h1>')
      expect(out).toContain('<strong>bold</strong>')
      expect(out).toContain('<em>italic</em>')
      expect(out).toContain('<code>x</code>')
      expect(out).toContain('<li>one</li>')
      expect(out).toContain('<td>c</td>')
    })
  })

  // The sync anchors are the only data-* attributes admitted, and only as a
  // matched pair carrying app-controlled values: a numeric source line AND the
  // exact current render key. An invalid pair has BOTH attributes dropped, so a
  // copy typed into a note's raw HTML can never leave a usable anchor behind.
  describe('source-line sync anchors', () => {
    it('keeps both anchor attributes when the render key matches and the line is numeric', () => {
      const out = sanitize(`<p ${SOURCE_LINE_ATTR}="5" ${RENDER_KEY_ATTR}="${TEST_KEY}">x</p>`)
      expect(out).toContain(`${SOURCE_LINE_ATTR}="5"`)
      expect(out).toContain(`${RENDER_KEY_ATTR}="${TEST_KEY}"`)
    })

    it('drops the whole pair when the render key does not match the current render', () => {
      const out = sanitize(`<p ${SOURCE_LINE_ATTR}="5" ${RENDER_KEY_ATTR}="stale-or-forged">x</p>`)
      expect(out).not.toContain(SOURCE_LINE_ATTR)
      expect(out).not.toContain(RENDER_KEY_ATTR)
      expect(out).not.toContain('stale-or-forged')
    })

    it('drops a lone source line that has no render key (note-authored copy)', () => {
      const out = sanitize(`<p ${SOURCE_LINE_ATTR}="999">x</p>`)
      expect(out).not.toContain(SOURCE_LINE_ATTR)
      expect(out).not.toContain('999')
    })

    it('drops the whole pair when the source line is non-numeric', () => {
      const out = sanitize(`<p ${SOURCE_LINE_ATTR}="x" ${RENDER_KEY_ATTR}="${TEST_KEY}">x</p>`)
      expect(out).not.toContain(SOURCE_LINE_ATTR)
      expect(out).not.toContain(RENDER_KEY_ATTR)
    })

    it('drops a lone render key that has no source line', () => {
      const out = sanitize(`<p ${RENDER_KEY_ATTR}="${TEST_KEY}">x</p>`)
      expect(out).not.toContain(RENDER_KEY_ATTR)
    })

    it('still admits no other data-* attribute, and leaves a valid pair intact', () => {
      const out = sanitize(
        `<p data-evil="1" ${SOURCE_LINE_ATTR}="5" ${RENDER_KEY_ATTR}="${TEST_KEY}">x</p>`,
      )
      expect(out).not.toContain('data-evil')
      expect(out).toContain(`${SOURCE_LINE_ATTR}="5"`)
      expect(out).toContain(`${RENDER_KEY_ATTR}="${TEST_KEY}"`)
    })
  })
})

// The paste handler reuses this predicate so a pasted single-anchor link cannot
// write a scheme the preview sanitizer would strip (consistency/defense-in-depth).
describe('isAllowedHref', () => {
  it.each([
    'https://example.com',
    'http://example.com',
    'mailto:user@example.com',
    '/relative/path',
    '#anchor',
  ])('accepts the safe href %s', (href) => {
    expect(isAllowedHref(href)).toBe(true)
  })

  it.each([
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'javascript:alert(1)',
    // Whitespace-prefixed dangerous schemes: DOMPurify strips ATTR_WHITESPACE
    // before its URI regex, so the preview sanitizer rejects these — the paste
    // predicate must reject them the same way (without the strip, the raw regex
    // matches the leading whitespace via its relative-URL branch and accepts).
    ' javascript:alert(1)',
    '\tdata:text/html,x',
    '\nvbscript:msgbox(1)',
    // U+FEFF (ZWNBSP) is removed by String.prototype.trim() but is NOT in
    // DOMPurify's ATTR_WHITESPACE set; DOMPurify trims first, so it strips the
    // BOM and rejects these. The predicate must trim before the strip to match.
    '﻿javascript:alert(1)',
    '﻿data:text/html,x',
  ])('rejects the dangerous href %s', (href) => {
    expect(isAllowedHref(href)).toBe(false)
  })
})
