/** Browser panel runtime state — module-level store shared by AG-UI hooks and the panel UI.
 *
 * Fed by browser tool-call events (see browser-panel-agui.ts) and consumed by
 * BrowserPanel.tsx via useSyncExternalStore. Also owns auto-showing the browser
 * right-stage surface when the agent opens a page.
 */

import {
  getBridgeOwnerSessionKey,
  setBridgeOwnerSessionKey,
} from './browser-bridge-owner.js'
import { browserEmbedPark } from './browser-embed-client.js'
import { ensureNativeEmbed, NATIVE_EMBED_THREAD_ID, syncNativeEmbed } from './browser-embed-surface.js'
import { parseBrowserLiveToolOutput } from './chat-normalize.js'
import { isSameBrowserLoad, sanitizeBrowserPageUrl } from './browser-page-url.js'
import {
  getCurrentRightStageSessionKey,
  upsertBrowserTabInSessionMemory,
} from './right-stage/right-stage-session-memory.js'
import { rightStageStore } from './right-stage/right-stage-store.js'
import { normalizeRightStageKind } from './right-stage/right-stage-types.js'
import type { BrowserStreamFrameMetadata } from './browser-stream-client.js'
import type { BrowserTabSummary } from './browser-viewport-client.js'
import { dbgLog, dbgWarn } from './browser-debug-log.js'
import { blogTimeline } from './browser-unified-log.js'

export { getBridgeOwnerSessionKey, setBridgeOwnerSessionKey } from './browser-bridge-owner.js'

export type BrowserPanelMode = 'evopanel' | 'headed' | 'cdp' | 'headless' | 'embed'

export type BrowserRuntimeState = {
  pageUrl: string
  /** Document title from the live page (toolbar / tab chip). */
  pageTitle: string
  /** Thread id extracted from the live stream path (`/api/threads/{tid}/browser-stream`). */
  streamThreadId: string
  browserMode?: BrowserPanelMode
  sharedBrowser: boolean
  /** True while a browser tool call is in flight (ZCode-style operation indicator). */
  operating: boolean
  operatingAction: string
  operatingToolCallId: string
  lastFrameMeta?: BrowserStreamFrameMetadata
  /** 引擎实时标签页（tabList 轮询结果） */
  tabs: BrowserTabSummary[]
  /** null = unknown (enable button); false only after engine reports no history. */
  canGoBack: boolean | null
  canGoForward: boolean | null
  /**
   * Soft-decouple: last URL the *user* asked the HWND to load (address bar /
   * history / tab switch). Agent/getState syncs must not clear this; BrowserPanel
   * treats pageUrl changes without a matching user intent as chrome-only.
   */
  lastUserNavigateUrl: string
}

const EMPTY: BrowserRuntimeState = {
  pageUrl: '',
  pageTitle: '',
  streamThreadId: '',
  sharedBrowser: false,
  operating: false,
  operatingAction: '',
  operatingToolCallId: '',
  tabs: [],
  canGoBack: null,
  canGoForward: null,
  lastUserNavigateUrl: '',
}

/** Mark that the user (not the agent) is driving the next HWND navigation. */
export function markUserNavigateIntent(url: string): void {
  const clean = sanitizeBrowserPageUrl(url)
  if (!clean) return
  patch({ lastUserNavigateUrl: clean })
}

/** True when `url` matches the last user-driven navigate (same-load tolerant). */
export function isUserNavigateIntent(url: string): boolean {
  const clean = sanitizeBrowserPageUrl(url)
  if (!clean || !state.lastUserNavigateUrl) return false
  return clean === state.lastUserNavigateUrl || isSameBrowserLoad(clean, state.lastUserNavigateUrl)
}

let state: BrowserRuntimeState = { ...EMPTY }
const listeners = new Set<() => void>()

/** Resolve session for engine/panel-request writes: explicit → owner → current UI. */
export function resolveBrowserUiSessionKey(explicit?: string | null): string {
  const fromArg = String(explicit || '').trim()
  if (fromArg) return fromArg
  const owner = getBridgeOwnerSessionKey()
  if (owner) return owner
  return getCurrentRightStageSessionKey()
}

function emit() {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // listener errors must not break the stream
    }
  }
}

function patch(next: Partial<BrowserRuntimeState>) {
  let changed = false
  for (const key of Object.keys(next) as Array<keyof BrowserRuntimeState>) {
    const prev = state[key]
    const val = next[key]
    if (Object.is(prev, val)) continue
    // tabs 常是新数组但内容相同；全量 stringify 避免无意义 emit 拖垮 ChatApp。
    if (key === 'tabs' && JSON.stringify(prev) === JSON.stringify(val)) continue
    changed = true
    break
  }
  if (!changed) return
  state = { ...state, ...next }
  emit()
}

