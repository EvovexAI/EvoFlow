/**
 * 原生 WebView 的显隐只走这里。规则对齐 ZCode 侧栏，不是多处各自 park。
 *
 * ZCode（Electron）把 `<webview>` 放进「当前选中的那个侧栏 tab」里：
 * - 侧栏折叠，或激活的不是这个 browser tab → 用户看不到 guest
 * - 可以有多个 browser tab（每条记录一个 id）
 * - 缓存分区只有一个：`persist:zcode-embedded-browser`，标签之间共用 cookie/缓存
 * - 布局是 DOM，guest 跟着槽位走，没有单独的屏幕坐标
 *
 * EvoFlow 的 WebView2 是主窗口里的一个子 HWND，不会跟着 React 隐藏，
 * 也无法参与 CSS z-index。原生窗口也只有一个：`browser-embed-primary`。
 *
 * 显示条件（同时满足）：
 * 1. 右栏展开且激活页是浏览器页
 * 2. 没有盖住聊天区的全局遮罩（overlayDepth === 0）
 * 全局弹窗打开时隐藏 HWND，关掉后再按右栏状态贴回。
 *
 * 层级：WebView2 是主窗口子 HWND，不吃 CSS z-index。
 * 凡是要盖在它上面的 HTML（工具详情、审批、右栏菜单、模型下拉、图片灯箱）都走同一条 overlay 计数：
 * - `.react-chat-modal-overlay` / `.chat-lightbox` / `[data-above-native-embed]` 由文末观察器自动登记
 * - 共享 Dialog/AlertDialog Overlay、Dropdown/Select/Popover/ContextMenu Content 已默认带 `data-above-native-embed`
 * - 还没进 DOM 的右栏 chrome 状态用 beginGlobalOverlay / useGlobalOverlayWhen
 */
import {
  browserEmbedPark,
  browserEmbedSetBounds,
  browserEmbedUpsert,
  type BrowserEmbedInfo,
} from './browser-embed-client.js'
import { getBridgeOwnerSessionKey } from './browser-bridge-owner.js'
import { isNavigableBrowserUrl, sanitizeBrowserPageUrl } from './browser-page-url.js'
import { blog } from './browser-unified-log.js'
import { getCurrentRightStageSessionKey } from './right-stage/right-stage-session-memory.js'
import { rightStageStore } from './right-stage/right-stage-store.js'
import { shouldSurfaceBrowserOnXiaomiVoiceUi } from './xiaomi-voice/voice-right-stage-foreground.js'

/** 与 browser-panel-store 的 NODE_REPL_BRIDGE_THREAD_ID 同一扇原生窗。 */
export const NATIVE_EMBED_THREAD_ID = 'evoflow-node-repl-bridge'

export type EmbedSlot = {
  x: number
  y: number
  width: number
  height: number
  viewportWidth?: number
  viewportHeight?: number
}

export type EmbedPlacement = {
  /** 空字符串 = 隐藏。非空 = 当前该显示的右栏浏览器 id。 */
  stageId: string
  reason: string
  overlayDepth: number
}

function browserStageIdFromSnapshot(): string {
  const snap = rightStageStore.getSnapshot()
  if (snap.collapsed || !snap.activeKey) return ''
  const tab =
    snap.tabs.find((item) => `${item.kind}:${item.id}` === snap.activeKey) || snap.surface
  if (!tab) return ''
  if (tab.kind === 'browser') {
    // 空白新标签：不要露出 HWND。单窗还停在上一标签的页，露出会「空白地址栏底下是旧网页」；
    // 切回有 URL 的标签时再 show。navigate about:blank 会毁掉上一页，切回去常贴不回来。
    const pageUrl = String(tab.data?.pageUrl || '').trim()
    if (!pageUrl || pageUrl === 'about:blank') return ''
    return String(tab.id || 'primary')
  }
  if (tab.kind === 'web-embed') {
    const data = tab.data || {}
    const ext = String(data.extensionId || data.extension_id || '').trim()
    if (!ext) return String(tab.id || 'primary')
  }
  return ''
}

let lastPlacementKey = ''
/** 右栏认为该显示的浏览器页 id（忽略遮罩）。贴位校验用这个。 */
let desiredStageId = ''
/** 遮罩为 0 且 desired 非空时真正显示的 id。 */
let visibleStageId = ''
let overlayDepth = 0
/** 上次成功发出的槽位；park/换页时清掉，相同槽位去重。 */
let lastReportedSlotKey = ''
/**
 * 显隐世代：hide 时自增。reportEmbedSlot 发出前/await 后都要核对，
 * 否则「切到图片/折叠」之后仍在飞的 set_bounds 会把语音态大 HWND 又贴回屏上盖住新页。
 */
