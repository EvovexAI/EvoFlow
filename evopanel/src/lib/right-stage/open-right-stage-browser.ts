/**
 * 对话预览卡「网站」→ 右侧浏览器侧栏（对齐 ZCode onOpenBrowserUrl）。
 *
 * 主按钮「打开」走本入口；下拉「在系统浏览器中打开」仍由 OpenSplitButton → platform.openExternal。
 *
 * 必须绑定 streamThreadId：工具栏刷新/后退走 `/browser-command`，没有 tid 时按钮可点但空操作。
 * 与手动打开浏览器侧栏（toggle-browser-stage）同一约定——优先真实会话 thread，否则桥 id。
 */
import {
  ensureBrowserStage,
  markUserNavigateIntent,
  NODE_REPL_BRIDGE_THREAD_ID,
  setBrowserPanelThreadId,
} from '../browser-panel-store.js'
import { isNavigableBrowserUrl, sanitizeBrowserPageUrl } from '../browser-page-url.js'
import { blogTimeline } from '../browser-unified-log.js'

export type OpenRightStageBrowserOpts = {
  sessionKey?: string | null
  /** 当前聊天会话的 engine thread id（用于工具栏 CDP 刷新/导航鉴权）。 */
  threadId?: string | null
}

/** 打开/激活右侧浏览器标签并导航到 url（localhost / file:// HTML / 公网均可）。 */
export function showRightStageBrowserUrl(
  url: string,
  opts?: OpenRightStageBrowserOpts,
): void {
  const raw = String(url || '').trim()
  const pageUrl = sanitizeBrowserPageUrl(raw)
  if (!pageUrl || !isNavigableBrowserUrl(pageUrl)) {
    if (typeof window !== 'undefined' && raw) {
      window.open(raw, '_blank', 'noopener,noreferrer')
    }
    return
  }

  const sessionKey = String(opts?.sessionKey || '').trim() || undefined
  const threadId =
    String(opts?.threadId || '').trim() || NODE_REPL_BRIDGE_THREAD_ID
  setBrowserPanelThreadId(threadId)
  blogTimeline(
    '侧栏打开',
    `来源=预览卡 会话=${sessionKey || '(无)'} 线程=${threadId} 链接=${pageUrl}`,
  )
  markUserNavigateIntent(pageUrl)
  ensureBrowserStage({
    sessionKey,
    pageUrl,
    replacePageUrl: true,
  })
}
