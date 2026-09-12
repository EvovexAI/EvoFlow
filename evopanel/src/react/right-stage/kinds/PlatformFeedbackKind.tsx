import { memo } from 'react'
import type { RightStageSurface } from '../../../lib/right-stage/right-stage-types.js'
import {
  navigatePlatformFeedbackRoute,
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
  }
  return map[String(domain || '').trim()] || '平台'
}

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
            关闭后可在上方 Exploring 中点击 platform 工具行重新打开；事项本身在任务中心。
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
          {actions.length ? (
            <div className="react-chat-platform-feedback-actions">
              {actions.map((action) => (
                <button
                  key={`${action.label}:${action.route || ''}`}
                  type="button"
                  className="react-chat-platform-feedback-action"
                  onClick={() => {
                    if (action.route) navigatePlatformFeedbackRoute(action.route)
                    else onClose?.()
                  }}
                >
                  {action.label}
                </button>
              ))}
              <button type="button" className="react-chat-platform-feedback-action react-chat-platform-feedback-action--muted" onClick={() => onClose?.()}>
                知道了
              </button>
            </div>
          ) : (
            <div className="react-chat-platform-feedback-actions">
              <button type="button" className="react-chat-platform-feedback-action" onClick={() => onClose?.()}>
                知道了
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

export const PlatformFeedbackKind = memo(PlatformFeedbackKindInner)
