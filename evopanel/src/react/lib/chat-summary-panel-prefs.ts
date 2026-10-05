/**
 * 状态面板（ChatSummaryPanel）本地偏好。
 *
 * 两类持久化：
 * - displayMode：三态胶囊/面板/隐藏（ZCode 的 data-display-mode）
 * - expandPolicy：面板态下「有运行中进程是否自动展开面板」
 *
 * 控制台调试：localStorage.setItem('EVOFLOW_CHAT_PANEL_DEBUG', '1')
 */

const MODE_KEY = 'evopanel_chat_summary_display_mode_v1'
const POLICY_KEY = 'evopanel_chat_summary_expand_policy_v1'
const SECTIONS_KEY = 'evopanel_chat_summary_sections_v1'
const SECTIONS_LAYOUT_KEY = 'evopanel_chat_summary_sections_layout_v2'
const DEBUG_KEY = 'EVOFLOW_CHAT_PANEL_DEBUG'

/** 面板三态：胶囊（浮层小条）/ 面板（右栏）/ 隐藏（完全不占位） */
export type ChatSummaryDisplayMode = 'capsule' | 'panel' | 'hidden'

/** 展开策略：运行中是否自动把胶囊撑成面板 */
export type ChatSummaryExpandPolicy = 'auto-expand' | 'sticky' | 'sticky-collapsed'

export type ChatSummarySectionId = 'process' | 'agent' | 'more'

function debugOn(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false
    return localStorage.getItem(DEBUG_KEY) === '1'
  } catch {
    return false
  }
}

function trace(stage: string, detail?: unknown): void {
  if (!debugOn()) return
  // eslint-disable-next-line no-console
  console.log('[chat-summary-panel]', stage, detail ?? '')
}

function readRaw(key: string): string {
  try {
    if (typeof localStorage === 'undefined') return ''
    return String(localStorage.getItem(key) || '').trim()
  } catch {
    return ''
  }
}

function writeRaw(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(key, value)
  } catch {
    /* private mode / quota —— 偏好丢失不应影响主流程 */
  }
}

export function normalizeChatSummaryDisplayMode(raw: unknown): ChatSummaryDisplayMode {
  const s = String(raw || '').trim().toLowerCase()
  if (s === 'capsule' || s === 'mini') return 'capsule'
  if (s === 'hidden' || s === 'none' || s === 'off') return 'hidden'
  return 'panel'
}

export function normalizeChatSummaryExpandPolicy(raw: unknown): ChatSummaryExpandPolicy {
  const s = String(raw || '').trim().toLowerCase()
  if (s === 'sticky' || s === 'stay') return 'sticky'
  if (s === 'sticky-collapsed' || s === 'sticky_minimized') return 'sticky-collapsed'
  return 'auto-expand'
}

const ALL_SECTIONS: ChatSummarySectionId[] = ['process', 'agent', 'more']

/** 缺省：智能体开（面板主体，放最上面）、进程关、更多关 */
export const DEFAULT_CHAT_SUMMARY_SECTIONS: Record<ChatSummarySectionId, boolean> = {
  agent: true,
  process: false,
  more: false,
}

export function normalizeChatSummarySections(raw: unknown): Record<ChatSummarySectionId, boolean> {
  const next = { ...DEFAULT_CHAT_SUMMARY_SECTIONS }
  let parsed: unknown = null
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (!s) return next
    try {
      parsed = JSON.parse(s)
    } catch {
      trace('sections_parse_error', s)
      return next
    }
  } else if (raw && typeof raw === 'object') {
    parsed = raw
  }
  if (!parsed || typeof parsed !== 'object') return next
  for (const id of ALL_SECTIONS) {
    const v = (parsed as Record<string, unknown>)[id]
    if (typeof v === 'boolean') next[id] = v
  }
  return next
}

export type ChatSummaryPrefs = {
  displayMode: ChatSummaryDisplayMode
  expandPolicy: ChatSummaryExpandPolicy
  sections: Record<ChatSummarySectionId, boolean>
}

export function loadChatSummaryPrefs(): ChatSummaryPrefs {
  const displayMode = normalizeChatSummaryDisplayMode(readRaw(MODE_KEY))
  const expandPolicy = normalizeChatSummaryExpandPolicy(readRaw(POLICY_KEY))
  const sections = loadSectionsWithLayoutMigration()
  trace('load', { displayMode, expandPolicy, sections })
  return { displayMode, expandPolicy, sections }
}

/**
 * v1→v2 布局迁移：分区顺序和默认展开项都换了（进程在前 → 智能体在前且默认展开）。
 * 老用户 localStorage 里存的是 { process:true, agent:false }，光改 DEFAULT 不生效，
 * 他们会一直卡在旧形态（智能体收着、进程展开着）。
 *
 * 用一个独立 stamp 而不是改 SECTIONS_KEY 的版本号后缀：后者会把老值当脏数据丢掉，
 * 无法区分「从没设置过」和「显式设成了 false」。这里只在 stamp 缺失时套用新默认，
 * 之后用户再手动调都以他们的选择为准，不再覆盖。
 */
function loadSectionsWithLayoutMigration(): Record<ChatSummarySectionId, boolean> {
  const raw = readRaw(SECTIONS_KEY)
  const stamped = readRaw(SECTIONS_LAYOUT_KEY) === 'v2'
  if (!raw || stamped) return normalizeChatSummarySections(raw)

  trace('sections_layout_migrate_v1_to_v2', raw)
  const migrated = { ...DEFAULT_CHAT_SUMMARY_SECTIONS }
  writeRaw(SECTIONS_KEY, JSON.stringify(migrated))
  writeRaw(SECTIONS_LAYOUT_KEY, 'v2')
  return migrated
}

export function saveChatSummaryDisplayMode(mode: ChatSummaryDisplayMode): void {
  const next = normalizeChatSummaryDisplayMode(mode)
  trace('save_display_mode', next)
  writeRaw(MODE_KEY, next)
}

export function saveChatSummaryExpandPolicy(policy: ChatSummaryExpandPolicy): void {
  const next = normalizeChatSummaryExpandPolicy(policy)
  trace('save_expand_policy', next)
  writeRaw(POLICY_KEY, next)
}

export function saveChatSummarySections(sections: Record<ChatSummarySectionId, boolean>): void {
  const next = normalizeChatSummarySections(sections)
  trace('save_sections', next)
  writeRaw(SECTIONS_KEY, JSON.stringify(next))
  // 用户显式设置即视为已在新布局下做过选择，钉住版本，
  // 否则下次 load 又会被 v1→v2 迁移覆盖回默认值。
  writeRaw(SECTIONS_LAYOUT_KEY, 'v2')
}
