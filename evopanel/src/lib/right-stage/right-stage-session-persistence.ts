/**
 * 右栏会话缓存的持久化（同一标签页内重载可恢复）。
 *
 * 语义（2026-11-21 第115轮放宽，原为 reload-only）：
 * - 只要是**同一个标签页**内的重载 —— 用户刷新、dev HMR 整页重建、webview
 *   reload —— 都恢复上次的右栏标签；
 * - 新开标签页 / 应用重启 → sessionStorage 本身为空，天然回到草稿态；
 * - 额外用 ``savedAt`` 做 TTL 兜底：超过 {@link PERSIST_MAX_AGE_MS} 的快照一律丢弃，
 *   防止分区被复用时把很久以前的一次运行当成自己的恢复源。
 *
 * 【为什么不再用 ``isReloadNavigation()`` 门控】
 * 它依赖 ``performance.navigation.type === 'reload'``，而 dev HMR / webview 重载
 * 常常报 ``navigate``，导致「刷新后签全丢」（实测 rev=41 tabs=7 → rev=1 tabs=0）。
 * 判据换成「sessionStorage 里有未过期的快照」本身——介质已经表达了标签页边界，
 * 再加一层 navigation 类型判断只会误伤。
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
/**
 * 快照保鲜期：超过就丢弃。
 * 取值只服务一个目的——「同一次工作时段内的重载」；12 小时覆盖一整天开发足够，
 * 跨天残留宁可回到草稿态，也不要拿昨天的一堆签糊到用户脸上。
 */
const PERSIST_MAX_AGE_MS = 12 * 60 * 60 * 1000

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
 *
 * 注意：**不再**用作恢复门控（见文件头注释）。dev HMR / webview reload 常报
 * `navigate`，靠它判断会漏恢复。保留导出仅作诊断与既有调用方/测试的兼容。
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

/**
 * 压成「可落盘形态」：按单条体积剥壳、按整份体积兜底全部剥壳。
 * 抽出来是为了给写入侧做**内容签名判重**——``savedAt`` 每次写入都变，
 * 直接比对整份 payload 永远不相等，等于没判重。
 */
function buildCompactEntries(entries: PersistedSessionEntry[]): PersistedSessionEntry[] {
  const compact: PersistedSessionEntry[] = entries.map((entry) => ({
    key: entry.key,
    memory: {
      tabs: entry.memory.tabs.map((tab) => {
        const dataText = JSON.stringify(tab.data || {})
        return byteLength(dataText) > PERSIST_MAX_TAB_DATA_BYTES ? stripTabData(tab) : tab
      }),
      activeKey: entry.memory.activeKey,
      collapsed: entry.memory.collapsed,
      // 【self-evolution-bot · 2026-11-21 · 第102轮 · 模型:deepseek-v4.1-flash-1017】
      // 改了什么：用户主动收起锁随记忆一起持久化。
      // 为什么：不存的话刷新一次就退化成"未锁定"，用户刚收起的右栏又自己弹回来 ——
      //   与"切会话后永远打不开"是同一处语义缺陷的两个方向。
      userCollapsed: entry.memory.userCollapsed === true,
      // 最近关闭列表对"刷新后还在"没有价值，且会重复携带 tab 全量，直接不持久化。
      recentClosed: [],
    },
  }))
  if (byteLength(JSON.stringify({ version: 1, entries: compact })) <= PERSIST_MAX_BYTES) {
    return compact
  }
  // 兜底：全部剥壳。壳只有几十字节/条，正常不会再次超限。
  return compact.map((entry) => ({
    key: entry.key,
    memory: { ...entry.memory, tabs: entry.memory.tabs.map(stripTabData) },
  }))
}

/** 内容签名：只反映「要恢复什么」，不含写入时间。 */
export function persistedEntriesSignature(entries: PersistedSessionEntry[]): string {
  return JSON.stringify(buildCompactEntries(entries))
}

/** 序列化：先按单条体积剥壳，再按整份体积兜底。 */
export function serializeSessionEntries(entries: PersistedSessionEntry[]): string {
  return JSON.stringify({
    version: 1,
    savedAt: Date.now(),
    entries: buildCompactEntries(entries),
  })
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
          // 【self-evolution-bot · 2026-11-21 · 第102轮 · 模型:deepseek-v4.1-flash-1017】
          // 旧数据没这个字段 → false（不锁定）。只有显式 true 才认。
          userCollapsed: (record.memory as { userCollapsed?: unknown })?.userCollapsed === true,
          recentClosed: [],
        },
      })
    }
    return result
  } catch {
    return []
  }
}

/** 内容不变时，最快隔这么久刷新一次 ``savedAt``（避免长会话里快照被判过期）。 */
const PERSIST_TOUCH_INTERVAL_MS = 30 * 60 * 1000

