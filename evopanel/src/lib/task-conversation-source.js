/**
 * 任务详情的「对话」面板该读哪一条会话。
 *
 * 【self-evolution-bot · 2026-11-22 · 第125轮 · 模型:deepseek-v4.1-flash】
 * 改了什么：把 task-detail.js 里的选源判断抽成纯函数，供单测直接覆盖接线。
 * 为什么（用户「task 那个老是误导别人」+ 现网复算）：
 *   同一个任务页里，「续聊」按钮按 `proactive:{执行人}:task:{taskId}` 跳转，
 *   而「对话」面板却按 `task.thread_id` 读 —— 两处指向不同会话，页面自相矛盾。
 *   实测（2026-11-22 18:5x）：task 2611221757_60a8 的 thread_id=8bcaa342 里是
 *   case-fullstack-dev 的 28 条普通聊天，真正执行记录在 task 桶 5 条里。
 *   40 条带 thread_id 的任务中 16 条如此（thread 指向的不是 task 桶）。
 * 判据：执行会话有消息 → 用它；否则才回退 thread，且回退结果必须属于同一执行人，
 *   别人的对话一律不展示（宁可空着，也不张冠李戴）。
 * 边界：`agent:main`（主智能体主对话）属合理展示，不算他人对话。
 */

/** 员工任务会话 key：``proactive:{code}:task:{taskId}``（与 task-detail.js / 后端同口径） */
export function proactiveTaskSessionKey(agentCode, taskId) {
  const code = String(agentCode || '').trim()
  const tid = String(taskId || '')
    .trim()
    .replace(/[:/\\]/g, '-')
  if (!code || !tid) return ''
  return `proactive:${code}:task:${tid}`
}

/**
 * 这条回退会话是否属于该任务的执行人（不属他人）。
 * @param {string} sourceSessionKey 实际读到消息的会话键（后端 by-thread 回填）
 * @param {string} assignedTo 任务执行人
 */
export function isOwnTaskConversation(sourceSessionKey, assignedTo) {
  const sk = String(sourceSessionKey || '').trim()
  const agent = String(assignedTo || '').trim()
  if (!agent) return true // 没有归属信息就没有「别人的对话」可言
  if (!sk) return true // 后端没回填会话键 → 无从判定，按原行为展示
  if (sk.startsWith(`proactive:${agent}:`)) return true
  if (sk === 'agent:main' || sk.startsWith('agent:main:')) return true
  return false
}

/**
 * 选源。
 * @returns {{messages: Array, source: 'task-session'|'thread-same-agent'|'thread-mismatch'|'none', mismatchSessionKey: string}}
 */
export function pickTaskConversationSource(opts) {
  const taskSessionMessages = Array.isArray(opts?.taskSessionMessages) ? opts.taskSessionMessages : []
  if (taskSessionMessages.length) {
    return { messages: taskSessionMessages, source: 'task-session', mismatchSessionKey: '' }
  }
  const threadMessages = Array.isArray(opts?.threadMessages) ? opts.threadMessages : []
  if (!threadMessages.length) {
    return { messages: [], source: 'none', mismatchSessionKey: '' }
  }
  const assignedTo = String(opts?.assignedTo || '').trim()
  const sourceSessionKey = String(opts?.sourceSessionKey || '').trim()
  if (!isOwnTaskConversation(sourceSessionKey, assignedTo)) {
    return { messages: [], source: 'thread-mismatch', mismatchSessionKey: sourceSessionKey }
  }
  // 同一员工（或主会话）但**不是本任务专用会话**：可以展示，但必须标明来源，
  // 否则用户会以为这就是本任务的全部执行记录（本轮被点名的「误导」正是这一类）。
  const taskKey = String(opts?.taskSessionKey || '').trim()
  const isDedicated = taskKey && sourceSessionKey === taskKey
  if (isDedicated) {
    return { messages: threadMessages, source: 'task-session', mismatchSessionKey: '' }
  }
  return { messages: threadMessages, source: 'thread-same-agent', mismatchSessionKey: '' }
}
