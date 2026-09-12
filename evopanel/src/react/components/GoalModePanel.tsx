import { memo, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { pushTargetKey, type PushTargetOption } from '../lib/goalPushTarget.js'
import { PushTargetPicker } from './PushTargetPicker.js'
import { MarkdownHtml } from './MarkdownHtml.js'

function goalStatusLabel(ui: {
  goalActive: boolean
  completionOutcome: string
  status: string
  isExecuting: boolean
}): string {
  if (ui.completionOutcome) return ui.completionOutcome
  if (!ui.goalActive) return ''
  if (ui.status === 'paused') return '判断中'
  if (ui.isExecuting) return '执行中'
  return '等待中'
}

function GoalModePanelInner({
  panelOpen,
  setPanelOpen,
  ui,
  statusText,
  statusIcon,
  setDraft,
  onStartGoal,
  onStopGoal,
}: {
  panelOpen: boolean
  setPanelOpen: React.Dispatch<React.SetStateAction<boolean>>
  ui: {
    goalActive: boolean
    isExecuting: boolean
    status: string
    prompt: string
    lastError: string
    goalSummary: string
    completionOutcome: string
    feishuPushOnComplete: boolean
    pushChannel: string
    pushTargetId: string
    pushTargets: PushTargetOption[]
    pushTargetsAvailable: boolean
    feishuPushConfigured: boolean
  }
  statusText: string
  statusIcon: string
  setDraft: (next: {
    prompt?: string
    feishuPushOnComplete?: boolean
    pushTargetKey?: string
    pushChannel?: string
    pushTargetId?: string
  }) => void
  onStartGoal: () => void
  onStopGoal: () => void
}) {
  const lockForm = ui.goalActive
  const statusLabel = goalStatusLabel(ui)
  const selectedPushKey = pushTargetKey(ui.pushChannel, ui.pushTargetId)
  const pushSelectDisabled = lockForm || !ui.pushTargetsAvailable || !ui.feishuPushOnComplete

  useEffect(() => {
    if (!panelOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPanelOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panelOpen, setPanelOpen])

  if (typeof document === 'undefined') return null

  const miniFab =
    !panelOpen && ui.goalActive
      ? createPortal(
          <button
            type="button"
            className="react-chat-goal-mini-fab"
            onClick={() => setPanelOpen(true)}
            title={statusText || '目标进行中'}
            aria-label="打开目标模式"
          >
            <span className="react-chat-goal-mini-fab-icon" aria-hidden>
              {statusIcon || '●'}
            </span>
            <span className="react-chat-goal-mini-fab-text">{statusText || '目标进行中'}</span>
          </button>,
          document.body,
        )
      : null

  const modal =
    panelOpen && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="react-chat-modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-label="目标模式"
            onClick={(e) => {
              if (e.target === e.currentTarget) setPanelOpen(false)
            }}
          >
            <div className="react-chat-modal-card react-chat-goal-modal" onClick={(e) => e.stopPropagation()}>
              <div className="react-chat-modal-header react-chat-goal-modal-header">
                <div className="react-chat-goal-modal-header-main">
                  <span className="react-chat-modal-title">目标模式</span>
                  {ui.goalActive ? (
                    <span className={`react-chat-goal-status-pill${ui.isExecuting ? ' is-running' : ''}`}>
                      {statusLabel}
                    </span>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="react-chat-modal-close"
                  onClick={() => setPanelOpen(false)}
                  aria-label="关闭"
                >
                  ×
                </button>
              </div>

              {ui.goalActive && !ui.completionOutcome && ui.lastError ? (
                <div className="react-chat-goal-progress-strip">
                  <div className="react-chat-goal-progress-error">{ui.lastError}</div>
                </div>
              ) : null}

              <div className="react-chat-modal-body react-chat-goal-modal-body">
                <section className="react-chat-goal-section">
                  <label className="react-chat-goal-field-label" htmlFor="goal-mode-prompt">
                    任务目标
                  </label>
                  <textarea
                    id="goal-mode-prompt"
                    className="react-chat-goal-prompt"
                    rows={3}
                    value={ui.prompt}
                    disabled={lockForm}
                    placeholder="例如：持续优化此仓库代码质量，直到没有可改进的地方"
                    onChange={(e) => setDraft({ prompt: e.target.value })}
                  />
                  <p className="react-chat-goal-hint">
                    目标模式会在本应用中自动推进任务；模型配置沿用 AI 助手页面设置。
                  </p>
                </section>

                <section className="react-chat-goal-section react-chat-goal-section--limits">
                  <div className="react-chat-goal-limit-row react-chat-goal-limit-row--inline">
                    <span className="react-chat-goal-limit-label">完成后推送结果</span>
                    <label className="react-chat-goal-toggle">
                      <input
                        type="checkbox"
                        checked={!!ui.feishuPushOnComplete}
                        disabled={lockForm || !ui.pushTargetsAvailable}
                        onChange={(e) => setDraft({ feishuPushOnComplete: e.target.checked })}
                      />
                      <span className="react-chat-goal-toggle-track" />
                    </label>
                  </div>
                  {ui.feishuPushOnComplete ? (
                    <div className="react-chat-goal-limit-row react-chat-goal-push-target-row">
                      <span className="react-chat-goal-limit-label">推送渠道</span>
                      <PushTargetPicker
                        value={selectedPushKey}
                        options={ui.pushTargets}
                        disabled={pushSelectDisabled}
                        onChange={(next) => setDraft({ pushTargetKey: next })}
                      />
                    </div>
                  ) : null}
                  {!ui.pushTargetsAvailable ? (
                    <p className="react-chat-goal-hint">暂无可用的推送渠道，请先绑定 IM 或配置飞书默认会话</p>
                  ) : null}
                </section>

                {(ui.goalSummary || ui.completionOutcome) ? (
                  <section className="react-chat-goal-section react-chat-goal-section--summary">
                    <div className="react-chat-goal-section-head">
                      <h3 className="react-chat-goal-section-title">完成总结</h3>
                      {ui.completionOutcome ? (
                        <span className="react-chat-goal-section-badge react-chat-goal-section-badge--done">
                          {ui.completionOutcome}
                        </span>
                      ) : null}
                    </div>
                    {ui.goalSummary ? (
                      <div className="react-chat-goal-summary-body msg-text react-chat-hosted-closure-md">
                        <MarkdownHtml text={ui.goalSummary} />
                      </div>
                    ) : null}
                  </section>
                ) : null}
              </div>

              <div className="react-chat-modal-actions react-chat-goal-modal-actions">
                <span className="react-chat-goal-footer-status">{statusText || '就绪'}</span>
                {!ui.goalActive ? (
                  <button
                    type="button"
                    className="react-chat-modal-btn react-chat-modal-btn--primary"
                    onClick={() => onStartGoal()}
                  >
                    启动目标
                  </button>
                ) : (
                  <button
                    type="button"
                    className="react-chat-modal-btn react-chat-modal-btn--ghost"
                    onClick={() => onStopGoal()}
                  >
                    停止目标
                  </button>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )
      : null

  if (!miniFab && !modal) return null

  return (
    <>
      {miniFab}
      {modal}
    </>
  )
}

export const GoalModePanel = memo(GoalModePanelInner)
