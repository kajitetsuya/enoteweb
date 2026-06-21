import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownPreview } from './MarkdownPreview'

afterEach(cleanup)

describe('MarkdownPreview', () => {
  it('mounts rendered markdown output in the preview', () => {
    const { getByTestId } = render(
      <MarkdownPreview fontFamily="serif" fontSizePx={16} source={'# Title\n\ntext'} />,
    )
    expect(getByTestId('markdown-preview').querySelector('h1')?.textContent).toBe('Title')
  })

  it('applies the editor font family and size to the preview', () => {
    const { getByTestId } = render(
      <MarkdownPreview fontFamily="Georgia, serif" fontSizePx={22} source="x" />,
    )
    const preview = getByTestId('markdown-preview')
    expect(preview.style.fontSize).toBe('22px')
    expect(preview.style.fontFamily).toBe('Georgia, serif')
  })
})