let embedGateEpoch = 0
/**
 * 串行贴位：同时只跑一条 set_bounds；期间只保留最新槽位。
 * 避免拖宽风暴里「后发先至」被更早 IPC 回写盖掉。
 */
type SlotReportJob = {
  id: string
  slot: EmbedSlot
  force: boolean
  epoch: number
}
let slotReportInflight: Promise<boolean> | null = null
let slotReportQueued: SlotReportJob | null = null

export function currentEmbedPlacement(): EmbedPlacement {
  return { stageId: visibleStageId, reason: lastPlacementKey, overlayDepth }
}

export function getGlobalOverlayDepth(): number {
  return overlayDepth
}

/** 当前显隐世代；BrowserPanel 也可用来丢弃过期 settle。 */
export function getEmbedGateEpoch(): number {
  return embedGateEpoch
}

function placementKey(stageId: string, depth: number): string {
  if (depth > 0) return `hide:overlay:${depth}`
  return stageId ? `show:${stageId}` : 'hide'
}

/** 右栏展开/换页/切会话/折叠/遮罩变化之后调用。只有结果变了才动原生窗。 */
export function syncNativeEmbed(reason = 'right-stage') {
  const stageId = browserStageIdFromSnapshot()
  desiredStageId = stageId
  // Shared HWND: only the owning chat session may show it. If the user switched
  // to B while A's agent still drives the bridge, park — otherwise B sees A's page.
  const uiSk = getCurrentRightStageSessionKey()
  const ownerSk = getBridgeOwnerSessionKey()
  // 语音占用：小V 开的浏览器 owner 常被标成 main，仍允许贴位。
  const foreignOwner =
    Boolean(ownerSk && uiSk && ownerSk !== uiSk) &&
    !shouldSurfaceBrowserOnXiaomiVoiceUi(ownerSk)
  const canShow = Boolean(stageId) && overlayDepth === 0 && !foreignOwner
  const shownId = canShow ? stageId : ''
  const key = foreignOwner
    ? `hide:foreign-owner:${ownerSk}`
    : placementKey(stageId, overlayDepth)
  if (key === lastPlacementKey) return
  lastPlacementKey = key
  visibleStageId = shownId
  // park / 换页后槽位必须重新上报，不能吃旧的 lastReportedSlotKey。
  lastReportedSlotKey = ''
  // 丢掉尚未贴出的中间槽位，避免 park 后 worker 再 SetWindowPos 一次。
  slotReportQueued = null
  const active = rightStageStore.getSnapshot().activeKey || '(none)'
  const line =
    `[browser-embed-surface] ${key} reason=${reason} active=${active} ` +
    `overlay=${overlayDepth} ui=${uiSk || '(none)'} owner=${ownerSk || '(none)'}`
  console.info(line)
  blog('info', line)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('browser-embed-gate', {
        detail: {
          show: Boolean(shownId),
          id: shownId,
          desiredId: stageId,
          overlayDepth,
          reason,
          foreignOwner,
        },
      }),
    )
  }
  if (!shownId) {
    // 先抬世代再 park：阻断本拍之前已排队的 reportEmbedSlot。
    embedGateEpoch += 1
    // present=false 也会走 hide（见 Rust）；与 park 双发，谁先到谁先把语音态大窗挪走，
    // 避免「打开图片」后 HWND 还盖在文件预览上整整一拍。
    void browserEmbedSetBounds({
      threadId: NATIVE_EMBED_THREAD_ID,
      x: 0,
      y: 0,
      width: 120,
      height: 80,
      present: false,
    })
    void browserEmbedPark(NATIVE_EMBED_THREAD_ID)
  } else {
    embedGateEpoch += 1
  }
}

/**
 * 盖住聊天区的全局遮罩打开。引用计数：嵌套弹窗各 begin 一次。
 * 原生 HWND 压不过 CSS，只能先藏起来。
 */
export function beginGlobalOverlay(reason = 'overlay') {
  overlayDepth += 1
  syncNativeEmbed(`overlay:${reason}:begin`)
}

/** 与 beginGlobalOverlay 成对。depth 不会掉到 0 以下。 */
export function endGlobalOverlay(reason = 'overlay') {
  if (overlayDepth <= 0) {
    overlayDepth = 0
    return
  }
  overlayDepth -= 1
  syncNativeEmbed(`overlay:${reason}:end`)
}

