/**
 * ChatApp.tsx module-顶层 helper 集合（v3.5 阶段 F2 commit 1 抽出）。
 *
 * 主题：**session-busy** —— session 维度的"忙/不忙"判断 + 路由重入时
 * 防止并发 createSession 重复请求的合并。
 */
import { isSessionWireActive } from '../../lib/session-execution/queries.js'

/**
 * 某 session key 当前是否正处于流式活跃态(wire 帧活跃)。
 * 包装 store 的 isSessionWireActive,语义不变,纯粹是 ChatApp.tsx 的本地别名。
 */
export function turnBusyForSession(sessionKey: string | null | undefined): boolean {
  return isSessionWireActive(sessionKey)
}

/** 路由未 cleanup 时可能残留多个 ChatApp；合并并发「新建会话」为一次 POST。 */
let globalCreateSessionInflight: Promise<string | null> | null = null

export function coalesceCreateSession(work: () => Promise<string | null>): Promise<string | null> {
  if (globalCreateSessionInflight) return globalCreateSessionInflight
  globalCreateSessionInflight = work().finally(() => {
    globalCreateSessionInflight = null
  })
  return globalCreateSessionInflight
}

/**
 * 暴露给 ChatApp.tsx 读正在 inflight 的"新建会话" Promise。
 * 用于 handleSendMessage 时若 pendingNewSessionRef + 此 Promise 同时存在,
 * 等待 inflight 结束再继续(避免快速双击 + ChatApp 单例多挂时双 POST)。
 */
export function getGlobalCreateSessionInflight(): Promise<string | null> | null {
  return globalCreateSessionInflight
}
