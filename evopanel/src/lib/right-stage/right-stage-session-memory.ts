/**
 * 右栏按会话缓存：切会话时整表换出 / 换回，标签实例语义对齐「浏览器标签页」。
 * 不落盘 localStorage——进程内 Map，最多保留最近 N 个会话。
 */
import {
  rightStageStore,
  type RightStageSessionMemory,
} from './right-stage-store.js'
import type { RightStageSurface } from './right-stage-types.js'
import { defaultLayoutForKind, defaultTitleForKind, normalizeRightStageKind } from './right-stage-types.js'
import {
  getCurrentRightStageSessionKey,
  scopeOfKind,
  setCurrentRightStageSessionKey,
} from './right-stage-scope.js'
import { isTaskCenterStageSessionKey } from './task-center-stage-key.js'
import {
  RIGHT_STAGE_PERSIST_LIMITS,
  readPersistedSessionEntries,
  writePersistedSessionEntries,
  type PersistedSessionEntry,
} from './right-stage-session-persistence.js'

// 当前 UI 会话这一状态已收敛到 right-stage-scope（store.show 也要读它，避免循环依赖）。
// 这里保持原有导出面不变，老调用方无需改动。
export { getCurrentRightStageSessionKey, setCurrentRightStageSessionKey }

/**
 * 超过这个条数先「剥壳」（保留 tab 骨架、丢掉 data 载荷），
 * 只有连壳都放不下时才真正淘汰整个会话。
 *
 * 动机：用户回到第 41 个会话时，右侧直接变空是最难受的体验；
 * 而 tabs 的壳（kind/id/title/layout/sessionKey）很轻，真正占内存的是
 * data 里的 URL、历史栈、预览正文、消息数组。
 */
const MAX_ENTRIES = 40
/** 剥壳后仍超限时的硬上限；超过才真正丢会话。 */
const MAX_SHELL_ENTRIES = 120

const sessionMemory = new Map<string, RightStageSessionMemory>()

/**
 * 身份字段：丢了壳就没意义（渲染需要它去重新取内容）。
 * 其余 data 一律视为载荷，剥壳时清空。
 */
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
  'source',
  'format',
  'title',
] as const

/**
 * 剥壳：保留 tab 骨架和身份字段，丢掉重载荷。
 * 切回该会话时 tab 仍在，内容由面板自己按身份字段重新拉取。
 */
export function shellOutTab(tab: RightStageSurface): RightStageSurface {
  const data = tab.data || {}
  const identity: Record<string, unknown> = {}
  for (const key of IDENTITY_DATA_KEYS) {
    if (data[key] !== undefined && data[key] !== null && data[key] !== '') {
      identity[key] = data[key]
    }
  }
  return {
    ...tab,
    data: { ...identity, evicted: true },
  }
}

function shellOutMemory(memory: RightStageSessionMemory): RightStageSessionMemory {
  return {
    tabs: memory.tabs.map(shellOutTab),
    activeKey: memory.activeKey,
    collapsed: memory.collapsed,
    recentClosed: [],
  }
}

/** 是否还有未剥壳的载荷；空标签列表也算「没有载荷」，不该占淘汰预算。 */
function hasPayload(memory: RightStageSessionMemory): boolean {
  return memory.tabs.some(
    (t) => (t.data as { evicted?: boolean } | undefined)?.evicted !== true,
  )
}

function prune() {
  // 第一轮：重条目（未剥壳）超过 MAX_ENTRIES 时，从最旧的开始逐个剥壳。
  // 剥壳保留 tab 骨架，所以"回到第 41 个会话"看到的仍是原来的标签，只是内容按需重取。
  let heavy = 0
  for (const memory of sessionMemory.values()) {
    if (hasPayload(memory)) heavy += 1
  }
  if (heavy > MAX_ENTRIES) {
    for (const [key, memory] of sessionMemory) {
      if (heavy <= MAX_ENTRIES) break
      if (!hasPayload(memory)) continue
      sessionMemory.set(key, shellOutMemory(memory))
      heavy -= 1
    }
  }
  // 第二轮：壳也太多（远超体验收益）才真正按 LRU 淘汰整条会话。
  while (sessionMemory.size > MAX_SHELL_ENTRIES) {
    const oldest = sessionMemory.keys().next().value
    if (oldest == null) break
    sessionMemory.delete(oldest)
  }
}

