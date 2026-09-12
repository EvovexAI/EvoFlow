import { memo } from 'react'

export type InsertChip = {
  id: string
  label: string
  /** Text inserted into the target field */
  insert: string
  title?: string
}

type Props = {
  label: string
  hint?: string
  chips: InsertChip[]
  onInsert: (text: string) => void
  emptyText?: string
  emptyActionLabel?: string
  onEmptyAction?: () => void
  /** FastGPT-like: show insert token on chip */
  showToken?: boolean
}

/** Compact chip strip for inserting params / upstream refs into step text fields. */
function InsertChipBar({
  label,
  hint,
  chips,
  onInsert,
  emptyText,
  emptyActionLabel,
  onEmptyAction,
  showToken = true,
}: Props) {
  if (!chips.length && !emptyText) return null
  return (
    <div className="wf-insert-chip-bar">
      <div className="wf-insert-chip-bar-head">
        <span className="wf-insert-chip-bar-label">{label}</span>
        {hint ? <span className="wf-insert-chip-bar-hint">{hint}</span> : null}
      </div>
      {chips.length ? (
        <div className="wf-insert-chip-bar-row" role="group" aria-label={label}>
          {chips.map((c) => (
            <button
              key={c.id}
              type="button"
              className="wf-insert-chip wf-insert-chip--var"
              title={c.title || c.insert}
              onClick={() => onInsert(c.insert)}
            >
              <span className="wf-insert-chip-name">{c.label}</span>
              {showToken ? <code className="wf-insert-chip-token">{c.insert}</code> : null}
            </button>
          ))}
        </div>
      ) : (
        <div className="wf-insert-chip-bar-empty">
          <span>{emptyText}</span>
          {emptyActionLabel && onEmptyAction ? (
            <button type="button" className="wf-insert-chip-bar-cta" onClick={onEmptyAction}>
              {emptyActionLabel}
            </button>
          ) : null}
        </div>
      )}
    </div>
  )
}

export default memo(InsertChipBar)
