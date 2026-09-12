import type { PushTargetOption } from '../lib/goalPushTarget.js'

export function PushTargetPicker({
  value,
  options,
  disabled,
  onChange,
}: {
  value: string
  options: PushTargetOption[]
  disabled?: boolean
  onChange: (value: string) => void
}) {
  if (!options.length) {
    return <p className="react-chat-goal-hint">暂无可用的推送渠道</p>
  }

  return (
    <div className="react-chat-thread-clarify-options react-chat-goal-push-options" role="radiogroup" aria-label="推送渠道">
      {options.map((t) => {
        const active = t.id === value
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            className={`react-chat-thread-clarify-option${active ? ' is-selected' : ''}`}
            onClick={() => onChange(t.id)}
          >
            <span className="react-chat-thread-clarify-option-indicator" aria-hidden />
            <span className="react-chat-thread-clarify-option-label">{t.label}</span>
          </button>
        )
      })}
    </div>
  )
}