function touch(key: string, memory: RightStageSessionMemory) {
  sessionMemory.delete(key)
  sessionMemory.set(key, memory)
  prune()
  schedulePersist()
}

/* ---------- reload-only 持久化 ---------- */

const PERSIST_DEBOUNCE_MS = 300
let persistTimer: ReturnType<typeof setTimeout> | null = null
let persistSuspended = false

/** 只在「同一标签页刷新」时预置缓存；冷启动返回空并把残留键清掉。 */
function hydrateFromPersistence() {
  const entries = readPersistedSessionEntries()
  if (!entries.length) return
  for (const entry of entries) {
    if (!entry.key || !entry.memory) continue
    sessionMemory.set(entry.key, entry.memory)
  }
  prune()
}

hydrateFromPersistence()

function persistNow() {
  if (persistSuspended) return
  // 只持久化最近使用的若干会话（Map 的插入序即最近使用顺序）。
  const keys = [...sessionMemory.keys()].slice(-RIGHT_STAGE_PERSIST_LIMITS.maxSessions)
  const entries: PersistedSessionEntry[] = keys.flatMap((key) => {
    const memory = sessionMemory.get(key)
    return memory ? [{ key, memory }] : []
  })
  writePersistedSessionEntries(entries)
}

function schedulePersist() {
  if (persistSuspended) return
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    persistNow()
  }, PERSIST_DEBOUNCE_MS)
}

/** 立刻把待写内容刷盘（切会话 / 页面卸载前调用）。 */
export function flushRightStageSessionPersistence() {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  persistNow()
}

/** 测试用：暂停/恢复落盘，避免用例之间互相污染 sessionStorage。 */
export function setRightStageSessionPersistenceSuspended(suspended: boolean) {
  persistSuspended = suspended
}

export function saveRightStageSessionMemory(sessionKey: string | null | undefined) {
  const key = String(sessionKey || '').trim()
  if (!key) return
  touch(key, rightStageStore.exportSessionMemory())
}

/**
 * 换入目标会话记忆。
 * workspace 级标签（文件树 / 写入 / 思维导图 / 工作流）不随会话冻结，
 * 这里从当前 live 表里摘出来带过去，保证切会话后它们仍在。
 */
export function restoreRightStageSessionMemory(sessionKey: string | null | undefined) {
  const key = String(sessionKey || '').trim()
  // workspace 级 + 任务中心独占标签：切对话会话时保留，不进会话记忆、也不被冲掉。
  const carryTabs = rightStageStore.getSnapshot().tabs.filter(
    (t) =>
      scopeOfKind(t.kind) === 'workspace' || isTaskCenterStageSessionKey(t.sessionKey),
  )
  // 目标会话从未打开过右栏时：有「对话可见」的 workspace 级标签才展开；
  // 仅有 task-center:* 时保持收起，避免对话壳被任务中心侧栏撑开。
  const chatVisibleCarry = carryTabs.filter(
    (t) => !isTaskCenterStageSessionKey(t.sessionKey),
  )
  const collapsedWhenNoMemory = chatVisibleCarry.length === 0
  if (!key) {
    rightStageStore.importSessionMemory(null, { carryTabs, collapsedWhenNoMemory })
    setCurrentRightStageSessionKey('')
    return
  }
  rightStageStore.importSessionMemory(sessionMemory.get(key) ?? null, {
    carryTabs,
    collapsedWhenNoMemory,
  })
  setCurrentRightStageSessionKey(key)
}

