import { createRef } from 'react'
import { EditorView } from '@codemirror/view'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CodeMirrorEditor } from './CodeMirrorEditor'
import type { EditorHandle } from './CodeMirrorEditor'

const originalResizeObserver = globalThis.ResizeObserver

beforeAll(() => {
  // CodeMirror's EditorView uses ResizeObserver, which jsdom does not provide.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

afterAll(() => {
  globalThis.ResizeObserver = originalResizeObserver
})

afterEach(cleanup)

const baseProps = {
  autocapitalize: 'off' as const,
  autocorrect: false,
  editorMode: 'plain' as const,
  fontFamily: 'monospace',
  fontSizePx: 16,
  lineWrap: false,
  onCursorChange: () => {},
  onHistoryAvailabilityChange: () => {},
  readOnly: false,
  showWhitespace: false,
  spellcheck: false,
}

describe('CodeMirrorEditor insertText', () => {
  it('inserts text at the cursor in an empty document', () => {
    const ref = createRef<EditorHandle>()
    const onChange = vi.fn()

    render(<CodeMirrorEditor ref={ref} value="" onChange={onChange} {...baseProps} />)
    act(() => ref.current?.insertText('ABC123'))

    expect(onChange).toHaveBeenLastCalledWith('ABC123')
  })
})

describe('CodeMirrorEditor focus reporting', () => {
  it('reports focus entering and leaving the editing surface', async () => {
    const onFocusChange = vi.fn()

    render(
      <CodeMirrorEditor value="" onChange={() => {}} {...baseProps} onFocusChange={onFocusChange} />,
    )

    const content = document.querySelector('.cm-content') as HTMLElement

    // Real focus moves (not just events): CodeMirror checks activeElement.
    act(() => content.focus())
    await waitFor(() => expect(onFocusChange).toHaveBeenLastCalledWith(true))

    act(() => content.blur())
    await waitFor(() => expect(onFocusChange).toHaveBeenLastCalledWith(false))
  })
})

describe('CodeMirrorEditor viewport resume', () => {
  it('remeasures when the app returns visible without a viewport resize event', async () => {
    class FakeViewport extends EventTarget {
      height = window.innerHeight
      offsetTop = 0
      scale = 1
    }

    const previousViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport')
    const previousVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    const requestMeasure = vi.spyOn(EditorView.prototype, 'requestMeasure')

    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: new FakeViewport(),
    })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    })

    try {
      render(<CodeMirrorEditor value="" onChange={() => {}} {...baseProps} />)
      requestMeasure.mockClear()

      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })

      await waitFor(() => expect(requestMeasure).toHaveBeenCalled())
    } finally {
      requestMeasure.mockRestore()

      if (previousViewport) {
        Object.defineProperty(window, 'visualViewport', previousViewport)
      } else {
        delete (window as { visualViewport?: unknown }).visualViewport
      }

      if (previousVisibility) {
        Object.defineProperty(document, 'visibilityState', previousVisibility)
      } else {
        delete (document as { visibilityState?: unknown }).visibilityState
      }
    }
  })
})

