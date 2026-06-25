import { history, redo, redoDepth, undo, undoDepth } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import {
  Compartment,
  EditorSelection,
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from '@codemirror/state'
import type { Transaction } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  highlightTrailingWhitespace,
  highlightWhitespace,
  keymap,
  layer,
  lineNumbers,
  RectangleMarker,
  scrollPastEnd,
} from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { CSSProperties } from 'react'
import { copyText } from '../clipboard'
import { isAllowedHref } from '../markdown/sanitizeHtml'
import {
  findDirectionalSearchMatchSafely,
  replaceAllMatchesSafely,
  replaceCurrentMatchSafely,
  replaceSelectedMatchAndMoveSafely,
} from '../search/searchWorkerClient'
import { isSupersededResult } from '../search/searchEngine'
import type { SearchErrorCode, SearchMatch, SearchOptions } from '../search/searchEngine'
import { countGraphemes, countWords, extractLastWordRange } from './textMetrics'

export type EditorCursorInfo = {
  // 1-based line and column of the primary selection head.
  line: number
  column: number
  // Grapheme-cluster length of the primary selection (0 when it is empty).
  selectionLength: number
  // Word count of the primary selection (0 when it is empty).
  selectionWordCount: number
}

type SearchHighlightRange = {
  from: number
  to: number
}

const setSearchHighlightsEffect = StateEffect.define<SearchHighlightRange[]>()
const searchHighlightMark = Decoration.mark({ class: 'cm-search-match' })
const selectedSearchHighlightMark = Decoration.mark({ class: 'cm-search-match-selected' })

type SearchHighlightState = {
  decorations: DecorationSet
  ranges: SearchHighlightRange[]
}

const mapSearchHighlightRanges = (ranges: SearchHighlightRange[], transaction: Transaction) =>
  ranges
    .map((range) => ({
      from: transaction.changes.mapPos(range.from),
      to: transaction.changes.mapPos(range.to),
    }))
    .filter((range) => range.from < range.to)

const buildSearchHighlightDecorations = (
  ranges: SearchHighlightRange[],
  state: EditorState,
): DecorationSet => {
  const builder = new RangeSetBuilder<Decoration>()
  const selection = state.selection.main

  for (const range of ranges) {
    if (range.from < range.to) {
      const mark =
        selection.from === range.from && selection.to === range.to
          ? selectedSearchHighlightMark
          : searchHighlightMark

      builder.add(range.from, range.to, mark)
    }
  }

  return builder.finish()
}

