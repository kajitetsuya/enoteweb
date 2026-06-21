import { describe, expect, it } from 'vitest'
import { createHelpHeadingIdTracker, getHelpHeadingId, getHelpMarkdown } from './helpContent'

const expectLicenseAtEnd = (markdown: string) => {
  expect(markdown).toContain('## License and Warranty')
  expect(markdown.indexOf('## Common Messages')).toBeLessThan(
    markdown.indexOf('## License and Warranty'),
  )
  expect(markdown.trim()).toMatch(/## License and Warranty[\s\S]*suitable for your use\.$/)
}

const expectHomeAboutAtEnd = (markdown: string) => {
  expect(markdown).toContain('## About eNoteWeb')
  expect(markdown.indexOf('## License and Warranty')).toBeLessThan(
    markdown.indexOf('## About eNoteWeb'),
  )
  expect(markdown.trim()).toMatch(
    /## About eNoteWeb[\s\S]*Development of eNoteWeb was assisted by OpenAI ChatGPT and Anthropic Claude\.$/,
  )
}

describe('helpContent', () => {
  it('uses stable heading ids for generated Contents links', () => {
    expect(getHelpHeadingId('Home Screen and Home Settings')).toBe(
      'home-screen-and-home-settings',
    )
    expect(getHelpHeadingId('License and Warranty')).toBe('license-and-warranty')

    const nextHeadingId = createHelpHeadingIdTracker()

    expect(nextHeadingId('Storage provider')).toBe('storage-provider')
    expect(nextHeadingId('Storage provider')).toBe('storage-provider-2')
  })

  it('extracts the Home help sections without embedding comments', () => {
    const markdown = getHelpMarkdown('home')

    expect(markdown.trimStart().startsWith('## Contents')).toBe(true)
    expect(markdown).toContain('- [Core Concepts](#core-concepts)')
    expect(markdown).toContain('  - [Storage provider](#storage-provider)')
    expect(markdown).toContain('  - [Document kind](#document-kind)')
    expect(markdown).toContain(
      '- [Home Screen and Home Settings](#home-screen-and-home-settings)',
    )
    expect(markdown).toContain('  - [Storage provider](#storage-provider-2)')
    expect(markdown).toContain('  - [Password hardening](#password-hardening)')
    expect(markdown).toContain('  - [Secret key](#secret-key)')
    expect(markdown.indexOf('## Contents')).toBeLessThan(markdown.indexOf('## Core Concepts'))
    expect(markdown).toContain('## Home Screen and Home Settings')
    expect(markdown).toContain('### Password hardening')
    expect(markdown.indexOf('### Password hardening')).toBeLessThan(
      markdown.indexOf('### Secret key'),
    )
    expect(markdown).toContain('Standard` is the default')
    expect(markdown).toContain('Strong` uses more memory')
    expect(markdown).toContain('This setting is the default for future password-choosing dialogs')
    expect(markdown).toContain('Change Password dialog starts from the document')
    expect(markdown).toContain('## Home File Lists')
    expect(markdown).toContain('## Dropbox Sync and Conflicts')
    expectHomeAboutAtEnd(markdown)
    expect(markdown).not.toContain('## Editor Settings')
    expect(markdown).not.toContain('Embedding note')
  })

  it('extracts the editor help sections including regex references', () => {
    const markdown = getHelpMarkdown('editor')

    expect(markdown.trimStart().startsWith('## Contents')).toBe(true)
    expect(markdown).toContain('- [Settings Dialog Map](#settings-dialog-map)')
    expect(markdown).toContain('  - [Shared controls](#shared-controls)')
    expect(markdown).toContain('- [Editor Settings](#editor-settings)')
    expect(markdown).toContain('  - [Font](#font)')
    expect(markdown).toContain('  - [Find options](#find-options)')
    expect(markdown.indexOf('## Contents')).toBeLessThan(
      markdown.indexOf('## Settings Dialog Map'),
    )
    expect(markdown.indexOf('## Settings Dialog Map')).toBeLessThan(
      markdown.indexOf('## Editor Settings'),
    )
    expect(markdown).toContain('## Editor Settings')
    expect(markdown).toContain('Use strong password hardening')
    expect(markdown).toContain('## Find and Replace')
    expect(markdown).toContain('https://tc39.es/ecma262/#sec-patterns')
    expectLicenseAtEnd(markdown)
    expect(markdown).not.toContain('## About eNoteWeb')
    expect(markdown).not.toContain('## Home File Lists')
    expect(markdown).not.toContain('Embedding note')
  })
})