function slotReportKey(id: string, slot: EmbedSlot): string {
  return `${id}:${slot.x},${slot.y},${slot.width}x${slot.height}:${slot.viewportWidth || 0}x${slot.viewportHeight || 0}`
}

/** 贴位成功后若队列里仍是同一矩形（rAF 重复上报），丢掉以免 worker 永不收工。 */
function dropQueuedIfSameAs(id: string, key: string) {
  const q = slotReportQueued
  if (!q) return
  if (q.id === id && slotReportKey(q.id, q.slot) === key) {
    slotReportQueued = null
  }
}

async function applyEmbedSlotJob(job: SlotReportJob): Promise<boolean> {
  const { id, slot, force, epoch } = job
  const key = slotReportKey(id, slot)
  const stillFront = () =>
    epoch === embedGateEpoch && id === visibleStageId && overlayDepth === 0
  if (!stillFront()) {
    lastReportedSlotKey = ''
    return false
  }
  if (!force && key === lastReportedSlotKey) {
    dropQueuedIfSameAs(id, key)
    return true
  }
  lastReportedSlotKey = key
  const applied = await browserEmbedSetBounds({
    threadId: NATIVE_EMBED_THREAD_ID,
    ...slot,
    present: true,
  })
  if (!stillFront()) {
    lastReportedSlotKey = ''
    return false
  }
  // 排队期间又来了更新槽位：
  // - 同一矩形：rAF/RO 重复投递 → 丢弃，本拍算成功（否则 Promise 永不 resolve，lastKey 锁不上，set_bounds 打满）。
  // - 不同矩形：作废本拍结果，外层 loop 贴最新。
  if (slotReportQueued) {
    const qKey = slotReportKey(slotReportQueued.id, slotReportQueued.slot)
    if (slotReportQueued.id === id && qKey === key) {
      slotReportQueued = null
      if (applied) return true
    } else {
      lastReportedSlotKey = ''
      return false
    }
  }
  if (applied) return true
  // 失败后允许立刻重试，不要被上一次 key 卡住。
  // （含：最大化 Moved 把 set_bounds defer 后返回 false）
  lastReportedSlotKey = ''
  blog('warn', `[browser-embed-surface] set-bounds missed stage=${id} — retry`)
  await new Promise((r) => setTimeout(r, 250))
  if (!stillFront()) return false
  dropQueuedIfSameAs(id, key)
  if (slotReportQueued) return false
  const retried = await browserEmbedSetBounds({
    threadId: NATIVE_EMBED_THREAD_ID,
    ...slot,
    present: true,
  })
  if (!stillFront()) {
    lastReportedSlotKey = ''
    return false
  }
  dropQueuedIfSameAs(id, key)
  if (slotReportQueued) {
    lastReportedSlotKey = ''
    return false
  }
  if (retried) {
    lastReportedSlotKey = key
    return true
  }
  // Soft-decouple: do NOT recreate here. Panel place failures must not tear
  // down the agent WebView (that made backend navigate/settle fail). Next
  // panel-mount / ensureNativeEmbed can place the existing HWND.
  blog(
    'warn',
    `[browser-embed-surface] set-bounds still missing stage=${id} — leave agent window alone`,
  )
  return false
}

/**
 * 槽位布局变了。只有这个 stageId 正是前台浏览器页且无全局遮罩时才贴位。
 * 窗口若已销毁（park/崩溃后），改走 ensure 重建，避免右侧空白。
 */
export function reportEmbedSlot(
  stageId: string,
  slot: EmbedSlot,
  opts?: { url?: string; force?: boolean },
): Promise<boolean> {
  const id = String(stageId || '').trim()
  if (!id || id !== visibleStageId || overlayDepth > 0) return Promise.resolve(false)
  slotReportQueued = {
    id,
    slot: { ...slot },
    force: Boolean(opts?.force),
    epoch: embedGateEpoch,
  }
  // 已有 worker：只覆盖队列为最新槽位，共用同一 Promise（最终贴的是最后一次）。
  if (slotReportInflight) return slotReportInflight
  slotReportInflight = (async () => {
    let ok = false
    try {
      // await 期间新来的槽位写进 queued；每轮只取最新一条，丢弃中间态。
      while (slotReportQueued) {
        const next = slotReportQueued
        slotReportQueued = null
        ok = await applyEmbedSlotJob(next)
      }
      return ok
    } finally {
      slotReportInflight = null
    }
  })()
  return slotReportInflight
}

