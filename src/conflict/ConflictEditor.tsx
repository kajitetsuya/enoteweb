import { useState } from 'react'
import type { ConflictResolutionChoice, ConflictResolutions } from './conflictController'
import type { ConflictRegion, MergeRegion } from '../merge/threeWayMerge'

type ConflictEditorProps = {
  regions: MergeRegion[]
  resolutions: ConflictResolutions
  busy: boolean
  onChoose: (conflictIndex: number, choice: ConflictResolutionChoice) => void
  onChooseAll: (kind: 'local' | 'remote' | 'both') => void
  onSave: () => void
  onCancel: () => void
  onExportLocal: () => void
  onExportRemote: () => void
}

// Renders region lines verbatim; an empty side (a deletion) shows a faint marker
// so the choice is legible rather than blank.
const Lines = ({ lines }: { lines: string[] }) =>
  lines.length === 0 ? (
    <span className="ce-lines ce-empty">(no lines on this side)</span>
  ) : (
    <span className="ce-lines">{lines.join('\n')}</span>
  )

const resolvedLines = (choice: ConflictResolutionChoice, region: ConflictRegion): string[] => {
  switch (choice.kind) {
    case 'local':
      return region.local
    case 'remote':
      return region.remote
    case 'both':
      return [...region.local, ...region.remote]
    case 'edited':
      return choice.lines
    default: {
      const exhaustive: never = choice
      return exhaustive
    }
  }
}

const choiceLabel = (choice: ConflictResolutionChoice): string => {
  switch (choice.kind) {
    case 'local':
      return '◀ local'
    case 'remote':
      return '▶ remote'
    case 'both':
      return '⇕ both'
    case 'edited':
      return '✎ edited'
    default: {
      const exhaustive: never = choice
      return exhaustive
    }
  }
}