describe('CodeMirrorEditor read-only', () => {
  it('keeps the caret surface but blocks programmatic and Tab edits', () => {
    const ref = createRef<EditorHandle>()
    const onChange = vi.fn()

    render(<CodeMirrorEditor ref={ref} value="abc" onChange={onChange} {...baseProps} readOnly />)

    const content = document.querySelector('.cm-content') as HTMLElement

    // The surface stays focusable/navigable so keyboard selection and copy
    // work; read-only is enforced at the change level.
    expect(content.getAttribute('contenteditable')).toBe('true')
    expect(content.getAttribute('aria-readonly')).toBe('true')

    act(() => ref.current?.insertText('X'))
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.keyDown(content, { key: 'Tab' })
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('CodeMirrorEditor link paste', () => {
  it('pastes a single copied hyperlink as a markdown link in markdown mode', () => {
    const ref = createRef<EditorHandle>()
    const onChange = vi.fn()

    render(
      <CodeMirrorEditor
        ref={ref}
        value=""
        onChange={onChange}
        {...baseProps}
        editorMode="markdown"
      />,
    )

    fireEvent.paste(document.querySelector('.cm-content') as HTMLElement, {
      clipboardData: {
        getData: (type: string) =>
          type === 'text/html'
            ? '<meta charset="utf-8"><a href="https://example.com/page">Example</a>'
            : 'Example',
      },
    })

    expect(onChange).toHaveBeenLastCalledWith('[Example](https://example.com/page)')
  })

  it('pastes the plain-text flavor in plain mode', () => {
    const ref = createRef<EditorHandle>()
    const onChange = vi.fn()

    render(<CodeMirrorEditor ref={ref} value="" onChange={onChange} {...baseProps} />)

    fireEvent.paste(document.querySelector('.cm-content') as HTMLElement, {
      clipboardData: {
        getData: (type: string) =>
          type === 'text/html'
            ? '<a href="https://example.com/page">Example</a>'
            : 'Example',
      },
    })

    expect(onChange).not.toHaveBeenCalledWith('[Example](https://example.com/page)')
  })

  it('leaves multi-element rich pastes to the plain default in markdown mode', () => {
    const ref = createRef<EditorHandle>()
    const onChange = vi.fn()

    render(
      <CodeMirrorEditor
        ref={ref}
        value=""
        onChange={onChange}
        {...baseProps}
        editorMode="markdown"
      />,
    )

    fireEvent.paste(document.querySelector('.cm-content') as HTMLElement, {
      clipboardData: {
        getData: (type: string) =>
          type === 'text/html'
            ? '<p>intro <a href="https://example.com">Example</a> outro</p>'
            : 'intro Example outro',
      },
    })

    expect(onChange).not.toHaveBeenCalledWith(
      expect.stringContaining('[Example](https://example.com)'),
    )
  })
})

describe('CodeMirrorEditor line-number copy', () => {
  it('reports the copied word through onLineWordCopied', () => {
    const ref = createRef<EditorHandle>()
    const onLineWordCopied = vi.fn()

    render(
      <CodeMirrorEditor
        ref={ref}
        value="hello world"
        onChange={() => {}}
        onLineWordCopied={onLineWordCopied}
        {...baseProps}
      />,
    )

    const lineNumber = Array.from(
      document.querySelectorAll('.cm-lineNumbers .cm-gutterElement'),
    ).find((element) => element.textContent === '1')

    expect(lineNumber).toBeDefined()
    fireEvent.click(lineNumber as Element)

    expect(onLineWordCopied).toHaveBeenCalledWith('world')
  })
})

describe('CodeMirrorEditor Tab key', () => {
  it('inserts a literal tab character at the cursor', () => {
    const ref = createRef<EditorHandle>()
    const onChange = vi.fn()

    render(<CodeMirrorEditor ref={ref} value="abc" onChange={onChange} {...baseProps} />)

    const content = document.querySelector('.cm-content') as HTMLElement

    fireEvent.keyDown(content, { key: 'Tab' })

    expect(onChange).toHaveBeenLastCalledWith('\tabc')
  })
})

describe('CodeMirrorEditor whitespace highlighting', () => {
  it('renders whitespace marks only while showWhitespace is on', () => {
    const ref = createRef<EditorHandle>()
    const { rerender } = render(
      <CodeMirrorEditor ref={ref} value="a b" onChange={() => {}} {...baseProps} />,
    )

    expect(document.querySelector('.cm-highlightSpace')).toBeNull()

    rerender(
      <CodeMirrorEditor ref={ref} value="a b" onChange={() => {}} {...baseProps} showWhitespace />,
    )
    expect(document.querySelector('.cm-highlightSpace')).not.toBeNull()

    rerender(<CodeMirrorEditor ref={ref} value="a b" onChange={() => {}} {...baseProps} />)
    expect(document.querySelector('.cm-highlightSpace')).toBeNull()
  })
})