/** 右栏还没量到槽位时的占位矩形。只用于把窗口建出来，不会在非浏览器页上显示。 */
export function estimateEmbedSlot(): EmbedSlot {
  const iw = window.innerWidth || 1280
  const ih = window.innerHeight || 800
  const width = Math.max(480, Math.floor(iw * 0.45))
  const height = Math.max(360, Math.floor(ih - 96))
  return {
    x: Math.max(0, Math.floor(iw - width - 12)),
    y: 64,
    width,
    height,
    viewportWidth: iw,
    viewportHeight: ih,
  }
}

function slotFor(_stageId: string | undefined, slot: EmbedSlot | null | undefined): EmbedSlot {
  if (slot && slot.width >= 8 && slot.height >= 8) return slot
  return estimateEmbedSlot()
}

/** Coalesce storm: early+boot+chat-app+panel-mount+navigate all fire within ~100ms. */
let ensureInflight: Promise<BrowserEmbedInfo | null> | null = null
let ensureInflightKey = ''
let ensureLastKey = ''
let ensureLastAt = 0
let ensureLastInfo: BrowserEmbedInfo | null = null
const ENSURE_RECENT_MS = 750

/**
 * 创建或导航那一扇原生窗。
 * 前台就是这个浏览器页且无全局遮罩：按槽位显示。
 * 否则只保证窗口存在（给 CDP），并保持隐藏。
 *
 * 重要：没有实测槽位时绝不能用 estimateEmbedSlot 当「前台贴位」——
 * 估算矩形在右上角 y≈64，会盖住标签条标题，再与真实槽位来回抢 → 抖动。
 */
export async function ensureNativeEmbed(opts: {
  url?: string
  slot?: EmbedSlot | null
  stageId?: string
  reason: string
  /** 切签时 true：location.replace，不往共用 history 压栈。 */
  replace?: boolean
  /**
   * 后台会话导航：只保证 HWND/CDP 可用，绝不贴到当前 UI 右栏。
   * （多会话共用 primary id 时，否则会误判 present=true。）
   */
  forceHidden?: boolean
  /**
   * Soft-decouple: place/show HWND without navigating (agent already drove CDP).
   * Mount / early / boot should prefer this when the label exists.
   */
  placeOnly?: boolean
}): Promise<BrowserEmbedInfo | null> {
  const stageId = String(opts.stageId || '').trim()
  const forceHidden = opts.forceHidden === true || opts.reason === 'background-session'
  const uiSk = getCurrentRightStageSessionKey()
  const ownerSk = getBridgeOwnerSessionKey()
  const foreignOwner =
    Boolean(ownerSk && uiSk && ownerSk !== uiSk) &&
    !shouldSurfaceBrowserOnXiaomiVoiceUi(ownerSk)
  const present =
    !forceHidden &&
    !foreignOwner &&
    overlayDepth === 0 &&
    Boolean(desiredStageId) &&
    (!stageId || stageId === desiredStageId)
  const hasRealSlot = Boolean(opts.slot && opts.slot.width >= 8 && opts.slot.height >= 8)
  const slot = slotFor(stageId, opts.slot)
  // 只有「该显示 + 有真实槽位」才贴位显影；否则 managed-only（导航但不挪窗）。
  const placeNow = present && hasRealSlot
  // chrome-error:// 等内部页绝不能再 upsert，否则死循环刷错误页。
  const rawUrl = String(opts.url || '').trim()
  const placeOnly = opts.placeOnly === true
  const navUrl =
    placeOnly || !rawUrl
      ? ''
      : isNavigableBrowserUrl(rawUrl)
        ? sanitizeBrowserPageUrl(rawUrl)
        : ''
  if (rawUrl && !placeOnly && !navUrl) {
    blog('warn', `[browser-embed-surface] ensure skip bad url reason=${opts.reason} url=${rawUrl}`)
  }
  // Key includes placeNow so managed-only storms collapse, but a later real-slot
  // place is still allowed to run (different key).
  const coalesceKey = `${navUrl || ''}|p=${placeNow ? 1 : 0}|h=${forceHidden ? 1 : 0}|r=${opts.replace ? 1 : 0}|o=${placeOnly ? 1 : 0}`
  const now = Date.now()
  if (ensureInflight && ensureInflightKey === coalesceKey) {
    blog(
      'info',
      `[browser-embed-surface] ensure coalesce-inflight reason=${opts.reason} key=${coalesceKey}`,
    )
    return ensureInflight
  }
  if (
    ensureLastKey === coalesceKey &&
    now - ensureLastAt < ENSURE_RECENT_MS &&
    ensureLastInfo
  ) {
    blog(
      'info',
      `[browser-embed-surface] ensure coalesce-recent reason=${opts.reason} age=${now - ensureLastAt}ms`,
    )
    return ensureLastInfo
  }

  blog(
    'info',
    `[browser-embed-surface] ensure reason=${opts.reason} present=${present} place=${placeNow} ` +
      `placeOnly=${placeOnly} forceHidden=${forceHidden} foreignOwner=${foreignOwner} stage=${stageId || '(any)'} ` +
      `visible=${visibleStageId || '(none)'} overlay=${overlayDepth} ui=${uiSk || '(none)'} owner=${ownerSk || '(none)'}`,
  )
  // Foreign UI session opening its own stage must not yank the owner's page.
  // Agent paths (background / early / boot) may still upsert+park for CDP.
  const agentDrive =
    forceHidden ||
    opts.reason === 'background-session' ||
    opts.reason === 'early' ||
    opts.reason === 'boot'
  if (foreignOwner && !agentDrive) {
    void browserEmbedPark(NATIVE_EMBED_THREAD_ID)
    return null
  }

  ensureInflightKey = coalesceKey
  ensureInflight = (async () => {
    const info = await browserEmbedUpsert({
      threadId: NATIVE_EMBED_THREAD_ID,
      url: navUrl || undefined,
      ...slot,
      respectManagedBounds: !placeNow,
      // 切签/新标签：replace 进历史，避免单 HWND 多标签把后退栈串成「抖音↔百度」。
      replaceUrl: opts.replace === true,
    })
    // 只有「不该显示」才 park。前台缺槽位时绝不能 park——会和随后的
    // reportEmbedSlot/set_bounds 竞态，窗口被藏死后 lastReportedSlotKey 还挡重试。
    if (!present) void browserEmbedPark(NATIVE_EMBED_THREAD_ID)
    return info
  })()

  try {
    const info = await ensureInflight
    ensureLastKey = coalesceKey
    ensureLastAt = Date.now()
    ensureLastInfo = info
    return info
  } finally {
    if (ensureInflightKey === coalesceKey) {
      ensureInflight = null
      ensureInflightKey = ''
    }
  }
}

