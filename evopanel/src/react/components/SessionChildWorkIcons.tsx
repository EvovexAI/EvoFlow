/**
 * Icons beside the permission pill: spinning when that kind of child work is running.
 * Click opens that work's live detail directly (not the summary list).
 */
import { useMemo } from 'react'
import { useSessionChildWorks } from '../hooks/useSessionChildWorks.js'
import {
  openSessionChildWorkDetail,
  pickActiveChildWork,
} from '../../lib/right-stage/open-session-child-work-detail.js'
import { openSessionRuntimeInRightStage } from '../../lib/right-stage/open-session-runtime-stage.js'
import { logSessionChildWorkIconClick } from '../lib/session-child-work-log.js'
import type { SessionChildWorkItem } from '../lib/session-reattach.js'

const KIND_META: Array<{
  kind: string
  label: string
  icon: 'subagent' | 'collab' | 'duty' | 'bash'
}> = [
  { kind: 'subagent', label: '子代理', icon: 'subagent' },
  { kind: 'workflow', label: '工作流', icon: 'collab' },
  { kind: 'collab_subtask', label: '工作流节点', icon: 'collab' },
  { kind: 'duty', label: 'BOT', icon: 'duty' },
  { kind: 'warm_bash', label: '会话终端', icon: 'bash' },
]

function KindGlyph({ icon }: { icon: (typeof KIND_META)[number]['icon'] }) {
  if (icon === 'subagent') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" aria-hidden="true">
        <circle cx="12" cy="8" r="3" />
        <path d="M5 19c1.5-3 4-4.5 7-4.5S17.5 16 19 19" strokeLinecap="round" />
      </svg>
    )
  }
  if (icon === 'collab') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" aria-hidden="true">
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="8.5" y="14" width="7" height="7" rx="1.5" />
        <path d="M10 6.5h4M6.5 10v4M17.5 10v2.5" strokeLinecap="round" />
      </svg>
    )
  }
  if (icon === 'duty') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" aria-hidden="true">
        <path d="M16 19v-2a3 3 0 0 0-3-3H7a3 3 0 0 0-3 3v2" strokeLinecap="round" />
        <circle cx="10" cy="8" r="3" />
        <path d="M19 8v6M22 11h-6" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" aria-hidden="true">
      <path d="M4 6h16v12H4z" strokeLinejoin="round" />
      <path d="M7 10l2 2-2 2M12 14h5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function SessionChildWorkIcons(props: { sessionKey?: string | null }) {
  const sk = String(props.sessionKey || '').trim()
  const { works, openCount, activeByKind } = useSessionChildWorks(sk || null)

  const visible = useMemo(() => {
    return KIND_META.filter((m) => (activeByKind.get(m.kind) || []).length > 0)
  }, [activeByKind])

  if (!sk || visible.length === 0) return null

  const openLiveDetail = (focusKind: string) => {
    const list = works as SessionChildWorkItem[]
    logSessionChildWorkIconClick({
      sessionKey: sk,
      focusKind,
      works: list,
    })
    const target = pickActiveChildWork(list, focusKind)
    if (target && openSessionChildWorkDetail(target, sk)) return
    // 无法解析详情时才退回汇总（例如缺 task_id 的旧行）
    openSessionRuntimeInRightStage({
      sessionKey: sk,
      works: list,
      focusKind,
      forceExpand: true,
    })
  }

  return (
    <div
      className="react-chat-session-child-work-icons"
      role="group"
      aria-label={`运行中 ${openCount}`}
    >
      {visible.map((m) => {
        const items = activeByKind.get(m.kind) || []
        const n = items.length
        const tip =
          n > 1
            ? `${m.label}运行中（${n}）· 点击打开最新一条详情`
            : `${m.label}运行中 · 点击查看详情`
        return (
          <button
            key={m.kind}
            type="button"
            className="react-chat-session-child-work-icon is-running"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => openLiveDetail(m.kind)}
            title={tip}
            aria-label={tip}
            data-tauri-no-drag
          >
            <span className="react-chat-session-child-work-icon__glyph" aria-hidden="true">
              <KindGlyph icon={m.icon} />
            </span>
            <span className="react-chat-session-child-work-icon__spin" aria-hidden="true" />
            {n > 1 ? (
              <span className="react-chat-session-child-work-icon__badge">{n > 9 ? '9+' : n}</span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
