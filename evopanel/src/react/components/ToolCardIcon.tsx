import { memo, type ReactNode } from 'react'

/**
 * 工具卡片类别注册表：toolKind → 类别（图标 + 主题色）。
 *
 * 与 ZCode 的工具卡体系同构：卡片外壳按 kind 查注册表取元数据，
 * 而不是在每个调用点内联分支。EvoFlow 现有 TOOL_NAME_ZH / TOOL_ICON
 * 继续负责文案与 emoji 兜底，本表只负责"分类观感"。
 */

export type ToolCardCategory =
  | 'terminal'
  | 'file'
  | 'search'
  | 'browser'
  | 'knowledge'
  | 'memory'
  | 'plan'
  | 'collab'
  | 'media'
  | 'system'

const EXACT_KIND_CATEGORY: Record<string, ToolCardCategory> = {
  bash: 'terminal',
  execute_command: 'terminal',
  terminal: 'terminal',
  code_execution: 'terminal',

  read_file: 'file',
  read: 'file',
  ls: 'file',
  list_dir: 'file',
  find_file: 'file',
  find: 'file',
  write_file: 'file',
  write_to_file: 'file',
  write: 'file',
  str_replace: 'file',
  replace_in_file: 'file',
  replace: 'file',
  edit: 'file',
  delete_file: 'file',
  delete: 'file',

  search_content: 'search',
  search_code_index: 'search',
  rg: 'search',
  grep: 'search',
  tool_search: 'search',

  web_search: 'browser',
  web_fetch: 'browser',
  image_search: 'browser',
  browser: 'browser',
  preview_url: 'browser',

  knowledge: 'knowledge',
  kb_search: 'knowledge',
  recall: 'knowledge',

  remember: 'memory',
  memory_write: 'memory',
  assets: 'memory',
  experience: 'memory',
  person_memory: 'memory',

  plan: 'plan',
  write_todos: 'plan',
  todo: 'plan',
  mode_set: 'plan',
  scenario: 'plan',
  scenario_activation: 'plan',

  subagent: 'collab',
  task: 'collab',
  supervisor: 'collab',
  worker: 'collab',
  list_agents: 'collab',
  invoke_acp_agent: 'collab',
  create_agent: 'collab',

  view_image: 'media',

  automation: 'system',
  ask_clarification: 'system',
}

const PREFIX_CATEGORY_RULES: ReadonlyArray<readonly [string, ToolCardCategory]> = [
  ['browser_', 'browser'],
  ['web_', 'browser'],
  ['search_', 'search'],
  ['kb_', 'knowledge'],
  ['memory_', 'memory'],
  ['collab_', 'collab'],
  ['person_', 'memory'],
  ['diagnostics', 'system'],
]

/** 未登记的工具回退到中性 system 类别，不抛错。 */
export function resolveToolCardCategory(toolKind: string): ToolCardCategory {
  const key = String(toolKind || '').trim().toLowerCase()
  if (!key) return 'system'
  const exact = EXACT_KIND_CATEGORY[key]
  if (exact) return exact
  for (const [prefix, category] of PREFIX_CATEGORY_RULES) {
    if (key.startsWith(prefix)) return category
  }
  return 'system'
}

/** 24×24 stroke 线性图标（lucide 风格路径，stroke 用 currentColor）。 */
const CATEGORY_ICONS: Record<ToolCardCategory, ReactNode> = {
  terminal: (
    <>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </>
  ),
  file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </>
  ),
  browser: (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </>
  ),
  knowledge: (
    <>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </>
  ),
  memory: (
    <>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
      <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" />
    </>
  ),
  plan: (
    <>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <line x1="9" y1="12" x2="15" y2="12" />
      <line x1="9" y1="16" x2="13" y2="16" />
    </>
  ),
  collab: (
    <>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  media: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </>
  ),
  system: (
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  ),
}

/** 工具卡片头部左侧的类别图标徽章（运行中带呼吸态）。 */
function ToolCardIconInner({
  toolKind,
  running = false,
}: {
  toolKind: string
  running?: boolean
}) {
  const category = resolveToolCardCategory(toolKind)
  return (
    <span
      className={`evf-tcard-icon evf-tcard-icon--${category}${running ? ' is-running' : ''}`}
      aria-hidden="true"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {CATEGORY_ICONS[category]}
      </svg>
    </span>
  )
}

export const ToolCardIcon = memo(ToolCardIconInner)
