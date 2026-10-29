/**
 * 右栏生命周期排查日志（打开工作流 → 对话结束被关）。
 *
 * - 控制台过滤：`EvoFlow:right-stage`
 * - 落盘文件：`{evoflow}/logs/right-stage-YYYY-MM-DD.log`（Tauri `append_right_stage_log`）
 *   读尾：`search_log` / `read_log_tail` 的 logName=`right-stage`
 *
 * 可选：`localStorage.setItem('ef.debug.rightStage','0')` 关控制台；落盘默认仍开。
 * 关落盘：`localStorage.setItem('ef.debug.rightStage.file','0')`
 */
const TAG = '[EvoFlow:right-stage]'

let seq = 0
let fileQueue: Promise<void> = Promise.resolve()
let fileWarned = false

function consoleEnabled(): boolean {
  try {
    const v = String(globalThis?.localStorage?.getItem?.('ef.debug.rightStage') ?? '').trim()
    if (v === '0' || v === 'false' || v === 'off') return false
  } catch {
    /* ignore */
  }
  return true
}

function fileEnabled(): boolean {
  try {
    const v = String(globalThis?.localStorage?.getItem?.('ef.debug.rightStage.file') ?? '').trim()
    if (v === '0' || v === 'false' || v === 'off') return false
  } catch {
    /* ignore */
  }
  return true
}

function snapTabs(storeLike?: {
  getSnapshot?: () => {
    tabs?: Array<{ id?: string; kind?: string; title?: string }>
    activeKey?: string | null
    collapsed?: boolean
    surface?: { id?: string; kind?: string; title?: string } | null
  }
}): Record<string, unknown> | undefined {
  try {
    const snap = storeLike?.getSnapshot?.()
    if (!snap) return undefined
    return {
      collapsed: snap.collapsed,
      activeKey: snap.activeKey,
      activeKind: snap.surface?.kind ?? null,
      activeId: snap.surface?.id ?? null,
      activeTitle: snap.surface?.title ?? null,
      tabs: (snap.tabs || []).map((t) => ({
        id: t?.id,
        kind: t?.kind,
        title: t?.title,
      })),
    }
  } catch {
    return undefined
  }
}

function safeJson(detail: Record<string, unknown>): string {
  try {
    return JSON.stringify(detail, (_k, v) => {
      if (typeof v === 'string' && v.length > 800) return `${v.slice(0, 800)}…(+${v.length - 800})`
      return v
    })
  } catch {
    try {
      return String(detail)
    } catch {
      return '{}'
    }
  }
}

function isTauriRuntime(): boolean {
  try {
    return typeof window !== 'undefined' && !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  } catch {
    return false
  }
}

function appendFileLine(line: string): void {
  if (!fileEnabled()) return
  // Web / incomplete IPC: never touch @tauri-apps — avoids
  // "Cannot read properties of undefined (reading 'invoke')" noise.
  if (!isTauriRuntime()) return
  fileQueue = fileQueue
    .then(async () => {
      try {
        const mod = await import('@tauri-apps/api/core')
        const invoke = mod?.invoke
        if (typeof invoke !== 'function') return
        await invoke('append_right_stage_log', { message: line.slice(0, 15_500) })
      } catch (err) {
        // Boot race / missing command: warn once, never throw into UI paths.
        if (!fileWarned) {
          fileWarned = true
          try {
            const msg = err instanceof Error ? err.message : String(err || '')
            // Expected when IPC bridge is mid-init; keep quiet unless unexpected.
            if (!/invoke|undefined|not allowed|command/i.test(msg)) {
              console.warn(TAG, 'file log unavailable', err)
            }
          } catch {
            /* ignore */
          }
        }
      }
    })
    .catch(() => {})
}

export type RightStageLogOpts = {
  /** 收栏类事件默认带短栈，便于看是谁调的 */
  stack?: boolean
  /** 附带当前 store 快照（传入 rightStageStore） */
  store?: Parameters<typeof snapTabs>[0]
  /**
   * 分类（写入文件前缀）：
   * - platform：平台工具结果 / 参数
   * - trigger：谁触发了开栏（autoOpen / STAGE_SET / chat_send sync…）
   * - panel：store show/hide / syncRemote
   * - pane：employeeProcess 面板挂载 / meta / send
   */
  cat?: 'platform' | 'trigger' | 'panel' | 'pane' | 'misc'
}

/** 主入口：打开 / 决策 / hide 都走这里。控制台 + 落盘。 */
export function logRightStage(
  event: string,
  detail?: Record<string, unknown>,
  opts?: RightStageLogOpts,
): void {
  const n = ++seq
  const cat = opts?.cat || 'misc'
  try {
    const payload: Record<string, unknown> = { ...(detail || {}) }
    const tabs = snapTabs(opts?.store)
    if (tabs) payload.store = tabs
    let stackLines: string[] | undefined
    const wantStack = opts?.stack === true
    if (wantStack) {
      stackLines = String(new Error('ef-rs').stack || '')
        .split('\n')
        .slice(2, 10)
        .map((l) => l.trim())
        .filter(Boolean)
      if (stackLines.length) payload.stack = stackLines
    }

    if (consoleEnabled()) {
      if (wantStack) {
        console.log(TAG, event, payload, { stack: stackLines })
      } else if (Object.keys(payload).length) {
        console.log(TAG, event, payload)
      } else {
        console.log(TAG, event)
      }
    }

    const fileLine = `#${n} [${cat}] ${event} ${safeJson(payload)}`
    appendFileLine(fileLine)
  } catch {
    /* ignore */
  }
}

/** @deprecated 旧名；等同 logRightStage */
export function logPanelSet(step: string, detail?: Record<string, unknown>): void {
  logRightStage(step, detail, { cat: 'panel' })
}

/** 平台工具链路专用（文件里好搜 `[platform]`） */
export function logRightStagePlatform(
  event: string,
  detail?: Record<string, unknown>,
  opts?: Omit<RightStageLogOpts, 'cat'>,
): void {
  logRightStage(event, detail, { ...opts, cat: 'platform' })
}

/** 触发开栏链路 */
export function logRightStageTrigger(
  event: string,
  detail?: Record<string, unknown>,
  opts?: Omit<RightStageLogOpts, 'cat'>,
): void {
  logRightStage(event, detail, { ...opts, cat: 'trigger' })
}

/** 面板（employeeProcess 等）内部 */
export function logRightStagePane(
  event: string,
  detail?: Record<string, unknown>,
  opts?: Omit<RightStageLogOpts, 'cat'>,
): void {
  logRightStage(event, detail, { ...opts, cat: 'pane' })
}
