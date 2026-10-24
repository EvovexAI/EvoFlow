import { memo, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import type { PlatformUiFeedback } from '../../lib/right-stage/platform-feedback.js'
import { navigatePlatformFeedbackRoute } from '../../lib/right-stage/platform-feedback.js'
import { api } from '../../lib/tauri-api.js'
import { toast } from '../../components/toast.js'

const CHANNEL_LABELS: Record<string, string> = {
  feishu: '飞书',
  wecom: '企业微信',
  dingtalk: '钉钉',
  weixin: '微信',
}

async function encodeQrDataUrl(raw: string, size = 200): Promise<string> {
  const text = String(raw || '').trim()
  if (!text) return ''
  return QRCode.toDataURL(text, {
    width: size,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#111111', light: '#ffffff' },
  })
}

type Props = {
  data: PlatformUiFeedback
  /** Compact layout for inline message-stream cards */
  compact?: boolean
  onBound?: () => void
}

/** Shared Feishu/WeCom employee bind QR + auto poll/apply. */
export const EmployeeBindChannelQr = memo(function EmployeeBindChannelQr({
  data,
  compact = false,
  onBound,
}: Props) {
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
    void encodeQrDataUrl(qrRaw, compact ? 180 : 220)
      .then((uri) => {
        if (!cancelled) setImgSrc(uri)
      })
      .catch((e) => {
        if (!cancelled) setQrError(String(e?.message || e || '二维码生成失败'))
      })
    return () => {
      cancelled = true
    }
  }, [qrRaw, compact])

  useEffect(() => {
    if (!sessionId || !agentCode) return
    if (data.bindStatus === 'bound') {
      setStatus('bound')
      setStatusText(`已绑定本岗 AI 员工（${label}）`)
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
            const uri = await encodeQrDataUrl(nextQr, compact ? 180 : 220)
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
          setStatusText(st === 'expired' ? '二维码已过期，请重新出码' : '扫码失败，请重试')
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
            setStatusText(`已绑定本岗 AI 员工（${label}）`)
            toast(`「${data.entityLabel || agentCode}」已绑定到${label}`, 'success')
            onBound?.()
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
        /* transient poll errors */
      }
    }

    void tick()
    pollRef.current = setInterval(() => void tick(), 2000)
    return () => {
      stopped = true
      stopPoll()
    }
  }, [sessionId, agentCode, channel, label, data.entityLabel, data.bindStatus, compact, onBound])

  const size = compact ? 180 : 220

  return (
    <div className={`emp-bind-channel-qr${compact ? ' emp-bind-channel-qr--compact' : ''}`}>
      <div className="emp-bind-channel-qr-frame" aria-label={`${label}扫码`} style={{ width: size + 8, height: size + 8 }}>
        {imgSrc ? (
          <img className="emp-bind-channel-qr-img" src={imgSrc} alt={`${label}扫码`} width={size} height={size} />
        ) : (
          <div className="emp-bind-channel-qr-placeholder">{qrError || '二维码加载中…'}</div>
        )}
      </div>
      {qrRaw ? (
        <p className="emp-bind-channel-qr-link">
          <a href={qrRaw} target="_blank" rel="noopener noreferrer">
            用{label}打开扫码页
          </a>
        </p>
      ) : null}
      <p className={`emp-bind-channel-qr-status emp-bind-channel-qr-status--${status}`} role="status">
        {statusText}
      </p>
      {status === 'bound' && agentCode ? (
        <button
          type="button"
          className="emp-bind-channel-qr-open-role"
          onClick={() => navigatePlatformFeedbackRoute(`/proactive/${agentCode}`)}
        >
          查看员工
        </button>
      ) : null}
    </div>
  )
})