const searchHighlightField = StateField.define<SearchHighlightState>({
  create: (state) => ({
    decorations: buildSearchHighlightDecorations([], state),
    ranges: [],
  }),
  update: (highlightState, transaction) => {
    let ranges = transaction.docChanged
      ? mapSearchHighlightRanges(highlightState.ranges, transaction)
      : highlightState.ranges
    let shouldRebuild = transaction.docChanged || Boolean(transaction.selection)

    for (const effect of transaction.effects) {
      if (effect.is(setSearchHighlightsEffect)) {
        ranges = effect.value
        shouldRebuild = true
      }
    }

    return shouldRebuild
      ? { decorations: buildSearchHighlightDecorations(ranges, transaction.state), ranges }
      : highlightState
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
})

export type EditorSearchCommandResult = {
  currentIndex: number
  error: SearchErrorCode | null
  matchCount: number
  message: string
  ok: boolean
  // Set when a newer regex request superseded this one before it settled. The
  // caller must ignore the result entirely (no message), not treat it as an
  // error.
  superseded?: true
}

export type EditorReplaceCommandResult = {
  count: number
  error: SearchErrorCode | null
  message: string
  ok: boolean
  // See EditorSearchCommandResult.superseded.
  superseded?: true
}

export type EditorHandle = {
  findNext: (query: string, options: SearchOptions) => Promise<EditorSearchCommandResult>
  findPrevious: (query: string, options: SearchOptions) => Promise<EditorSearchCommandResult>
  focus: () => void
  // 1-based source line at the top of the editor viewport (for preview sync).
  getTopVisibleLine: () => number
  insertText: (text: string) => void
  replaceAll: (
    query: string,
    replacement: string,
    options: SearchOptions,
  ) => Promise<EditorReplaceCommandResult>
  replaceCurrent: (
    query: string,
    replacement: string,
    options: SearchOptions,
  ) => Promise<EditorReplaceCommandResult>
  replaceNext: (
    query: string,
    replacement: string,
    options: SearchOptions,
  ) => Promise<EditorReplaceCommandResult>
  replacePrevious: (
    query: string,
    replacement: string,
    options: SearchOptions,
  ) => Promise<EditorReplaceCommandResult>
  redo: () => boolean
  // Scrolls so `line` (1-based) sits at the top of the editor viewport (preview sync).
  scrollLineToTop: (line: number) => void
  setSearchHighlights: (matches: SearchMatch[]) => void
  undo: () => boolean
}

type CodeMirrorEditorProps = {
  autocapitalize: 'off' | 'none' | 'sentences' | 'words' | 'characters'
  autocorrect: boolean
  editorMode: 'plain' | 'markdown'
  fontFamily: string
  fontSizePx: number
  lineWrap: boolean
  onChange: (value: string) => void
  onCursorChange: (info: EditorCursorInfo) => void
  onHistoryAvailabilityChange: (availability: { canRedo: boolean; canUndo: boolean }) => void
  // Called after a line-number tap copies that line's last word, so the app
  // can confirm the copy (and, on a device, reveal whether the tap was even
  // delivered — the write itself has no observable result).
  onLineWordCopied?: ((word: string) => void) | undefined
  // Reports focus entering/leaving the editing surface. The app combines it
  // with the on-screen-keyboard signal to retract chrome only while the
  // keyboard belongs to the EDITOR (focus in find/replace must not retract).
  onFocusChange?: ((focused: boolean) => void) | undefined
  // Document-level read-only (SPEC §11): blocks typing, paste, cut, and
  // programmatic edits while keeping selection, copy, and search usable.
  readOnly: boolean
  showWhitespace: boolean
  spellcheck: boolean
  // Height (px) of UI overlaying the editor's top edge (the search panel):
  // scroll-into-view operations keep their target below this strip.
  topScrollMargin?: number | undefined
  value: string
}

type EditorStyle = CSSProperties & {
  '--editor-font-family': string
  '--editor-font-size': string
}

const getHistoryAvailability = (state: EditorState) => ({
  canRedo: redoDepth(state) > 0,
  canUndo: undoDepth(state) > 0,
})

const getCursorInfo = (state: EditorState): EditorCursorInfo => {
  const selection = state.selection.main
  const line = state.doc.lineAt(selection.head)
  const selectedText = selection.empty ? '' : state.sliceDoc(selection.from, selection.to)

  return {
    line: line.number,
    column: countGraphemes(line.text.slice(0, selection.head - line.from)) + 1,
    selectionLength: selection.empty ? 0 : countGraphemes(selectedText),
    selectionWordCount: selection.empty ? 0 : countWords(selectedText),
  }
}

const selectMatch = (view: EditorView, match: SearchMatch) => {
  view.dispatch({
    selection: { anchor: match.from, head: match.to },
    scrollIntoView: true,
  })
  view.focus()
}

const noViewResult = (): EditorSearchCommandResult => ({
  currentIndex: -1,
  error: null,
  matchCount: 0,
  message: 'Editor is not ready.',
  ok: false,
})

const getSearchResult = (
  view: EditorView,
  query: string,
  options: SearchOptions,
  direction: 'next' | 'previous',
): Promise<EditorSearchCommandResult> => {
  const text = view.state.doc.toString()
  const selection = view.state.selection.main

  return findDirectionalSearchMatchSafely(
    text,
    query,
    options,
    { from: selection.from, to: selection.to },
    direction,
  )
    .then((result) => {
      if (isSupersededResult(result)) {
        return supersededSearchResult()
      }

      if (view.state.doc.toString() !== text) {
        return {
          currentIndex: -1,
          error: null,
          matchCount: 0,
          message: 'Document changed. Try again.',
          ok: false,
        }
      }

      if (result.match) {
        selectMatch(view, result.match)
      }

      return {
        currentIndex: result.currentIndex,
        error: result.error,
        matchCount: result.matchCount,
        message: result.message,
        ok: result.ok,
      }
    })
}

const noReplaceResult = (): EditorReplaceCommandResult => ({
  count: 0,
  error: null,
  message: 'Editor is not ready.',
  ok: false,
})

// A regex request that a newer request superseded settles as a no-op: the
// caller ignores it (no document change, no message), so a fresher request can
// drive the outcome.
const supersededSearchResult = (): EditorSearchCommandResult => ({
  currentIndex: -1,
  error: null,
  matchCount: 0,
  message: '',
  ok: false,
  superseded: true,
})

const supersededReplaceResult = (): EditorReplaceCommandResult => ({
  count: 0,
  error: null,
  message: '',
  ok: false,
  superseded: true,
})

const documentChangedResult = (): EditorReplaceCommandResult => ({
  count: 0,
  error: null,
  message: 'Document changed. Try again.',
  ok: false,
})

// Markdown mode highlights GitHub Flavored Markdown (tables, strikethrough,
// task lists) to match the preview renderer's GFM support (SPEC §13).
const markdownWithGfm = () => markdown({ extensions: GFM })

// Whitespace marks (space/tab) plus trailing-whitespace highlighting, toggled
// together by the `Show whitespace` editor setting (SPEC §11).
const whitespaceExtensions = () => [highlightWhitespace(), highlightTrailingWhitespace()]

// A rich-clipboard paste consisting of EXACTLY one linked text (a single
// anchor that is the whole copied content) becomes a markdown link in
// markdown mode (SPEC §11). Anything more complex
// pastes as plain text — no general HTML→markdown conversion is attempted,
// so ordinary pastes can never be mangled.
const singleAnchorMarkdownLink = (html: string, plain: string): string | null => {
  let parsed: Document

  try {
    parsed = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return null
  }

  const anchors = parsed.querySelectorAll('a[href]')

  if (anchors.length !== 1) {
    return null
  }

  const anchor = anchors[0]
  const text = anchor?.textContent?.trim() ?? ''
  const href = anchor?.getAttribute('href') ?? ''

  if (!text || !href || !isAllowedHref(href)) {
    return null
  }

  // Only when the linked text IS the whole copied content (both in the HTML
  // flavor and the plain-text flavor of the clipboard).
  if (parsed.body.textContent?.trim() !== text || plain.trim() !== text) {
    return null
  }

  // Destinations with spaces or parentheses need the angle-bracket form.
  const destination = /[\s()<>]/.test(href) ? `<${href}>` : href
  const label = text.replace(/([[\]])/g, '\\$1')

  return `[${label}](${destination})`
}

// Read-only mode: `EditorState.readOnly` makes commands and DOM input refuse
// document changes, while the surface deliberately STAYS editable-looking —
// the caret remains, arrow keys move it, Shift+arrows select, and Ctrl+C
// copies. Direct dispatches are NOT covered by the facet,
// so programmatic edit paths (insertText, the Tab binding) carry their own
// `state.readOnly` guards.
const readOnlyExtensions = () => [
  EditorState.readOnly.of(true),
  // inputmode none: tapping a read-only document on iOS places the caret
  // (selection and copy keep working) without raising the on-screen
  // keyboard, which could only ever type into the void.
  EditorView.contentAttributes.of({ 'aria-readonly': 'true', inputmode: 'none' }),
]

// The insertion point must stay visible while the editor is NOT focused
// because on iOS the toolbar can only be used with the keyboard
// down, i.e. the editor blurred, and e.g. Insert Random String inserts at a
// caret the user otherwise could not see. Neither built-in caret covers this
// state — the native caret leaves with focus, and drawSelection's layer is
// both gated on .cm-focused and skips the primary cursor on iOS entirely —
// so this layer draws the primary caret exactly when the view is unfocused.
const unfocusedCaretLayer = layer({
  above: true,
  class: 'cm-unfocusedCaretLayer',
  markers(view) {
    if (view.hasFocus) {
      return []
    }

    const main = view.state.selection.main
    const cursor = main.empty
      ? main
      : EditorSelection.cursor(main.head, main.head > main.anchor ? -1 : 1)

    return RectangleMarker.forRange(view, 'cm-unfocused-caret', cursor)
  },
  update(update) {
    return (
      update.docChanged ||
      update.selectionSet ||
      update.focusChanged ||
      update.geometryChanged ||
      update.viewportChanged
    )
  },
})

// Copies the line's last word AND selects it, so the user sees exactly which
// string was copied. Selection works in read-only mode too —
// read-only blocks document changes, not the selection — and dispatching a
// selection does not scroll or steal focus, so the gutter tap stays put. Kept at
// module scope so the gutter handlers that call it stay stable for the once-built
// view effect (no spurious exhaustive-deps dependency).
const copyAndSelectLastWordOfLine = (
  view: EditorView,
  lineFrom: number,
  onCopied: ((word: string) => void) | undefined,
) => {
  const line = view.state.doc.lineAt(lineFrom)
  const { start, end } = extractLastWordRange(line.text)

  if (end <= start) {
    return
  }

  const word = line.text.slice(start, end)

  copyText(word)
  view.dispatch({ selection: { anchor: line.from + start, head: line.from + end } })
  onCopied?.(word)
}

export const CodeMirrorEditor = forwardRef<EditorHandle, CodeMirrorEditorProps>(
  function CodeMirrorEditor(
    {
      autocapitalize,
      autocorrect,
      editorMode,
      fontFamily,
      fontSizePx,
      lineWrap,
      onChange,
      onCursorChange,
      onHistoryAvailabilityChange,
      onLineWordCopied,
      onFocusChange,
      readOnly,
      showWhitespace,
      spellcheck,
      topScrollMargin = 0,
      value,
    },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement | null>(null)
    const viewRef = useRef<EditorView | null>(null)
    const onChangeRef = useRef(onChange)
    const onCursorChangeRef = useRef(onCursorChange)
    const onHistoryAvailabilityChangeRef = useRef(onHistoryAvailabilityChange)
    const initialValueRef = useRef(value)
    const initialLineWrapRef = useRef(lineWrap)
    const initialEditorModeRef = useRef(editorMode)
    const initialTextServicesRef = useRef({ autocapitalize, autocorrect, spellcheck })
    const initialShowWhitespaceRef = useRef(showWhitespace)
    const initialReadOnlyRef = useRef(readOnly)
    // Read by stable closures inside the once-built extensions, so none of
    // these need a compartment reconfigure when the prop changes.
    const onLineWordCopiedRef = useRef(onLineWordCopied)
    const onFocusChangeRef = useRef(onFocusChange)
    const topScrollMarginRef = useRef(topScrollMargin)
    const editorModeRef = useRef(editorMode)
    const lineWrapCompartmentRef = useRef(new Compartment())
    const languageCompartmentRef = useRef(new Compartment())
    const overlayPaddingCompartmentRef = useRef(new Compartment())
    const readOnlyCompartmentRef = useRef(new Compartment())
    const textServicesCompartmentRef = useRef(new Compartment())
    const whitespaceCompartmentRef = useRef(new Compartment())

    useEffect(() => {
      onChangeRef.current = onChange
    }, [onChange])

    useEffect(() => {
      onLineWordCopiedRef.current = onLineWordCopied
    }, [onLineWordCopied])

    useEffect(() => {
      onFocusChangeRef.current = onFocusChange
    }, [onFocusChange])

    useEffect(() => {
      editorModeRef.current = editorMode
    }, [editorMode])

    // The overlay strip needs more than a scroll margin: a match on line 1
    // can never be scrolled below the panel, because the document starts at
    // scrollTop 0 — there is nothing above it to scroll away. Top padding on
    // the scroller (which scrolls with the content, gutter included) creates
    // that headroom, and the simultaneous scrollTop compensation keeps the
    // visible text exactly where it was when the panel opens or closes.
    const appliedTopMarginRef = useRef(0)

    useEffect(() => {
      topScrollMarginRef.current = topScrollMargin

      const view = viewRef.current
      const previous = appliedTopMarginRef.current

      if (!view || previous === topScrollMargin) {
        return
      }

      appliedTopMarginRef.current = topScrollMargin
      view.dispatch({
        effects: overlayPaddingCompartmentRef.current.reconfigure(
          topScrollMargin > 0
            ? EditorView.theme({ '.cm-scroller': { paddingTop: `${topScrollMargin}px` } })
            : [],
        ),
      })
      view.scrollDOM.scrollTop += topScrollMargin - previous
    }, [topScrollMargin])

    // Shared by the line-number gutter's click and touchend handlers (iOS
    // Safari delivers only the touch event there). The first render's instance
    // is the one captured by the once-built extensions; it reports the copied
    // word through a stable ref. `copyAndSelectLastWordOfLine` is module-level so
    // this stays stable for the once-built view effect. Returning true marks the
    // gutter event handled.
    const copyLastWordOfGutterLine = (view: EditorView, block: { from: number }) => {
      copyAndSelectLastWordOfLine(view, block.from, onLineWordCopiedRef.current)

      return true
    }

    useEffect(() => {
      onCursorChangeRef.current = onCursorChange
    }, [onCursorChange])

    useEffect(() => {
      onHistoryAvailabilityChangeRef.current = onHistoryAvailabilityChange
    }, [onHistoryAvailabilityChange])

    useImperativeHandle(
      ref,
      () => ({
        findNext: async (query, options) => {
          const view = viewRef.current
          return view ? getSearchResult(view, query, options, 'next') : noViewResult()
        },
        findPrevious: async (query, options) => {
          const view = viewRef.current
          return view ? getSearchResult(view, query, options, 'previous') : noViewResult()
        },
        focus: () => viewRef.current?.focus(),
        getTopVisibleLine: () => {
          const view = viewRef.current

          if (!view) {
            return 1
          }

          // Convert the scroller's scroll offset into the document's height
          // coordinate space (0 = first content line) by removing the top
          // content padding, then read the line block at that height. This is
          // scroll-relative, so it is correct regardless of where the editor
          // sits on screen, and accurate with line wrapping on.
          const height = Math.max(0, view.scrollDOM.scrollTop - view.documentPadding.top)
          const block = view.lineBlockAtHeight(height)

          return view.state.doc.lineAt(block.from).number
        },
        insertText: (text) => {
          const view = viewRef.current

          // Programmatic dispatches bypass EditorView.editable, so read-only
          // must be enforced here too (the toolbar button is also disabled).
          if (!view || view.state.readOnly) {
            return
          }

          // Replaces the primary selection with `text` (inserting at the cursor
          // when the selection is empty) and places the cursor after it, scrolling
          // the insertion point into view so it is always visible even if the
          // cursor was off-screen. This dispatches a normal document change, so
          // onChange/onCursorChange and the undo history update like any other edit.
          view.dispatch({
            ...view.state.replaceSelection(text),
            scrollIntoView: true,
          })
          view.focus()
        },
        replaceAll: async (query, replacement, options) => {
          const view = viewRef.current

          if (!view) {
            return noReplaceResult()
          }

          const text = view.state.doc.toString()
          const result = await replaceAllMatchesSafely(text, query, options, replacement)

          if (isSupersededResult(result)) {
            return supersededReplaceResult()
          }

          if (view.state.doc.toString() !== text) {
            return documentChangedResult()
          }

          if (!result.ok) {
            return {
              count: 0,
              error: result.error,
              message: result.message,
              ok: false,
            }
          }

          // Keep the caret (roughly) where it was: the whole document is
          // replaced in one change, so position mapping cannot survive it —
          // anchor by line/column instead, clamped to the new text. Replaced
          // spans shift content, so this is approximate by design. The
          // selection-only dispatch adds no undo step.
          const head = view.state.selection.main.head
          const headLine = view.state.doc.lineAt(head)
          const lineNumber = headLine.number
          const column = head - headLine.from

          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: result.text },
          })

          const newDoc = view.state.doc
          const targetLine = newDoc.line(Math.min(lineNumber, newDoc.lines))

          view.dispatch({
            selection: { anchor: Math.min(targetLine.from + column, targetLine.to) },
            scrollIntoView: true,
          })
          view.focus()

          return {
            count: result.count,
            error: null,
            message: result.message,
            ok: true,
          }
        },
        replaceCurrent: async (query, replacement, options) => {
          const view = viewRef.current

          if (!view) {
            return noReplaceResult()
          }

          const text = view.state.doc.toString()
          const selection = view.state.selection.main
          const result = await replaceCurrentMatchSafely(
            text,
            query,
            options,
            { from: selection.from, to: selection.to },
            replacement,
          )

          if (isSupersededResult(result)) {
            return supersededReplaceResult()
          }

          if (view.state.doc.toString() !== text) {
            return documentChangedResult()
          }

          if (!result.ok) {
            return {
              count: 0,
              error: result.error,
              message: result.message,
              ok: false,
            }
          }

          if (!result.change) {
            return {
              count: result.count,
              error: result.error,
              message: result.message,
              ok: result.ok,
            }
          }

          view.dispatch({
            changes: result.change,
            selection: result.nextSelection
              ? { anchor: result.nextSelection.from, head: result.nextSelection.to }
              : { anchor: result.change.from },
            scrollIntoView: true,
          })
          view.focus()

          return {
            count: result.count,
            error: null,
            message: result.message,
            ok: true,
          }
        },
        replaceNext: async (query, replacement, options) => {
          const view = viewRef.current

          if (!view) {
            return noReplaceResult()
          }

          const text = view.state.doc.toString()
          const selection = view.state.selection.main
          const result = await replaceSelectedMatchAndMoveSafely(
            text,
            query,
            options,
            { from: selection.from, to: selection.to },
            replacement,
            'next',
          )

          if (isSupersededResult(result)) {
            return supersededReplaceResult()
          }

          if (view.state.doc.toString() !== text) {
            return documentChangedResult()
          }

          if (result.change) {
            view.dispatch({
              changes: result.change,
              selection: result.nextSelection
                ? { anchor: result.nextSelection.from, head: result.nextSelection.to }
                : { anchor: result.change.from },
              scrollIntoView: true,
            })
            view.focus()
          } else if (result.nextSelection) {
            selectMatch(view, {
              from: result.nextSelection.from,
              lineNumber: 0,
              lineText: '',
              snippet: '',
              text: '',
              to: result.nextSelection.to,
            })
          }

          return {
            count: result.count,
            error: result.error,
            message: result.message,
            ok: result.ok,
          }
        },
        replacePrevious: async (query, replacement, options) => {
          const view = viewRef.current

          if (!view) {
            return noReplaceResult()
          }

          const text = view.state.doc.toString()
          const selection = view.state.selection.main
          const result = await replaceSelectedMatchAndMoveSafely(
            text,
            query,
            options,
            { from: selection.from, to: selection.to },
            replacement,
            'previous',
          )

          if (isSupersededResult(result)) {
            return supersededReplaceResult()
          }

          if (view.state.doc.toString() !== text) {
            return documentChangedResult()
          }

          if (result.change) {
            view.dispatch({
              changes: result.change,
              selection: result.nextSelection
                ? { anchor: result.nextSelection.from, head: result.nextSelection.to }
                : { anchor: result.change.from },
              scrollIntoView: true,
            })
            view.focus()
          } else if (result.nextSelection) {
            selectMatch(view, {
              from: result.nextSelection.from,
              lineNumber: 0,
              lineText: '',
              snippet: '',
              text: '',
              to: result.nextSelection.to,
            })
          }

          return {
            count: result.count,
            error: result.error,
            message: result.message,
            ok: result.ok,
          }
        },
        redo: () => {
          const view = viewRef.current
          return view ? redo(view) : false
        },
        scrollLineToTop: (line) => {
          const view = viewRef.current

          if (!view) {
            return
          }

          const clamped = Math.min(Math.max(1, Math.floor(line)), view.state.doc.lines)
          const pos = view.state.doc.line(clamped).from

          view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 0 }) })
        },
        setSearchHighlights: (matches) => {
          const view = viewRef.current

          if (view) {
            view.dispatch({ effects: setSearchHighlightsEffect.of(matches) })
          }
        },
        undo: () => {
          const view = viewRef.current
          return view ? undo(view) : false
        },
      }),
      [],
    )

    useEffect(() => {
      if (!hostRef.current || viewRef.current) {
        return
      }

      const view = new EditorView({
        parent: hostRef.current,
        state: EditorState.create({
          doc: initialValueRef.current,
          extensions: [
            basicSetup,
            // Tab inserts a literal tab character at the cursor, replacing any
            // selection — typewriter semantics for notes, not code-editor line
            // indentation. Escape then Tab remains
            // the standard keyboard path out of the editor.
            keymap.of([
              {
                key: 'Tab',
                run: (view) => {
                  // Direct dispatch bypasses EditorState.readOnly — guard here
                  // (returning false lets Tab fall through to focus navigation,
                  // the natural behavior for a non-editable surface).
                  if (view.state.readOnly) {
                    return false
                  }

                  view.dispatch(view.state.replaceSelection('\t'), {
                    scrollIntoView: true,
                    userEvent: 'input.type',
                  })
                  return true
                },
              },
            ]),
            // Deepen undo retention beyond basicSetup's default (SPEC §11)
            // — history configs combine, the larger minDepth wins.
            history({ minDepth: 10_000 }),
            // The last line can scroll up past the bottom of the view, so the
            // end of the note is writable above the on-screen keyboard.
            scrollPastEnd(),
            // Clicking (or tapping) a line number copies that line's last word —
            // its final non-whitespace run — to the system clipboard (Section 11).
            // basicSetup already adds a lineNumbers() gutter; @codemirror/view
            // merges domEventHandlers across lineNumbers() configs into the single
            // line-number gutter, so this attaches the handler without creating a
            // second gutter. The clipboard write runs synchronously in the user
            // gesture (see copyText) to preserve transient activation. Returning
            // true marks the gutter event handled. `touchend` is wired alongside
            // `click` because iOS Safari does not deliver a click on the gutter;
            // the handled touchend is preventDefaulted by the gutter code, which
            // also suppresses the synthetic click on platforms that send both.
            lineNumbers({
              domEventHandlers: {
                click: copyLastWordOfGutterLine,
                touchend: copyLastWordOfGutterLine,
              },
            }),
            // The search panel overlays the editor's top edge (SPEC Section 12):
            // declare that strip as a scroll margin so every scroll-into-view
            // (match navigation, caret reveal, typing) keeps its target below
            // the panel instead of underneath it. Works together with the
            // scroller top padding above, which makes the position reachable
            // even for the document's first lines. 0 while the panel is closed.
            EditorView.scrollMargins.of(() => ({ top: topScrollMarginRef.current })),
            overlayPaddingCompartmentRef.current.of([]),
            // Copied rich text that is exactly one linked text pastes as a
            // markdown link in markdown mode (see singleAnchorMarkdownLink).
            // Plain mode, multi-element pastes, and plain-text pastes fall
            // through to CM's default plain paste. Returning true suppresses
            // the default for the handled case.
            EditorView.domEventHandlers({
              paste: (event, view) => {
                if (view.state.readOnly || editorModeRef.current !== 'markdown') {
                  return false
                }

                const html = event.clipboardData?.getData('text/html') ?? ''
                const plain = event.clipboardData?.getData('text/plain') ?? ''

                if (!html || !plain) {
                  return false
                }

                const link = singleAnchorMarkdownLink(html, plain)

                if (!link) {
                  return false
                }

                view.dispatch({
                  ...view.state.replaceSelection(link),
                  scrollIntoView: true,
                  userEvent: 'input.paste',
                })
                return true
              },
            }),
            languageCompartmentRef.current.of(
              initialEditorModeRef.current === 'markdown' ? markdownWithGfm() : [],
            ),
            searchHighlightField,
            lineWrapCompartmentRef.current.of(
              initialLineWrapRef.current ? EditorView.lineWrapping : [],
            ),
            whitespaceCompartmentRef.current.of(
              initialShowWhitespaceRef.current ? whitespaceExtensions() : [],
            ),
            readOnlyCompartmentRef.current.of(
              initialReadOnlyRef.current ? readOnlyExtensions() : [],
            ),
            textServicesCompartmentRef.current.of(
              EditorView.contentAttributes.of({
                'aria-label': 'Encrypted note text',
                autocapitalize: initialTextServicesRef.current.autocapitalize,
                autocorrect: initialTextServicesRef.current.autocorrect ? 'on' : 'off',
                spellcheck: initialTextServicesRef.current.spellcheck ? 'true' : 'false',
              }),
            ),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) {
                onChangeRef.current(update.state.doc.toString())
                onHistoryAvailabilityChangeRef.current(getHistoryAvailability(update.state))
              }

              if (update.docChanged || update.selectionSet) {
                onCursorChangeRef.current(getCursorInfo(update.state))
              }

              if (update.focusChanged) {
                onFocusChangeRef.current?.(update.view.hasFocus)
              }
            }),
            unfocusedCaretLayer,
          ],
        }),
      })

      viewRef.current = view
      onHistoryAvailabilityChangeRef.current(getHistoryAvailability(view.state))
      onCursorChangeRef.current(getCursorInfo(view.state))

      // iOS routes taps on the line-number DIGITS to the adjacent fold gutter
      // (touch-radius target selection), so CM's per-gutter touchend handler
      // never fires for them — on the device only the thin left edge copied
      // correctly. Geometry decides instead of the event
      // target: a touch ending left of the fold gutter's start copies (and
      // its preventDefault suppresses the synthetic click, so no fold
      // toggles); a touch on the fold gutter itself is left alone and folds.
      // CM's own handler still serves desktop clicks and, where it fires
      // first, marks the event handled (defaultPrevented) so this never
      // copies twice.
      const gutterContainer = view.dom.querySelector('.cm-gutters')
      const onGutterTouchEnd = (event: Event) => {
        if (event.defaultPrevented) {
          return
        }

        const touch = (event as TouchEvent).changedTouches?.[0]
        const numbersRect = gutterContainer
          ?.querySelector('.cm-lineNumbers')
          ?.getBoundingClientRect()

        if (!touch || !numbersRect || touch.clientX > numbersRect.right) {
          return
        }

        const block = view.lineBlockAtHeight(touch.clientY - view.documentTop)

        copyAndSelectLastWordOfLine(view, block.from, onLineWordCopiedRef.current)
        event.preventDefault()
      }

      gutterContainer?.addEventListener('touchend', onGutterTouchEnd)

      return () => {
        gutterContainer?.removeEventListener('touchend', onGutterTouchEnd)
        view.destroy()
        viewRef.current = null
      }
    }, [])

    useEffect(() => {
      const view = viewRef.current

      if (!view) {
        return
      }

      view.dispatch({
        effects: lineWrapCompartmentRef.current.reconfigure(
          lineWrap ? EditorView.lineWrapping : [],
        ),
      })
    }, [lineWrap])

    useEffect(() => {
      const view = viewRef.current

      if (!view) {
        return
      }

      view.dispatch({
        effects: whitespaceCompartmentRef.current.reconfigure(
          showWhitespace ? whitespaceExtensions() : [],
        ),
      })
    }, [showWhitespace])

    useEffect(() => {
      const view = viewRef.current

      if (!view) {
        return
      }

      view.dispatch({
        effects: readOnlyCompartmentRef.current.reconfigure(
          readOnly ? readOnlyExtensions() : [],
        ),
      })
    }, [readOnly])

    // iOS keyboard/app-switching: after the visual viewport changes, or after
    // the app foregrounds from an orientation change, CodeMirror can keep stale
    // geometry. Re-measure after layout settles, and reveal the caret when the
    // editor still owns focus.
    useEffect(() => {
      const viewport = typeof window !== 'undefined' ? window.visualViewport : null
      let measureFrame = 0
      let settledMeasureFrame = 0
      const requestFrame = (callback: FrameRequestCallback) =>
        typeof window.requestAnimationFrame === 'function'
          ? window.requestAnimationFrame(callback)
          : window.setTimeout(() => callback(window.performance.now()), 0)
      const cancelFrame = (handle: number) => {
        if (typeof window.cancelAnimationFrame === 'function') {
          window.cancelAnimationFrame(handle)
        } else {
          window.clearTimeout(handle)
        }
      }

      const syncEditorViewport = () => {
        const view = viewRef.current

        if (!view) {
          return
        }

        view.requestMeasure()

        if (view.hasFocus) {
          view.dispatch({
            effects: EditorView.scrollIntoView(view.state.selection.main.head),
          })
        }
      }

      const syncAfterLayout = () => {
        if (measureFrame) {
          cancelFrame(measureFrame)
        }

        measureFrame = requestFrame(() => {
          measureFrame = 0
          syncEditorViewport()
        })
      }

      const syncAfterForegroundSettles = () => {
        syncAfterLayout()

        if (settledMeasureFrame) {
          cancelFrame(settledMeasureFrame)
        }

        settledMeasureFrame = requestFrame(() => {
          settledMeasureFrame = 0
          syncAfterLayout()
        })
      }

      const syncWhenVisible = () => {
        if (document.visibilityState === 'visible') {
          syncAfterForegroundSettles()
        }
      }

      viewport?.addEventListener('resize', syncAfterLayout)
      document.addEventListener('visibilitychange', syncWhenVisible)
      window.addEventListener('focus', syncAfterForegroundSettles)
      window.addEventListener('pageshow', syncAfterForegroundSettles)
      window.addEventListener('orientationchange', syncAfterForegroundSettles)

      return () => {
        viewport?.removeEventListener('resize', syncAfterLayout)
        document.removeEventListener('visibilitychange', syncWhenVisible)
        window.removeEventListener('focus', syncAfterForegroundSettles)
        window.removeEventListener('pageshow', syncAfterForegroundSettles)
        window.removeEventListener('orientationchange', syncAfterForegroundSettles)

        if (measureFrame) {
          cancelFrame(measureFrame)
        }
        if (settledMeasureFrame) {
          cancelFrame(settledMeasureFrame)
        }
      }
    }, [])

    useEffect(() => {
      const view = viewRef.current

      if (!view) {
        return
      }

      view.dispatch({
        effects: languageCompartmentRef.current.reconfigure(
          editorMode === 'markdown' ? markdownWithGfm() : [],
        ),
      })
    }, [editorMode])

    useEffect(() => {
      const view = viewRef.current

      if (!view) {
        return
      }

      view.dispatch({
        effects: textServicesCompartmentRef.current.reconfigure(
          EditorView.contentAttributes.of({
            'aria-label': 'Encrypted note text',
            autocapitalize,
            autocorrect: autocorrect ? 'on' : 'off',
            spellcheck: spellcheck ? 'true' : 'false',
          }),
        ),
      })
    }, [autocapitalize, autocorrect, spellcheck])

    useEffect(() => {
      const view = viewRef.current

      if (!view || view.state.doc.toString() === value) {
        return
      }

      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: value,
        },
      })
    }, [value])

    const editorStyle: EditorStyle = {
      '--editor-font-family': fontFamily,
      '--editor-font-size': `${fontSizePx}px`,
    }

    return <div ref={hostRef} className="editor-host" data-testid="editor" style={editorStyle} />
  },
)
