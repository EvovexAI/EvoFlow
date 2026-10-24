/**
 * 右栏会话缓存的 reload-only 持久化（对齐 ZCode 的 isRendererReloadNavigation 门控）。
 *
 * 语义：
 * - **刷新页面**（navigation type === 'reload'）→ 恢复上次的右栏标签；
 * - **冷启动 / 新开标签页** → 一律回到草稿态，不消费上次运行留下的状态。
 *
 * 介质用 sessionStorage 而不是 localStorage：前者随标签页关闭销毁，
 * 正好表达"刷新活着、关掉就清空"，不需要额外清理逻辑。
 *
 * 体积控制：载荷（预览正文、历史栈、消息数组）在写盘前按条剥壳，
 * 只保留身份字段。这样刷新回来 tab 还在，内容由面板按身份重新拉取——
 * 与内存 LRU 的剥壳策略是同一套语义，避免"刷新后恢复一大坨过期内容"。
 */
import type { RightStageSessionMemory } from './right-stage-store.js'
import type { RightStageSurface } from './right-stage-types.js'
import {
  defaultLayoutForKind,
  normalizeRightStageKind,
} from './right-stage-types.js'

const PERSIST_STORAGE_KEY = 'evopanel_right_stage_sessions_v1'
/** 最多持久化多少个会话（最近使用的在前）。 */
const PERSIST_MAX_SESSIONS = 12
/** 单条 tab 的 data 超过这个体积就剥壳。 */
const PERSIST_MAX_TAB_DATA_BYTES = 4_000
/** 整份快照的硬上限；超了就整体退回"全部剥壳"。 */
const PERSIST_MAX_BYTES = 400_000

export interface PersistedSessionEntry {
  key: string
  memory: RightStageSessionMemory
}

/** 身份字段：与内存剥壳白名单保持一致（丢了就没法重新取内容）。 */
const IDENTITY_DATA_KEYS = [
  'path',
  'name',
  'url',
  'pageUrl',
  'threadId',
  'taskId',
  'toolCallId',
  'childSessionId',
  'parentSessionId',
  'sessionKey',
  'extensionId',
  'streamId',
  'format',
  'title',
] as const

function storage(): Storage | null {
  try {
    if (typeof sessionStorage === 'undefined') return null
    return sessionStorage
  } catch {
    // 隐私模式 / 沙箱环境可能直接抛。
    return null
  }
}

/**
 * 是否处于「同一标签页刷新」。
 * 与 ZCode 同判据：performance navigation entry 的 type === 'reload'。
 */
export function isReloadNavigation(): boolean {
  try {
    const entries = globalThis.performance?.getEntriesByType?.('navigation') as
      | Array<{ type?: string }>
      | undefined
    return entries?.[0]?.type === 'reload'
  } catch {
    return false
  }
}

function byteLength(text: string): number {
  try {
    return new TextEncoder().encode(text).byteLength
  } catch {
    return text.length
  }
}

function stripTabData(tab: RightStageSurface): RightStageSurface {
  const data = tab.data || {}
  const identity: Record<string, unknown> = {}
  for (const key of IDENTITY_DATA_KEYS) {
    const value = data[key]
    if (value !== undefined && value !== null && value !== '') identity[key] = value
  }
  return { ...tab, data: { ...identity, evicted: true } }
}

/** 序列化：先按单条体积剥壳，再按整份体积兜底。 */
export function serializeSessionEntries(entries: PersistedSessionEntry[]): string {
  const compact: PersistedSessionEntry[] = entries.map((entry) => ({
    key: entry.key,
    memory: {
      tabs: entry.memory.tabs.map((tab) => {
        const dataText = JSON.stringify(tab.data || {})
        return byteLength(dataText) > PERSIST_MAX_TAB_DATA_BYTES ? stripTabData(tab) : tab
      }),
      activeKey: entry.memory.activeKey,
      collapsed: entry.memory.collapsed,
      // 最近关闭列表对"刷新后还在"没有价值，且会重复携带 tab 全量，直接不持久化。
      recentClosed: [],
    },
  }))

  const payload = JSON.stringify({ version: 1, entries: compact })
  if (byteLength(payload) <= PERSIST_MAX_BYTES) return payload

  // 兜底：全部剥壳。壳只有几十字节/条，正常不会再次超限。
  const shelled = compact.map((entry) => ({
    key: entry.key,
    memory: { ...entry.memory, tabs: entry.memory.tabs.map(stripTabData) },
  }))
  return JSON.stringify({ version: 1, entries: shelled })
}