rightStageStore.subscribe(() => {
  syncNativeEmbed('right-stage')
})
syncNativeEmbed('boot')

/**
 * 和右栏菜单同一关系：HTML 层出现就藏 HWND，消失再贴回。
 * 工具详情等 `.react-chat-modal-overlay` 不用各自记得调用 begin/end。
 */
const ABOVE_NATIVE_SELECTOR =
  '.react-chat-modal-overlay, .chat-lightbox, [data-above-native-embed]'

function nodeHostsAboveNative(node: Node): boolean {
  if (!(node instanceof Element)) return false
  if (node.matches(ABOVE_NATIVE_SELECTOR)) return true
  return Boolean(node.querySelector(ABOVE_NATIVE_SELECTOR))
}

function installHtmlAboveNativeGate() {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
  const tracked = new Set<Element>()
  let raf = 0
  const reconcile = () => {
    raf = 0
    const live = new Set(document.querySelectorAll(ABOVE_NATIVE_SELECTOR))
    for (const el of tracked) {
      if (live.has(el)) continue
      tracked.delete(el)
      endGlobalOverlay('html-above-native')
    }
    for (const el of live) {
      if (tracked.has(el)) continue
      tracked.add(el)
      beginGlobalOverlay('html-above-native')
    }
  }
  const schedule = () => {
    if (raf) return
    raf = requestAnimationFrame(reconcile)
  }
  const mo = new MutationObserver((records) => {
    let sawAdd = false
    let sawRemove = false
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (nodeHostsAboveNative(node)) {
          sawAdd = true
          break
        }
      }
      if (sawAdd) break
      for (const node of record.removedNodes) {
        if (nodeHostsAboveNative(node)) {
          sawRemove = true
          break
        }
      }
      if (sawRemove) break
    }
    // Park synchronously on open so the native HWND yields before the first
    // paint of the dropdown (model picker etc.); defer closes to rAF to batch.
    if (sawAdd) {
      if (raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
      reconcile()
      return
    }
    if (sawRemove) schedule()
  })
  const start = () => {
    if (!document.body) return
    mo.observe(document.body, { childList: true, subtree: true })
    schedule()
  }
  if (document.body) start()
  else document.addEventListener('DOMContentLoaded', start, { once: true })
}

installHtmlAboveNativeGate()
