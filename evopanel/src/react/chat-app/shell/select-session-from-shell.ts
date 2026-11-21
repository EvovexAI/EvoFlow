/**
 * Select a session from the shell sidebar list.
 * Extracted from ChatApp.tsx (P50).
 */
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { skTail, ssLog } from '../../../lib/session-list-debug.js'
import { logV4Life, markV4OpenTrace } from '../../lib/v4-lifecycle-log.js'
import { logChatRuntimeUserClick } from '../../lib/chat-runtime-log.js'
import { beginOpenTrace } from '@zcode/ui/lib/openTrace.js'

export type SelectSessionFromShellCtx = {
  sessionRef: MutableRefObject<string>
  setShellSelectRevision: Dispatch<SetStateAction<number>>
  setNewChatButtonActive: (v: boolean) => void
  setMoreMenuKey: Dispatch<SetStateAction<string | null>>
  setSelectedSessionKey: (key: string) => void
  setMobileChatPane: (pane: 'list' | 'thread') => void
  /** 离开工作台仪表盘意图（点历史会话） */
  setPreferHomeDashboard?: (v: boolean) => void
  /** 与 preferHomeDashboard 同步；须在状态更新前写，避免 refresh 仍当首页把选中冲掉 */
  preferHomeDashboardRef?: MutableRefObject<boolean>
}

export function selectSessionFromShell(
  ctx: SelectSessionFromShellCtx,
  sessionKey: string,
): void {
  const k = String(sessionKey || '').trim()
  if (!k) return
  const from = String(ctx.sessionRef.current || '').trim()
  ssLog('shell.select', { key: skTail(k), from: skTail(from) })
  markV4OpenTrace({ sessionKey: k })
  // 全链路分段计时锚点：从这一行起，后续每个阶段都会打「+Nms / 本步耗时」。
  beginOpenTrace(k)
  logV4Life({
    event: 'session_click',
    sessionKey: k,
    zh: `用户点击侧栏会话，开始打开历史。session=${k}${from && from !== k ? `（从 ${from} 切过来）` : ''}（计时锚点已打，后续看 sinceClickMs）`,
    detail: { from: from || null },
    skipDedupe: true,
  })
  logChatRuntimeUserClick({
    action: 'session_switch',
    whoZh: from && from !== k
      ? `用户点击侧栏切换会话（${skTail(from)} → ${skTail(k)}）`
      : `用户点击侧栏打开会话（${skTail(k)}）`,
    sessionKey: k,
    detail: { from: from || null },
  })
  ctx.setShellSelectRevision((r) => r + 1)
  try {
    sessionStorage.removeItem('evopanel_pending_shell_session')
    // 仅保留「当前正打开的 mint 空草稿」标记；切到其它会话就清掉，避免误居中。
    const emptyDraft = sessionStorage.getItem('evopanel_shell_empty_draft')
    if (emptyDraft && emptyDraft !== k) {
      sessionStorage.removeItem('evopanel_shell_empty_draft')
    }
  } catch {
    /* ignore */
  }
  // 同步离开工作台意图，再落 sessionKey（部门群聊不在 sessions 列表里，靠这个防 refresh 回填）
  if (ctx.preferHomeDashboardRef) ctx.preferHomeDashboardRef.current = false
  ctx.sessionRef.current = k
  // 对齐 ZCode：切换是异步 commit + 门控（snapshot.sessionId / V4 lease generation）防串屏，
  // 不再 flushSync 同步渲染整个 ChatApp 控制器树（点击主线程阻塞的第一元凶）。
  // React 18 离散事件内的 setState 仍在同一帧绘制前提交，观感不变；sessionRef/preferHomeDashboardRef
  // 两个同步 ref 已覆盖「commit 前被同步读取」的场景（run-session-switch-layout 等 layout effect）。
  ctx.setPreferHomeDashboard?.(false)
  ctx.setNewChatButtonActive(false)
  ctx.setMoreMenuKey(null)
  ctx.setSelectedSessionKey(k)
  if (typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches) {
    ctx.setMobileChatPane('thread')
  }
}
