/** Browser panel runtime state — module-level store shared by AG-UI hooks and the panel UI.
 *
 * Fed by browser tool-call events (see browser-panel-agui.ts) and consumed by
 * BrowserPanel.tsx via useSyncExternalStore. Also owns auto-showing the browser
 * right-stage surface when the agent opens a page.
 */

import { parseBrowserLiveToolOutput } from './chat-normalize.js'
import { rightStageStore, hideRightStageIfKind } from './right-stage/right-stage-store.js'
import type { BrowserStreamFrameMetadata } from './browser-stream-client.js'

export type BrowserPanelMode = 'headed' | 'cdp' | 'headless' | 'embed'

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
}

const EMPTY: BrowserRuntimeState = {
  pageUrl: '',
  streamThreadId: '',
  sharedBrowser: false,
  operating: false,
  operatingAction: '',
  operatingToolCallId: '',
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

export function extractThreadIdFromStreamPath(streamWs: string): string {
  const raw = String(streamWs || '').trim()
  if (!raw) return ''
  const match = raw.match(/\/api\/threads\/([^/]+)\/browser-stream/i)
  if (!match?.[1]) return ''
  try {
    return decodeURIComponent(match[1]) || ''
  } catch {
    return match[1]
  }
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

/** User-initiated close (panel X button). */
export function closeBrowserStage() {
  hideRightStageIfKind('browser')
}

export function notifyBrowserToolStart(toolCallId: string, argsText?: string | null): boolean {
  const action = parseBrowserToolAction(argsText)
  patch({
    operating: true,
    operatingAction: action,
    operatingToolCallId: String(toolCallId || '').trim(),
  })
  return true
}

export function notifyBrowserToolResult(toolCallId: string, resultText?: string | null): boolean {
  const live = parseBrowserLiveToolOutput(resultText)
  const next: Partial<BrowserRuntimeState> = {
    operating: state.operatingToolCallId === String(toolCallId || '').trim() ? false : state.operating,
  }
  if (live) {
    const tid = extractThreadIdFromStreamPath(String((live as { streamWs?: string }).streamWs || ''))
    if (tid) next.streamThreadId = tid
    const pageUrl = String((live as { pageUrl?: string }).pageUrl || '').trim()
    if (pageUrl) next.pageUrl = pageUrl
    const mode = String((live as { mode?: string }).mode || '').trim()
    if (mode === 'headed' || mode === 'cdp' || mode === 'headless' || mode === 'embed') {
      next.browserMode = mode
    }
    const headed = Boolean((live as { headed?: boolean | string }).headed)
    next.sharedBrowser = headed || mode === 'headed' || mode === 'cdp' || mode === 'embed'
    // Agent opened a page → bring the browser stage up (ZCode side-pane behavior).
    if (pageUrl || tid) ensureBrowserStage()
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
