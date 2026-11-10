/**
 * 会话旁运行图标 → 直接打开对应详情（子代理 / 工作流 / 员工 / 终端），
 * 不经「运行中」汇总面板。
 */
import { openCollabSubtaskInRightStage } from './open-collab-subtask-stage.js'
import { openCollabWorkflowInRightStage } from './open-collab-workflow-stage.js'
import { openEmployeeProcessInRightStage } from './open-employee-process-stage.js'
import { rightStageStore } from './right-stage-store.js'
import type { SessionChildWorkItem } from '../../react/lib/session-reattach.js'

const KIND_LABEL: Record<string, string> = {
  subagent: '子代理',
  workflow: '工作流',
  collab_subtask: '工作流节点',
  duty: 'BOT 任务',
  warm_bash: '会话终端',
}

const ACTIVE = new Set(['pending', 'running'])

function isActive(status: string | null | undefined): boolean {
  return ACTIVE.has(String(status || '').trim().toLowerCase())
}

function displayTitle(work: SessionChildWorkItem): string {
  const kind = String(work.kind || '').trim()
  const raw = String(work.title || '').trim()
  if (kind === 'warm_bash' || raw.toLowerCase() === 'warm_bash') {
    return KIND_LABEL.warm_bash
  }
  return raw || KIND_LABEL[kind] || kind || '运行'
}

/** Prefer the newest active item of a kind (icon click target). */
export function pickActiveChildWork(
  works: SessionChildWorkItem[] | null | undefined,
  kind?: string | null,
): SessionChildWorkItem | null {
  const k = String(kind || '').trim()
  const pool = (Array.isArray(works) ? works : []).filter((w) => {
    if (!isActive(w.status)) return false
    if (!k) return true
    return String(w.kind || '').trim() === k
  })
  if (!pool.length) return null
  pool.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
  return pool[0] || null
}

/**
 * Open the live detail surface for one child work.
 * @returns true when a detail stage was opened.
 */
export function openSessionChildWorkDetail(
  work: SessionChildWorkItem | null | undefined,
  sessionKey: string,
): boolean {
  const sk = String(sessionKey || '').trim()
  if (!sk || !work) return false
  const kind = String(work.kind || '').trim()
  const ref = String(work.refId || '').trim()
  const title = displayTitle(work)

  if (kind === 'workflow') {
    const taskId = String(work.extra?.task_id || '').trim()
    if (!taskId) return false
    openCollabWorkflowInRightStage(
      { mainTaskId: taskId, leadThreadId: '', title: title || '工作流' },
      { sessionKey: sk, forceExpand: true },
    )
    return true
  }

  if (kind === 'collab_subtask' && ref.includes(':')) {
    const [mainTaskId, subtaskId] = ref.split(':', 2)
    if (!mainTaskId || !subtaskId) return false
    openCollabWorkflowInRightStage(
      { mainTaskId, leadThreadId: String(work.parentThreadId || ''), title: '工作流' },
      { sessionKey: sk, forceExpand: true },
    )
    openCollabSubtaskInRightStage(
      {
        subtaskId,
        mainTaskId,
        leadThreadId: String(work.parentThreadId || ''),
        title,
        status: String(work.status || ''),
      },
      { sessionKey: sk },
    )
    return true
  }

  if (kind === 'subagent' && ref) {
    rightStageStore.show({
      kind: 'subagentTranscript',
      id: `subagentTranscript:${ref}`,
      title: title || '子代理',
      layout: 'wide',
      sessionKey: sk,
      forceExpand: true,
      data: {
        taskId: ref,
        title,
        sessionKey: sk,
        fallbackStatus: String(work.status || ''),
      },
    })
    return true
  }

  if (kind === 'duty') {
    const agentCode = String(work.title || '').trim() || 'employee'
    openEmployeeProcessInRightStage(
      {
        taskId: ref || `live:${agentCode}`,
        agentCode,
        roleName: title || agentCode,
        title: title || '执行过程',
        busy: isActive(work.status),
        employeeSessionKey: sk,
      },
      { sessionKey: sk, forceExpand: true },
    )
    return true
  }

  if (kind === 'warm_bash') {
    rightStageStore.show({
      kind: 'terminal',
      id: `warm-bash:${ref || work.threadId || 'shell'}`,
      title: '会话终端',
      layout: 'half',
      sessionKey: sk,
      forceExpand: true,
      data: {
        sessionKey: sk,
        warmBash: true,
        warmBashKey: ref || work.threadId || '',
        command: '',
        running: isActive(work.status),
        outputFallback:
          '会话终端是保活 shell：命令跑完进程还在，下一条会复用。\n' +
          '这里跟本会话最新的 Bash 实时输出；若暂时没有，请看对话里的 Bash 工具卡。\n' +
          `状态：${String(work.status || '—')}`,
      },
    })
    return true
  }

  return false
}

export { KIND_LABEL as SESSION_CHILD_WORK_KIND_LABEL }
