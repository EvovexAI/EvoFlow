/** Browser panel runtime state — module-level store shared by AG-UI hooks and the panel UI.
 *
 * Fed by browser tool-call events (see browser-panel-agui.ts) and consumed by
 * BrowserPanel.tsx via useSyncExternalStore. Also owns auto-showing the browser
 * right-stage surface when the agent opens a page.
 */

import { parseBrowserLiveToolOutput } from './chat-normalize.js'
import { rightStageStore, hideRightStageIfKind } from './right-stage/right-stage-store.js'
import type { BrowserStreamFrameMetadata } from './browser-stream-client.js'
import type { BrowserTabSummary } from './browser-viewport-client.js'
import { dbgLog, dbgWarn } from './browser-debug-log.js'

export type BrowserPanelMode = 'evopanel' | 'headed' | 'cdp' | 'headless' | 'embed'

export type BrowserRuntimeState = {
  pageUrl: string
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
}

const EMPTY: BrowserRuntimeState = {
  pageUrl: '',
  streamThreadId: '',
  sharedBrowser: false,
  operating: false,
  operatingAction: '',
  operatingToolCallId: '',
  tabs: [],
}

let state: BrowserRuntimeState = { ...EMPTY }
const listeners = new Set<() => void>()

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

/** Show the browser right-stage surface (keeps existing data if already open). */
export function ensureBrowserStage() {
  const surface = rightStageStore.getSnapshot().surface
  if (surface?.kind === 'browser') {
    rightStageStore.applyRemote({
      action: 'update',
      surface: { id: 'primary', kind: 'browser', title: '浏览器', layout: 'wide', data: {} },
    })
    return
  }
  rightStageStore.applyRemote({
    action: 'show',
    surface: { id: 'primary', kind: 'browser', title: '浏览器', layout: 'wide', data: {} },
  })
}

/** 引擎标签页列表写入（面板轮询 tabList 后调用）。 */
export function setBrowserTabs(tabs: BrowserTabSummary[]) {
  patch({ tabs: Array.isArray(tabs) ? tabs : [] })
}

/** User-initiated close (panel X button). */
export function closeBrowserStage() {
  hideRightStageIfKind('browser')
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

export function notifyBrowserToolStart(toolCallId: string, argsText?: string | null): boolean {
  const action = parseBrowserToolAction(argsText)
  dbgLog(`[browser-panel-store] tool start toolCallId=${toolCallId} action=${action} argsText=${argsText || ''}`)
  patch({
    operating: true,
    operatingAction: action,
    operatingToolCallId: String(toolCallId || '').trim(),
  })
  // For page-opening actions, raise the right stage *before* the result
  // arrives so the user can see the live panel mount and the screencast
  // connect while the agent is still working. The result event then
  // patches the page URL on top.
  if (action === 'open' || action === 'navigate' || action === 'snapshot') {
    ensureBrowserStage()
  }
  return true
}

export function notifyBrowserToolResult(toolCallId: string, resultText?: string | null): boolean {
  const live = parseBrowserLiveToolOutput(resultText)
  const liveSummary = live
    ? { mode: live.mode, pageUrl: live.pageUrl, streamWs: live.streamWs, headed: live.headed }
    : null
  dbgLog(
    `[browser-panel-store] tool result toolCallId=${toolCallId} live=${JSON.stringify(liveSummary)} raw=${(resultText || '').slice(0, 160)}`,
  )
  if (resultText && !live) {
    dbgWarn(`[browser-panel-store] live parse returned null for toolCallId=${toolCallId}`)
  }
  const next: Partial<BrowserRuntimeState> = {
    operating: state.operatingToolCallId === String(toolCallId || '').trim() ? false : state.operating,
  }
  if (live) {
    const backendTid = extractThreadIdFromStreamPath(
      String((live as { streamWs?: string }).streamWs || ''),
    )
    if (backendTid) {
      next.streamThreadId = backendTid
    } else {
      dbgWarn(
        `[browser-panel-store] backend streamWs=${String((live as { streamWs?: string }).streamWs || '')} has placeholder thread — keeping real threadId=${state.streamThreadId || '(empty)'}`,
      )
    }
    const pageUrl = String((live as { pageUrl?: string }).pageUrl || '').trim()
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
    if (mode === 'evopanel') next.sharedBrowser = false
    // Agent opened a page → bring the browser stage up (ZCode side-pane behavior).
    if (pageUrl || backendTid) ensureBrowserStage()
  }
  patch(next)
  return Boolean(live)
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

function parseBrowserToolAction(argsText?: string | null): string {
  const raw = String(argsText || '').trim()
  if (!raw) return ''
  try {
    const args = JSON.parse(raw) as { action?: string }
    return String(args?.action || '').trim().toLowerCase()
  } catch {
    const match = raw.match(/"action"\s*:\s*"([^"]+)"/i)
    return String(match?.[1] || '').trim().toLowerCase()
  }
}
