import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { getAgentsDisplayCache } from '../../lib/agents-display-cache.js'
import { resolveAssignedAgentDisplayName } from '../../lib/tool-display.js'
import type { SubagentStreamTask } from '../chat-types.js'
import { ToolCallList } from './ToolCallList.js'
import { MarkdownHtml } from './MarkdownHtml.js'
import { MessageRow } from './MessageRow.js'

const phaseLabel: Record<SubagentStreamTask['phase'], string> = {
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  timed_out: '超时',
  cancelled: '已取消',
}

function agentTitle(t: SubagentStreamTask): string {
  const id = (t.subagentType || '').trim()
  if (!id) return '子智能体'
  return resolveAssignedAgentDisplayName(id, getAgentsDisplayCache()) || id
}

function progressPercent(t: SubagentStreamTask): number | null {
  if (t.phase !== 'running') return t.phase === 'completed' ? 100 : null
  if (t.messageIndex != null && t.totalMessages != null && t.totalMessages > 0) {
    return Math.min(100, Math.round((100 * t.messageIndex) / t.totalMessages))
  }
  return null
}

/** 子智能体并行卡片网格（嵌入会话气泡或与独立 dock 共用） */
export function SubagentInlineCards({ tasks }: { tasks: Record<string, SubagentStreamTask> }) {
  const list = Object.values(tasks).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const selectedTask = useMemo(
    () => list.find((t) => t.taskId === selectedTaskId) || null,
    [list, selectedTaskId],
  )
  if (!list.length) return null
  return (
    <>
      <div className="react-chat-subagent-grid">
        {list.map((t) => {
          const pct = progressPercent(t)
          const showIndeterminate = t.phase === 'running' && pct == null
          return (
            <article
              key={t.taskId}
              className={`react-chat-subagent-card react-chat-subagent-card--${t.phase}`}
            >
              <div className="react-chat-subagent-card__top">
                <div className="react-chat-subagent-card__agent">
                  <span className="react-chat-subagent-card__agent-name">{agentTitle(t)}</span>
                </div>
                <span
                  className={`react-chat-subagent-card__phase react-chat-subagent-card__phase--${t.phase}`}
                >
                  {phaseLabel[t.phase]}
                </span>
              </div>
              <h3 className="react-chat-subagent-card__task-title" title={t.description || t.taskId}>
                {t.description?.trim() ||
                  (t.taskId.length > 16 ? `${t.taskId.slice(0, 14)}…` : t.taskId)}
              </h3>
              <div
                className="react-chat-subagent-card__progress-wrap"
                aria-hidden={t.phase !== 'running' && pct == null}
              >
                {t.phase === 'running' && (t.messageIndex != null || t.totalMessages != null) ? (
                  <span className="react-chat-subagent-card__progress-label">
                    {t.messageIndex != null && t.totalMessages != null
                      ? `第 ${t.messageIndex} / ${t.totalMessages} 条模型输出`
                      : '处理中…'}
                  </span>
                ) : null}
                <div className="react-chat-subagent-card__progress-track">
                  {showIndeterminate ? (
                    <div className="react-chat-subagent-card__progress-bar react-chat-subagent-card__progress-bar--indeterminate" />
                  ) : pct != null ? (
                    <div
                      className="react-chat-subagent-card__progress-bar"
                      style={{ width: `${pct}%` }}
                    />
                  ) : null}
                </div>
              </div>
              {(t.phase === 'failed' || t.phase === 'timed_out') && t.error ? (
                <div className="react-chat-subagent-card__error">{t.error}</div>
              ) : null}
              <div className="react-chat-subagent-card__output-wrap">
                {t.tools && t.tools.length ? (
                  <>
                    <div className="react-chat-subagent-card__output-label">工具过程</div>
                    <ToolCallList tools={t.tools} liveOutput={t.liveOutput} />
                  </>
                ) : null}
                <div className="react-chat-subagent-card__output-label">实时输出</div>
                <div className="react-chat-subagent-card__output">
                  {(t.liveOutput || t.progressHint || '').trim() ? (
                    <MarkdownHtml text={(t.liveOutput || t.progressHint || '').trim()} />
                  ) : (
                    '（等待首条输出…）'
                  )}
                </div>
              </div>
              <div className="react-chat-subagent-card__output-label">
                <button
                  type="button"
                  className="react-chat-subagent-dock__toggle"
                  onClick={() => setSelectedTaskId(t.taskId)}
                >
                  查看详情
                </button>
              </div>
            </article>
          )
        })}
      </div>
      {selectedTask && typeof document !== 'undefined'
        ? createPortal(
            <div className="react-chat-run-output-panel">
              <div className="react-chat-run-output-header">
                <span className="react-chat-run-output-title">
                  子任务实时流 · {selectedTask.description || selectedTask.taskId}
                </span>
                <button
                  type="button"
                  className="react-chat-run-output-close"
                  onClick={() => setSelectedTaskId(null)}
                  title="关闭"
                >
                  ×
                </button>
              </div>
              <div className="react-chat-run-output-content">
                <MessageRow
                  row={{
                    role: 'assistant',
                    text: (selectedTask.liveOutput || selectedTask.progressHint || '').trim(),
                    tools: selectedTask.tools || [],
                    timestamp: selectedTask.startedAt,
                  }}
                />
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

/** @deprecated 保留导出：子智能体输出已默认并入主会话消息区，可改用 SubagentInlineCards */
export function SubagentLiveDock({
  tasks,
  hidden,
  onToggleHidden,
}: {
  tasks: Record<string, SubagentStreamTask>
  hidden: boolean
  onToggleHidden: () => void
}) {
  const list = Object.values(tasks).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
  if (!list.length) return null
  return (
    <section className="react-chat-subagent-dock" aria-label="子智能体实时过程">
      <header className="react-chat-subagent-dock__head">
        <span className="react-chat-subagent-dock__title">子智能体 · 并行实况</span>
        <div className="react-chat-subagent-dock__actions">
          <span className="react-chat-subagent-dock__meta">{list.length} 个任务</span>
          <button
            type="button"
            className="react-chat-subagent-dock__toggle"
            onClick={onToggleHidden}
            title={hidden ? '显示子智能体面板' : '隐藏子智能体面板'}
          >
            {hidden ? '显示' : '隐藏'}
          </button>
        </div>
      </header>
      {!hidden ? (
        <div className="react-chat-subagent-dock__body">
          <SubagentInlineCards tasks={tasks} />
        </div>
      ) : null}
    </section>
  )
}
