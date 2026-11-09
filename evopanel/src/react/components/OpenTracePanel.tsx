/**
 * 「点开会话 → 上屏」分段耗时可视面板（诊断用）。
 *
 * 用途：把 openTrace 记录的分段耗时**直接画在页面上**，不用开 DevTools。
 * 排查「有时秒开、有时等几秒」时，面板能一眼看出：
 * - 这次打开总耗时多少；
 * - 每一步各花了多久、哪一步超阈值（黄=偏慢 / 红=异常）；
 * - 超阈值那一步的**原因说明**（慢在服务端拉库？还是 SSE 没推帧？还是渲染卡？）；
 * - 历史上几次打开的对比（快的那次 vs 慢的那次，差在哪一步）。
 *
 * 显示开关（localStorage）：
 * - `EVOFLOW_OPEN_TRACE_PANEL=1` → 面板常驻显示
 * - 面板右上角「隐藏」按钮 → 本次会话内隐藏
 *
 * 数据源：`@zcode/ui/lib/openTrace.ts` 的环形缓冲（localStorage `EVOFLOW_OPEN_TRACE_RING`）。
 */
import { useEffect, useState, type ReactNode } from 'react'
import {
  clearOpenTraceRing,
  getOpenTraceRing,
  type OpenStageRecord,
  type OpenTraceRecord,
} from '@zcode/ui/lib/openTrace.js'

const LS_PANEL_KEY = 'EVOFLOW_OPEN_TRACE_PANEL'

/** 阶段中文名（与 openTrace 的 stage 对齐）。 */
const STAGE_LABELS: Record<string, string> = {
  click: '点击',
  ensure_thread: '补 threadId',
  acquire: '挂载数据层',
  subscribe: '订阅(服务端)',
  subscribe_ack: '等首帧',
  frame_snapshot: '收到首帧',
  store_apply: '投影入库',
  render: '渲染 DOM',
  paint: '上屏',
}

function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] || stage
}

function panelEnabledByDefault(): boolean {
  try {
    return localStorage.getItem(LS_PANEL_KEY) === '1'
  } catch {
    return false
  }
}

function statusLabel(status: string): string {
  if (status === 'error') return '异常'
  if (status === 'warn') return '偏慢'
  if (status === 'ok') return '正常'
  if (status === 'pending') return '进行中'
  return status
}

function StageRows({ trace }: { trace: OpenTraceRecord }): ReactNode {
  return (
    <table className="open-trace-panel-table">
      <thead>
        <tr>
          <th>阶段</th>
          <th className="open-trace-panel-num">累计</th>
          <th className="open-trace-panel-num">本步</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>
        {trace.stages.map((s: OpenStageRecord, i: number) => (
          <tr
            key={`${s.stage}-${i}`}
            className={`open-trace-panel-row is-${s.status}`}
          >
            <td className="open-trace-panel-stage">
              <span className="open-trace-panel-stage-name">{stageLabel(s.stage)}</span>
              <span className="open-trace-panel-stage-label">{s.label}</span>
              {s.reason ? (
                <div className="open-trace-panel-reason">原因：{s.reason}</div>
              ) : null}
            </td>
            <td className="open-trace-panel-num">+{s.atMs}ms</td>
            <td className="open-trace-panel-num">{s.durationMs}ms</td>
            <td>
              <span className={`open-trace-panel-badge is-${s.status}`}>
                {statusLabel(s.status)}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function OpenTracePanel(): ReactNode {
  const [visible, setVisible] = useState<boolean>(() => panelEnabledByDefault())
  const [traces, setTraces] = useState<OpenTraceRecord[]>(() => getOpenTraceRing())

  useEffect(() => {
    // 打开链路是异步的，轮询刷新环形缓冲。
    const id = window.setInterval(() => {
      setTraces(getOpenTraceRing())
    }, 700)
    return () => window.clearInterval(id)
  }, [])

  if (!visible) return null

  const latest = traces.length ? traces[traces.length - 1] : null

  return (
    <div className="open-trace-panel" data-testid="open-trace-panel">
      <div className="open-trace-panel-head">
        <span className="open-trace-panel-title">会话打开耗时</span>
        {latest ? (
          <span className={`open-trace-panel-total is-${latest.status}`}>
            总耗时 {latest.totalMs ?? 0}ms · {statusLabel(latest.status)}
          </span>
        ) : (
          <span className="open-trace-panel-total">暂无记录，点一下侧栏会话</span>
        )}
        <span className="open-trace-panel-actions">
          <button
            type="button"
            className="open-trace-panel-btn"
            onClick={() => setTraces(getOpenTraceRing())}
          >
            刷新
          </button>
          <button
            type="button"
            className="open-trace-panel-btn"
            onClick={() => {
              clearOpenTraceRing()
              setTraces([])
            }}
          >
            清空
          </button>
          <button
            type="button"
            className="open-trace-panel-btn"
            onClick={() => setVisible(false)}
          >
            隐藏
          </button>
        </span>
      </div>

      {latest ? (
        <div className={`open-trace-panel-verdict is-${latest.status}`}>
          {latest.verdict}
          {latest.slowest ? (
            <span className="open-trace-panel-slowest">
              最慢：{stageLabel(latest.slowest.stage)} {latest.slowest.durationMs}ms
            </span>
          ) : null}
        </div>
      ) : null}

      {latest ? <StageRows trace={latest} /> : null}

      {traces.length > 1 ? (
        <details className="open-trace-panel-history">
          <summary>历史对比（最近 {traces.length} 次）</summary>
          <table className="open-trace-panel-table">
            <thead>
              <tr>
                <th>时间</th>
                <th className="open-trace-panel-num">总耗时</th>
                <th className="open-trace-panel-num">最慢步</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {traces
                .slice()
                .reverse()
                .map((t) => (
                  <tr key={t.traceId} className={`open-trace-panel-row is-${t.status}`}>
                    <td>
                      {new Date(t.startedAt).toLocaleTimeString()}
                      <div className="open-trace-panel-stage-label">{t.sessionKey}</div>
                    </td>
                    <td className="open-trace-panel-num">{t.totalMs ?? 0}ms</td>
                    <td className="open-trace-panel-num">
                      {t.slowest ? `${stageLabel(t.slowest.stage)} ${t.slowest.durationMs}ms` : '—'}
                    </td>
                    <td>
                      <span className={`open-trace-panel-badge is-${t.status}`}>
                        {statusLabel(t.status)}
                      </span>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </div>
  )
}

export default OpenTracePanel
