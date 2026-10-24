import { memo, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import type { RightStageSurface } from '../../../lib/right-stage/right-stage-types.js'
import {
  navigatePlatformFeedbackRoute,
  type PlatformFeedbackSurfaceData,
  type PlatformUiFeedback,
} from '../../../lib/right-stage/platform-feedback.js'
import { api } from '../../../lib/tauri-api.js'
import { toast } from '../../../components/toast.js'

const CHANNEL_LABELS: Record<string, string> = {
  feishu: '飞书',
  wecom: '企业微信',
  dingtalk: '钉钉',
  weixin: '微信',
}

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

async function encodeQrDataUrl(raw: string, size = 220): Promise<string> {
  const text = String(raw || '').trim()
  if (!text) return ''
  return QRCode.toDataURL(text, {
    width: size,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#111111', light: '#ffffff' },
  })
}

function BindChannelQrBlock({
  data,
  onClose,
}: {
  data: PlatformUiFeedback
  onClose?: () => void
}) {
  const channel = String(data.channel || 'feishu').toLowerCase()
  const label = CHANNEL_LABELS[channel] || channel
  const agentCode = String(data.agentCode || data.entityId || '').trim()
  const sessionId = String(data.sessionId || '').trim()
  const qrRaw = String(data.qrUrl || '').trim()

  const [imgSrc, setImgSrc] = useState('')
  const [qrError, setQrError] = useState('')
  const [status, setStatus] = useState(String(data.bindStatus || 'pending'))
  const [statusText, setStatusText] = useState('等待扫码…')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const applyingRef = useRef(false)
  const liveQrRef = useRef(qrRaw)

  useEffect(() => {
    let cancelled = false
    setQrError('')
    setImgSrc('')
    if (!qrRaw) {
      setQrError('未返回二维码链接')
      return
    }
    void encodeQrDataUrl(qrRaw)
      .then((uri) => {
        if (!cancelled) setImgSrc(uri)
      })
      .catch((e) => {
        if (!cancelled) setQrError(String(e?.message || e || '二维码生成失败'))
      })
    return () => {
      cancelled = true
    }
  }, [qrRaw])

  useEffect(() => {
    if (!sessionId || !agentCode) return
    if (data.bindStatus === 'bound') {
      setStatus('bound')
      setStatusText(`已绑定${label}专属机器人`)
      return
    }

    const pollApi =
      channel === 'wecom'
        ? (sid: string) => api.pollWecomRegistration(sid)
        : (sid: string) => api.pollFeishuRegistration(sid)
    const applyApi =
      channel === 'wecom'
        ? (code: string, sid: string) => api.applyRoleWecomRegistration(code, sid)
        : (code: string, sid: string) => api.applyRoleFeishuRegistration(code, sid)
    let stopped = false

    const stopPoll = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }

    const tick = async () => {
      if (stopped || applyingRef.current) return
      try {
        const result = await pollApi(sessionId)
        if (stopped) return
        const st = String(result?.status || '').toLowerCase()
        const nextQr = String(result?.qr_url || '').trim()
        if (nextQr && nextQr !== liveQrRef.current) {
          liveQrRef.current = nextQr
          try {
            const uri = await encodeQrDataUrl(nextQr)
            if (!stopped) setImgSrc(uri)
          } catch {
            /* keep previous image */
          }
        }
        if (st === 'scanning') {
          setStatus('scanning')
          setStatusText('已扫码，确认中…')
          return
        }
        if (st === 'expired' || st === 'failed') {
          setStatus(st)
          setStatusText(st === 'expired' ? '二维码已过期，请让 AI 重新出码' : '扫码失败，请重试')
          stopPoll()
          return
        }
        if (st !== 'completed') {
          setStatus('pending')
          setStatusText('等待扫码…')
          return
        }
        applyingRef.current = true
        setStatusText('扫码成功，正在绑定…')
        stopPoll()
        try {
          await applyApi(agentCode, sessionId)
          if (!stopped) {
            setStatus('bound')
            setStatusText(`已绑定${label}专属机器人`)
            toast(`「${data.entityLabel || agentCode}」已绑定${label}`, 'success')
          }
        } catch (e) {
          if (!stopped) {
            setStatus('failed')
            setStatusText(`绑定失败：${String((e as Error)?.message || e)}`)
            toast(`绑定失败: ${e}`, 'error')
          }
        } finally {
          applyingRef.current = false
        }
      } catch {
        /* transient poll errors — keep waiting */
      }
    }

    void tick()
    pollRef.current = setInterval(() => void tick(), 2000)
    return () => {
      stopped = true
      stopPoll()
    }
  }, [sessionId, agentCode, channel, label, data.entityLabel, data.bindStatus])

  return (
    <div className="react-chat-platform-feedback-qr">
      <div className="react-chat-platform-feedback-qr-frame" aria-label={`${label}扫码`}>
        {imgSrc ? (
          <img className="react-chat-platform-feedback-qr-img" src={imgSrc} alt={`${label}扫码`} width={220} height={220} />
        ) : (
          <div className="react-chat-platform-feedback-qr-placeholder">{qrError || '二维码加载中…'}</div>
        )}
      </div>
      {qrRaw ? (
        <p className="react-chat-platform-feedback-qr-link">
          <a href={qrRaw} target="_blank" rel="noopener noreferrer">
            二维码不显示？点此打开链接
          </a>
        </p>
      ) : null}
      <p
        className={`react-chat-platform-feedback-qr-status react-chat-platform-feedback-qr-status--${status}`}
        role="status"
      >
        {statusText}
      </p>
      {status === 'bound' ? (
        <div className="react-chat-platform-feedback-actions">
          <button
            type="button"
            className="react-chat-platform-feedback-action"
            onClick={() => {
              if (agentCode) navigatePlatformFeedbackRoute(`/proactive/${agentCode}`)
              else onClose?.()
            }}
          >
            查看员工
          </button>
          <button type="button" className="react-chat-platform-feedback-action react-chat-platform-feedback-action--muted" onClick={() => onClose?.()}>
            知道了
          </button>
        </div>
      ) : null}
    </div>
  )
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
  const showBindQr =
    Boolean(data.qrUrl || data.sessionId) &&
    (String(data.action || '') === 'employees.bind_channel_begin' || Boolean(data.bindStatus))

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
          {showBindQr ? (
            <BindChannelQrBlock data={data} onClose={onClose} />
          ) : (
            <>
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
                <button
                  type="button"
                  className="react-chat-platform-feedback-action react-chat-platform-feedback-action--muted"
                  onClick={() => onClose?.()}
                >
                  知道了
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}

export const PlatformFeedbackKind = memo(PlatformFeedbackKindInner)
