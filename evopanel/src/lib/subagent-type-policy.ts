/**
 * 子智能体类型策略（与后端 evoflow.claude_subagent_type 对齐）。
 *
 * - Claude Code 族：专用流式拼接；协作子任务必须 subtask_outcome_report。
 * - 其余全部（内置 + agents 目录自定义 config 名）：delta 流式拼接；executor 成功可系统收口。
 */

/** 与后端 claude_subagent_type.CLAUDE_CODE_SUBAGENT_FAMILY 保持一致 */
const CLAUDE_CODE_SUBAGENT_FAMILY = new Set([
  'claude-code',
  'claude-session',
  'claude',
  'claude-session-tool',
])

function normalizeSubagentTypeName(name: string | undefined): string {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
}

/** 是否为 Claude Code 工作子智能体（含历史别名） */
export function isClaudeCodeSubagentType(name: string | undefined): boolean {
  const n = normalizeSubagentTypeName(name)
  if (!n) return false
  if (CLAUDE_CODE_SUBAGENT_FAMILY.has(n)) return true
  return n.startsWith('claude-')
}

/** 是否对 task_running 使用「非 Claude」delta 拼接（含所有自定义智能体 id） */
export function usesDeltaStreamMerge(subagentType: string | undefined): boolean {
  return !isClaudeCodeSubagentType(subagentType)
}
