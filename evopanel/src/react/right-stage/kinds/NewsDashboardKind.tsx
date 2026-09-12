import { memo, useCallback, useEffect, useState } from 'react'
import { apiUrlAsync } from '../../../lib/api-client.js'

type FeedItem = {
  rank?: number
  text?: string
  title?: string
  heat?: string | number
  tag?: string
  trend?: 'up' | 'down' | 'same' | string
  isNew?: boolean
  url?: string
  source?: string
}
type PlatformStatus = { ok?: boolean; count?: number; source?: string; error?: string }
type FeedsResponse = {
  ok?: boolean
  platforms?: Record<string, FeedItem[]>
  status?: Record<string, PlatformStatus>
  fetchedAt?: string
  stale?: boolean
  refreshMinutes?: number
  error?: string
}

const PLATFORM_ORDER = ['douyin', 'xiaohongshu', 'wechat', 'weibo'] as const

const PLATFORM_CONFIG: Record<
  string,
  { label: string; dotClass: string; style: 'heat' | 'label' }
> = {
  douyin: { label: '抖音', dotClass: 'react-chat-news-dot-douyin', style: 'heat' },
  xiaohongshu: { label: '小红书', dotClass: 'react-chat-news-dot-xhs', style: 'heat' },
  wechat: { label: '微信', dotClass: 'react-chat-news-dot-wechat', style: 'label' },
  weibo: { label: '微博', dotClass: 'react-chat-news-dot-weibo', style: 'heat' },
}

function itemTitle(item: FeedItem): string {
  return String(item.text || item.title || '').trim()
}

function formatFetchedAt(value?: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function displayHeat(item: FeedItem, style: 'heat' | 'label'): string {
  const heat = item.heat != null && item.heat !== '' ? String(item.heat) : ''
  const tag = String(item.tag || '').trim()
  if (style === 'label') return tag || heat
  return heat || tag
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M21 3v6h-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export const NewsDashboardKind = memo(function NewsDashboardKind({
  onClose,
}: {
  onClose?: () => void
}) {
  const [data, setData] = useState<FeedsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async (forceRefresh = false) => {
    setLoading(true)
    setError('')
    try {
      const path = forceRefresh ? '/stage/news/feeds?refresh=1' : '/stage/news/feeds'
      const url = await apiUrlAsync(path)
      const res = await fetch(url, { credentials: 'include', cache: 'no-store' })
      const json = (await res.json()) as FeedsResponse
      if (!res.ok || json?.ok === false) {
        throw new Error(json?.error || `HTTP ${res.status}`)
      }
      setData(json)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    queueMicrotask(() => void load())
    const t = window.setInterval(() => void load(), 30 * 60 * 1000)
    return () => window.clearInterval(t)
  }, [load])

  const platforms = data?.platforms || {}
  const status = data?.status || {}
  const totalCount = PLATFORM_ORDER.reduce((sum, key) => sum + (platforms[key]?.length || 0), 0)
  const timeLabel = formatFetchedAt(data?.fetchedAt)

  return (
    <div className="react-chat-news-dashboard">
      <header className="react-chat-news-toolbar">
        <span className="react-chat-news-toolbar-title">热榜</span>
        <span className="react-chat-news-toolbar-meta">
          {loading ? '加载中' : data?.stale ? '缓存' : '实时'}
          {timeLabel ? ` · ${timeLabel}` : ''}
          {totalCount > 0 ? ` · ${totalCount} 条` : ''}
        </span>
        <button
          type="button"
          className="react-chat-news-toolbar-btn"
          onClick={() => void load(true)}
          disabled={loading}
          title="刷新"
          aria-label="刷新"
        >
          <RefreshIcon />
        </button>
        {onClose ? (
          <button
            type="button"
            className="react-chat-news-toolbar-btn react-chat-news-toolbar-close"
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
          >
            ×
          </button>
        ) : null}
      </header>

      {error ? <p className="react-chat-news-banner react-chat-news-banner-error">{error}</p> : null}
      {data?.error && !error ? (
        <p className="react-chat-news-banner react-chat-news-banner-warn">部分源失败，已使用缓存</p>
      ) : null}

      <div className="react-chat-news-scroll">
        {PLATFORM_ORDER.map((key) => {
          const config = PLATFORM_CONFIG[key]
          const items = (platforms[key] || []).slice(0, 10)
          const platformStatus = status[key]

          return (
            <section key={key} className="react-chat-news-section">
              <div className="react-chat-news-section-label">
                <span className={`react-chat-news-platform-dot ${config.dotClass}`} aria-hidden />
                <span>{config.label}</span>
              </div>
              {platformStatus?.ok === false && platformStatus.error ? (
                <p className="react-chat-news-section-hint">{platformStatus.error}</p>
              ) : null}
              <ul className="react-chat-news-rows">
                {!items.length ? (
                  <li className="react-chat-news-row react-chat-news-row-empty">
                    <span className="react-chat-news-rank">—</span>
                    <span className="react-chat-news-text">暂无数据</span>
                  </li>
                ) : (
                  items.map((item, idx) => {
                    const title = itemTitle(item)
                    const rank = item.rank ?? idx + 1
                    const rankCls = rank <= 3 ? `react-chat-news-rank-top${rank}` : ''
                    const heat = displayHeat(item, config.style)
                    const href = String(item.url || '').trim()

                    return (
                      <li key={`${key}-${idx}`} className="react-chat-news-row">
                        <span className={`react-chat-news-rank ${rankCls}`}>{rank}</span>
                        {href ? (
                          <a
                            className="react-chat-news-text react-chat-news-link"
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={title}
                          >
                            {title}
                            {item.isNew ? <span className="react-chat-news-new">新</span> : null}
                          </a>
                        ) : (
                          <span className="react-chat-news-text">
                            {title}
                            {item.isNew ? <span className="react-chat-news-new">新</span> : null}
                          </span>
                        )}
                        {heat ? (
                          <span
                            className={
                              config.style === 'label'
                                ? 'react-chat-news-tag'
                                : 'react-chat-news-heat'
                            }
                          >
                            {heat}
                          </span>
                        ) : null}
                      </li>
                    )
                  })
                )}
              </ul>
            </section>
          )
        })}
      </div>
    </div>
  )
})