/**
 * 从 fromKey 切到 toKey：先冻结当前侧栏，再换入目标会话记忆。
 * 同 key 时只同步写回缓存，不重置 UI。
 */
export function switchRightStageSession(
  fromKey: string | null | undefined,
  toKey: string | null | undefined,
) {
  const from = String(fromKey || '').trim()
  const to = String(toKey || '').trim()
  if (from && from === to) {
    saveRightStageSessionMemory(from)
    flushRightStageSessionPersistence()
    setCurrentRightStageSessionKey(from)
    return
  }
  if (from) saveRightStageSessionMemory(from)
  // 切会话是"紧接着可能刷新页面"的时刻，这里把待写内容刷盘，不等 debounce。
  flushRightStageSessionPersistence()
  // 换入目标会话的标签缓存后，browser-embed-surface 根据激活页决定显示或隐藏。
  restoreRightStageSessionMemory(to || null)
  // Re-evaluate native HWND: foreign bridge owner must stay parked on the new UI.
  void import('../browser-embed-surface.js')
    .then((m) => m.syncNativeEmbed('session-switch'))
    .catch(() => {})
}

function emptyMemory(): RightStageSessionMemory {
  return { tabs: [], activeKey: null, collapsed: true, recentClosed: [] }
}

function tabKeyOf(tab: RightStageSurface): string {
  return `${normalizeRightStageKind(tab.kind)}:${tab.id}`
}

/**
 * 后台会话打开浏览器：只改该会话的冻结记忆，不动当前 UI 侧栏。
 * 避免「会话 A 的 agent 开浏览器，结果出现在正在看的会话 B」。
 */
export function upsertBrowserTabInSessionMemory(opts: {
  sessionKey: string
  id?: string
  title?: string
  pageUrl?: string
  pageTitle?: string
  activate?: boolean
}): boolean {
  const key = String(opts.sessionKey || '').trim()
  if (!key) return false
  const id = String(opts.id || 'primary').trim() || 'primary'
  const pageUrl = String(opts.pageUrl || '').trim() || 'about:blank'
  const title =
    String(opts.title || opts.pageTitle || '').trim() ||
    (pageUrl === 'about:blank' ? '新标签页' : defaultTitleForKind('browser'))
  const kind = normalizeRightStageKind('browser') || 'browser'
  const tabKey = `browser:${id}`

  // 若目标就是当前 UI 会话，应走 live store；这里只处理后台。
  if (key === getCurrentRightStageSessionKey()) return false

  const prev = sessionMemory.get(key) || emptyMemory()
  const tabs = prev.tabs.map((t) => ({ ...t, data: { ...(t.data || {}) } }))
  const idx = tabs.findIndex((t) => tabKeyOf(t) === tabKey)
  let faviconUrl = ''
  if (pageUrl && pageUrl !== 'about:blank') {
    try {
      faviconUrl = `${new URL(pageUrl).origin}/favicon.ico`
    } catch {
      faviconUrl = ''
    }
  }
  const data: Record<string, unknown> = {
    ...(idx >= 0 ? tabs[idx].data : {}),
    pageUrl,
    faviconUrl,
  }
  // 保留已有历史栈；没有则用当前 URL 初始化。
  if (!Array.isArray(data.historyStack) || !(data.historyStack as unknown[]).length) {
    data.historyStack = [pageUrl]
    data.historyIndex = 0
  } else {
    const stack = (data.historyStack as unknown[]).map((u) => String(u || '').trim()).filter(Boolean)
    const last = stack[stack.length - 1]
    if (pageUrl && pageUrl !== 'about:blank' && last !== pageUrl) {
      const index =
        typeof data.historyIndex === 'number' ? Math.max(0, Number(data.historyIndex)) : stack.length - 1
      const nextStack = stack.slice(0, index + 1)
      nextStack.push(pageUrl)
      data.historyStack = nextStack
      data.historyIndex = nextStack.length - 1
    }
  }

  const nextTab: RightStageSurface = {
    id,
    kind,
    title,
    layout: defaultLayoutForKind(kind),
    data,
    sessionKey: key,
  }
  if (idx >= 0) tabs[idx] = nextTab
  else tabs.push(nextTab)

  const activate = opts.activate !== false
  touch(key, {
    tabs,
    activeKey: activate ? tabKey : prev.activeKey || tabKey,
    collapsed: activate ? false : prev.collapsed,
    recentClosed: prev.recentClosed || [],
  })
  return true
}

