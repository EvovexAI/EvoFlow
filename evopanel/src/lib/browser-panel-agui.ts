import { parseBrowserLiveToolOutput } from './chat-normalize.js'
import { buildBrowserStreamPath } from './browser-stream-client.js'
import {
  ensureBrowserStage,
  notifyBrowserToolEnd,
  notifyBrowserToolResult,
  notifyBrowserToolStart,
} from './browser-panel-store.js'
import type { BrowserPanelState } from './browser-panel-screenshots.js'

export function isBrowserToolWireName(name: string): boolean {
  const n = String(name || '').trim().toLowerCase()
  return n === 'browser' || n.startsWith('browser_') || n === 'preview_url'
}

export type BrowserPanelPreview = {
  pageUrl?: string
  liveStreamUrl?: string
  browserMode?: 'evopanel' | 'headed' | 'cdp' | 'headless' | 'embed'
  sharedBrowser?: boolean
}

export type BrowserAgUiToolCall = {
  toolCallId: string
  toolCallName: string
  argsText?: string
  result?: string | null
}

export function browserPanelPreviewWithThread(
  preview: BrowserPanelPreview | null | undefined,
  threadId?: string,
): BrowserPanelPreview | null {
  const tid = String(threadId || '').trim()
  const merged: BrowserPanelPreview = { ...(preview || {}) }
  if (tid && !merged.liveStreamUrl) {
    merged.liveStreamUrl = buildBrowserStreamPath(tid)
  }
  return merged.pageUrl || merged.liveStreamUrl ? merged : tid ? { liveStreamUrl: buildBrowserStreamPath(tid) } : null
}

export function previewPatchFromBrowserAgUiTool(
  tc: BrowserAgUiToolCall | null | undefined,
  threadId?: string,
): BrowserPanelPreview | null {
  if (!tc) return browserPanelPreviewWithThread(null, threadId)
  const out: BrowserPanelPreview = {}
  const argsText = String(tc.argsText || '').trim()
  if (argsText) {
    try {
      const args = JSON.parse(argsText) as { action?: string; url?: string }
      const action = String(args?.action || '').trim().toLowerCase()
      const url = String(args?.url || '').trim()
      if (action === 'open' && url) out.pageUrl = url
    } catch {
      const urlMatch = argsText.match(/"url"\s*:\s*"([^"]+)"/)
      if (urlMatch?.[1]) out.pageUrl = urlMatch[1]
    }
  }
  const tid = String(threadId || '').trim()
  if (tid) out.liveStreamUrl = buildBrowserStreamPath(tid)
  if (tc.result) {
    const live = parseBrowserLiveToolOutput(tc.result)
    if (live?.streamWs) {
      out.liveStreamUrl = live.streamWs
      if (live.pageUrl) out.pageUrl = live.pageUrl
      if (live?.mode === 'evopanel' || live?.mode === 'headed' || live?.mode === 'cdp' || live?.mode === 'headless' || live?.mode === 'embed') {
        out.browserMode = live.mode
      }
      if (live?.headed || live?.mode === 'headed' || live?.mode === 'cdp' || live?.mode === 'embed') {
        out.sharedBrowser = true
      }
    }
  }
  return browserPanelPreviewWithThread(out, threadId)
}

export function mergeBrowserPanelState(
  base: BrowserPanelState,
  preview: BrowserPanelPreview | null | undefined,
): BrowserPanelState {
  if (!preview) return base
  return {
    ...base,
    pageUrl: preview.pageUrl || base.pageUrl,
    liveStreamUrl: preview.liveStreamUrl || base.liveStreamUrl,
    browserMode: preview.browserMode || base.browserMode,
    sharedBrowser: preview.sharedBrowser ?? base.sharedBrowser,
    activityCount: Math.max(base.activityCount, 1),
  }
}

export type BrowserPanelAgUiEvent = {
  type?: string
  toolCallId?: string
  toolCallName?: string
}

export function shouldOpenBrowserPanelForAgUiEvent(
  event: BrowserPanelAgUiEvent,
  toolName: string,
): boolean {
  const t = String(event.type || '')
  if (!isBrowserToolWireName(toolName)) return false
  return (
    t === 'TOOL_CALL_START' ||
    t === 'TOOL_CALL_ARGS' ||
    t === 'TOOL_CALL_END' ||
    t === 'TOOL_CALL_RESULT'
  )
}

export function resolveBrowserToolNameFromAgUiEvent(
  event: BrowserPanelAgUiEvent,
  toolCalls?: Map<string, BrowserAgUiToolCall> | null,
): string {
  const t = String(event.type || '')
  if (t === 'TOOL_CALL_START') {
    return String(event.toolCallName || '').trim().toLowerCase()
  }
  const toolCallId = String(event.toolCallId || '').trim()
  if (!toolCallId || !toolCalls) return ''
  return String(toolCalls.get(toolCallId)?.toolCallName || '').trim().toLowerCase()
}

export function browserToolActionFromAgUiTool(
  tc: BrowserAgUiToolCall | null | undefined,
): string {
  const argsText = String(tc?.argsText || '').trim()
  if (!argsText) return ''
  try {
    const args = JSON.parse(argsText) as { action?: string }
    return String(args?.action || '').trim().toLowerCase()
  } catch {
    const match = argsText.match(/"action"\s*:\s*"([^"]+)"/i)
    return String(match?.[1] || '').trim().toLowerCase()
  }
}

export function shouldRefreshBrowserStreamAfterAction(action: string): boolean {
  const act = String(action || '').trim().toLowerCase()
  // Only screenshot reliably kills screencast — backend handles other actions.
  return act === 'screenshot'
}

/** Feed one AG-UI tool-call event into the browser panel runtime store.
 *
 * Returns true when the event belonged to a browser tool (caller marks stream changed).
 */
export function syncBrowserPanelFromAgUiEvent(
  aguiEvent: BrowserPanelAgUiEvent,
  toolCalls?: Map<string, BrowserAgUiToolCall> | null,
): boolean {
  const toolName = resolveBrowserToolNameFromAgUiEvent(aguiEvent, toolCalls)
  if (!isBrowserToolWireName(toolName)) return false
  const type = String(aguiEvent.type || '').toUpperCase()
  const toolCallId = String(aguiEvent.toolCallId || '').trim()
  const tc = toolCallId ? toolCalls?.get(toolCallId) : undefined
  if (type === 'TOOL_CALL_START' || type === 'TOOL_CALL_ARGS') {
    return notifyBrowserToolStart(toolCallId, tc?.argsText)
  }
  if (type === 'TOOL_CALL_RESULT') {
    const result =
      typeof tc?.result === 'string'
        ? tc.result
        : typeof (aguiEvent as { content?: string }).content === 'string'
          ? (aguiEvent as { content?: string }).content
          : null
    const changed = notifyBrowserToolResult(toolCallId, result)
    notifyBrowserToolEnd(toolCallId)
    // AG-UI can deliver TOOL_CALL_RESULT before the reducer has stored
    // ``tc.result`` on the map entry. Re-read once on the next microtask so the
    // live metadata (stream_ws / page_url) is not lost.
    if (!result && toolCalls) {
      queueMicrotask(() => {
        const late = toolCalls.get(toolCallId)
        const lateResult = typeof late?.result === 'string' ? late.result : null
        if (lateResult) {
          notifyBrowserToolResult(toolCallId, lateResult)
          ensureBrowserStage()
        }
      })
    }
    return changed
  }
  if (type === 'TOOL_CALL_END') {
    notifyBrowserToolEnd(toolCallId)
    return true
  }
  return false
}
