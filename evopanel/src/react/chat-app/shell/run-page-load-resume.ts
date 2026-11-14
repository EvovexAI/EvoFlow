// @ts-nocheck — mechanical P95 extract.
/**
 * Page-load / app reopen: never auto-continue an interrupted interactive turn.
 *
 * Closing the desktop app (or F5) used to leave ``run_status=running`` in DB;
 * on reopen the last-selected session (e.g. 「研发部 Evoflow 专属工作铁律」)
 * would auto history-watch / look "self-started", then wedging cold LangGraph
 * when the user typed again. Product rule: restart = interrupted, stop — do
 * not resume unless the user explicitly refreshes that session.
 *
 * 2026-11-14（生命周期四件套第 1 件 / Phase B+C 配套，行为变更）：
 * V4 投影现在能恢复运行态——hydrate 探测 fresh running → 快照 control
 * running/canStop=true（hydration._probe_running_run）。「重启必丢运行态」的
 * 前提不再成立。等 V4 首帧（≤ PROJECTION_GRACE_MS）再裁决：
 * - 投影 canStop=true → **跳过自动 stop**：运行中显示交给用户自己决定停或等
 *   （停止键可用，REST stop 真停；齿轮/停止键由 control-first wrapper 驱动）。
 * - 投影终态 / draft / V4 关闭 / 无 threadId / 超时无首帧 → 维持旧规则
 *   stop 清理（DB running 但探测已 stale 的 zombie 场景落在这里）。
 */
import { getSharedV4SessionDataLayer } from '../../v4/V4StreamRowsBridge.js'
import { isEvoflowChatV4Enabled } from '../../v4/v4Gate.js'

export type RunPageLoadResumeCtx = Record<string, any>

const PROJECTION_GRACE_MS = 3000
const PROJECTION_POLL_MS = 250

export function runPageLoadResumeEffect(ctx: RunPageLoadResumeCtx): void {
  const {
    listLoading,
    pageLoadResumeDoneRef,
    selectedSessionKey,
    sessions,
    stopSessionExecutionRef,
  } = ctx
  if (listLoading || pageLoadResumeDoneRef.current) return
  const sk = String(selectedSessionKey || '').trim()
  if (!sk) return
  const row = sessions.find((s) => String(s.sessionKey || '') === sk)
  const st = String(row?.runStatus || '').trim().toLowerCase()
  if (st !== 'running' && st !== 'pending') {
    pageLoadResumeDoneRef.current = true
    return
  }
  pageLoadResumeDoneRef.current = true

  const stop = () => {
    void stopSessionExecutionRef.current?.(sk, {
      showToast: false,
      source: 'page_load_interrupt_stop',
    })
  }

  const tid = String(row?.threadId || '').trim()
  if (!tid || !isEvoflowChatV4Enabled()) {
    stop()
    return
  }

  // 等 V4 首帧（hydrate 运行态恢复在首帧快照里）。读到 control 的布尔 canStop
  // 即有裁决：true=运行中恢复（不自动停）；false=投影认为没在跑（DB stale）→ 清理。
  const pollOnce = (): boolean | null => {
    try {
      const snap = getSharedV4SessionDataLayer().peekStore(tid)?.getState()?.snapshot ?? null
      const control = snap?.control ?? null
      if (control && typeof control.canStop === 'boolean') {
        return control.canStop === true
      }
    } catch {
      /* V4 未就绪：继续等宽限期 */
    }
    return null
  }

  void (async () => {
    const deadline = Date.now() + PROJECTION_GRACE_MS
    while (Date.now() < deadline) {
      const verdict = pollOnce()
      if (verdict !== null) {
        if (verdict) {
          try {
            console.info('[page-load-resume] projection restored running; skip auto-stop', sk)
          } catch {
            /* noop */
          }
          return
        }
        break
      }
      await new Promise((r) => setTimeout(r, PROJECTION_POLL_MS))
    }
    stop()
  })()
}
