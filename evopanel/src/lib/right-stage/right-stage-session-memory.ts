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

const MAX_ENTRIES = 40

const sessionMemory = new Map<string, RightStageSessionMemory>()

/** 当前 UI 正在展示的右栏会话（与 ChatApp selectedSessionKey 同步）。 */
let currentSessionKey = ''

function touch(key: string, memory: RightStageSessionMemory) {
  sessionMemory.delete(key)
  sessionMemory.set(key, memory)
  while (sessionMemory.size > MAX_ENTRIES) {
    const oldest = sessionMemory.keys().next().value
    if (oldest == null) break
    sessionMemory.delete(oldest)
  }
}

export function getCurrentRightStageSessionKey(): string {
  return currentSessionKey
}

export function setCurrentRightStageSessionKey(sessionKey: string | null | undefined) {
  currentSessionKey = String(sessionKey || '').trim()
}

export function saveRightStageSessionMemory(sessionKey: string | null | undefined) {
  const key = String(sessionKey || '').trim()
  if (!key) return
  touch(key, rightStageStore.exportSessionMemory())
}

export function restoreRightStageSessionMemory(sessionKey: string | null | undefined) {
  const key = String(sessionKey || '').trim()
  if (!key) {
    rightStageStore.importSessionMemory(null)
    currentSessionKey = ''
    return
  }
  rightStageStore.importSessionMemory(sessionMemory.get(key) ?? null)
  currentSessionKey = key
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
    currentSessionKey = from
    return
  }
  if (from) saveRightStageSessionMemory(from)
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
  if (key === currentSessionKey) return false

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