/**
 * 后台会话更新任意右栏标签：只改该会话的冻结记忆，不动当前 UI 侧栏。
 *
 * 与 `upsertBrowserTabInSessionMemory` 同一语义（后者是它的浏览器特化版本，
 * 额外维护 URL / favicon / 历史栈）。用于 panel_set 等后台会话写入。
 * 目标是当前 UI 会话时返回 false，调用方应改走 live store。
 */
export function upsertTabInSessionMemory(opts: {
  sessionKey: string
  tab: RightStageSurface
  activate?: boolean
}): boolean {
  const key = String(opts.sessionKey || '').trim()
  if (!key) return false
  if (key === getCurrentRightStageSessionKey()) return false
  const kind = normalizeRightStageKind(opts.tab.kind)
  if (!kind) return false

  const nextTab: RightStageSurface = {
    ...opts.tab,
    kind,
    title: String(opts.tab.title || '').trim() || defaultTitleForKind(kind),
    layout: opts.tab.layout || defaultLayoutForKind(kind),
    data: { ...(opts.tab.data || {}) },
    sessionKey: key,
  }
  const tabKey = tabKeyOf(nextTab)

  const prev = sessionMemory.get(key) || emptyMemory()
  const tabs = prev.tabs.map((t) => ({ ...t, data: { ...(t.data || {}) } }))
  const idx = tabs.findIndex((t) => tabKeyOf(t) === tabKey)
  if (idx >= 0) tabs[idx] = nextTab
  else tabs.push(nextTab)

  const activate = opts.activate !== false
  touch(key, {
    tabs,
    activeKey: activate ? tabKey : prev.activeKey || tabKey,
    collapsed: activate ? false : prev.collapsed,
    recentClosed: prev.recentClosed || [],
  })
  return true
}

/**
 * 缓存诊断快照：排查"切回某会话右栏为什么是空的"时用它，不靠猜。
 * 对齐 ZCode 的 uiMemoryDiagnosticsRegistry（那边也只有计数，不 dump 内容）。
 */
export function getRightStageMemoryStats(): {
  entries: number
  heavyEntries: number
  shells: number
  tabs: number
  shelledTabs: number
  maxEntries: number
  maxShellEntries: number
} {
  let heavyEntries = 0
  let tabs = 0
  let shelledTabs = 0
  for (const memory of sessionMemory.values()) {
    if (hasPayload(memory)) heavyEntries += 1
    for (const tab of memory.tabs) {
      tabs += 1
      if ((tab.data as { evicted?: boolean } | undefined)?.evicted === true) shelledTabs += 1
    }
  }
  return {
    entries: sessionMemory.size,
    heavyEntries,
    shells: sessionMemory.size - heavyEntries,
    tabs,
    shelledTabs,
    maxEntries: MAX_ENTRIES,
    maxShellEntries: MAX_SHELL_ENTRIES,
  }
}

/** 测试与调试用：清空全部会话缓存（不影响 live store）。 */
export function clearRightStageSessionMemory() {
  sessionMemory.clear()
}

// 页面隐藏/卸载前把待写内容刷盘：debounce 未到就刷新页面时，不能丢掉最后一次改动。
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => flushRightStageSessionPersistence())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushRightStageSessionPersistence()
  })
}
