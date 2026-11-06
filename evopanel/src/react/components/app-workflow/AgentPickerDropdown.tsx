import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import AssignedAgentAvatar from '../AssignedAgentAvatar.tsx'
import { sortAgentsForPicker, type AgentPickerRow } from '../../lib/agent-tags.ts'
import { resolveWorkflowAgent } from './WorkflowStepAgentHead.tsx'

type AnchorRect = { top: number; left: number; bottom: number; right: number; width: number; height: number }

export type AgentPickerDropdownProps = {
  agents: AgentPickerRow[]
  loading?: boolean
  value?: string | null
  onChange: (agentCode: string) => void
  disabled?: boolean
  /** field：侧栏表单；portal：画布锚点弹出 */
  variant?: 'field' | 'portal'
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** portal 模式锚点；缺省时居中偏上 */
  anchorRect?: AnchorRect | null
  placeholder?: string
  className?: string
  'aria-label'?: string
  /** 触发器右侧附加操作（详情 / 编辑） */
  trailing?: ReactNode
}

function toRect(el: Element | null): AnchorRect | null {
  if (!el || typeof el.getBoundingClientRect !== 'function') return null
  const r = el.getBoundingClientRect()
  return { top: r.top, left: r.left, bottom: r.bottom, right: r.right, width: r.width, height: r.height }
}

function cssEscapeAttr(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function findWorkflowNodeAnchor(nodeId: string): AnchorRect | null {
  if (typeof document === 'undefined' || !nodeId) return null
  const safe = cssEscapeAttr(nodeId)
  const el =
    document.querySelector(`.react-flow__node[data-id="${safe}"]`) ||
    document.querySelector(`[data-id="${safe}"]`)
  return toRect(el)
}

export function AgentPickerDropdown({
  agents,
  loading = false,
  value,
  onChange,
  disabled = false,
  variant = 'field',
  open: openControlled,
  onOpenChange,
  anchorRect,
  placeholder = '搜索并选择执行者…',
  className = '',
  'aria-label': ariaLabel = '选择执行者',
  trailing,
}: AgentPickerDropdownProps) {
  const listId = useId()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [portalStyle, setPortalStyle] = useState<CSSProperties | null>(null)

  const isControlled = typeof openControlled === 'boolean'
  const open = isControlled ? openControlled : uncontrolledOpen

  const setOpen = useCallback(
    (next: boolean) => {
      if (!isControlled) setUncontrolledOpen(next)
      onOpenChange?.(next)
    },
    [isControlled, onOpenChange],
  )

  const selected = useMemo(() => resolveWorkflowAgent(agents, value), [agents, value])
  const triggerLabel = selected.hasAgent ? selected.label : placeholder

  const filtered = useMemo(() => {
    const sorted = sortAgentsForPicker(agents)
    const q = query.trim().toLowerCase()
    if (!q) return sorted
    return sorted.filter((a) => {
      const code = String(a.agent_code || '').toLowerCase()
      const name = String(a.agent_name || '').toLowerCase()
      return code.includes(q) || name.includes(q)
    })
  }, [agents, query])

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
  }, [setOpen])

  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => searchRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
        triggerRef.current?.focus()
      }
    }
    const onPointer = (e: MouseEvent | PointerEvent) => {
      const t = e.target as Node | null
      if (!t) return
      if (rootRef.current?.contains(t)) return
      if (menuRef.current?.contains(t)) return
      close()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer, true)
    }
  }, [open, close])

  useLayoutEffect(() => {
    if (!open || typeof window === 'undefined') {
      setPortalStyle(null)
      return
    }
    const update = () => {
      const gap = 8
      const sidePad = 10
      const menuW = 280
      const maxH = Math.min(360, window.innerHeight * 0.55)
      const fromTrigger = toRect(triggerRef.current)
      const r =
        variant === 'portal'
          ? anchorRect || fromTrigger
          : fromTrigger

      if (!r) {
        setPortalStyle({
          position: 'fixed',
          left: Math.max(sidePad, (window.innerWidth - menuW) / 2),
          top: Math.max(sidePad, window.innerHeight * 0.2),
          width: menuW,
          maxHeight: maxH,
          zIndex: 10070,
        })
        return
      }

      const left = Math.max(sidePad, Math.min(r.left, window.innerWidth - sidePad - menuW))
      let top = r.bottom + gap
      if (top + 160 > window.innerHeight - sidePad) {
        top = Math.max(sidePad, r.top - gap - maxH)
      }
      setPortalStyle({
        position: 'fixed',
        left,
        top,
        width: Math.max(menuW, Math.min(320, r.width || menuW)),
        maxHeight: Math.max(120, Math.min(maxH, window.innerHeight - top - sidePad)),
        zIndex: 10070,
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, variant, anchorRect, triggerLabel])

  const pick = (code: string) => {
    const next = code.trim()
    if (!next) return
    onChange(next)
    close()
  }

  const menuBody = open ? (
    <div
      ref={menuRef}
      id={listId}
      role="listbox"
      aria-label={ariaLabel}
      className="wf-agent-dd-menu"
      style={portalStyle || { display: 'none' }}
    >
      <div className="wf-agent-dd-search">
        <input
          ref={searchRef}
          type="search"
          className="wf-agent-dd-search-input"
          placeholder="搜索名称或编码…"
          value={query}
          aria-label="搜索执行者"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </div>
      <div className="wf-agent-dd-list">
        {loading ? <div className="wf-agent-dd-empty">加载中…</div> : null}
        {!loading && filtered.length === 0 ? (
          <div className="wf-agent-dd-empty">无匹配智能体</div>
        ) : null}
        {filtered.map((a) => {
          const code = String(a.agent_code || '')
          const active = String(value || '') === code
          const name = String(a.agent_name || code)
          return (
            <button
              key={code}
              type="button"
              role="option"
              aria-selected={active}
              className={`wf-agent-dd-item${active ? ' is-active' : ''}`}
              onClick={() => pick(code)}
            >
              <AssignedAgentAvatar agentCode={code} agents={agents} size={24} />
              <span className="wf-agent-dd-item-name" title={name}>
                {name}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  ) : null

  if (variant === 'portal') {
    return typeof document !== 'undefined' && menuBody
      ? createPortal(menuBody, document.body)
      : null
  }

  return (
    <div
      ref={rootRef}
      className={`wf-agent-dd${open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}${
        className ? ` ${className}` : ''
      }`}
    >
      <div className="wf-agent-dd-row">
        <button
          ref={triggerRef}
          type="button"
          className={`wf-agent-dd-trigger${selected.hasAgent ? '' : ' is-placeholder'}${
            open ? ' is-open' : ''
          }`}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-label={ariaLabel}
          onClick={() => {
            if (disabled) return
            setOpen(!open)
          }}
        >
          {selected.hasAgent ? (
            <AssignedAgentAvatar agentCode={value} agents={agents} size={22} />
          ) : (
            <span className="wf-agent-dd-trigger-icon" aria-hidden>
              ⌕
            </span>
          )}
          <span className="wf-agent-dd-trigger-label">{triggerLabel}</span>
          <span className="wf-agent-dd-caret" aria-hidden>
            ▾
          </span>
        </button>
        {trailing}
      </div>
      {typeof document !== 'undefined' && menuBody ? createPortal(menuBody, document.body) : null}
    </div>
  )
}
