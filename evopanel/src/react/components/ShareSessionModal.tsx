import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, getGatewayBaseUrl } from '../../lib/tauri-api.js'
import { getAccessUrls, getWebuiStatus } from '../../lib/webui-remote.js'
import { toast } from '../../components/toast.js'
import {
  messagesToShareMarkdown,
  saveMarkdownExport,
  type ShareMarkdownMessage,
} from '../lib/session-share-markdown.js'

type CreatedShare = {
  token: string
  url_path: string
  title: string
  expires_at?: string | null
  message_count?: number
}

function isLocalOnlyBase(url: string): boolean {
  try {
    const u = new URL(url)
    const h = u.hostname.toLowerCase()
    return h === 'localhost' || h === '127.0.0.1' || h === '::1'
  } catch {
    return /localhost|127\.0\.0\.1/i.test(url)
  }
}

async function resolveShareBaseUrl(): Promise<{ base: string; localOnly: boolean }> {
  const candidates: string[] = []
  try {
    const status = await getWebuiStatus()
    for (const u of status?.access_urls || []) {
      const s = String(u || '').trim().replace(/\/$/, '')
      if (s) candidates.push(s)
    }
  } catch {
    /* optional */
  }
  try {
    const access = await getAccessUrls()
    for (const u of access?.urls || []) {
      const s = String(u || '').trim().replace(/\/$/, '')
      if (s) candidates.push(s)
    }
  } catch {
    /* optional */
  }
  try {
    const gw = String((await getGatewayBaseUrl()) || '').trim().replace(/\/$/, '')
    if (gw) candidates.push(gw)
  } catch {
    /* optional */
  }
  if (typeof window !== 'undefined' && window.location?.origin) {
    candidates.push(String(window.location.origin).replace(/\/$/, ''))
  }
  const unique = [...new Set(candidates.filter(Boolean))]
  const lan = unique.find((u) => !isLocalOnlyBase(u))
  const base = lan || unique[0] || (typeof window !== 'undefined' ? window.location.origin : '')
  return { base: String(base || '').replace(/\/$/, ''), localOnly: isLocalOnlyBase(base) }
}

