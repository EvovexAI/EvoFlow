/**
 * 会话子工作实时面板 → 右栏 tab（完全访问旁图标点击）。
 */
import { rightStageStore } from './right-stage-store.js'
import type { SessionChildWorkItem } from '../../react/lib/session-reattach.js'

export const SESSION_RUNTIME_KIND = 'sessionRuntime'

export type OpenSessionRuntimeStageOpts = {
  sessionKey?: string | null
  works?: SessionChildWorkItem[]
  focusKind?: string | null
  forceExpand?: boolean
}

export function sessionRuntimeStageTabId(sessionKey?: string | null): string {
  const sk = String(sessionKey || '').trim() || 'unknown'
  return `sessionRuntime:${sk}`
}

export function openSessionRuntimeInRightStage(opts?: OpenSessionRuntimeStageOpts): string {
  const sk = String(opts?.sessionKey || '').trim()
  if (!sk) return ''
  const id = sessionRuntimeStageTabId(sk)
  rightStageStore.show({
    kind: SESSION_RUNTIME_KIND,
    id,
    title: '运行中',
    layout: 'narrow',
    sessionKey: sk,
    forceExpand: opts?.forceExpand !== false,
    data: {
      sessionKey: sk,
      focusKind: String(opts?.focusKind || '').trim(),
      works: Array.isArray(opts?.works) ? opts!.works : [],
    },
  })
  return id
}
