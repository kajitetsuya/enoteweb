// App-generated attributes that map a rendered Markdown block back to its source
// line, for preview <-> editor position sync (SPEC: preview position sync).
//
// `data-enote-source-line` carries the 1-based source line of the block.
// `data-enote-render-key` carries a value unique to the render that produced it.
// Only these two attributes survive the Section 13 sanitizer (see sanitizeHtml.ts),
// and only as a matched pair with app-controlled values (a numeric line and the
// current render key). A copy typed into a note's own raw HTML has BOTH attributes
// dropped — its render key cannot match the current render — so it can never
// become a false sync anchor.
export const SOURCE_LINE_ATTR = 'data-enote-source-line'
export const RENDER_KEY_ATTR = 'data-enote-render-key'