function buildAbsoluteShareUrl(base: string, urlPath: string): string {
  const path = String(urlPath || '').trim()
  if (/^https?:\/\//i.test(path)) return path
  const b = String(base || '').replace(/\/$/, '')
  if (path.startsWith('/#/')) return `${b}${path}`
  if (path.startsWith('#')) return `${b}/${path}`
  if (path.startsWith('/share/')) return `${b}/#${path}`
  return `${b}/#/share/${path.replace(/^\//, '')}`
}

export function ShareSessionModal({
  open,
  onClose,
  sessionKey,
  sessionTitle,
}: {
  open: boolean
  onClose: () => void
  sessionKey: string
  sessionTitle: string
}) {
  const [includeTools, setIncludeTools] = useState(false)
  const [expiresDays, setExpiresDays] = useState<number | null>(7)
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<CreatedShare | null>(null)
  const [absoluteUrl, setAbsoluteUrl] = useState('')
  const [localOnly, setLocalOnly] = useState(false)
  const [latestToken, setLatestToken] = useState('')

  const sk = String(sessionKey || '').trim()
  const title = String(sessionTitle || '').trim() || '未命名会话'

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) {
      setCreated(null)
      setAbsoluteUrl('')
      setBusy(false)
      return
    }
    let cancelled = false
    void (async () => {
      if (!sk) return
      try {
        const res = await api.shareLatestForSession(sk)
        if (cancelled) return
        const share = res?.share
        if (share?.active && share?.token) {
          setLatestToken(String(share.token))
          setCreated({
            token: String(share.token),
            url_path: String(share.url_path || `/#/share/${share.token}`),
            title: String(share.title || title),
            expires_at: share.expires_at,
          })
        } else {
          setLatestToken('')
        }
      } catch {
        if (!cancelled) setLatestToken('')
      }
      try {
        const { base, localOnly: lo } = await resolveShareBaseUrl()
        if (cancelled) return
        setLocalOnly(lo)
        if (created?.url_path || latestToken) {
          const path = created?.url_path || `/#/share/${latestToken}`
          setAbsoluteUrl(buildAbsoluteShareUrl(base, path))
        }
      } catch {
        /* ignore */
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sk])

  useEffect(() => {
    if (!open || !created?.url_path) return
    let cancelled = false
    void resolveShareBaseUrl().then(({ base, localOnly: lo }) => {
      if (cancelled) return
      setLocalOnly(lo)
      setAbsoluteUrl(buildAbsoluteShareUrl(base, created.url_path))
    })
    return () => {
      cancelled = true
    }
  }, [open, created?.url_path])

  const loadMessagesForExport = useCallback(async (): Promise<ShareMarkdownMessage[]> => {
    const { wsClient } = await import('../../lib/ws-client.js')
    const hist = await wsClient.chatHistory(sk, 5000, { all: true })
    return Array.isArray(hist?.messages) ? hist.messages : []
  }, [sk])

  const copyText = async (text: string, okMsg: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast(okMsg, 'success')
    } catch {
      toast('复制失败，请手动选择文本', 'error')
    }
  }

  const onExportCopy = async () => {
    if (!sk || busy) return
    setBusy(true)
    try {
      const messages = await loadMessagesForExport()
      const md = messagesToShareMarkdown(title, messages, { includeTools })
      await copyText(md, '已复制 Markdown')
    } catch (e) {
      toast(`导出失败：${String((e as Error)?.message || e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const onExportDownload = async () => {
    if (!sk || busy) return
    setBusy(true)
    try {
      const messages = await loadMessagesForExport()
      const md = messagesToShareMarkdown(title, messages, { includeTools })
      const result = await saveMarkdownExport(title, md)
      if (!result.ok) {
        toast('已取消保存', 'info')
        return
      }
      if (result.mode === 'path') {
        toast(`已保存到：${result.path}`, 'success', { duration: 6000 })
      } else {
        toast(`已开始下载「${result.filename}」，请到浏览器「下载」文件夹查看`, 'success', {
          duration: 6000,
        })
      }
    } catch (e) {
      toast(`下载失败：${String((e as Error)?.message || e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const onCreateLink = async () => {
    if (!sk || busy) return
    setBusy(true)
    try {
      const res = await api.shareCreate({
        session_key: sk,
        expires_in_days: expiresDays,
        include_tools: includeTools,
      })
      const next: CreatedShare = {
        token: String(res?.token || ''),
        url_path: String(res?.url_path || ''),
        title: String(res?.title || title),
        expires_at: res?.expires_at,
        message_count: res?.message_count,
      }
      setCreated(next)
      setLatestToken(next.token)
      const { base, localOnly: lo } = await resolveShareBaseUrl()
      setLocalOnly(lo)
      const abs = buildAbsoluteShareUrl(base, next.url_path || `/#/share/${next.token}`)
      setAbsoluteUrl(abs)
      await copyText(abs, '分享链接已复制')
    } catch (e) {
      toast(`生成链接失败：${String((e as Error)?.message || e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const onRevoke = async () => {
    const token = String(created?.token || latestToken || '').trim()
    if (!token || busy) return
    setBusy(true)
    try {
      await api.shareRevoke(token)
      setCreated(null)
      setLatestToken('')
      setAbsoluteUrl('')
      toast('已撤销分享链接', 'success')
    } catch (e) {
      toast(`撤销失败：${String((e as Error)?.message || e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      className="react-chat-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="分享会话"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="react-chat-modal-card react-chat-share-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="react-chat-modal-header">
          <div>
            <div className="react-chat-modal-title">分享会话</div>
            <div className="react-chat-share-modal-sub" title={title}>
              {title}
            </div>
          </div>
          <button type="button" className="react-chat-modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="react-chat-modal-body react-chat-share-modal-body">
          <section className="react-chat-share-section" aria-label="只读链接">
            <div className="react-chat-share-section-title">只读链接</div>
            <p className="react-chat-share-hint">
              生成后冻结当前对话快照。对方需能访问本机网关才能打开。
            </p>
            <label className="react-chat-share-check">
              <input
                type="checkbox"
                checked={includeTools}
                onChange={(e) => setIncludeTools(e.target.checked)}
                disabled={busy}
              />
              包含工具过程摘要
            </label>
            <label className="react-chat-share-field">
              <span>有效期</span>
              <select
                value={expiresDays == null ? 'never' : String(expiresDays)}
                disabled={busy}
                onChange={(e) => {
                  const v = e.target.value
                  setExpiresDays(v === 'never' ? null : Number(v))
                }}
              >
                <option value="7">7 天</option>
                <option value="30">30 天</option>
                <option value="never">不过期</option>
              </select>
            </label>
            {absoluteUrl ? (
              <div className="react-chat-share-link-box">
                <input
                  className="react-chat-modal-input"
                  readOnly
                  value={absoluteUrl}
                  onFocus={(e) => e.currentTarget.select()}
                />
                {localOnly ? (
                  <p className="react-chat-share-warn">
                    当前为 localhost 地址，仅本机可打开；局域网请用 LAN 访问地址。
                  </p>
                ) : null}
                {created?.expires_at ? (
                  <p className="react-chat-share-meta">过期：{String(created.expires_at)}</p>
                ) : created ? (
                  <p className="react-chat-share-meta">不过期</p>
                ) : null}
              </div>
            ) : null}
            <div className="react-chat-share-actions">
              <button
                type="button"
                className="react-chat-modal-btn react-chat-modal-btn--primary"
                disabled={busy || !sk}
                onClick={() => void onCreateLink()}
              >
                {absoluteUrl ? '重新生成并复制' : '生成链接并复制'}
              </button>
              {absoluteUrl ? (
                <button
                  type="button"
                  className="react-chat-modal-btn react-chat-modal-btn--ghost"
                  disabled={busy}
                  onClick={() => void copyText(absoluteUrl, '链接已复制')}
                >
                  复制链接
                </button>
              ) : null}
              {created?.token || latestToken ? (
                <button
                  type="button"
                  className="react-chat-modal-btn react-chat-modal-btn--ghost"
                  disabled={busy}
                  onClick={() => void onRevoke()}
                >
                  撤销链接
                </button>
              ) : null}
            </div>
          </section>

          <section className="react-chat-share-section" aria-label="本机导出">
            <div className="react-chat-share-section-title">本机导出</div>
            <p className="react-chat-share-hint">复制或下载 Markdown，不依赖外网。</p>
            <div className="react-chat-share-actions">
              <button
                type="button"
                className="react-chat-modal-btn react-chat-modal-btn--ghost"
                disabled={busy || !sk}
                onClick={() => void onExportCopy()}
              >
                复制 Markdown
              </button>
              <button
                type="button"
                className="react-chat-modal-btn react-chat-modal-btn--ghost"
                disabled={busy || !sk}
                onClick={() => void onExportDownload()}
              >
                保存为 .md
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  )
}
