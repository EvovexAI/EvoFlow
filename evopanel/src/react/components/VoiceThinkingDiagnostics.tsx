/**
 * 语音思考调试：看清「舞台处理中」vs「模型真思考」，以及网关是否加载了关思考守卫。
 */
import { useCallback, useEffect, useState } from 'react'
import { apiUrl } from '../../lib/api-client.js'

type WireRow = {
  ts?: number
  runtime_enabled?: boolean | null
  thinking_type?: string | null
  wire_enable_thinking?: boolean | null
  wire_thinking_type?: string | null
  wire_reasoning_effort?: string | null
  model?: string
  stage?: string
  thread_id?: string
}

type Probe = {
  ok?: boolean
  frozen?: boolean
  has_thinking_off_guard?: boolean
  factory_file?: string
  gateway_mode?: string
  error?: string
}

type ModelInfo = {
  id?: string
  display_name?: string
  vendor?: string
  thinking_default_mode?: string
  thinking_always_on?: boolean
  can_disable_thinking?: boolean
}

type DebugPayload = {
  ok?: boolean
  probe?: Probe
  last?: WireRow | null
  items?: WireRow[]
  model_thinking_on?: boolean | null
  model?: ModelInfo | null
  ui_note?: string
}

type Props = {
  open: boolean
  onClose: () => void
}

function fmtTs(ts?: number): string {
  const n = Number(ts || 0)
  if (!n) return '—'
  try {
    return new Date(n * 1000).toLocaleTimeString('zh-CN', { hour12: false })
  } catch {
    return '—'
  }
}

function yn(v: unknown): string {
  if (v === true) return '开'
  if (v === false) return '关'
  if (v == null || v === '') return '—'
  return String(v)
}

async function fetchThinkingDebug(): Promise<DebugPayload> {
  const url = import.meta.env?.DEV
    ? '/api/speech/thinking-debug?limit=10'
    : apiUrl('/speech/thinking-debug?limit=10')
  const res = await fetch(url, { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as DebugPayload
}

export function VoiceThinkingDiagnostics({ open, onClose }: Props) {
  const [data, setData] = useState<DebugPayload | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setBusy(true)
    setErr('')
    try {
      setData(await fetchThinkingDebug())
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void refresh()
    const t = window.setInterval(() => void refresh(), 2500)
    return () => window.clearInterval(t)
  }, [open, refresh])

  if (!open) return null

  const probe = data?.probe
  const last = data?.last
  const guardOk = probe?.has_thinking_off_guard === true
  const mode = probe?.gateway_mode || (probe?.frozen ? 'packaged' : '—')
  const modelOn = data?.model_thinking_on

  return (
    <div className="xws-playback xws-thinking-debug" data-tauri-no-drag="" role="dialog" aria-label="思考调试">
      <header className="xws-playback-head">
        <strong>思考调试</strong>
        <div className="xws-playback-head-actions">
          <button type="button" className="xws-playback-iconbtn" onClick={() => void refresh()} disabled={busy}>
            刷新
          </button>
          <button type="button" className="xws-playback-iconbtn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
      </header>
      <div className="xws-playback-body">
        <p className="xws-thinking-note">{data?.ui_note || '舞台「处理中」≠ 模型思考模式'}</p>
        {err ? <p className="xws-thinking-bad">拉取失败：{err}</p> : null}
        <div className="xws-thinking-grid">
          <div>
            <span className="xws-thinking-k">网关</span>
            <span className={mode === 'source' ? 'xws-thinking-ok' : 'xws-thinking-bad'}>{mode}</span>
          </div>
          <div>
            <span className="xws-thinking-k">关思考守卫</span>
            <span className={guardOk ? 'xws-thinking-ok' : 'xws-thinking-bad'}>
              {guardOk ? '已加载' : '缺失（旧安装包）'}
            </span>
          </div>
          <div>
            <span className="xws-thinking-k">当前模型</span>
            <span className={data?.model?.thinking_always_on ? 'xws-thinking-bad' : ''}>
              {data?.model?.display_name || data?.model?.id || last?.model || '—'}
            </span>
          </div>
          <div>
            <span className="xws-thinking-k">模型思考策略</span>
            <span className={data?.model?.thinking_always_on ? 'xws-thinking-bad' : 'xws-thinking-ok'}>
              {data?.model?.thinking_always_on
                ? '强制开（关不掉）'
                : data?.model?.thinking_default_mode
                  ? String(data.model.thinking_default_mode)
                  : '—'}
            </span>
          </div>
          <div>
            <span className="xws-thinking-k">最近 wire 思考</span>
            <span
              className={
                modelOn === false ? 'xws-thinking-ok' : modelOn === true ? 'xws-thinking-bad' : ''
              }
            >
              {modelOn === false ? '关' : modelOn === true ? '开（有问题）' : '尚无请求'}
            </span>
          </div>
        </div>
        {probe?.factory_file ? (
          <p className="xws-thinking-path" title={probe.factory_file}>
            factory：{probe.factory_file}
          </p>
        ) : null}
        {last ? (
          <div className="xws-thinking-last">
            <div>最近一次 · {fmtTs(last.ts)}</div>
            <div>
              runtime={yn(last.runtime_enabled)} type={String(last.thinking_type || '—')} model=
              {String(last.model || '—')}
            </div>
            <div>
              wire enable_thinking={yn(last.wire_enable_thinking)} thinking.type=
              {String(last.wire_thinking_type || '—')} reasoning_effort=
              {String(last.wire_reasoning_effort || '—')}
            </div>
          </div>
        ) : (
          <p className="xws-thinking-note">说一句话后这里会出现厂商请求摘要。</p>
        )}
        <ul className="xws-thinking-list">
          {(data?.items || []).slice(0, 8).map((row, i) => (
            <li key={`${row.ts || 0}-${i}`}>
              <code>
                {fmtTs(row.ts)} · rt={yn(row.runtime_enabled)} · et={yn(row.wire_enable_thinking)} · re=
                {String(row.wire_reasoning_effort || '—')}
              </code>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
