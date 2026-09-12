/**
 * 智能体员工会话：只聊天 / 派任务 / 继续任务 三模式切换条。
 */
import type { RefObject } from 'react'

export type EmployeeTalkMode = 'chat' | 'dispatch' | 'resume'

export type EmployeeOpenTask = {
  taskId: string
  name: string
  status: string
  progress?: number
  roundId?: string
}

export type EmployeeTalkModeBarProps = {
  mode: EmployeeTalkMode
  onModeChange: (mode: EmployeeTalkMode) => void
  openTasks: EmployeeOpenTask[]
  resumeTaskId: string
  onResumeTaskChange: (taskId: string) => void
  onFreshChat: () => void
  hintTask?: EmployeeOpenTask | null
  onHintResume?: () => void
  menuOpen?: boolean
  onMenuOpenChange?: (open: boolean) => void
  menuRef?: RefObject<HTMLDivElement | null>
}

const MODE_META: Record<EmployeeTalkMode, { label: string; title: string }> = {
  chat: {
    label: '只聊天',
    title: '普通对话：不建任务，也不接着未完的工作',
  },
  dispatch: {
    label: '派任务',
    title: '把这句话当成新任务交给他去做，并叫醒执行',
  },
  resume: {
    label: '继续任务',
    title: '选一个未完任务，接着往下推进',
  },
}

export function EmployeeTalkModeBar({
  mode,
  onModeChange,
  openTasks,
  resumeTaskId,
  onResumeTaskChange,
  onFreshChat,
  hintTask,
  onHintResume,
  menuOpen = false,
  onMenuOpenChange,
  menuRef,
}: EmployeeTalkModeBarProps) {
  const meta = MODE_META[mode]
  const resumeLabel =
    openTasks.find((t) => t.taskId === resumeTaskId)?.name ||
    (resumeTaskId ? resumeTaskId : '选择任务')

  return (
    <div className="employee-talk-mode-wrap">
      {hintTask && mode === 'chat' ? (
        <div className="employee-talk-hint" role="status">
          <span className="employee-talk-hint-text">
            进行中：{hintTask.name}
            {typeof hintTask.progress === 'number' ? `（${hintTask.progress}%）` : ''}
          </span>
          <button type="button" className="employee-talk-hint-btn" onClick={() => onHintResume?.()}>
            改为继续任务
          </button>
          <span className="employee-talk-hint-muted">不点则只聊天</span>
        </div>
      ) : null}

      <div className="employee-talk-mode-row">
        <div className="react-chat-mode-menu-wrap" ref={menuRef}>
          <button
            type="button"
            className="react-chat-bottom-pill react-chat-bottom-mode-pill employee-talk-mode-pill"
            title={meta.title}
            onClick={() => onMenuOpenChange?.(!menuOpen)}
          >
            <span className="react-chat-bottom-pill-text">{meta.label}</span>
            <span className="react-chat-bottom-pill-caret">▾</span>
          </button>
          {menuOpen ? (
            <div className="react-chat-mode-menu" role="menu">
              {(Object.keys(MODE_META) as EmployeeTalkMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`react-chat-mode-item${m === mode ? ' active' : ''}`}
                  title={MODE_META[m].title}
                  onClick={() => {
                    onMenuOpenChange?.(false)
                    onModeChange(m)
                  }}
                >
                  {MODE_META[m].label}
                  <span className="employee-talk-mode-item-desc">{MODE_META[m].title}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {mode === 'chat' ? (
          <button
            type="button"
            className="react-chat-bottom-pill employee-talk-fresh-pill"
            title="新开一轮聊天（不带上一轮对话）"
            onClick={onFreshChat}
          >
            新开聊天
          </button>
        ) : null}

        {mode === 'resume' ? (
          <label className="employee-talk-resume-select-wrap" title="选择要继续的未完任务">
            <span className="sr-only">继续的任务</span>
            <select
              className="employee-talk-resume-select"
              value={resumeTaskId}
              onChange={(e) => onResumeTaskChange(e.target.value)}
            >
              <option value="">选择未完任务…</option>
              {openTasks.map((t) => (
                <option key={t.taskId} value={t.taskId}>
                  {t.name || t.taskId}
                  {t.status ? ` · ${t.status}` : ''}
                </option>
              ))}
            </select>
            {!openTasks.length ? (
              <span className="employee-talk-hint-muted">暂无未完任务</span>
            ) : (
              <span className="employee-talk-resume-current" title={resumeLabel}>
                {resumeTaskId ? '已选' : '未选'}
              </span>
            )}
          </label>
        ) : null}
      </div>
    </div>
  )
}

export function mintEmployeeChatEpisodeId(): string {
  return `chat:${new Date().toISOString()}`
}

export function employeeTalkPlaceholder(mode: EmployeeTalkMode): string {
  if (mode === 'dispatch') return '要他办的事（会派成新任务并叫醒）…'
  if (mode === 'resume') return '补充说明 / 纠偏（接着选中的未完任务）…'
  return '跟他说点什么（只聊天，不建任务）…'
}
