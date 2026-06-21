import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConflictEditor } from './ConflictEditor'
import type { ConflictResolutionChoice, ConflictResolutions } from './conflictController'
import type { MergeRegion } from '../merge/threeWayMerge'

afterEach(cleanup)

const regions: MergeRegion[] = [
  { type: 'clean', lines: ['# Title', ''] },
  { type: 'conflict', local: ['Alice'], base: ['?'], remote: ['Bob'] },
  { type: 'clean', lines: ['middle'] },
  { type: 'conflict', local: ['June 20'], base: ['June'], remote: ['June 27'] },
  { type: 'clean', lines: ['end'] },
]

const noop = () => {}

// A controlled wrapper so choosing actually updates the resolution map (the real
// caller is App; here the harness plays that role).
const Harness = ({
  onChoose = noop,
  onSave = noop,
}: {
  onChoose?: (i: number, c: ConflictResolutionChoice) => void
  onSave?: () => void
}) => {
  const [resolutions, setResolutions] = useState<ConflictResolutions>(new Map())
  return (
    <ConflictEditor
      regions={regions}
      resolutions={resolutions}
      busy={false}
      onChoose={(index, choice) => {
        onChoose(index, choice)
        setResolutions((prev) => new Map(prev).set(index, choice))
      }}
      onChooseAll={(kind) =>
        setResolutions(new Map([[0, { kind }], [1, { kind }]] as const))
      }
      onSave={onSave}
      onCancel={noop}
      onExportLocal={noop}
      onExportRemote={noop}
    />
  )
}

describe('ConflictEditor', () => {
  it('renders clean text and both sides of each conflict', () => {
    render(<Harness />)
    expect(screen.getByText('# Title', { exact: false })).toBeTruthy()
    expect(screen.getByText('Alice')).toBeTruthy()
    expect(screen.getByText('Bob')).toBeTruthy()
    expect(screen.getByText('June 20')).toBeTruthy()
    expect(screen.getByText('June 27')).toBeTruthy()
  })

  it('keeps Save disabled until every conflict is resolved', () => {
    render(<Harness />)
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Use local version for conflict 1' }))
    expect(save.disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Use remote version for conflict 2' }))
    expect(save.disabled).toBe(false)
  })

  it('emits the resolution choices and fires onSave', () => {
    const onChoose = vi.fn()
    const onSave = vi.fn()
    render(<Harness onChoose={onChoose} onSave={onSave} />)

    fireEvent.click(screen.getByRole('button', { name: 'Use local version for conflict 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use remote version for conflict 2' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onChoose).toHaveBeenNthCalledWith(1, 0, { kind: 'local' })
    expect(onChoose).toHaveBeenNthCalledWith(2, 1, { kind: 'remote' })
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('keeps both versions for a single conflict (local then remote)', () => {
    const onChoose = vi.fn()
    render(<Harness onChoose={onChoose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Keep both versions for conflict 1' }))

    expect(onChoose).toHaveBeenCalledWith(0, { kind: 'both' })
    // The collapsed resolved view shows the "both" tag and the combined lines
    // (whitespace, including the joining newline, is normalized to a space).
    expect(screen.getByText('⇕ both')).toBeTruthy()
    expect(screen.getByText('Alice Bob')).toBeTruthy()
  })

  it('bulk-applies keep-both to all conflicts', () => {
    const onChooseAll = vi.fn()
    render(
      <ConflictEditor
        regions={regions}
        resolutions={new Map()}
        busy={false}
        onChoose={noop}
        onChooseAll={onChooseAll}
        onSave={noop}
        onCancel={noop}
        onExportLocal={noop}
        onExportRemote={noop}
      />,
    )

    fireEvent.click(screen.getByText('Take union'))
    expect(onChooseAll).toHaveBeenCalledWith('both')
  })

  it('bulk actions still collapse visible choices after change reopens a resolved conflict', () => {
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: 'Use local version for conflict 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use remote version for conflict 2' }))
    fireEvent.click(screen.getAllByText('change')[0] as HTMLElement)

    expect(screen.getByRole('button', { name: 'Use remote version for conflict 1' })).toBeTruthy()

    fireEvent.click(screen.getByText('Keep remote'))

    expect(screen.queryByRole('button', { name: 'Use remote version for conflict 1' })).toBeNull()
    expect(screen.getByText('Bob')).toBeTruthy()
  })

  it('splits a manually edited hunk on newlines', () => {
    const onChoose = vi.fn()
    render(
      <ConflictEditor
        regions={regions}
        resolutions={new Map()}
        busy={false}
        onChoose={onChoose}
        onChooseAll={noop}
        onSave={noop}
        onCancel={noop}
        onExportLocal={noop}
        onExportRemote={noop}
      />,
    )

    fireEvent.click(screen.getAllByText('Edit…')[0] as HTMLElement)
    fireEvent.change(screen.getByLabelText('Edit conflict 1'), {
      target: { value: 'X\nY' },
    })
    fireEvent.click(screen.getByText('Save edit'))

    expect(onChoose).toHaveBeenCalledWith(0, { kind: 'edited', lines: ['X', 'Y'] })
  })

  it('bulk-resolves all conflicts and fires export callbacks', () => {
    const onExportLocal = vi.fn()
    const onExportRemote = vi.fn()
    render(
      <ConflictEditor
        regions={regions}
        resolutions={new Map()}
        busy={false}
        onChoose={noop}
        onChooseAll={noop}
        onSave={noop}
        onCancel={noop}
        onExportLocal={onExportLocal}
        onExportRemote={onExportRemote}
      />,
    )

    fireEvent.click(screen.getByText('Export local'))
    fireEvent.click(screen.getByText('Export remote'))
    expect(onExportLocal).toHaveBeenCalledTimes(1)
    expect(onExportRemote).toHaveBeenCalledTimes(1)
  })

  it('disables Save while busy', () => {
    render(
      <ConflictEditor
        regions={regions}
        resolutions={new Map([[0, { kind: 'local' }], [1, { kind: 'remote' }]])}
        busy
        onChoose={noop}
        onChooseAll={noop}
        onSave={noop}
        onCancel={noop}
        onExportLocal={noop}
        onExportRemote={noop}
      />,
    )
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })
})
