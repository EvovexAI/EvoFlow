import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  formatToolApprovalPrimaryLine,
  TOOL_APPROVAL_OP_ZH,
} from '../../lib/tool-approval.js'
import {
  getCachedGlobalToolApprovalPolicy,
  isToolApprovalDisabled,
  patchGlobalToolApprovalPolicy,
  TOOL_APPROVAL_POLICY_CHANGED,
  TOOL_APPROVAL_POLICY_GRANT_ALL,
  TOOL_APPROVAL_POLICY_SESSION,
} from '../../lib/tool-approval-settings.js'

export type ToolApprovalChoice = 'allow_once' | 'always_project' | 'full_access' | 'deny'

/** 点击后的乐观决策态：面板从「等待确认」切换为结果反馈（多工具审批时的点击回执） */
export type ToolApprovalDecision = 'approved' | 'denied'

/** 审批面板勾选「新对话默认完全访问」后，请 ChatApp 同步当前会话并放行 pending */
export const TOOL_APPROVAL_REQUEST_SESSION_FULL_ACCESS =
  'evopanel:tool-approval-request-session-full-access'

type Props = {
  toolName: string
  summary: string
  /** Optional trailing metrics e.g. "+2 -1" */
  detailExtra?: string
  busy?: boolean
  /** Auto-focus the panel for keyboard navigation when mounted */
  autoFocus?: boolean
  /** 已提交的决策（approved/denied）——渲染结果态而非选项列表 */
  decided?: ToolApprovalDecision | null
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
    desc: '本会话内同名工具不再询问（如全部 bash）',
  },
  {
    id: 'full_access',
    title: '完全访问',
    desc: '本会话所有工具不再询问',
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
  decided = null,
  onConfirm,
}: Props) {
  const labelId = useId()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [selected, setSelected] = useState(0)
  const [newChatDefault, setNewChatDefault] = useState(() =>
    isToolApprovalDisabled(getCachedGlobalToolApprovalPolicy()),
  )
  const [globalBusy, setGlobalBusy] = useState(false)
  const primary = useMemo(
    () => formatToolApprovalPrimaryLine(toolName, summary),
    [toolName, summary],
  )
  const contextLabel = useMemo(() => {
    const detail = String(summary || '').trim() || primary
    const extra = String(detailExtra || '').trim()
    return extra ? `${detail} ${extra}` : detail
  }, [summary, primary, detailExtra])

  useEffect(() => {
    const sync = () => {
      setNewChatDefault(isToolApprovalDisabled(getCachedGlobalToolApprovalPolicy()))
    }
    window.addEventListener(TOOL_APPROVAL_POLICY_CHANGED, sync)
    return () => window.removeEventListener(TOOL_APPROVAL_POLICY_CHANGED, sync)
  }, [])

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

  const toggleNewChatDefault = useCallback(async (next: boolean) => {
    if (globalBusy) return
    setGlobalBusy(true)
    setNewChatDefault(next)
    try {
      await patchGlobalToolApprovalPolicy(
        next ? TOOL_APPROVAL_POLICY_GRANT_ALL : TOOL_APPROVAL_POLICY_SESSION,
      )
      if (next) {
        try {
          window.dispatchEvent(new CustomEvent(TOOL_APPROVAL_REQUEST_SESSION_FULL_ACCESS))
        } catch {
          /* ignore */
        }
      }
    } catch {
      setNewChatDefault(!next)
    } finally {
      setGlobalBusy(false)
    }
  }, [globalBusy])

  useEffect(() => {
    if (!autoFocus || decided) return
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
  }, [autoFocus, decided])

  useEffect(() => {
    if (decided) return
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
      if (e.key === '1' || e.key === '2' || e.key === '3' || e.key === '4') {
        e.preventDefault()
        setSelected(Number(e.key) - 1)
      }
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  }, [busy, decided, move, submit])

  const contextRow = (
    <div className="tool-approval-panel__context">
      <span className="tool-approval-panel__context-icon" aria-hidden>
        ✎
      </span>
      {decided ? (
        <span
          className={`tool-approval-panel__decision${
            decided === 'denied' ? ' tool-approval-panel__decision--denied' : ''
          }`}
          role="status"
        >
          {decided === 'denied' ? '已拒绝' : '已批准，等待执行…'}
        </span>
      ) : (
        <span className="tool-approval-panel__context-wait">等待确认</span>
      )}
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
  )

  if (decided) {
    return (
      <div
        ref={rootRef}
        className="tool-approval-panel tool-approval-panel--decided"
        role="group"
        aria-labelledby={labelId}
        data-decided={decided}
      >
        <div className="tool-approval-panel__eyebrow" id={labelId}>
          需要权限
        </div>
        {contextRow}
      </div>
    )
  }

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
      {contextRow}

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

      <label
        className={`tool-approval-panel__global${newChatDefault ? ' is-on' : ''}`}
        onMouseDown={(e) => e.preventDefault()}
      >
        <input
          type="checkbox"
          checked={newChatDefault}
          disabled={busy || globalBusy}
          onChange={(e) => void toggleNewChatDefault(e.target.checked)}
          aria-label="新对话默认完全访问"
        />
        <span className="tool-approval-panel__global-body">
          <span className="tool-approval-panel__global-title">新对话默认完全访问</span>
          <span className="tool-approval-panel__global-desc">
            与设置→安全中心同一开关；开启后本会话也会切到完全访问
          </span>
        </span>
      </label>

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
