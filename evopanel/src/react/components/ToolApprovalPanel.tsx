import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  formatToolApprovalPrimaryLine,
  TOOL_APPROVAL_OP_ZH,
} from '../../lib/tool-approval.js'

export type ToolApprovalChoice = 'allow_once' | 'always_project' | 'deny'

type Props = {
  toolName: string
  summary: string
  /** Optional trailing metrics e.g. "+2 -1" */
  detailExtra?: string
  busy?: boolean
  /** Auto-focus the panel for keyboard navigation when mounted */
  autoFocus?: boolean
  onConfirm: (choice: ToolApprovalChoice) => void
}

const CHOICES: Array<{
  id: ToolApprovalChoice
  title: string
  desc: string
}> = [
  { id: 'allow_once', title: '允许', desc: '仅允许这一次' },
  {
    id: 'always_project',
    title: '始终允许本项目',
    desc: '本会话内同类操作不再询问',
  },
  { id: 'deny', title: '拒绝', desc: '这次先拒绝' },
]

function toolOpLabel(toolName: string): string {
  const key = String(toolName || '')
    .trim()
    .toLowerCase()
  return (TOOL_APPROVAL_OP_ZH as Record<string, string>)[key] || key || '工具'
}

function ToolApprovalPanelInner({
  toolName,
  summary,
  detailExtra,
  busy,
  autoFocus = true,
  onConfirm,
}: Props) {
  const labelId = useId()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [selected, setSelected] = useState(0)
  const primary = useMemo(
    () => formatToolApprovalPrimaryLine(toolName, summary),
    [toolName, summary],
  )
  const contextLabel = useMemo(() => {
    const detail = String(summary || '').trim() || primary
    const extra = String(detailExtra || '').trim()
    return extra ? `${detail} ${extra}` : detail
  }, [summary, primary, detailExtra])

  const move = useCallback((delta: number) => {
    setSelected((i) => {
      const n = CHOICES.length
      return (i + delta + n) % n
    })
  }, [])

  const submit = useCallback(() => {
    if (busy) return
    const choice = CHOICES[selected]?.id || 'allow_once'
    onConfirm(choice)
  }, [busy, onConfirm, selected])

  useEffect(() => {
    if (!autoFocus) return
    const el = rootRef.current
    if (!el) return
    // Defer so stream re-renders do not steal focus mid-type.
    const t = window.setTimeout(() => {
      try {
        el.focus({ preventScroll: true })
      } catch {
        el.focus()
      }
    }, 30)
    return () => window.clearTimeout(t)
  }, [autoFocus])

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onKey = (e: KeyboardEvent) => {
      if (busy) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey)) {
        e.preventDefault()
        move(1)
        return
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey)) {
        e.preventDefault()
        move(-1)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        submit()
        return
      }
      if (e.key === '1' || e.key === '2' || e.key === '3') {
        e.preventDefault()
        setSelected(Number(e.key) - 1)
      }
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  }, [busy, move, submit])

  return (
    <div
      ref={rootRef}
      className="tool-approval-panel"
      role="group"
      aria-labelledby={labelId}
      tabIndex={0}
    >
      <div className="tool-approval-panel__eyebrow" id={labelId}>
        需要权限
      </div>
      <div className="tool-approval-panel__context">
        <span className="tool-approval-panel__context-icon" aria-hidden>
          ✎
        </span>
        <span className="tool-approval-panel__context-wait">等待确认</span>
        <span className="tool-approval-panel__context-sep" aria-hidden>
          ·
        </span>
        <span className="tool-approval-panel__context-detail" title={primary}>
          {toolOpLabel(toolName) ? (
            <span className="tool-approval-panel__op">{toolOpLabel(toolName)}</span>
          ) : null}{' '}
          {contextLabel}
        </span>
      </div>

      <ol className="tool-approval-panel__choices" role="listbox" aria-label="授权选项">
        {CHOICES.map((c, idx) => {
          const active = idx === selected
          return (
            <li key={c.id} role="option" aria-selected={active}>
              <button
                type="button"
                className={`tool-approval-panel__choice${active ? ' is-selected' : ''}`}
                disabled={busy}
                onClick={() => setSelected(idx)}
                onDoubleClick={() => {
                  if (busy) return
                  onConfirm(c.id)
                }}
              >
                <span className="tool-approval-panel__choice-index">{idx + 1}.</span>
                <span className="tool-approval-panel__choice-body">
                  <span className="tool-approval-panel__choice-title">{c.title}</span>
                  <span className="tool-approval-panel__choice-desc">{c.desc}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ol>

      <div className="tool-approval-panel__footer">
        <p className="tool-approval-panel__hint">
          <span className="tool-approval-panel__hint-icon" aria-hidden>
            i
          </span>
          使用 Tab / 上下键选择，回车确认
        </p>
        <button
          type="button"
          className="tool-approval-panel__confirm"
          disabled={busy}
          onClick={submit}
        >
          {busy ? '处理中…' : '确认'}
        </button>
      </div>
    </div>
  )
}

export const ToolApprovalPanel = memo(ToolApprovalPanelInner)
