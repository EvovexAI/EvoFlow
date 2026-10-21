import { parseBrowserLiveToolOutput } from './chat-normalize.js'
import { buildBrowserStreamPath } from './browser-stream-client.js'
import { blog } from './browser-unified-log.js'
import {
  ensureBrowserStage,
  NODE_REPL_BRIDGE_THREAD_ID,
  nodeReplArgsTouchBrowser,
  notifyBrowserToolEnd,
  notifyBrowserToolResult,
  notifyBrowserToolStart,
  setBrowserPanelThreadId,
} from './browser-panel-store.js'

export { NODE_REPL_BRIDGE_THREAD_ID }
import type { BrowserPanelState } from './browser-panel-screenshots.js'

export function isBrowserToolWireName(name: string): boolean {
  const n = String(name || '').trim().toLowerCase()
  if (n === 'browser' || n.startsWith('browser_') || n === 'preview_url') return true
  // ZCode 插件运行时内核工具：browser-use / computer-use 技能的唯一执行入口。
  // 面板不再随调用无条件展开——先按 code 里的浏览器 API 识别意图
  // （nodeReplArgsTouchBrowser），纯数据处理 JS 调用保持侧栏安静；
  // 漏判由后端 browser-panel-request（CDP 真驱动 WebView2 时必发）兜底。
  return n === 'mcp__node_repl__js'
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
      const args = JSON.parse(argsText) as { action?: string; url?: string; code?: string }
      const action = String(args?.action || '').trim().toLowerCase()
      const url = String(args?.url || '').trim()
      if (action === 'open' && url) out.pageUrl = url
      // node_repl 内核工具：从 js 代码里提取首个意图 URL（browsers.open / tabs.new / navigate）
      const code = String(args?.code || '')
      if (!out.pageUrl && code) {
        const openMatch = code.match(
          /(?:browsers\.open|tabs\.new|\.navigate|agent\.browsers\.open)\(\s*["'`]([^"'`]+)["'`]/,
        )
        if (openMatch?.[1]) out.pageUrl = openMatch[1]
      }
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
  opts?: { sessionKey?: string },
): boolean {
  const toolName = resolveBrowserToolNameFromAgUiEvent(aguiEvent, toolCalls)
  if (!isBrowserToolWireName(toolName)) return false
  const type = String(aguiEvent.type || '').toUpperCase()
  const toolCallId = String(aguiEvent.toolCallId || '').trim()
  const tc = toolCallId ? toolCalls?.get(toolCallId) : undefined
  const sessionKey = String(opts?.sessionKey || '').trim() || undefined
  // node_repl 只有代码真的触碰浏览器才展开面板；forceOpen 只留给真浏览器工具。
  const isNodeRepl = toolName === 'mcp__node_repl__js'
  const nodeReplBrowser = isNodeRepl && nodeReplArgsTouchBrowser(tc?.argsText)
  // 浏览器工具事件进统一日志（logs/plugin-control.log），与后端引擎/内核桥时间线对齐。
  blog(
    'info',
    `[tool] ${type} tool=${toolName} id=${toolCallId} session=${sessionKey || '(none)'}` +
      (tc?.argsText ? ` args=${String(tc.argsText).replace(/\s+/g, ' ').slice(0, 120)}` : ''),
  )
  // browser-use / node-repl always owns the shared bridge WebView2 session.
  if (toolName === 'mcp__node_repl__js') {
    setBrowserPanelThreadId(NODE_REPL_BRIDGE_THREAD_ID)
  }
  const openStage = () => {
    if (!isNodeRepl || nodeReplBrowser) ensureBrowserStage({ sessionKey })
  }
  if (type === 'TOOL_CALL_START' || type === 'TOOL_CALL_ARGS') {
    return notifyBrowserToolStart(toolCallId, tc?.argsText, {
      toolName,
      forceOpen: !isNodeRepl,
      sessionKey,
    })
  }
  if (type === 'TOOL_CALL_RESULT') {
    const result =
      typeof tc?.result === 'string'
        ? tc.result
        : typeof (aguiEvent as { content?: string }).content === 'string'
          ? (aguiEvent as { content?: string }).content
          : null
    blog('info', `[tool] result for id=${toolCallId}: ${String(result || '').replace(/\s+/g, ' ').slice(0, 200) || '(empty)'}`)
    // Keep the panel open for browser-driving calls even when the tool result is
    // not a browser_live JSON blob (node-repl returns JS stdout / structured SDK
    // results). Pure-JS node_repl results must not re-raise a closed panel.
    openStage()
    const changed = notifyBrowserToolResult(toolCallId, result, { nodeReplBrowser, sessionKey })
    notifyBrowserToolEnd(toolCallId)
    // AG-UI can deliver TOOL_CALL_RESULT before the reducer has stored
    // ``tc.result`` on the map entry. Re-read once on the next microtask so the
    // live metadata (stream_ws / page_url) is not lost.
    if (!result && toolCalls) {
      queueMicrotask(() => {
        const late = toolCalls.get(toolCallId)
        const lateResult = typeof late?.result === 'string' ? late.result : null
        if (lateResult) {
          notifyBrowserToolResult(toolCallId, lateResult, { nodeReplBrowser, sessionKey })
          openStage()
        }
      })
    }
    return changed || true
  }
  if (type === 'TOOL_CALL_END') {
    openStage()
    notifyBrowserToolEnd(toolCallId)
    return true
  }
  return false
}