/** 读出已有快照的内容签名与写入时间；坏数据返回 null。 */
function inspectSnapshot(raw: string): { signature: string; savedAt: number | null } | null {
  try {
    const parsed = JSON.parse(raw) as { entries?: unknown; savedAt?: unknown }
    if (!Array.isArray(parsed?.entries)) return null
    return {
      signature: JSON.stringify(parsed.entries),
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : null,
    }
  } catch {
    return null
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
    // 内容没变就不用重写：dev HMR / 反复切签会高频触发落盘，无谓的 setItem 既费 CPU
    // 也让其他消费方误以为状态有变。比对**内容签名**（不含 savedAt）；
    // 但超过 PERSIST_TOUCH_INTERVAL_MS 仍补写一次，顺带把 TTL 续上。
    const signature = persistedEntriesSignature(entries)
    const existing = store.getItem(PERSIST_STORAGE_KEY)
    if (existing) {
      const meta = inspectSnapshot(existing)
      if (
        meta &&
        meta.signature === signature &&
        Date.now() - (meta.savedAt ?? 0) < PERSIST_TOUCH_INTERVAL_MS
      ) {
        return true
      }
    }
    store.setItem(
      PERSIST_STORAGE_KEY,
      JSON.stringify({ version: 1, savedAt: Date.now(), entries: JSON.parse(signature) }),
    )
    return true
  } catch {
    // 配额超限等：宁可丢掉持久化，也不能影响右栏正常交互。
    return false
  }
}

/** 读取上次重载留下的会话缓存；过期或不存在都返回空。 */
export function readPersistedSessionEntries(): PersistedSessionEntry[] {
  const raw = storage()?.getItem(PERSIST_STORAGE_KEY) ?? null
  if (!raw) return []
  // TTL：分区被复用 / 隔天回来时，别把上一次运行的签糊上来。
  if (isSnapshotExpired(raw)) {
    clearPersistedSessionEntries()
    return []
  }
  try {
    return deserializeSessionEntries(raw)
  } catch {
    return []
  }
}

/** 快照是否已过保鲜期；缺 ``savedAt`` 的旧格式按「未过期」处理，保留兼容。 */
function isSnapshotExpired(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as { savedAt?: unknown }
    const savedAt = typeof parsed?.savedAt === 'number' ? parsed.savedAt : null
    if (savedAt === null) return false
    return Date.now() - savedAt > PERSIST_MAX_AGE_MS
  } catch {
    return false
  }
}

/* ---------- workspace 级签：独立快照 ---------- */

/**
 * 【第115轮】workspace 级签（文件树 / 写入 / 思维导图 / 交互终端 / 小V）单独存一份。
 *
 * 为什么不能塞进会话记忆：``exportSessionMemory`` 明确把它们过滤掉了（那是正确的
 * ——否则 40 条 LRU 会被同一份 workspace 签副本吃满）。但过滤的结果是它们
 * **只活在内存里**，整页重载后一条不剩，而它们恰恰是"跨会话常驻"的那种签，
 * 丢了最刺眼。
 *
 * 存形态：``{version, savedAt, tabs:[...]}``，与会话快照分开一个键，
 * 各自独立 TTL，互不影响。
 */
const PERSIST_WORKSPACE_KEY = 'evopanel_right_stage_workspace_v1'

export function writePersistedWorkspaceTabs(
  tabs: ReadonlyArray<RightStageSurface>,
): boolean {
  const store = storage()
  if (!store) return false
  try {
    if (!tabs.length) {
      store.removeItem(PERSIST_WORKSPACE_KEY)
      return true
    }
    const compact = tabs.map((tab) => {
      const dataText = JSON.stringify(tab.data || {})
      return byteLength(dataText) > PERSIST_MAX_TAB_DATA_BYTES ? stripTabData(tab) : tab
    })
    const signature = JSON.stringify(compact)
    const existing = store.getItem(PERSIST_WORKSPACE_KEY)
    if (existing) {
      const meta = inspectSnapshot(existing)
      if (
        meta &&
        meta.signature === signature &&
        Date.now() - (meta.savedAt ?? 0) < PERSIST_TOUCH_INTERVAL_MS
      ) {
        return true
      }
    }
    store.setItem(
      PERSIST_WORKSPACE_KEY,
      JSON.stringify({ version: 1, savedAt: Date.now(), tabs: compact }),
    )
    return true
  } catch {
    return false
  }
}

export function readPersistedWorkspaceTabs(): RightStageSurface[] {
  const raw = storage()?.getItem(PERSIST_WORKSPACE_KEY) ?? null
  if (!raw) return []
  if (isSnapshotExpired(raw)) {
    try {
      storage()?.removeItem(PERSIST_WORKSPACE_KEY)
    } catch {
      /* ignore */
    }
    return []
  }
  try {
    const parsed = JSON.parse(raw) as { version?: number; tabs?: unknown }
    if (parsed?.version !== 1 || !Array.isArray(parsed.tabs)) return []
    const tabs: RightStageSurface[] = []
    const seen = new Set<string>()
    for (const rawTab of parsed.tabs) {
      if (!rawTab || typeof rawTab !== 'object') continue
      const tab = rawTab as Partial<RightStageSurface>
      const kind = normalizeRightStageKind(tab.kind)
      if (!kind) continue
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
      })
    }
    return tabs
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
  maxAgeMs: PERSIST_MAX_AGE_MS,
  storageKey: PERSIST_STORAGE_KEY,
} as const
