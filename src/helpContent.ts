import helpMarkdown from '../HELP.md?raw'

export type HelpContext = 'editor' | 'home'

const homeSections = [
  'Core Concepts',
  'Settings Dialog Map',
  'Home Screen and Home Settings',
  'Home File Lists',
  'Dropbox Sync and Conflicts',
  'Offline Use',
  'Privacy and Security Limits',
  'Common Messages',
  'License and Warranty',
  'About eNoteWeb',
]

const editorSections = [
  'Settings Dialog Map',
  'Editor Settings',
  'Editor Basics',
  'Autosave and Locking',
  'Storage Actions in the Editor',
  'Passwords and Change Password',
  'Read-only',
  'Find and Replace',
  'Markdown',
  'Random String',
  'Line Number Copy',
  'Privacy and Security Limits',
  'Common Messages',
  'License and Warranty',
]

const stripHtmlComments = (source: string) => source.replace(/<!--[\s\S]*?-->\s*/g, '')

const collectTopLevelSections = (source: string): ReadonlyMap<string, string> => {
  const sections = new Map<string, string>()
  const lines = stripHtmlComments(source).split(/\r?\n/)
  let activeTitle: string | null = null
  let activeLines: string[] = []

  const flush = () => {
    if (activeTitle) {
      sections.set(activeTitle, activeLines.join('\n').trim())
    }
  }

  for (const line of lines) {
    const heading = /^## ([^\n]+)$/.exec(line)

    if (heading) {
      flush()
      activeTitle = heading[1] ?? null
      activeLines = [line]
      continue
    }

    if (activeTitle) {
      activeLines.push(line)
    }
  }

  flush()

  return sections
}

const helpSections = collectTopLevelSections(helpMarkdown)

const sectionTitlesByContext: Record<HelpContext, readonly string[]> = {
  editor: editorSections,
  home: homeSections,
}

type HelpSubsectionOutline = {
  id: string
  title: string
}

type HelpSectionOutline = HelpSubsectionOutline & {
  markdown: string
  subsections: HelpSubsectionOutline[]
}

export const getHelpHeadingId = (title: string): string => {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[`'"\u2019\u201C\u201D]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return slug || 'section'
}

export const createHelpHeadingIdTracker = (): ((title: string) => string) => {
  const seenHeadings = new Map<string, number>()

  return (title: string) => {
    const baseId = getHelpHeadingId(title)
    const count = seenHeadings.get(baseId) ?? 0

    seenHeadings.set(baseId, count + 1)

    return count === 0 ? baseId : `${baseId}-${count + 1}`
  }
}

const escapeLinkText = (title: string): string => title.replace(/([\\[\]])/g, '\\$1')

const collectSubsectionTitles = (sectionMarkdown: string): string[] =>
  sectionMarkdown
    .split(/\r?\n/)
    .map((line) => /^### ([^\n]+)$/.exec(line)?.[1])
    .filter((title): title is string => Boolean(title))

const buildContentsSection = (sections: readonly HelpSectionOutline[]): string => {
  const lines = ['## Contents', '']

  for (const section of sections) {
    lines.push(`- [${escapeLinkText(section.title)}](#${section.id})`)

    for (const subsection of section.subsections) {
      lines.push(`  - [${escapeLinkText(subsection.title)}](#${subsection.id})`)
    }
  }

  return lines.join('\n')
}

export const getHelpMarkdown = (context: HelpContext): string => {
  const nextHeadingId = createHelpHeadingIdTracker()

  nextHeadingId('Contents')

  const sections = sectionTitlesByContext[context]
    .map((title) => ({ title, markdown: helpSections.get(title) }))
    .filter((section): section is { title: string; markdown: string } => Boolean(section.markdown))
    .map(
      (section): HelpSectionOutline => ({
        id: nextHeadingId(section.title),
        title: section.title,
        markdown: section.markdown,
        subsections: collectSubsectionTitles(section.markdown).map((title) => ({
          id: nextHeadingId(title),
          title,
        })),
      }),
    )

  return [
    buildContentsSection(sections),
    ...sections.map((section) => section.markdown),
  ].join('\n\n')
}
