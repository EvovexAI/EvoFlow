/**
 * 右栏生命周期排查日志（打开工作流 → 对话结束被关）。
 *
 * 控制台过滤关键字：`EvoFlow:right-stage`
 * 过完假日复现后，把带此前缀的日志整段复制发回即可。
 *
 * 可选：`localStorage.setItem('ef.debug.rightStage','0')` 关闭；缺省开启。
 */
const TAG = '[EvoFlow:right-stage]'

function enabled(): boolean {
  try {
    const v = String(globalThis?.localStorage?.getItem?.('ef.debug.rightStage') ?? '').trim()
    if (v === '0' || v === 'false' || v === 'off') return false
  } catch {
    /* ignore */
  }
  return true
}

function snapTabs(storeLike?: {
  getSnapshot?: () => {
    tabs?: Array<{ id?: string; kind?: string }>
    activeKey?: string | null
    collapsed?: boolean
    surface?: { id?: string; kind?: string } | null
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
      tabs: (snap.tabs || []).map((t) => ({ id: t?.id, kind: t?.kind })),
    }
  } catch {
    return undefined
  }
}

export type RightStageLogOpts = {
  /** 收栏类事件默认带短栈，便于看是谁调的 */
  stack?: boolean
  /** 附带当前 store 快照（传入 rightStageStore） */
  store?: Parameters<typeof snapTabs>[0]
}

/** 主入口：打开 / 决策 / hide 都走这里。 */
export function logRightStage(
  event: string,
  detail?: Record<string, unknown>,
  opts?: RightStageLogOpts,
): void {
  if (!enabled()) return
  try {
    const payload: Record<string, unknown> = { ...(detail || {}) }
    const tabs = snapTabs(opts?.store)
    if (tabs) payload.store = tabs
    const wantStack = opts?.stack === true
    if (wantStack) {
      const stack = String(new Error('ef-rs').stack || '')
        .split('\n')
        .slice(2, 10)
        .map((l) => l.trim())
        .filter(Boolean)
      console.log(TAG, event, payload, { stack })
    } else if (Object.keys(payload).length) {
      console.log(TAG, event, payload)
    } else {
      console.log(TAG, event)
    }
  } catch {
    /* ignore */
  }
}

/** @deprecated 旧名；等同 logRightStage */
export function logPanelSet(step: string, detail?: Record<string, unknown>): void {
  logRightStage(step, detail)
}