/** 反序列化：脏数据整体丢弃（部分救回只会造出空壳 tab）。 */
export function deserializeSessionEntries(raw: string | null | undefined): PersistedSessionEntry[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as { version?: number; entries?: unknown }
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return []
    const result: PersistedSessionEntry[] = []
    for (const item of parsed.entries) {
      if (!item || typeof item !== 'object') continue
      const record = item as {
        key?: unknown
        memory?: { tabs?: unknown; activeKey?: unknown; collapsed?: unknown }
      }
      const key = String(record.key || '').trim()
      if (!key) continue
      const rawTabs = Array.isArray(record.memory?.tabs) ? record.memory.tabs : []
      const tabs: RightStageSurface[] = []
      const seen = new Set<string>()
      for (const rawTab of rawTabs) {
        if (!rawTab || typeof rawTab !== 'object') continue
        const tab = rawTab as Partial<RightStageSurface>
        const kind = normalizeRightStageKind(tab.kind)
        if (!kind || kind === 'artifacts') continue
        const id = String(tab.id || 'primary').trim() || 'primary'
        const tabKey = `${kind}:${id}`
        if (seen.has(tabKey)) continue
        seen.add(tabKey)
        tabs.push({
          id,
          kind,
          ...(tab.title ? { title: tab.title } : {}),
          layout: tab.layout || defaultLayoutForKind(kind),
          data: { ...((tab.data as Record<string, unknown>) || {}) },
          ...(tab.sessionKey ? { sessionKey: tab.sessionKey } : {}),
        })
      }
      const activeKey =
        typeof record.memory?.activeKey === 'string' &&
        tabs.some((t) => `${t.kind}:${t.id}` === record.memory?.activeKey)
          ? (record.memory?.activeKey as string)
          : null
      result.push({
        key,
        memory: {
          tabs,
          activeKey: activeKey ?? (tabs.length ? `${tabs[tabs.length - 1]!.kind}:${tabs[tabs.length - 1]!.id}` : null),
          collapsed: typeof record.memory?.collapsed === 'boolean' ? record.memory.collapsed : tabs.length === 0,
          recentClosed: [],
        },
      })
    }
    return result
  } catch {
    return []
  }
}

export function writePersistedSessionEntries(entries: PersistedSessionEntry[]): boolean {
  const store = storage()
  if (!store) return false
  try {
    if (!entries.length) {
      store.removeItem(PERSIST_STORAGE_KEY)
      return true
    }
    store.setItem(PERSIST_STORAGE_KEY, serializeSessionEntries(entries))
    return true
  } catch {
    // 配额超限等：宁可丢掉持久化，也不能影响右栏正常交互。
    return false
  }
}

/** 读取上次刷新留下的会话缓存；冷启动一律返回空。 */
export function readPersistedSessionEntries(): PersistedSessionEntry[] {
  if (!isReloadNavigation()) {
    // 冷启动清键：避免"上次运行"的残留被下次 reload 当成自己的恢复源。
    try {
      storage()?.removeItem(PERSIST_STORAGE_KEY)
    } catch {
      /* ignore */
    }
    return []
  }
  try {
    return deserializeSessionEntries(storage()?.getItem(PERSIST_STORAGE_KEY) ?? null)
  } catch {
    return []
  }
}

export function clearPersistedSessionEntries() {
  try {
    storage()?.removeItem(PERSIST_STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

export const RIGHT_STAGE_PERSIST_LIMITS = {
  maxSessions: PERSIST_MAX_SESSIONS,
  maxTabDataBytes: PERSIST_MAX_TAB_DATA_BYTES,
  maxBytes: PERSIST_MAX_BYTES,
  storageKey: PERSIST_STORAGE_KEY,
} as const
