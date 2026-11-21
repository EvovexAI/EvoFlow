/**
 * 员工面板「发送该用哪个会话」的判据。
 *
 * 【self-evolution-bot · 2026-11-21 · 第111轮 · 模型:deepseek-v4.1-flash-1017】
 * 为什么单独抽出来：这段判据原来内联在 v4-employee-process-pane 的 resolveSendSessionKey 里，
 *   测试只能复制一份等价逻辑，结果「禁用护栏测试依然全绿」——测的是测试自己，不是源码。
 *
 * 现网事故（2026-11-21 19:40 真机实证）：
 *   同时给个人助理 + 审核员发消息。个人助理正常；审核员面板毫无反应。
 *   查库发现审核员**其实收到并回答了**，只是落点错了：
 *     thread 517144f5 / `proactive:reviewer:task:2611202007_de39`
 *       19:40:28 user「只说一句：你的岗位叫什么？不超过10个字。」
 *       19:40:31 assistant「审核员」
 *   而面板显示的是 `proactive:reviewer:chat:dept-e52862be9e71`（thread ce27a8d1，
 *   只有 3 条、停在昨天 20:07）。
 *   根因：panel surface 带着昨天任务的 taskId → pickProactiveConversationSessionKey 的
 *   taskId 分支（kind==='task'）排在最前 → 面板绑定 task 会话 → 对话消息写进任务时间线。
 *   更坏：后端回执的 session_key 是调用方传的 chat key，看起来完全正确，纯属误导。
 *
 * 判据：对话发送只能用非 task 会话；判据只看 session_key 形状，不依赖调用方传参。
 */

/** 会话键是否指向「任务时间线」—— 任务时间线里的消息不会出现在员工对话面板。 */
export function isTaskTimelineSessionKey(sessionKey: unknown): boolean {
  const s = String(sessionKey ?? '').trim()
  if (!s) return false
  // 只认 `:task:` 这一整段，避免把 code/hash 里含 task 字样的 chat 会话误判
  return /:task:/.test(s)
}

/**
 * 决定发送时实际使用的会话键。
 * @returns `{ sk, switchedFrom }`：switchedFrom 非空表示原会话被拒、已改用 fallback。
 */
export function resolveSendSessionKeyForChat(opts: {
  candidate: string
  fallback: string
}): { sk: string; switchedFrom: string } {
  const candidate = String(opts.candidate ?? '').trim()
  const fallback = String(opts.fallback ?? '').trim()
  if (!isTaskTimelineSessionKey(candidate)) return { sk: candidate, switchedFrom: '' }
  return { sk: fallback, switchedFrom: candidate }
}
