import { memo } from 'react'
import type { RightStageSurface } from '../../../lib/right-stage/right-stage-types.js'
import {
  activatePlatformFeedbackAction,
  type PlatformFeedbackSurfaceData,
  type PlatformUiFeedback,
} from '../../../lib/right-stage/platform-feedback.js'

function domainLabel(domain?: string): string {
  const map: Record<string, string> = {
    knowledge: '知识库',
    workflow: '工作流',
    settings: '设置',
    agents: '智能体',
    employees: '员工',
    tasks: '协作任务',
    items: '待办',
    skills: '技能',
    mcp: 'MCP',
    automation: '自动化',
    approvals: '审批',
    memory: '记忆',
    experience: '经验',
    verification: '验证',
    channels: 'IM 渠道',
  }
  return map[String(domain || '').trim()] || '平台'
}

/**
 * 右侧平台反馈：纯文字摘要。
 * 扫码绑本岗 AI 员工的二维码只在对话流工具下方展示，不在右侧重复出码。
 */
function PlatformFeedbackKindInner({
  surface,
  onClose,
}: {
  surface: RightStageSurface
  onClose?: () => void
}) {
  const data = (surface.data || {}) as PlatformFeedbackSurfaceData & PlatformUiFeedback
  const kind = data.kind === 'warning' ? 'warning' : data.kind === 'error' ? 'error' : 'success'
  const domain = domainLabel(data.domain)
  const actions = Array.isArray(data.actions) ? data.actions : []
  const details = Array.isArray(data.details) ? data.details : []
  const isBindBegin = String(data.action || '') === 'employees.bind_channel_begin'
  const qrUrl = String(data.qrUrl || '').trim()

  return (
    <>
      <header className="react-chat-collab-exec-panel-header react-chat-platform-feedback-header">
        <div className="react-chat-platform-feedback-header-title">
          <span
            className={`react-chat-platform-feedback-status react-chat-platform-feedback-status--${kind}`}
            aria-hidden
          >
            {kind === 'warning' ? '!' : kind === 'error' ? '×' : '✓'}
          </span>
          <span>{surface.title || '平台操作'}</span>
        </div>
        {onClose ? (
          <button type="button" className="react-chat-collab-exec-panel-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        ) : null}
      </header>
      <div className="react-chat-collab-exec-panel-body react-chat-platform-feedback-body">
        <div className={`react-chat-platform-feedback-card react-chat-platform-feedback-card--${kind}`}>
          <div className="react-chat-platform-feedback-domain">{domain}</div>
          <div className="react-chat-platform-feedback-title">{String(data.title || '').trim() || '操作成功'}</div>
          {data.subtitle ? (
            <p className="react-chat-platform-feedback-subtitle">{data.subtitle}</p>
          ) : null}
          <p className="react-chat-platform-feedback-hint">
            {isBindBegin
              ? "扫码绑定本岗 AI 员工。"
              : "关闭后可在上方 Exploring 中点击 platform 工具行重新打开；事项本身在任务中心。"}
          </p>
          {details.length ? (
            <ul className="react-chat-platform-feedback-details">
              {details.map((row) => (
                <li key={`${row.label}:${row.value}`}>
                  <span className="react-chat-platform-feedback-details-label">{row.label}</span>
                  <span className="react-chat-platform-feedback-details-value">{row.value}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="react-chat-platform-feedback-actions">
            {isBindBegin && qrUrl ? (
              <button
                type="button"
                className="react-chat-platform-feedback-action"
                onClick={() => window.open(qrUrl, '_blank', 'noopener,noreferrer')}
              >
                打开扫码页
              </button>
            ) : null}
            {actions.map((action) => (
              <button
                key={`${action.label}:${action.route || action.openStage?.kind || ''}`}
                type="button"
                className="react-chat-platform-feedback-action"
                onClick={() => {
                  if (!activatePlatformFeedbackAction(action)) onClose?.()
                }}
              >
                {action.label}
              </button>
            ))}
            <button
              type="button"
              className="react-chat-platform-feedback-action react-chat-platform-feedback-action--muted"
              onClick={() => onClose?.()}
            >
              知道了
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

export const PlatformFeedbackKind = memo(PlatformFeedbackKindInner)