// The inline merged-view conflict editor (SPEC §9). Presentational: the merge
// regions and the resolution map are owned by the caller (so they can be cleared
// on lock); only transient view state (which resolved blocks are expanded, and the
// in-progress edit draft) lives here.
export const ConflictEditor = ({
  regions,
  resolutions,
  busy,
  onChoose,
  onChooseAll,
  onSave,
  onCancel,
  onExportLocal,
  onExportRemote,
}: ConflictEditorProps) => {
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [editing, setEditing] = useState<{ index: number; draft: string } | null>(null)

  const totalConflicts = regions.filter((region) => region.type === 'conflict').length
  // Count only CURRENT conflict indices that still lack a choice — not
  // `totalConflicts - resolutions.size`. A resolution map left over from a
  // prior merge (a remote re-fetch on open, or a 409 re-resolve that rebuilt
  // the regions) can hold stale/extra indices; subtracting its size could read
  // as "all resolved" while current conflicts are unchosen, which is exactly
  // what let Save fire early and made the bulk actions look like no-ops.
  let unresolved = 0
  {
    let conflictOrdinal = 0
    for (const region of regions) {
      if (region.type !== 'conflict') {
        continue
      }
      if (!resolutions.has(conflictOrdinal)) {
        unresolved += 1
      }
      conflictOrdinal += 1
    }
  }

  const collapse = (index: number) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.delete(index)
      return next
    })

  const choose = (index: number, choice: ConflictResolutionChoice) => {
    onChoose(index, choice)
    collapse(index)
    setEditing((prev) => (prev?.index === index ? null : prev))
  }

  const saveEdit = (index: number, draft: string) => {
    // Split on '\n' to match composeRegions / threeWayMerge so trailing newlines
    // and blank lines survive into the resolved text.
    choose(index, { kind: 'edited', lines: draft.split('\n') })
  }

  const chooseAll = (kind: 'local' | 'remote' | 'both') => {
    onChooseAll(kind)
    setExpanded(new Set())
    setEditing(null)
  }

  return (
    <section
      className="conflict-editor"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conflict-editor-title"
    >
      <header className="ce-head">
        <h2 id="conflict-editor-title">Resolve Dropbox conflict</h2>
        <span className="ce-count">
          {totalConflicts} {totalConflicts === 1 ? 'conflict' : 'conflicts'} ·{' '}
          {unresolved === 0 ? 'all resolved' : `${unresolved} unresolved`}
        </span>
      </header>

      <div className="ce-bulk">
        <button type="button" className="secondary-button compact-button" onClick={() => chooseAll('local')}>
          Keep local
        </button>
        <button type="button" className="secondary-button compact-button" onClick={() => chooseAll('remote')}>
          Keep remote
        </button>
        <button type="button" className="secondary-button compact-button" onClick={() => chooseAll('both')}>
          Take union
        </button>
      </div>
      <p className="ce-hint">
        Click the version you want for each conflict, or use Both to combine the two sides
        (local then remote) or Edit… to merge by hand.
      </p>

      <div className="ce-doc">
        {regions.map((region, regionIndex) => {
          if (region.type === 'clean') {
            if (region.lines.length === 0) {
              return null
            }
            return (
              <div key={regionIndex} className="ce-clean">
                {region.lines.join('\n')}
              </div>
            )
          }

          // 0-based index among conflict regions (counts conflicts before this one).
          const index = regions
            .slice(0, regionIndex)
            .filter((earlier) => earlier.type === 'conflict').length
          const choice = resolutions.get(index)
          const showOptions = !choice || expanded.has(index)
          const isEditing = editing?.index === index

          return (
            <div key={regionIndex} className="ce-conflict" data-conflict={index}>
              <div className="ce-conflict-head">
                Conflict {index + 1} of {totalConflicts}
                {choice ? ' · resolved' : ''}
              </div>

              {showOptions ? (
                <>
                  {/* The hunks themselves are the choice: clicking a side selects
                      that version. Real buttons keep keyboard/focus working. */}
                  <button
                    type="button"
                    className="ce-side ce-local ce-pick"
                    aria-label={`Use local version for conflict ${index + 1}`}
                    onClick={() => choose(index, { kind: 'local' })}
                  >
                    <span className="ce-who">◀ Local</span>
                    <Lines lines={region.local} />
                  </button>
                  <button
                    type="button"
                    className="ce-side ce-remote ce-pick"
                    aria-label={`Use remote version for conflict ${index + 1}`}
                    onClick={() => choose(index, { kind: 'remote' })}
                  >
                    <span className="ce-who">▶ Remote</span>
                    <Lines lines={region.remote} />
                  </button>

                  {isEditing ? (
                    <div className="ce-edit">
                      <textarea
                        className="ce-textarea"
                        aria-label={`Edit conflict ${index + 1}`}
                        value={editing.draft}
                        onChange={(event) =>
                          setEditing({ index, draft: event.target.value })
                        }
                      />
                      <div className="ce-choose">
                        <button
                          type="button"
                          className="primary-button compact-button"
                          onClick={() => saveEdit(index, editing.draft)}
                        >
                          Save edit
                        </button>
                        <button
                          type="button"
                          className="secondary-button compact-button"
                          onClick={() => setEditing(null)}
                        >
                          Cancel edit
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="ce-choose ce-choose-edit">
                      <button
                        type="button"
                        className="secondary-button compact-button"
                        aria-label={`Keep both versions for conflict ${index + 1}`}
                        onClick={() => choose(index, { kind: 'both' })}
                      >
                        Both
                      </button>
                      <button
                        type="button"
                        className="secondary-button compact-button"
                        aria-label={`Edit merged text for conflict ${index + 1}`}
                        onClick={() =>
                          setEditing({
                            index,
                            draft: resolvedLines(
                              choice ?? { kind: 'local' },
                              region,
                            ).join('\n'),
                          })
                        }
                      >
                        Edit…
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <div className={`ce-resolved ce-${choice.kind}`}>
                  <span className="ce-tag">{choiceLabel(choice)}</span>
                  <Lines lines={resolvedLines(choice, region)} />
                  <button
                    type="button"
                    className="ce-change"
                    onClick={() => setExpanded((prev) => new Set(prev).add(index))}
                  >
                    change
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <footer className="ce-foot">
        <button type="button" className="secondary-button compact-button" onClick={onExportLocal}>
          Export local
        </button>
        <button type="button" className="secondary-button compact-button" onClick={onExportRemote}>
          Export remote
        </button>
        <span className="ce-foot-spacer" />
        <button type="button" className="secondary-button compact-button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="primary-button compact-button"
          disabled={busy || unresolved > 0}
          onClick={onSave}
        >
          Save
        </button>
      </footer>
    </section>
  )
}
