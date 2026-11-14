/**
 * 对话内工作流进度卡 vs 底部「运行中工作流」图标不同步排查。
 *
 * - 控制台过滤：`EvoFlow:workflow-progress`
 * - 桌面端落盘：`~/.evoflow/logs/frontend-YYYY-MM-DD.log`（`append_frontend_log`）
 * - 默认关（长会话每帧 join 会打爆主线程 + 14MB/日日志）；开启：
 *   `localStorage.setItem('ef.debug.workflowProgress','1')`
 */

const TAG = '[EvoFlow:workflow-progress]'
const LS_KEY = 'ef.debug.workflowProgress'

let seq = 0
/** 同 key 短窗去重，避免 render 刷屏 */
const recent = new Map<string, number>()
const DEDUPE_MS = 800

function enabled(): boolean {
  try {
    const v = String(globalThis?.localStorage?.getItem?.(LS_KEY) ?? '').trim()
    if (v === '1' || v === 'true' || v === 'on') return true
  } catch {
    /* ignore */
  }
  return false
}

function safeJson(detail: Record<string, unknown>): string {
  try {
    return JSON.stringify(detail, (_k, v) => {
      if (typeof v === 'string' && v.length > 400) return `${v.slice(0, 400)}…(+${v.length - 400})`
      return v
    })
  } catch {
    return '{}'
  }
}

function appendFrontend(level: 'info' | 'warn', message: string): void {
  try {
    void import('./tauri-api.js')
      .then((m) => m.appendFrontendLog?.(level, message.slice(0, 11_500)))
      .catch(() => {})
  } catch {
    /* ignore */
  }
}

export function logWorkflowProgress(
  event: string,
  detail?: Record<string, unknown>,
  opts?: { dedupeKey?: string },
): void {
  if (!enabled()) return
  try {
    const key = opts?.dedupeKey
    if (key) {
      const now = Date.now()
      const prev = recent.get(key) ?? 0
      if (now - prev < DEDUPE_MS) return
      recent.set(key, now)
      if (recent.size > 200) {
        for (const [k, t] of recent) {
          if (now - t > 10_000) recent.delete(k)
        }
      }
    }
    const n = ++seq
    const payload = detail && Object.keys(detail).length ? detail : undefined
    if (payload) console.log(TAG, `#${n}`, event, payload)
    else console.log(TAG, `#${n}`, event)
    appendFrontend('info', `${TAG} #${n} ${event} ${payload ? safeJson(payload) : ''}`)
  } catch {
    /* ignore */
  }
}

/** 测试用：强制打一条（不受去重影响）。 */
export function logWorkflowProgressForce(
  event: string,
  detail?: Record<string, unknown>,
): void {
  if (!enabled()) return
  try {
    const line = `${TAG} FORCE ${event} ${detail ? safeJson(detail) : ''}`
    console.log(TAG, 'FORCE', event, detail ? safeJson(detail) : '')
    appendFrontend('info', line)
  } catch {
    /* ignore */
  }
}
