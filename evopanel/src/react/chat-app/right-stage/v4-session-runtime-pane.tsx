/**
 * 会话子工作实时列表（右栏）。点行可钻到子代理 / 协作节点 / 员工过程。
 */
import { useEffect, useMemo, useState } from 'react'
import type { SessionChildWorkItem } from '../../lib/session-reattach.js'
import { fetchSessionExecutionState } from '../../lib/session-reattach.js'
import { isChildWorkActive } from '../../hooks/useSessionChildWorks.js'
import { openCollabSubtaskInRightStage } from '../../../lib/right-stage/open-collab-subtask-stage.js'
import { openCollabWorkflowInRightStage } from '../../../lib/right-stage/open-collab-workflow-stage.js'
import { openEmployeeProcessInRightStage } from '../../../lib/right-stage/open-employee-process-stage.js'
import { rightStageStore } from '../../../lib/right-stage/right-stage-store.js'

const KIND_LABEL: Record<string, string> = {
  subagent: '子代理',
  workflow: '工作流',
  collab_subtask: '工作流节点',
  duty: '员工任务',
  warm_bash: '会话终端',
}

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

function openDetail(work: SessionChildWorkItem, sessionKey: string) {
  const kind = String(work.kind || '').trim()
  const ref = String(work.refId || '').trim()
  const title = String(work.title || KIND_LABEL[kind] || kind || '运行').trim()

  if (kind === 'workflow') {
    const taskId = String(work.extra?.task_id || '').trim()
    if (taskId) {
      openCollabWorkflowInRightStage(
        { mainTaskId: taskId, leadThreadId: '', title: title || '工作流' },
        { sessionKey, forceExpand: true },
      )
      return
    }
  }

  if (kind === 'collab_subtask' && ref.includes(':')) {
    const [mainTaskId, subtaskId] = ref.split(':', 2)
    if (mainTaskId && subtaskId) {
      openCollabWorkflowInRightStage(
        { mainTaskId, leadThreadId: String(work.parentThreadId || ''), title: '工作流' },
        { sessionKey, forceExpand: true },
      )
      openCollabSubtaskInRightStage(
        {
          subtaskId,
          mainTaskId,
          leadThreadId: String(work.parentThreadId || ''),
          title,
          status: String(work.status || ''),
        },
        { sessionKey },
      )
      return
    }
  }

  if (kind === 'subagent' && ref) {
    rightStageStore.show({
      kind: 'subagentTranscript',
      id: `subagentTranscript:${ref}`,
      title: title || '子代理',
      layout: 'wide',
      sessionKey,
      forceExpand: true,
      data: {
        taskId: ref,
        title,
        sessionKey,
        fallbackStatus: String(work.status || ''),
      },
    })
    return
  }

  if (kind === 'duty') {
    const agentCode = String(title || '').trim() || 'employee'
    openEmployeeProcessInRightStage(
      {
        taskId: ref || `live:${agentCode}`,
        agentCode,
        roleName: title || agentCode,
        title: title || '执行过程',
        busy: isChildWorkActive(work.status),
        employeeSessionKey: sessionKey,
      },
      { sessionKey, forceExpand: true },
    )
    return
  }

  if (kind === 'warm_bash') {
    // Registry ref is the warm-pool key (usually lead thread_id), NOT a bash
    // tool_call_id — opening Terminal with that id yields an empty panel.
    // Mark warmBash so the renderer binds the latest live Bash stream instead.
    rightStageStore.show({
      kind: 'terminal',
      id: `warm-bash:${ref || work.threadId || 'shell'}`,
      title: '会话终端',
      layout: 'half',
      sessionKey,
      forceExpand: true,
      data: {
        sessionKey,
        warmBash: true,
        warmBashKey: ref || work.threadId || '',
        command: '',
        running: isChildWorkActive(work.status),
        outputFallback:
          '会话终端是保活 shell：命令跑完进程还在，下一条会复用。\n' +
          '这里跟本会话最新的 Bash 实时输出；若暂时没有，请看对话里的 Bash 工具卡。\n' +
          `状态：${String(work.status || '—')}`,
      },
    })
  }
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
        <div className="react-chat-session-runtime-pane__empty">还没有登记的子代理 / 工作流 / 员工任务</div>
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
                  onClick={() => openDetail(w, sk)}
                  title="查看实时情况"
                >
                  <span
                    className={`react-chat-session-runtime-pane__kind-dot kind-${kind}${active ? ' is-spinning' : ''}`}
                    aria-hidden="true"
                  />
                  <span className="react-chat-session-runtime-pane__row-body">
                    <span className="react-chat-session-runtime-pane__row-title">
                      {kind === 'warm_bash' ||
                      String(w.title || '').trim().toLowerCase() === 'warm_bash'
                        ? KIND_LABEL.warm_bash
                        : String(w.title || KIND_LABEL[kind] || kind)}
                    </span>
                    <span className="react-chat-session-runtime-pane__row-sub">
                      {KIND_LABEL[kind] || kind}
                      {w.refId ? ` · ${String(w.refId).slice(0, 28)}` : ''}
                    </span>
                  </span>
                  <span className={`react-chat-session-runtime-pane__status status-${st}`}>
                    {active ? <span className="react-chat-session-runtime-spin" aria-hidden="true" /> : null}
                    {statusLabel(st)}
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
