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
  readPersistedWorkspaceTabs,
  writePersistedSessionEntries,
  writePersistedWorkspaceTabs,
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
  // 【self-evolution-bot · 2026-11-21 · 第103轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：剥壳/裁剪时**原样带上** ``userCollapsed``。
  // 为什么（本轮真机实测抓到的真缺陷）：本文件多处 ``touch(key, {tabs, activeKey,
  //   collapsed, recentClosed})`` 重新构造记忆对象，字段表是手写的 —— 少写一个字段
  //   就等于**静默抹掉**它。``userCollapsed`` 是本轮才加的字段，于是每过一轮 prune/
  //   剥壳/清理，用户亲手收起的意图就被降级成 false。表现与第102轮修的那条一样：
  //   用户收起的右栏过一会儿自己又弹开，而且越用越「记不住」。
  // 判据：记忆对象的**每一个**构造点都必须显式决定 userCollapsed，不许靠"漏写"。
  return {
    tabs: memory.tabs.map(shellOutTab),
    activeKey: memory.activeKey,
    collapsed: memory.collapsed,
    userCollapsed: memory.userCollapsed === true,
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

/* ---------- 同标签页重载持久化 ---------- */

const PERSIST_DEBOUNCE_MS = 300
let persistTimer: ReturnType<typeof setTimeout> | null = null
let persistSuspended = false

/**
 * 预置缓存：同一标签页内重载（刷新 / dev HMR / webview reload）都会走到这里。
 * 不再判 navigation type——介质是 sessionStorage，标签页边界已由它表达，
 * 过期判据交给快照自带的 ``savedAt``（见 right-stage-session-persistence）。
 */
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

/**
 * 【第115轮】补一条「状态变化即落盘」的订阅。
 *
 * 为什么需要：原先落盘只有两条入口 —— ``switchRightStageSession``（切会话）和
 * 收起手势。可「开签 / 关签 / 换激活签」这三件事都不经过切会话，于是
 * "开了 7 个签但没切过会话"的场景在整页重载后一个签都留不下（实测
 * rev=41 tabs=7 → rev=1 tabs=0）。``bump()`` 是 store 状态变化的唯一收敛点，
 * 订阅它按**当前会话键**覆写记忆，重载恢复才有东西可读。
 *
 * 递归安全：这里只写内存 Map + 触发 debounce 落盘，不会回头 bump store；
 * 写盘判重由 ``writePersistedSessionEntries`` 的内容签名负责。
 *
 * 安装时机：不能在本模块体里直接 subscribe —— 依赖链 store → agui →
 * session-memory 是环，本模块被求值时 ``rightStageStore`` 还是 undefined
 * （实测 ``Cannot read properties of undefined (reading 'subscribe')``）。
 * 因此推迟到微任务，此时模块图已求值完毕。
 */
let autosaveInstalled = false
/**
 * 换入目标会话期间暂挂 autosave。
 * 原因：``importSessionMemory`` 末尾会 bump，而 ``setCurrentRightStageSessionKey``
 * 在其之后才执行 —— 此刻订阅回调读到的还是**上一个**会话键，会把 B 的签写进
 * A 的记忆，等于平白制造串台。
 */
let autosaveSuppressDepth = 0
/** workspace 快照是否已回填；回填前 autosave 不许覆写空状态。 */
let workspaceHydrated = false

export function ensureRightStageAutosaveInstalled() {
  if (autosaveInstalled) return
  if (typeof rightStageStore?.subscribe !== 'function') return
  autosaveInstalled = true
  rightStageStore.subscribe(() => {
    if (persistSuspended || autosaveSuppressDepth > 0) return
    // workspace 级签：不分会话，整份覆写。
    // 必须先于会话分支处理——它不依赖当前会话键，没有会话时也要存。
    //
    // 但**回填完成前不许写**：冷启动时 live store 还是空的，若此时先 bump，
    // 一写就把磁盘上的 workspace 快照抹成空，重载恢复直接失效。
    if (workspaceHydrated) {
      writePersistedWorkspaceTabs(
        rightStageStore.getSnapshot().tabs.filter((t) => scopeOfKind(t.kind) === 'workspace'),
      )
    }
    const key = getCurrentRightStageSessionKey()
    if (!key) return
    touch(key, rightStageStore.exportSessionMemory())
  })
}

/**
 * 回填 workspace 级签（重载后）。
 *
 * 用 ``importSessionMemory`` 而不是 ``show``：后者是"用户显式打开"的语义，
 * 会清掉收起锁并把面板撑开；这里只需要签回到 live 表里，
 * 让人接着切会话时被 carry 带走、面板不必自己弹出来。
 */
export function hydrateWorkspaceTabsFromPersistence() {
  if (workspaceHydrated) return
  workspaceHydrated = true
  if (typeof rightStageStore?.importSessionMemory !== 'function') return
  const persisted = readPersistedWorkspaceTabs()
  if (!persisted.length) return
  const current = rightStageStore.getSnapshot()
  // 已经有签（比如热更新时 store 没被重建）就不覆盖，避免把活状态冲掉。
  if (current.tabs.length > 0) return
  rightStageStore.importSessionMemory(
    {
      tabs: persisted,
      activeKey: `${persisted[persisted.length - 1]!.kind}:${persisted[persisted.length - 1]!.id}`,
      // 保持收起：签要回来，但面板不该自己弹开。
      collapsed: true,
      userCollapsed: false,
      recentClosed: [],
    },
    { carryTabs: [] },
  )
}

queueMicrotask(() => {
  try {
    // 先回填再装 autosave：顺序反了会先写一次空快照，把磁盘上的签抹掉。
    hydrateWorkspaceTabsFromPersistence()
    ensureRightStageAutosaveInstalled()
  } catch {
    /* 安装失败只影响"重载后恢复"，不能拖垮右栏本身 */
  }
})

function persistNow() {
  if (persistSuspended) return
  // workspace 级签：独立快照，不与会话记忆混存（见 writePersistedWorkspaceTabs 注释）。
  if (workspaceHydrated) {
    writePersistedWorkspaceTabs(
      rightStageStore.getSnapshot().tabs.filter((t) => scopeOfKind(t.kind) === 'workspace'),
    )
  }
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

export type RestoreRightStageOptions = {
  /**
   * 是否把当前 live 表里的 workspace / task-center 签带到目标会话。
   * 主对话切会话默认 true；小V adopt/release 必须 false（两侧缓存彻底隔离）。
   */
  carryWorkspace?: boolean
}

/**
 * 换入目标会话记忆。
 * workspace 级标签（文件树 / 写入 / 思维导图 / 小V）不随会话冻结，
 * 这里从当前 live 表里摘出来带过去，保证切会话后它们仍在。
 * 进度/壳页已是会话级，会进冻结记忆，不会被 carry 到新建对话。
 */
export function restoreRightStageSessionMemory(
  sessionKey: string | null | undefined,
  options?: RestoreRightStageOptions,
) {
  const key = String(sessionKey || '').trim()
  const carryWorkspace = options?.carryWorkspace !== false
  // workspace 级 + 任务中心独占标签：切对话会话时保留，不进会话记忆、也不被冲掉。
  // 小V 占用/释放时 carryWorkspace=false：不把主对话的员工/任务/工作流签带进语音域。
  const carryTabs = carryWorkspace
    ? rightStageStore.getSnapshot().tabs.filter(
        (t) =>
          scopeOfKind(t.kind) === 'workspace' || isTaskCenterStageSessionKey(t.sessionKey),
      )
    : []
  // 目标会话从未打开过右栏时：有「对话可见」的 workspace 级标签才展开；
  // 仅有 task-center:* 时保持收起，避免对话壳被任务中心侧栏撑开。
  const chatVisibleCarry = carryTabs.filter(
    (t) => !isTaskCenterStageSessionKey(t.sessionKey),
  )
  const collapsedWhenNoMemory = chatVisibleCarry.length === 0
  // 换入期间暂挂 autosave：``importSessionMemory`` 末尾会 bump，而会话键要在这之后
  // 才切换 —— 不挡住就会用「目标会话的签」覆写源会话记忆（串台），
  // 且 carryWorkspace=false 时（小V adopt）还会拿空 workspace 表把磁盘快照抹掉。
  autosaveSuppressDepth += 1
  try {
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
  } finally {
    autosaveSuppressDepth -= 1
  }
}

/**
 * 从 fromKey 切到 toKey：先冻结当前侧栏，再换入目标会话记忆。
 * 同 key 时只同步写回缓存，不重置 UI。
 */
export function switchRightStageSession(
  fromKey: string | null | undefined,
  toKey: string | null | undefined,
  options?: RestoreRightStageOptions,
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
  // 换入目标会话期间暂挂 autosave（抑制在 restoreRightStageSessionMemory 内部
  // 统一处理，那里也是 bump 真正发生的地方）。
  restoreRightStageSessionMemory(to || null, options)
  // Re-evaluate native HWND: foreign bridge owner must stay parked on the new UI.
  void import('../browser-embed-surface.js')
    .then((m) => m.syncNativeEmbed('session-switch'))
    .catch(() => {})
}

function emptyMemory(): RightStageSessionMemory {
  // 【self-evolution-bot · 2026-11-21 · 第103轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：显式补 ``userCollapsed: false``。
  // 为什么：空记忆 = 这个会话从没开过右栏，用户当然没"亲手收起"过。
  //   漏写该字段会得到 undefined，读侧 ``=== true`` 恰好也判 false，所以**不是**
  //   当前可见的 bug；但把"恰好对"留成隐含契约，下一个人改读侧判据就会翻脸。
  return { tabs: [], activeKey: null, collapsed: true, userCollapsed: false, recentClosed: [] }
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
    // Agent 后台开浏览器：必须清收起锁。否则切回该会话时 userCollapsed 仍 true，
    // 侧栏继续收着 —— 表现成「工具在跑、浏览器没打开」（双会话串台常见）。
    userCollapsed: activate ? false : prev.userCollapsed === true,
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
    // 【self-evolution-bot · 2026-11-21 · 第103轮 · 模型:deepseek-v4.1-flash-1017】
    // 带上用户收起意图：手写字段表漏一个就是静默抹掉（见 shellOutMemory 注释）。
    userCollapsed: prev.userCollapsed === true,
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

/**
 * 从所有会话记忆里剔除匹配标签（含 recentClosed），避免切回会话又打开已删实体页。
 * @returns 剔除的标签数（含 recentClosed）
 */
export function purgeMatchingTabsFromSessionMemory(
  match: (tab: RightStageSurface) => boolean,
): number {
  if (typeof match !== 'function') return 0
  let purged = 0
  for (const [key, memory] of sessionMemory.entries()) {
    const nextTabs = memory.tabs.filter((t) => {
      if (!match(t)) return true
      purged += 1
      return false
    })
    const nextClosed = (memory.recentClosed || []).filter((e) => {
      if (!e?.tab || !match(e.tab)) return true
      purged += 1
      return false
    })
    if (nextTabs.length === memory.tabs.length && nextClosed.length === (memory.recentClosed || []).length) {
      continue
    }
    let activeKey = memory.activeKey
    if (activeKey && !nextTabs.some((t) => tabKeyOf(t) === activeKey)) {
      activeKey = nextTabs.length ? tabKeyOf(nextTabs[nextTabs.length - 1]) : null
    }
    touch(key, {
      tabs: nextTabs,
      activeKey,
      collapsed: nextTabs.length === 0 ? true : memory.collapsed,
      // 【self-evolution-bot · 2026-11-21 · 第103轮 · 模型:deepseek-v4.1-flash-1017】
      // 清理标签不该顺带改掉"用户锁了收起"这件事。
      userCollapsed: memory.userCollapsed === true,
      recentClosed: nextClosed,
    })
  }
  return purged
}

// 页面隐藏/卸载前把待写内容刷盘：debounce 未到就刷新页面时，不能丢掉最后一次改动。
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => flushRightStageSessionPersistence())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushRightStageSessionPersistence()
  })
}
