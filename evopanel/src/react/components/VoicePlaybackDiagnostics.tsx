/**
 * P2 语音播报台账诊断：按 TRACE 看「哪些字 → 哪条 utterance → 播没播完」。
 * 挂在小V 语音全屏左上角「台账」按钮。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiUrl } from '../../lib/api-client.js'

export type VoiceUtteranceRow = {
  id?: string
  trace_id?: string
  sid?: string
  seq?: number
  text?: string
  status?: string
  source?: string
  speaker?: string
  provider?: string
  created_at?: number
  synth_started_at?: number | null
  synth_ended_at?: number | null
  play_started_at?: number | null
  play_ended_at?: number | null
  bytes?: number
  duration_ms?: number
  audio_path?: string
  error?: string
}

const STATUS_LABEL: Record<string, string> = {
  queued: '排队',
  synthesizing: '合成中',
  ready: '就绪',
  playing: '播放中',
  played: '已播完',
  cancelled: '已取消',
  failed: '失败',
}

function statusClass(status: string): string {
  const s = String(status || '').toLowerCase()
  if (s === 'played') return 'ok'
  if (s === 'playing' || s === 'ready' || s === 'synthesizing' || s === 'queued') return 'live'
  if (s === 'cancelled') return 'warn'
  if (s === 'failed') return 'bad'
  return ''
}

function clip(s: string, n = 72): string {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`
}

function fmtMs(ms: number | undefined): string {
  const n = Number(ms || 0)
  if (!n || !Number.isFinite(n)) return '—'
  if (n < 1000) return `${Math.round(n)}ms`
  return `${(n / 1000).toFixed(1)}s`
}

function fmtClock(ts: number | null | undefined): string {
  const n = Number(ts || 0)
  if (!n) return '—'
  try {
    // backend stores unix seconds
    const d = new Date(n > 1e12 ? n : n * 1000)
    return d.toLocaleTimeString('zh-CN', { hour12: false })
  } catch {
    return '—'
  }
}

async function fetchRecent(limit = 80): Promise<VoiceUtteranceRow[]> {
  const url = import.meta.env?.DEV
    ? `/api/speech/playback/recent?limit=${limit}`
    : apiUrl(`/speech/playback/recent?limit=${limit}`)
  const res = await fetch(url, { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as { items?: VoiceUtteranceRow[] }
  return Array.isArray(data?.items) ? data.items : []
}

async function fetchByTrace(trace: string, limit = 100): Promise<VoiceUtteranceRow[]> {
  const tid = encodeURIComponent(String(trace || '').trim())
  if (!tid) return []
  const url = import.meta.env?.DEV
    ? `/api/speech/playback/by-trace?trace=${tid}&limit=${limit}`
    : apiUrl(`/speech/playback/by-trace?trace=${tid}&limit=${limit}`)
  const res = await fetch(url, { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as { items?: VoiceUtteranceRow[] }
  return Array.isArray(data?.items) ? data.items : []
}

function groupByTrace(rows: VoiceUtteranceRow[]): { trace: string; items: VoiceUtteranceRow[] }[] {
  const map = new Map<string, VoiceUtteranceRow[]>()
  for (const row of rows) {
    const tid = String(row.trace_id || '').trim() || '(无 TRACE)'
    const list = map.get(tid) || []
    list.push(row)
    map.set(tid, list)
  }
  const groups = [...map.entries()].map(([trace, items]) => ({
    trace,
    items: items.slice().sort((a, b) => {
      const ca = Number(a.created_at || 0)
      const cb = Number(b.created_at || 0)
      if (ca !== cb) return ca - cb
      return Number(a.seq || 0) - Number(b.seq || 0)
    }),
  }))
  groups.sort((a, b) => {
    const ta = Math.max(0, ...a.items.map((i) => Number(i.created_at || 0)))
    const tb = Math.max(0, ...b.items.map((i) => Number(i.created_at || 0)))
    return tb - ta
  })
  return groups
}

type Props = {
  open: boolean
  onClose: () => void
}

export function VoicePlaybackDiagnostics({ open, onClose }: Props) {
  const [rows, setRows] = useState<VoiceUtteranceRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [traceFilter, setTraceFilter] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [liveTrace, setLiveTrace] = useState('')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void import('../../lib/xiaomi-voice/voice-file-log.js')
      .then((m) => {
        if (cancelled) return
        const tid = typeof m.getVoiceTrace === 'function' ? m.getVoiceTrace() || '' : ''
        setLiveTrace(tid)
        if (tid && !traceFilter) setTraceFilter(tid)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // only seed once when opening
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const filter = String(traceFilter || '').trim()
      const items = filter ? await fetchByTrace(filter) : await fetchRecent(80)
      setRows(items)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e || 'load failed'))
    } finally {
      setLoading(false)
    }
  }, [traceFilter])

  useEffect(() => {
    if (!open) return
    void reload()
    const t = window.setInterval(() => {
      void reload()
    }, 2500)
    return () => window.clearInterval(t)
  }, [open, reload])

  const groups = useMemo(() => groupByTrace(rows), [rows])

  if (!open) return null

  return (
    <aside className="xws-playback" data-tauri-no-drag="" aria-label="播报台账">
      <header className="xws-playback-head">
        <div className="xws-playback-title">
          <span>播报台账</span>
          <span className="xws-playback-sub">
            {loading ? '刷新中…' : `${rows.length} 条`}
            {liveTrace ? ` · 当前 ${clip(liveTrace, 18)}` : ''}
          </span>
        </div>
        <div className="xws-playback-actions">
          <button type="button" className="xws-playback-btn" onClick={() => void reload()} title="刷新">
            刷新
          </button>
          <button type="button" className="xws-playback-btn" onClick={onClose} title="关闭" aria-label="关闭台账">
            ×
          </button>
        </div>
      </header>

      <div className="xws-playback-filter">
        <input
          className="xws-playback-input"
          value={traceFilter}
          onChange={(e) => setTraceFilter(e.target.value)}
          placeholder="按 TRACE 过滤（空=最近）"
          spellCheck={false}
        />
        {liveTrace ? (
          <button
            type="button"
            className="xws-playback-btn"
            onClick={() => setTraceFilter(liveTrace)}
            title="填入当前 TRACE"
          >
            当前
          </button>
        ) : null}
        {traceFilter ? (
          <button type="button" className="xws-playback-btn" onClick={() => setTraceFilter('')} title="清空">
            清空
          </button>
        ) : null}
      </div>

      {error ? <div className="xws-playback-error">{error}</div> : null}

      <div className="xws-playback-body">
        {groups.length === 0 && !loading ? (
          <div className="xws-playback-empty">
            {error
              ? '台账接口不可用（gateway /api/speech/playback）。重启 gateway 后再试。'
              : '暂无记录。有字无声时通常是正文卡在 Frame 暂存、尚未进 TTS——看前端日志「连接中暂存 / 冲刷暂存」。'}
          </div>
        ) : null}
        {groups.map((g) => (
          <section key={g.trace} className="xws-playback-group">
            <div className="xws-playback-trace" title={g.trace}>
              <button
                type="button"
                className="xws-playback-trace-btn"
                onClick={() => setTraceFilter(g.trace === '(无 TRACE)' ? '' : g.trace)}
              >
                {clip(g.trace, 36)}
              </button>
              <span className="xws-playback-count">{g.items.length}</span>
            </div>
            <ul className="xws-playback-list">
              {g.items.map((row) => {
                const id = String(row.id || `${row.trace_id}:${row.seq}`)
                const st = String(row.status || '')
                const openRow = expandedId === id
                return (
                  <li key={id} className={`xws-playback-row is-${statusClass(st)}`}>
                    <button
                      type="button"
                      className="xws-playback-row-main"
                      onClick={() => setExpandedId(openRow ? null : id)}
                    >
                      <span className={`xws-playback-badge is-${statusClass(st)}`}>
                        {STATUS_LABEL[st] || st || '?'}
                      </span>
                      <span className="xws-playback-seq">#{Number(row.seq || 0)}</span>
                      <span className="xws-playback-text" title={row.text || ''}>
                        {clip(row.text || '(无文本)', 48)}
                      </span>
                      <span className="xws-playback-meta">
                        {row.source || 'frame'} · {fmtMs(row.duration_ms)}
                      </span>
                    </button>
                    {openRow ? (
                      <div className="xws-playback-detail">
                        <div>
                          <b>id</b> {id}
                        </div>
                        <div>
                          <b>speaker</b> {row.speaker || '—'} · <b>provider</b> {row.provider || '—'}
                        </div>
                        <div>
                          <b>created</b> {fmtClock(row.created_at)} · <b>play</b>{' '}
                          {fmtClock(row.play_started_at)} → {fmtClock(row.play_ended_at)}
                        </div>
                        <div>
                          <b>bytes</b> {row.bytes || 0}
                          {row.audio_path ? (
                            <>
                              {' '}
                              · <b>clip</b> {row.audio_path}
                            </>
                          ) : null}
                        </div>
                        {row.error ? (
                          <div className="xws-playback-errline">
                            <b>error</b> {row.error}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  )
}

export default VoicePlaybackDiagnostics
