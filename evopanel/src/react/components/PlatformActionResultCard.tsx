import { memo, useMemo } from 'react'
import {
  activatePlatformFeedbackAction,
  parsePlatformUiFeedbackFromTool,
  platformActionCardMeta,
  platformActionCardTitle,
  type PlatformUiFeedback,
} from '../../lib/right-stage/platform-feedback.js'
import { requestOpenPlatformFeedbackFromTool } from '../../lib/right-stage/platform-feedback-bridge.js'
import { EmployeeBindChannelQr } from './EmployeeBindChannelQr.js'

type Props = {
  tool: Record<string, unknown>
  className?: string
}

function StatusIcon({ kind }: { kind: PlatformUiFeedback['kind'] }) {
  if (kind === 'error') {
    return (
      <span className="msg-action-result-icon is-error" aria-hidden>
        <svg viewBox="0 0 18 18" width="18" height="18" fill="none">
          <circle cx="9" cy="9" r="8" fill="currentColor" />
          <path d="M6.2 6.2l5.6 5.6M11.8 6.2l-5.6 5.6" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </span>
    )
  }
  if (kind === 'warning') {
    return (
      <span className="msg-action-result-icon is-warning" aria-hidden>
        <svg viewBox="0 0 18 18" width="18" height="18" fill="none">
          <circle cx="9" cy="9" r="8" fill="currentColor" />
          <path d="M9 5.2v5" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
          <circle cx="9" cy="12.6" r="0.9" fill="#fff" />
        </svg>
      </span>
    )
  }
  return (
    <span className="msg-action-result-icon is-success" aria-hidden>
      <svg viewBox="0 0 18 18" width="18" height="18" fill="none">
        <circle cx="9" cy="9" r="8" fill="currentColor" />
        <path
          d="M5.4 9.2l2.4 2.4 4.8-5"
          stroke="#fff"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}

function hasBindQr(ui: PlatformUiFeedback): boolean {
  return Boolean(
    (ui.qrUrl || ui.sessionId) &&
      (String(ui.action || '') === 'employees.bind_channel_begin' || Boolean(ui.bindStatus)),
  )
}

const CHANNEL_LABELS: Record<string, string> = {
  feishu: '飞书',
  wecom: '企业微信',
  dingtalk: '钉钉',
  weixin: '微信',
}

/** 平台工具完成后的结构化 Action Result（消息流内） */
export const PlatformActionResultCard = memo(function PlatformActionResultCard({
  tool,
  className = '',
}: Props) {
  const ui = useMemo(() => parsePlatformUiFeedbackFromTool(tool), [tool])
  if (!ui) return null

  const title = platformActionCardTitle(ui)
  const meta = platformActionCardMeta(ui)
  const showQr = hasBindQr(ui)
  const primaryAction = Array.isArray(ui.actions) && ui.actions.length > 0 ? ui.actions[0] : null
  const actionLabel = primaryAction?.label || '查看详情'
  const channelLabel = CHANNEL_LABELS[String(ui.channel || '').toLowerCase()] || '渠道'
  const employeeName = String(ui.entityLabel || ui.agentCode || '本岗 AI 员工').trim()

  const onOpen = () => {
    if (ui.qrUrl) {
      window.open(String(ui.qrUrl), '_blank', 'noopener,noreferrer')
      return
    }
    if (primaryAction && activatePlatformFeedbackAction(primaryAction)) return
    requestOpenPlatformFeedbackFromTool(tool)
  }

  // 绑渠道：像微信/钉钉发图一样，直接在对话下方出大图二维码扫码绑定本岗 AI 员工
  if (showQr) {
    return (
      <div className={`msg-bind-employee-qr${className ? ` ${className}` : ''}`}>
        <div className="msg-bind-employee-qr-caption">
          扫码绑定本岗 AI 员工「{employeeName}」· {channelLabel}
        </div>
        <EmployeeBindChannelQr data={ui} />
        {ui.qrUrl ? (
          <button type="button" className="msg-bind-employee-qr-open-link" onClick={onOpen}>
            打不开码？点此打开{channelLabel}扫码页
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <div className={`msg-action-result${className ? ` ${className}` : ''}`}>
      <StatusIcon kind={ui.kind} />
      <div className="msg-action-result-body">
        <div className="msg-action-result-title">{title}</div>
        <div className="msg-action-result-meta">{meta}</div>
      </div>
      <button type="button" className="msg-action-result-link" onClick={onOpen}>
        {actionLabel === '查看事项' || actionLabel === '查看任务' ? '查看详情' : actionLabel}
      </button>
    </div>
  )
})
