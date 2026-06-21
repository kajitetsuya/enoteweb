import { describe, expect, it } from 'vitest'
import { RENDER_KEY_ATTR, SOURCE_LINE_ATTR } from './previewAnchors'
import { renderMarkdownToSafeHtml } from './renderMarkdown'

// Parses the rendered (already-sanitized) HTML and returns the [tag, line] pair
// for every block carrying a source-line anchor stamped with the current render
// key — the exact data the preview-sync feature reads back from the DOM.
const anchorsOf = (html: string, renderKey: string): Array<[string, number]> => {
  const host = document.createElement('div')
  host.innerHTML = html

  return Array.from(
    host.querySelectorAll<HTMLElement>(`[${SOURCE_LINE_ATTR}][${RENDER_KEY_ATTR}="${renderKey}"]`),
  ).map((element) => [
    element.tagName.toLowerCase(),
    Number.parseInt(element.getAttribute(SOURCE_LINE_ATTR) ?? '', 10),
  ])
}

describe('renderMarkdownToSafeHtml', () => {
  it('renders common Markdown constructs', () => {
    const { html } = renderMarkdownToSafeHtml(
      '# Heading\n\nSome **bold** and *italic* text.\n\n- one\n- two\n',
    )
    expect(html).toContain('>Heading</h1>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
    expect(html).toContain('>one</li>')
  })

  it('renders links and fenced code blocks', () => {
    const { html } = renderMarkdownToSafeHtml('[site](https://example.com)\n\n```\ncode\n```\n')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('<pre')
    expect(html).toContain('code')
  })

  it('sanitizes raw HTML embedded in the Markdown source', () => {
    const { html } = renderMarkdownToSafeHtml('Hi <script>alert(1)</script> there')
    expect(html).not.toContain('script')
    expect(html).not.toContain('alert(1)')
    expect(html).toContain('Hi')
    expect(html).toContain('there')
  })

  it('neutralizes an inline image XSS payload', () => {
    const { html } = renderMarkdownToSafeHtml('<img src=x onerror="alert(1)">')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('alert')
  })

  it('does not emit a remote image request via Markdown image syntax', () => {
    const { html } = renderMarkdownToSafeHtml('![pixel](https://tracker.example/p.gif)')
    expect(html).not.toContain('tracker.example')
  })

  it('stamps each render with a distinct render key', () => {
    const first = renderMarkdownToSafeHtml('# A\n')
    const second = renderMarkdownToSafeHtml('# A\n')
    expect(first.renderKey).not.toBe(second.renderKey)
    expect(first.html).toContain(first.renderKey)
    expect(second.html).not.toContain(first.renderKey)
  })
})

// The whole sync feature rests on source-line offsets reconstructed from marked's
// token `raw`. These pin the mapping across the constructs most likely to drift:
// blank-line runs, fenced code (with blank lines inside), tables, nested/loose
// lists, blockquotes, and raw HTML.
describe('renderMarkdownToSafeHtml source-line anchors', () => {
  it('maps top-level blocks past blank-line runs', () => {
    //               1
    //               2 (blank)
    //               3 (blank)
    //               4
    const { html, renderKey } = renderMarkdownToSafeHtml('# Title\n\n\nA paragraph.\n')
    expect(anchorsOf(html, renderKey)).toEqual([
      ['h1', 1],
      ['p', 4],
    ])
  })

  it('maps a fenced code block that contains a blank line', () => {
    //               1 para
    //               2 (blank)
    //               3 ```
    //               4 code
    //               5 (blank inside fence)
    //               6 more
    //               7 ```
    const source = 'para\n\n```\ncode\n\nmore\n```\n'
    const { html, renderKey } = renderMarkdownToSafeHtml(source)
    expect(anchorsOf(html, renderKey)).toEqual([
      ['p', 1],
      ['pre', 3],
    ])
  })

  it('maps a table after preceding blocks', () => {
    //               1 para
    //               2 (blank)
    //               3 | a | b |
    //               4 |---|---|
    //               5 | 1 | 2 |
    const source = 'para\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'
    const { html, renderKey } = renderMarkdownToSafeHtml(source)
    expect(anchorsOf(html, renderKey)).toEqual([
      ['p', 1],
      ['table', 3],
    ])
  })

  it('maps top-level list items (loose), degrading nested items to their parent', () => {
    //               1 - a
    //               2 (blank -> loose list)
    //               3 - b
    //               4   - nested c
    //               5   - nested d
    const source = '- a\n\n- b\n  - nested c\n  - nested d\n'
    const { html, renderKey } = renderMarkdownToSafeHtml(source)
    // ul/ol containers are not anchored; only items are. marked de-indents a
    // nested list's raw, so nested items cannot be located reliably and degrade
    // to their containing top-level item (line 3) rather than getting their own
    // anchors at lines 4 and 5.
    expect(anchorsOf(html, renderKey)).toEqual([
      ['li', 1],
      ['li', 3],
    ])
  })

  it('anchors a blockquote at its container line (inner blocks degrade to it)', () => {
    //               1 intro
    //               2 (blank)
    //               3 > quoted
    const source = 'intro\n\n> quoted\n'
    const { html, renderKey } = renderMarkdownToSafeHtml(source)
    const anchors = anchorsOf(html, renderKey)
    expect(anchors).toContainEqual(['p', 1])
    expect(anchors).toContainEqual(['blockquote', 3])
    // The blockquote's inner paragraph is not separately anchored.
    expect(anchors.filter(([tag]) => tag === 'p')).toEqual([['p', 1]])
  })

  it('does not trust a source-line attribute typed into the note as raw HTML', () => {
    const { html, renderKey } = renderMarkdownToSafeHtml(
      `<p ${SOURCE_LINE_ATTR}="999" ${RENDER_KEY_ATTR}="forged">x</p>\n`,
    )
    // The forged key never matches the current render, so no anchor is trusted.
    expect(anchorsOf(html, renderKey)).toEqual([])
  })
})
