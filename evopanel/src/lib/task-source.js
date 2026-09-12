/**
 * 任务来源 — 仅三种：chat / workflow / role（与后端 task_source 对齐）。
 */

const SOURCE_LABELS = {
  chat: '主对话',
  workflow: '工作流',
  role: '智能体岗位',
}

const SOURCE_ALIASES = {
  conversation: 'chat',
  chat_mention: 'chat',
  main_chat: 'chat',
  manual: 'chat',
  cli: 'chat',
  api: 'chat',
  restart_task: 'chat',
  automation: 'workflow',
  task_center: 'workflow',
  app: 'workflow',
  app_runner: 'workflow',
  app_runner_lead: 'workflow',
  supervisor: 'workflow',
  proactive: 'role',
  proactive_patrol: 'role',
  proactive_dispatch: 'role',
  proactive_initiative: 'role',
  proactive_think: 'role',
  xiaomi: 'role',
  employee_page: 'role',
  role_work: 'role',
}

/** @param {unknown} raw */
export function normalizeTaskSource(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
  if (!s) return ''
  if (SOURCE_LABELS[s]) return s
  if (s.startsWith('event:') || s.startsWith('dispatch:')) return 'role'
  return SOURCE_ALIASES[s] || 'chat'
}

/** @param {unknown} raw */
export function formatTaskSourceZh(raw) {
  const canon = normalizeTaskSource(raw)
  if (!canon) return '未标注'
  return SOURCE_LABELS[canon] || canon
}

export function listTaskSources() {
  return Object.entries(SOURCE_LABELS).map(([id, labelZh]) => ({ id, labelZh }))
}
