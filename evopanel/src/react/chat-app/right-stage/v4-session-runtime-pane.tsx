/**
 * 会话子工作实时列表（右栏）。点行可钻到子代理 / 协作节点 / 员工过程。
 * 图标主路径已直达详情；本面板仅作多实例兜底/总览。
 */
import { useEffect, useMemo, useState } from 'react'
import type { SessionChildWorkItem } from '../../lib/session-reattach.js'
import { fetchSessionExecutionState } from '../../lib/session-reattach.js'
import { isChildWorkActive } from '../../hooks/useSessionChildWorks.js'
import {
  openSessionChildWorkDetail,
  SESSION_CHILD_WORK_KIND_LABEL,
} from '../../../lib/right-stage/open-session-child-work-detail.js'

function statusLabel(status: string): string {
  const s = status.toLowerCase()
  if (s === 'pending') return '排队'
  if (s === 'running') return '运行中'
  if (s === 'completed') return '已完成'
  if (s === 'failed') return '失败'
  if (s === 'timed_out') return '超时'
  if (s === 'cancelled') return '已取消'
  if (s === 'dropped') return '已结束'
  if (s === 'superseded') return '已替换'
  return status || '—'
}

function rowTitle(work: SessionChildWorkItem): string {
  const kind = String(work.kind || '').trim()
  const raw = String(work.title || '').trim()
  if (kind === 'warm_bash' || raw.toLowerCase() === 'warm_bash') {
    return SESSION_CHILD_WORK_KIND_LABEL.warm_bash
  }
  return raw || SESSION_CHILD_WORK_KIND_LABEL[kind] || kind || '运行'
}

export function V4SessionRuntimePane(props: {
  sessionKey: string
  initialWorks?: SessionChildWorkItem[]
  focusKind?: string
}) {
  const sk = String(props.sessionKey || '').trim()
  const [works, setWorks] = useState<SessionChildWorkItem[]>(
    Array.isArray(props.initialWorks) ? props.initialWorks : [],
  )

  useEffect(() => {
    if (!sk) return
    let cancelled = false
    const pull = async () => {
      try {
        const st = await fetchSessionExecutionState(sk, { bypassCache: true })
        if (cancelled) return
        setWorks(Array.isArray(st?.childWorks) ? st!.childWorks! : [])
      } catch {
        /* ignore */
      }
    }
    void pull()
    const id = window.setInterval(() => void pull(), 2500)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [sk])

  const ordered = useMemo(() => {
    const focus = String(props.focusKind || '').trim()
    const copy = [...works]
    copy.sort((a, b) => {
      const aActive = isChildWorkActive(a.status) ? 0 : 1
      const bActive = isChildWorkActive(b.status) ? 0 : 1
      if (aActive !== bActive) return aActive - bActive
      if (focus) {
        const af = String(a.kind || '') === focus ? 0 : 1
        const bf = String(b.kind || '') === focus ? 0 : 1
        if (af !== bf) return af - bf
      }
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
    })
    return copy
  }, [works, props.focusKind])

  const openN = ordered.filter((w) => isChildWorkActive(w.status)).length

  return (
    <aside className="react-chat-session-runtime-pane" role="region" aria-label="会话运行状态">
      <header className="react-chat-session-runtime-pane__head">
        <div className="react-chat-session-runtime-pane__title">运行中</div>
        <div className="react-chat-session-runtime-pane__meta">
          {openN > 0 ? `${openN} 个进行中` : '暂无进行中的子任务'}
        </div>
      </header>
      {ordered.length === 0 ? (
        <div className="react-chat-session-runtime-pane__empty">还没有登记的子代理 / 工作流 / BOT 任务</div>
      ) : (
        <ul className="react-chat-session-runtime-pane__list">
          {ordered.map((w) => {
            const kind = String(w.kind || 'unknown')
            const active = isChildWorkActive(w.status)
            const st = String(w.status || '')
            return (
              <li key={String(w.workId || `${kind}:${w.refId}`)}>
                <button
                  type="button"
                  className={`react-chat-session-runtime-pane__row${active ? ' is-active' : ''}`}
                  onClick={() => openSessionChildWorkDetail(w, sk)}
                  title="查看实时详情"
                >
                  <span
                    className={`react-chat-session-runtime-pane__kind-dot kind-${kind}${active ? ' is-spinning' : ''}`}
                    aria-hidden="true"
                  />
                  <span className="react-chat-session-runtime-pane__row-body">
                    <span className="react-chat-session-runtime-pane__row-title">
                      {rowTitle(w)}
                    </span>
                    <span className="react-chat-session-runtime-pane__row-sub">
                      {SESSION_CHILD_WORK_KIND_LABEL[kind] || kind} · {statusLabel(st)}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </aside>
  )
}