export function subscribeBrowserRuntime(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getBrowserRuntimeSnapshot(): BrowserRuntimeState {
  return state
}

const DEFAULT_TID = ''

/**
 * Fixed engine session used by ``/api/browser/*`` (node-repl browser-use bridge).
 * The side panel must mount *this* WebView2 label so the user sees the same page
 * the agent drives — chat thread ids never reach the bridge execute path.
 */
export const NODE_REPL_BRIDGE_THREAD_ID = 'evoflow-node-repl-bridge'

/** Backend falls back to a literal ``evoflow`` session when the tool runtime has no
 * thread_id. That path never matches the panel's real thread, so reject it and keep
 * whatever real thread id we already have. */
const PLACEHOLDER_TIDS = new Set(['', 'evoflow', 'default', '__default__'])

export function extractThreadIdFromStreamPath(streamWs: string): string {
  const raw = String(streamWs || '').trim()
  if (!raw) return DEFAULT_TID
  const match = raw.match(/\/api\/threads\/([^/]+)\/browser-stream/i)
  if (!match?.[1]) return DEFAULT_TID
  let tid = ''
  try {
    tid = decodeURIComponent(match[1]) || ''
  } catch {
    tid = match[1]
  }
  return PLACEHOLDER_TIDS.has(tid.toLowerCase()) ? DEFAULT_TID : tid
}

/** Accept a thread id only when it looks like a real id (not a backend placeholder). */
export function acceptThreadId(tid: string | null | undefined): string {
  const raw = String(tid || '').trim()
  if (PLACEHOLDER_TIDS.has(raw.toLowerCase())) return DEFAULT_TID
  return raw
}

function newBrowserStageId(): string {
  return `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 打开或激活浏览器标签（不关掉其它 kind）。
 *  - 默认复用 `primary`（顶栏地球 / agent 驱动）
 *  - `forceNew: true` 时新建独立标签（加号菜单）
 */
function faviconUrlForPage(url: string): string {
  try {
    const parsed = new URL(url)
    if (!parsed.hostname || parsed.protocol === 'about:') return ''
    return `${parsed.origin}/favicon.ico`
  } catch {
    return ''
  }
}

function displayTitle(pageUrl: string, pageTitle: string): string {
  const titled = pageTitle.trim()
  if (titled) return titled
  const raw = pageUrl.trim()
  if (!raw) return '浏览器'
  try {
    // host 含非默认端口（如 127.0.0.1:8769）；hostname 会丢掉端口。
    return new URL(raw).host || '浏览器'
  } catch {
    return raw.slice(0, 40) || '浏览器'
  }
}

type TabHistory = { stack: string[]; index: number }

function readTabHistory(data: Record<string, unknown> | undefined | null): TabHistory {
  const stackRaw = data?.historyStack
  const stack = Array.isArray(stackRaw)
    ? stackRaw.map((u) => sanitizeBrowserPageUrl(String(u || '').trim())).filter(Boolean)
    : []
  if (!stack.length) return { stack: [], index: -1 }
  let index = typeof data?.historyIndex === 'number' ? Number(data.historyIndex) : stack.length - 1
  if (!Number.isFinite(index)) index = stack.length - 1
  index = Math.max(0, Math.min(Math.floor(index), stack.length - 1))
  return { stack, index }
}

function activeBrowserTabId(): string | null {
  const snap = rightStageStore.getSnapshot()
  const key = String(snap.activeKey || '')
  if (!key.startsWith('browser:')) return null
  return key.slice('browser:'.length) || null
}

function applyHistoryFlags(stack: string[], index: number) {
  patch({
    canGoBack: index > 0,
    canGoForward: index >= 0 && index < stack.length - 1,
  })
}

/**
 * 站内导航：压入指定（或当前前台）标签的逻辑历史栈（单 HWND 不能靠 window.history）。
 * @param pinTabId 钉死目标签；地址栏回车必须传 stageId，禁止跟「当时 active」——
 *   否则 agent ensure(primary) 抢激活后，第二签的地址会写进第一签标题，表现为「第一签没了」。
 */
export function pushBrowserTabHistory(url: string, pageTitle = '', pinTabId?: string): boolean {
  const tabId = String(pinTabId || activeBrowserTabId() || '').trim()
  if (!tabId) return false
  const clean = sanitizeBrowserPageUrl(url)
  if (!clean) return false
  const tab = rightStageStore.findTab(`browser:${tabId}`)
  if (!tab) return false
  const { stack, index } = readTabHistory(tab.data)
  let truncated = stack.slice(0, Math.max(0, index + 1))
  // 旧标签没有栈时，先把当前 pageUrl 垫进栈底，后退才回得到。
  if (!truncated.length) {
    const cur = sanitizeBrowserPageUrl(String(tab.data?.pageUrl || '').trim())
    if (cur && cur !== clean) truncated = [cur]
  }
  if (truncated[truncated.length - 1] === clean) {
    applyHistoryFlags(truncated, truncated.length - 1)
    return true
  }
  truncated.push(clean)
  const newIndex = truncated.length - 1
  const isBlank = clean === 'about:blank'
  rightStageStore.patchTab(`browser:${tabId}`, {
    title: isBlank ? '新标签页' : displayTitle(clean, pageTitle),
    data: {
      pageUrl: isBlank ? 'about:blank' : clean,
      faviconUrl: isBlank ? '' : faviconUrlForPage(clean),
      historyStack: truncated,
      historyIndex: newIndex,
    },
  })
  patch({
    pageUrl: isBlank ? '' : clean,
    pageTitle: String(pageTitle || '').trim(),
    canGoBack: newIndex > 0,
    canGoForward: false,
  })
  return true
}

/** 逻辑栈后退/前进。返回目标 URL；无法移动时返回 null。 */
export function stepBrowserTabHistory(delta: -1 | 1): string | null {
  const tabId = activeBrowserTabId()
  if (!tabId) return null
  const tab = rightStageStore.findTab(`browser:${tabId}`)
  if (!tab) return null
  const { stack, index } = readTabHistory(tab.data)
  const next = index + delta
  if (next < 0 || next >= stack.length) return null
  const url = stack[next]
  const isBlank = !url || url === 'about:blank'
  rightStageStore.patchTab(`browser:${tabId}`, {
    title: isBlank ? '新标签页' : displayTitle(url, ''),
    data: {
      pageUrl: isBlank ? 'about:blank' : url,
      faviconUrl: isBlank ? '' : faviconUrlForPage(url),
      historyStack: stack,
      historyIndex: next,
    },
  })
  patch({
    pageUrl: isBlank ? '' : url,
    canGoBack: next > 0,
    canGoForward: next < stack.length - 1,
  })
  return url
}

/**
 * 把网页标题/图标写到指定（或当前激活）浏览器标签。
 * @param pinTabId 钉死写入目标；CDP settle 时必须传发起导航的签，禁止跟「当时 active」。
 */
function syncBrowserStageChrome(pageUrl: string, pageTitle: string, pinTabId?: string) {
  const id = String(pinTabId || activeBrowserTabId() || '').trim()
  if (!id) return
  const active = rightStageStore.findTab(`browser:${id}`)
  if (!active) return
  // 错误页 URL 不写进标签，保留该标签已有地址。
  const prevUrl = String(active.data?.pageUrl || '').trim()
  const url = sanitizeBrowserPageUrl(pageUrl, prevUrl)
  if (!url && String(pageUrl || '').trim()) return
  const isBlank = !url || url === 'about:blank'
  const prevBlank = !prevUrl || prevUrl === 'about:blank'
  // 新标签仍是 blank：HWND 常还停在上一标签页。禁止把残留页写进本标签。
  if (prevBlank && !isBlank && !isUserNavigateIntent(url)) {
    dbgLog(
      `[browser-panel-store] skip chrome sync onto blank tab id=${active.id} url=${url}`,
    )
    return
  }
  // 已有独立 URL 的签：禁止换成另一地址。用户导航走 pushBrowserTabHistory；
  // 这里若放行 isUserNavigateIntent，会在 pin=primary 时把第二签的地址盖进第一签。
  if (!prevBlank && !isBlank && !isSameBrowserLoad(prevUrl, url)) {
    dbgLog(
      `[browser-panel-store] skip chrome overwrite id=${active.id} prev=${prevUrl} url=${url}`,
    )
    return
  }
  // 只改 title/pageUrl/favicon，保留 historyStack / historyIndex。
  rightStageStore.patchTab(`browser:${active.id}`, {
    title: isBlank ? '新标签页' : displayTitle(url, pageTitle),
    data: {
      pageUrl: isBlank ? 'about:blank' : url,
      faviconUrl: isBlank ? '' : faviconUrlForPage(url),
    },
  })
}

/**
 * 原生 WebView2 只有一扇窗。右侧可以有多个 browser 标签，各自在 tab.data.pageUrl
 * 里记当前页。切签时把原生窗导航到该标签保存的地址，避免「新标签还是旧网页」。
 *
 * 切签/新标签时这里不带实测槽位：ensureNativeEmbed 会 managed-only 导航并保持停靠，
 * 由前台 BrowserPanel 的 reportEmbedSlot 再贴回面板区域（避免估算矩形盖住标签条）。
 */
let lastActiveBrowserKey = ''

function applyStageBrowserSurface(tabId: string, pageUrl: string, pageTitle: string, reason: string) {
  const raw = String(pageUrl || '').trim() || 'about:blank'
  const url = sanitizeBrowserPageUrl(raw, 'about:blank') || 'about:blank'
  const title = String(pageTitle || '').trim()
  const tab = rightStageStore.findTab(`browser:${tabId}`)
  const { stack, index } = readTabHistory(tab?.data)
  patch({
    pageUrl: url === 'about:blank' ? '' : url,
    pageTitle: title === '新标签页' ? '' : title,
    canGoBack: index > 0,
    canGoForward: index >= 0 && index < stack.length - 1,
  })
  // Another session owns the shared HWND (agent still driving). Do not navigate
  // it to this session's URL — that would steal the page from the owner agent.
  // syncNativeEmbed already parks on foreign-owner; chrome above still updates.
  const uiSk = getCurrentRightStageSessionKey()
  const ownerSk = getBridgeOwnerSessionKey()
  if (ownerSk && uiSk && ownerSk !== uiSk) {
    dbgLog(
      `[browser-panel-store] skip HWND nav (foreign owner=${ownerSk} ui=${uiSk}) reason=${reason} url=${url}`,
    )
    return
  }
  // 空白标签：只 park，绝不 navigate about:blank。
  // 共享 HWND 里上一标签的文档还在；毁掉后再切回去经常贴不回槽位。
  if (!url || url === 'about:blank') {
    markUserNavigateIntent('about:blank')
    syncNativeEmbed(`${reason}:blank-park`)
    void browserEmbedPark(NATIVE_EMBED_THREAD_ID)
    dbgLog(`[browser-panel-store] blank tab park id=${tabId} reason=${reason}`)
    return
  }
  markUserNavigateIntent(url)
  // 先刷新显隐门闩（desiredStageId），再 upsert——否则 present=false 会把刚导航的窗又 park 掉。
  syncNativeEmbed(`${reason}:show`)
  void ensureNativeEmbed({
    url,
    stageId: tabId,
    reason,
    // 切签/新标签/会话恢复用 replace，后退只走「本标签内」历史。
    replace:
      reason === 'stage-switch' || reason === 'stage-restore' || reason === 'force-new',
  })
}

/**
 * 切会话时清空「上一激活浏览器 tab」跟踪。
 * 否则 A/B 都用 browser:primary 时，key 相同会跳过导航，HWND 仍停在 A 的页面。
 */
export function resetBrowserStageSwitchTracking() {
  lastActiveBrowserKey = ''
}

function onRightStageBrowserChange() {
  const snap = rightStageStore.getSnapshot()
  const key = String(snap.activeKey || '')
  if (!key.startsWith('browser:')) {
    lastActiveBrowserKey = ''
    return
  }
  if (key === lastActiveBrowserKey) return
  const prev = lastActiveBrowserKey
  lastActiveBrowserKey = key
  const tab = snap.tabs.find((t) => `browser:${t.id}` === key)
  if (!tab) return
  const url =
    sanitizeBrowserPageUrl(String(tab.data?.pageUrl || '').trim(), 'about:blank') || 'about:blank'
  const title = String(tab.title || '').trim()
  // prev 为空也要导航：切回「后台开过浏览器」的会话时，必须把 HWND 贴回该标签 URL。
  dbgLog(`[browser-panel-store] stage switch ${prev || '(none)'} → ${key} url=${url}`)
  applyStageBrowserSurface(tab.id, url, title, prev ? 'stage-switch' : 'stage-restore')
}

rightStageStore.subscribe(onRightStageBrowserChange)

/**
 * 打开/激活浏览器标签。
 * - 归属会话 === 当前 UI 会话：写 live 右栏并贴 HWND。
 * - 归属会话是后台：只写入该会话的冻结记忆，不污染当前会话侧栏。
 *   Agent 仍可用共享 HWND（CDP）；UI 上 HWND 由 syncNativeEmbed 在非浏览器页时 park。
 */
export function ensureBrowserStage(opts?: {
  forceNew?: boolean
  sessionKey?: string
  title?: string
  id?: string
  pageUrl?: string
  /**
   * Soft-decouple: raise/expand the right-stage browser chrome without
   * upsert-navigating the HWND (agent CDP already owns the page).
   */
  skipHwndNav?: boolean
  /**
   * Agent 导航：允许把已有 URL 的签改成新地址。用户地址栏禁止靠这个盖其它签。
   */
  replacePageUrl?: boolean
}) {
  const sessionKey = String(opts?.sessionKey || '').trim() || undefined
  // 未指定 id 时跟当前激活浏览器标签，不要写死 primary——否则在第二个标签里
  // 打开/导航会把 pageUrl 盖到第一个标签上。
  const id = opts?.forceNew
    ? newBrowserStageId()
    : String(opts?.id || activeBrowserTabId() || 'primary').trim() || 'primary'
  // 关键模型：tab.data.pageUrl 只接受「调用方显式传入」的 URL。
  // 禁止 opts.pageUrl 缺失时用 state.pageUrl（HWND/上一签残留）回填——那会把 blank 新签写成 baidu。
  const hasExplicitUrl = opts != null && Object.prototype.hasOwnProperty.call(opts, 'pageUrl')
  const explicitPageUrl = hasExplicitUrl
    ? sanitizeBrowserPageUrl(String(opts?.pageUrl || '').trim(), 'about:blank')
    : null
  const skipHwndNav = opts?.skipHwndNav === true
  const currentSk = getCurrentRightStageSessionKey()

  // 后台会话：不碰当前 UI 右栏。
  if (sessionKey && currentSk && sessionKey !== currentSk) {
    dbgLog(
      `[browser-panel-store] ensureBrowserStage background session=${sessionKey} (ui=${currentSk}) id=${id}`,
    )
    upsertBrowserTabInSessionMemory({
      sessionKey,
      id,
      title: opts?.title,
      pageUrl: explicitPageUrl || 'about:blank',
      pageTitle: opts?.title,
      activate: true,
    })
    // 前台正在看浏览器时绝不能改共享 HWND（否则 B 的画面会变成 A 的 URL）。
    // 前台无浏览器时：managed 导航 + park，切回归属会话再由 stage-restore 贴位。
    const uiSnap = rightStageStore.getSnapshot()
    const uiShowsBrowser =
      !uiSnap.collapsed && String(uiSnap.activeKey || '').startsWith('browser:')
    if (
      !skipHwndNav &&
      !uiShowsBrowser &&
      explicitPageUrl &&
      explicitPageUrl !== 'about:blank'
    ) {
      void ensureNativeEmbed({
        url: explicitPageUrl,
        stageId: id,
        reason: 'background-session',
        replace: true,
        forceHidden: true,
      })
    }
    return
  }

  // Foreground open claims ownership so a prior background agent cannot keep the HWND parked forever.
  if (sessionKey && (!currentSk || sessionKey === currentSk)) {
    setBridgeOwnerSessionKey(sessionKey)
  }

  const existing = rightStageStore.findTab(`browser:${id}`)

  if (opts?.forceNew) {
    // 新标签：空白页。只建 chrome + park HWND，不 navigate about:blank（会毁上一标签文档）。
    lastActiveBrowserKey = `browser:${id}`
    patch({
      pageUrl: '',
      pageTitle: '',
      canGoBack: false,
      canGoForward: false,
    })
    rightStageStore.show({
      kind: 'browser',
      id,
      title: '新标签页',
      layout: 'wide',
      sessionKey,
      data: {
        pageUrl: 'about:blank',
        faviconUrl: '',
        historyStack: ['about:blank'],
        historyIndex: 0,
      },
    })
    if (!skipHwndNav) applyStageBrowserSurface(id, 'about:blank', '', 'force-new')
    return
  }

  const nextData = existing?.data ? { ...existing.data } : {}
  const prevTabUrl = String(existing?.data?.pageUrl || '').trim()
  const prevTabBlank = !prevTabUrl || prevTabUrl === 'about:blank'
  if (explicitPageUrl && explicitPageUrl !== 'about:blank') {
    // 写 pageUrl 规则：
    // - 同趟 URL：可以（刷新 chrome）
    // - blank 签：仅 primary（agent 种子）或「本签」用户导航意图
    // - 已有其它 URL：仅 replacePageUrl（agent）或「本签」用户导航意图
    // 禁止：仅凭 isUserNavigateIntent(url) 盖掉另一签（第二签回车 → 第一签标题被换）。
    const same = !prevTabBlank && isSameBrowserLoad(prevTabUrl, explicitPageUrl)
    const activeId = activeBrowserTabId()
    const intentForThisTab =
      Boolean(activeId) &&
      id === activeId &&
      isUserNavigateIntent(explicitPageUrl)
    let allowWrite = false
    if (same) {
      allowWrite = true
    } else if (prevTabBlank) {
      allowWrite = id === 'primary' || intentForThisTab
    } else {
      allowWrite = opts?.replacePageUrl === true || intentForThisTab
    }
    if (allowWrite) {
      nextData.pageUrl = explicitPageUrl
    } else {
      dbgLog(
        `[browser-panel-store] ensure skip stomp tab id=${id} prev=${prevTabUrl || '(blank)'} url=${explicitPageUrl}`,
      )
    }
  }
  // Latch BEFORE show: show() notifies subscribers synchronously; if
  // lastActiveBrowserKey is still empty, onRightStageBrowserChange treats this
  // as stage-restore and upsert-navigates — undoing soft-decouple (CDP already
  // owns the page; FE then rebuilds HWND → guest-poll / COM death).
  lastActiveBrowserKey = `browser:${id}`
  rightStageStore.show({
    kind: 'browser',
    id,
    title: String(opts?.title || '').trim() || existing?.title || '浏览器',
    layout: 'wide',
    sessionKey,
    data: nextData,
  })
  const navUrl = String(nextData.pageUrl || '').trim()
  if (
    !skipHwndNav &&
    navUrl &&
    navUrl !== 'about:blank' &&
    String(existing?.data?.pageUrl || '') !== navUrl
  ) {
    applyStageBrowserSurface(id, navUrl, String(opts?.title || ''), 'ensure-nav')
  }
}

/** 引擎标签页列表写入（面板轮询 tabList 后调用）。 */
export function setBrowserTabs(tabs: BrowserTabSummary[]) {
  const list = Array.isArray(tabs) ? tabs : []
  const next: Partial<BrowserRuntimeState> = { tabs: list }
  const engineActive = list.find((t) => t.active) || list[0]
  if (engineActive) {
    const url = sanitizeBrowserPageUrl(String(engineActive.url || '').trim())
    const title = String(engineActive.title || '').trim()
    // 只把引擎 URL 同步进 runtime（地址栏瞬时对齐），且必须与当前激活签同趟。
    // 禁止 syncBrowserStageChrome：切签后 HWND 常还停在上一页，会把 baidu 写进 blank/另一签。
    const tabId = activeBrowserTabId()
    const tab = tabId ? rightStageStore.findTab(`browser:${tabId}`) : null
    const tabUrl = String(tab?.data?.pageUrl || '').trim()
    if (
      url &&
      tabUrl &&
      tabUrl !== 'about:blank' &&
      isSameBrowserLoad(url, tabUrl) &&
      url !== state.pageUrl &&
      !isSameBrowserLoad(url, state.pageUrl)
    ) {
      next.pageUrl = url
    }
    if (title && tabUrl && tabUrl !== 'about:blank' && isSameBrowserLoad(url, tabUrl)) {
      if (title !== state.pageTitle) next.pageTitle = title
    }
  }
  patch(next)
}

/** 只关浏览器这一页，其它 right-stage 标签保留。 */
export function closeBrowserStage(id = 'primary') {
  const tabId = String(id || 'primary').trim() || 'primary'
  rightStageStore.closeTab(`browser:${tabId}`)
}

/** Publish the panel's *real* thread id (from the chat session) so the browser
 * tool metadata can be validated against it. Called by ChatApp on every
 * browser tool event. */
export function setBrowserPanelThreadId(threadId: string | null | undefined): boolean {
  const tid = acceptThreadId(threadId)
  if (!tid || tid === state.streamThreadId) return false
  dbgLog(`[browser-panel-store] set threadId=${tid} (was ${state.streamThreadId || '(empty)'})`)
  patch({ streamThreadId: tid })
  return true
}

/** Patch runtime from a direct browser-command/tab response (user-initiated
 *  action that did NOT go through the AG-UI tool stream). Without this, typing
 *  a URL into the address bar would succeed at the backend but the panel would
 *  not refresh because it only listened for tool-result events. */
export function applyBrowserCommandResponse(input: {
  threadId?: string
  pageUrl?: string
  pageTitle?: string
  streamWs?: string
  canGoBack?: boolean
  canGoForward?: boolean
  /** 为 true 时压入当前标签逻辑历史（地址栏/站内导航）；切签后退不要传。 */
  pushHistory?: boolean
  /**
   * Soft-decouple: user chrome action (address bar). Seeds lastUserNavigateUrl.
   * Agent / panel-request / getState sync must leave this false so BrowserPanel
   * only updates the address bar and does not upsert-navigate the HWND.
   */
  navigateIntent?: boolean
  /**
   * Owning chat session. Engine `browser-panel-request` must pass the bridge
   * owner (or omit to use {@link resolveBrowserUiSessionKey}) — never blindly
   * write into whatever session the user is currently viewing.
   */
  sessionKey?: string
  /**
   * 钉死 chrome 回写的浏览器签 id。CDP settle 时若用户已切走，必须仍写发起导航的签，
   * 不能跟「当前 active」。
   */
  stageId?: string
}): boolean {
  const sessionKey = resolveBrowserUiSessionKey(input.sessionKey) || undefined
  const currentSk = getCurrentRightStageSessionKey()
  const isBackground = Boolean(sessionKey && currentSk && sessionKey !== currentSk)

  const next: Partial<BrowserRuntimeState> = {}
  const tid = acceptThreadId(input.threadId)
  if (tid && tid !== state.streamThreadId) next.streamThreadId = tid
  const pageUrl = sanitizeBrowserPageUrl(input.pageUrl || '', state.pageUrl)
  const pageUrlChanged = Boolean(
    pageUrl &&
      !isBackground &&
      pageUrl !== state.pageUrl &&
      !isSameBrowserLoad(pageUrl, state.pageUrl),
  )
  if (pageUrlChanged) next.pageUrl = pageUrl
  if (input.navigateIntent && pageUrl && !isBackground) {
    if (pageUrl !== state.lastUserNavigateUrl) next.lastUserNavigateUrl = pageUrl
  }
  if (input.pageTitle !== undefined && !isBackground) {
    const title = String(input.pageTitle || '').trim()
    if (title !== state.pageTitle) next.pageTitle = title
  }
  // 工具栏以后退栈为准；引擎 canGo* 不再覆盖逻辑栈（除非未 push 且显式传入）。
  if (!input.pushHistory && !isBackground) {
    if (typeof input.canGoBack === 'boolean' && input.canGoBack !== state.canGoBack) {
      next.canGoBack = input.canGoBack
    }
    if (typeof input.canGoForward === 'boolean' && input.canGoForward !== state.canGoForward) {
      next.canGoForward = input.canGoForward
    }
  }
  const snap = rightStageStore.getSnapshot()
  const hasBrowser = snap.tabs.some((t) => normalizeRightStageKind(t.kind) === 'browser')
  const activeIsBrowser = String(snap.activeKey || '').startsWith('browser:')
  const needRaise = !isBackground && (!hasBrowser || snap.collapsed || !activeIsBrowser)

  if (
    !Object.keys(next).length &&
    !input.pushHistory &&
    !isBackground &&
    !needRaise
  ) {
    return false
  }
  dbgLog(
    `[browser-panel-store] apply browser-command response thread=${tid || state.streamThreadId} ` +
      `session=${sessionKey || '(none)'} bg=${isBackground} ` +
      `url=${pageUrl || '(unchanged)'} title=${next.pageTitle ?? '(unchanged)'} push=${Boolean(input.pushHistory)}`,
  )

  if (isBackground) {
    // Keep CDP thread id; never touch foreground chrome / live pageUrl.
    if (tid) patch({ streamThreadId: tid })
    if (pageUrl) {
      upsertBrowserTabInSessionMemory({
        sessionKey: sessionKey!,
        pageUrl,
        pageTitle: String(input.pageTitle || '').trim() || undefined,
        activate: true,
      })
    }
    ensureBrowserStage({ sessionKey, pageUrl: pageUrl || undefined })
    return true
  }

  const pinTabId = String(input.stageId || '').trim() || undefined
  if (Object.keys(next).length) patch(next)
  if (input.pushHistory && pageUrl) {
    pushBrowserTabHistory(pageUrl, state.pageTitle, pinTabId)
  } else if (pageUrlChanged || next.pageTitle !== undefined) {
    syncBrowserStageChrome(state.pageUrl, state.pageTitle, pinTabId)
  }
  // 地址栏回车（navigateIntent + pushHistory）：空白新标签 HWND 处于 park，
  // 仅靠 CDP soft-decouple 不会 upsert/贴位 → 用户感觉「按了回车没反应」。
  // 先开门闩再导航共享窗；CDP navigate 仍由 BrowserPanel 随后补一枪对齐引擎态。
  if (
    input.navigateIntent &&
    input.pushHistory &&
    pageUrl &&
    pageUrl !== 'about:blank' &&
    !isBackground
  ) {
    const tabId = pinTabId || activeBrowserTabId()
    syncNativeEmbed('address-bar')
    if (tabId) {
      void ensureNativeEmbed({
        url: pageUrl,
        stageId: tabId,
        reason: 'address-bar',
        replace: true,
      })
    }
  }
  // Soft-decouple: agent/pageUrl sync must still *raise* the right stage (expand +
  // activate browser tab). Previously we skipped ensure when a browser tab
  // already existed — collapsed panels never re-opened. Always skipHwndNav here:
  // HWND nav is CDP / sendBrowserCommand / tab-switch ensureNativeEmbed.
  if (needRaise) {
    ensureBrowserStage({
      sessionKey,
      pageUrl: pageUrl || undefined,
      // 引擎/agent 抬栏：允许改当前签地址；用户地址栏走 pushHistory，不靠这里盖写。
      replacePageUrl: Boolean(pageUrl) && !input.navigateIntent,
      skipHwndNav: true,
    })
    blogTimeline(
      '侧栏打开',
      `来源=后台回写 会话=${sessionKey || '(无)'} 链接=${pageUrl || '(无)'} ` +
        `此前折叠=${snap.collapsed ? '是' : '否'} 已有浏览器标签=${hasBrowser ? '是' : '否'}`,
    )
  }
  return true
}

export function notifyBrowserToolStart(
  toolCallId: string,
  argsText?: string | null,
  opts?: { toolName?: string; forceOpen?: boolean; sessionKey?: string },
): boolean {
  const toolName = String(opts?.toolName || '').trim().toLowerCase()
  const isNodeRepl = toolName === 'mcp__node_repl__js'
  const { action, url } = parseBrowserToolArgs(argsText)
  const sessionKey = String(opts?.sessionKey || '').trim() || undefined
  // node_repl 只有代码里真的出现浏览器 API 才自动拉起面板；纯数据处理 JS 保持侧栏安静。
  const nodeReplBrowser = isNodeRepl && nodeReplArgsTouchBrowser(argsText)
  dbgLog(
    `[browser-panel-store] tool start toolCallId=${toolCallId} tool=${toolName || '(n/a)'} ` +
      `session=${sessionKey || '(none)'} action=${action} url=${url || '(none)'} browserIntent=${nodeReplBrowser} argsText=${(argsText || '').slice(0, 200)}`,
  )
  // Claim shared HWND ownership so engine panel-request / navigate land on this
  // session's memory — not whatever chat the user switched to mid-run.
  if (sessionKey && (nodeReplBrowser || !isNodeRepl || opts?.forceOpen)) {
    setBridgeOwnerSessionKey(sessionKey)
  }
  // node-repl / browser-use always drives the shared bridge WebView2. Bind the
  // panel to that session *before* ensureBrowserStage so the embed host mounts
  // the same HWND the agent is about to control.
  if (isNodeRepl) {
    patch({ streamThreadId: NODE_REPL_BRIDGE_THREAD_ID })
  }
  patch({
    operating: true,
    operatingAction: action || (isNodeRepl ? 'node_repl' : ''),
    operatingToolCallId: String(toolCallId || '').trim(),
  })
  const currentSk = getCurrentRightStageSessionKey()
  const isBackground = Boolean(sessionKey && currentSk && sessionKey !== currentSk)
  // Publish the target URL now rather than waiting for the tool result. The
  // embedded browser mounts as soon as the stage opens, so a late URL meant the
  // window rendered on `about:blank` until the agent finished.
  // 后台会话只写记忆，不改前台 runtime.pageUrl。
  if (url && /^https?:\/\//i.test(url) && !isBackground) {
    if (url !== state.pageUrl) {
      dbgLog(`[browser-panel-store] seed pageUrl=${url} (from tool start)`)
      patch({ pageUrl: url })
    }
  }
  // For page-opening actions (and node_repl calls whose code drives the browser),
  // raise the right stage *before* the result arrives so the user can see the live
  // panel mount while the agent is still working.
  if (
    opts?.forceOpen ||
    nodeReplBrowser ||
    action === 'open' ||
    action === 'navigate' ||
    action === 'snapshot'
  ) {
    blogTimeline(
      '工具准备开页',
      `工具=${toolName || '(无)'} 动作=${action || '(无)'} 链接=${url || '(无)'} ` +
        `会话=${sessionKey || '(无)'} 识别为浏览器调用=${nodeReplBrowser ? '是' : '否'}`,
    )
    // Soft-decouple: raise UI from tool args；Agent 固定写 primary，不盖用户加号出的 blank 签。
    ensureBrowserStage({
      sessionKey,
      id: 'primary',
      pageUrl: url || undefined,
      replacePageUrl: Boolean(url),
      skipHwndNav: true,
    })
    blogTimeline(
      '侧栏打开',
      `来源=工具开始 会话=${sessionKey || '(无)'} 链接=${url || state.pageUrl || '(无)'}`,
    )
  }
  return true
}

export function notifyBrowserToolResult(
  toolCallId: string,
  resultText?: string | null,
  opts?: { nodeReplBrowser?: boolean; sessionKey?: string },
): boolean {
  const sessionKey = String(opts?.sessionKey || '').trim() || undefined
  const live = parseBrowserLiveToolOutput(resultText)
  const liveSummary = live
    ? { mode: live.mode, pageUrl: live.pageUrl, streamWs: live.streamWs, headed: live.headed }
    : null
  dbgLog(
    `[browser-panel-store] tool result toolCallId=${toolCallId} live=${JSON.stringify(liveSummary)} raw=${(resultText || '').slice(0, 160)}`,
  )
  if (resultText && !live) {
    // node-repl results are SDK stdout / structured objects, not browser_live —
    // that is expected. Keep the panel bound to the bridge session anyway.
    dbgWarn(`[browser-panel-store] live parse returned null for toolCallId=${toolCallId}`)
  }
  const next: Partial<BrowserRuntimeState> = {
    operating: state.operatingToolCallId === String(toolCallId || '').trim() ? false : state.operating,
  }
  // If we are already on the node-repl bridge session (or just opened for it),
  // keep the panel up even without a browser_live payload — but only when this
  // call actually drove the browser; a pure-JS node_repl result must not re-raise
  // a panel the user closed.
  const onBridge =
    state.streamThreadId === NODE_REPL_BRIDGE_THREAD_ID ||
    state.operatingAction === 'node_repl'
  if (onBridge) {
    next.streamThreadId = NODE_REPL_BRIDGE_THREAD_ID
    next.browserMode = next.browserMode || state.browserMode || 'embed'
    next.sharedBrowser = false
    if (opts?.nodeReplBrowser !== false) {
      // 只抬 primary chrome；不传 pageUrl，避免用 runtime 残留盖掉用户其它签。
      ensureBrowserStage({ sessionKey, id: 'primary', skipHwndNav: true })
    }
  }
  if (live) {
    const backendTid = extractThreadIdFromStreamPath(
      String((live as { streamWs?: string }).streamWs || ''),
    )
    if (backendTid) {
      next.streamThreadId = backendTid
    } else if (!onBridge) {
      dbgWarn(
        `[browser-panel-store] backend streamWs=${String((live as { streamWs?: string }).streamWs || '')} has placeholder thread — keeping real threadId=${state.streamThreadId || '(empty)'}`,
      )
    }
    const pageUrl = sanitizeBrowserPageUrl(String((live as { pageUrl?: string }).pageUrl || '').trim())
    if (pageUrl) next.pageUrl = pageUrl
    const mode = String((live as { mode?: string }).mode || '').trim()
    if (
      mode === 'evopanel' ||
      mode === 'headed' ||
      mode === 'cdp' ||
      mode === 'headless' ||
      mode === 'embed'
    ) {
      next.browserMode = mode
    }
    const headed = Boolean((live as { headed?: boolean | string }).headed)
    // In-process Playwright engine: browser lives in EvoPanel, *not* on the
    // user's desktop. Only legacy headed / external CDP / WebView2 embed share
    // the user's own browser, so we suppress the shared-browser flag there.
    next.sharedBrowser = headed || mode === 'headed' || mode === 'cdp' || mode === 'embed'
    if (mode === 'evopanel' || mode === 'embed' || onBridge) next.sharedBrowser = false
    // Agent opened a page → 只抬 primary，不盖用户加号签。
    if (pageUrl || backendTid || onBridge) {
      ensureBrowserStage({
        sessionKey,
        id: 'primary',
        pageUrl: pageUrl || undefined,
        replacePageUrl: Boolean(pageUrl),
        skipHwndNav: true,
      })
    }
  }
  const currentSk = getCurrentRightStageSessionKey()
  const isBackground =
    Boolean(sessionKey && currentSk && sessionKey !== currentSk)
  if (isBackground) {
    // 后台结果只写归属会话记忆；禁止改全局 runtime.pageUrl，否则前台 B 地址栏会串成 A。
    const bgUrl = String(next.pageUrl || '').trim()
    if (bgUrl) {
      upsertBrowserTabInSessionMemory({
        sessionKey: sessionKey!,
        id: 'primary',
        pageUrl: bgUrl,
        pageTitle: String(next.pageTitle || '').trim() || undefined,
        activate: true,
      })
    }
    // 仅收尾 operating，不覆盖前台 chrome / URL。
    patch({
      operating:
        state.operatingToolCallId === String(toolCallId || '').trim() ? false : state.operating,
    })
    return Boolean(live) || onBridge
  }
  patch(next)
  if (next.pageUrl || state.pageUrl) {
    // Agent 结果只回写 primary chrome。
    syncBrowserStageChrome(state.pageUrl, state.pageTitle, 'primary')
  }
  return Boolean(live) || onBridge
}

export function notifyBrowserToolEnd(toolCallId: string): boolean {
  if (state.operatingToolCallId && state.operatingToolCallId !== String(toolCallId || '').trim()) {
    return false
  }
  patch({ operating: false, operatingAction: '', operatingToolCallId: '' })
  return true
}

export function notifyBrowserFrameMetadata(meta?: BrowserStreamFrameMetadata) {
  if (!meta) return
  patch({ lastFrameMeta: meta })
}

/** Pull URL intents out of node-repl ``code`` (browsers.open / navigate / tabs.new). */
function extractUrlFromNodeReplCode(code: string): string {
  const raw = String(code || '')
  if (!raw) return ''
  const openMatch = raw.match(
    /(?:browsers\.open|tabs\.new|\.navigate|agent\.browsers\.open)\(\s*["'`]([^"'`]+)["'`]/,
  )
  return String(openMatch?.[1] || '').trim()
}

/** browser-use 技能写进 node_repl 代码的浏览器 API 面（control-browser SKILL 形状：
 * agent.browsers.* / tabs.new / tab.navigate / b.execute({method:...}) / 桥符号）。
 * 刻意排除 computer-use（agent.computerUse.*）——桌面控制没有浏览器面板可展示；
 * 也排除常见数据处理词形（tabs 数组的 .map/.forEach/.length 不会命中）。
 * 召回优先：漏判的浏览器调用还有后端 browser-panel-request（CDP 真驱动 WebView2
 * 时必发）兜底拉起面板，不会出现「浏览器动了、面板不在」。 */
const NODE_REPL_BROWSER_INTENT_RE = new RegExp(
  [
    'agent\\.browsers\\b',
    '\\bbrowsers\\s*\\.\\s*(open|get|getForUrl|getDefault|list)\\b',
    "\\btabs?\\s*\\.\\s*(new|get|list|finalize|activate|claim|close|reload|navigate|snapshot|screenshot|click|fill|type|press|scroll|hover|select|check|drag|back|forward|evaluate|waitFor|getState|elementInfo)\\s*\\(",
    '\\.\\s*navigate\\s*\\(',
    '\\.\\s*(newTab|activateTab|claimTab|browserViewportSet)\\s*\\(',
    // \\? 吃掉 JSON 转义引号前的反斜杠（argsText 里是 method: \"navigate\"）
    "\\bmethod\\s*:\\s*\\\\?[\"'`]?(?:navigate|back|forward|reload|snapshot|click|fill|type|press|scroll|hover|select|check|drag|screenshot|evaluate|waitFor|elementInfo|getState|close|newTab|activateTab|claimTab|browserViewportSet)\\b",
    'browser-control-bridge',
  ].join('|'),
  'i',
)

/** Does this node_repl ``js`` tool args payload drive the browser?
 *  Runs on the raw (possibly partial, JSON-escaped) args text — streamed
 *  TOOL_CALL_ARGS chunks must already trigger the intent, not only complete JSON. */
export function nodeReplArgsTouchBrowser(argsText?: string | null): boolean {
  const raw = String(argsText || '')
  if (!raw) return false
  return NODE_REPL_BROWSER_INTENT_RE.test(raw)
}

/** Pull the requested URL out of the tool arguments, tolerating a partial
 *  (streamed, truncated) JSON payload. The embedded browser boots as soon as the
 *  stage opens — which happens on tool *start* — so waiting for the tool result to
 *  reveal the URL left the window sitting on `about:blank` for the whole time the
 *  agent was working. */
function parseBrowserToolArgs(argsText?: string | null): { action: string; url: string } {
  const raw = String(argsText || '').trim()
  if (!raw) return { action: '', url: '' }
  try {
    const args = JSON.parse(raw) as { action?: string; url?: string; code?: string }
    const action = String(args?.action || '').trim().toLowerCase()
    let url = String(args?.url || '').trim()
    if (!url && args?.code) url = extractUrlFromNodeReplCode(args.code)
    return { action, url }
  } catch {
    const action = String(raw.match(/"action"\s*:\s*"([^"]+)"/i)?.[1] || '').trim().toLowerCase()
    // Streamed args can end mid-string, so accept whatever was captured so far.
    let url = String(raw.match(/"url"\s*:\s*"([^"]*)/i)?.[1] || '').trim()
    if (!url) url = extractUrlFromNodeReplCode(raw)
    return { action, url }
  }
}
