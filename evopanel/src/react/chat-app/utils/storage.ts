/**
 * ChatApp.tsx module-顶层 helper 集合（v3.5 阶段 F2 commit 1 抽出）。
 *
 * 主题：**storage 常量** —— 跟 localStorage / sessionStorage 持久化相关的
 * 简单常量 + 模式识别。
 *
 * 这些是纯常量 / 纯函数,无 React 依赖,无副作用,可在任意上下文
 * (包括 SSR / node) 调用。抽出来是为了让 ChatApp.tsx 不再被这些
 * 散落的"启动配置"占前 100 行,搜索时也容易找。
 */

/** session meta 持久化 key(localStorage)。 */
export const STORAGE_SESSION_META_KEY = 'evopanel-chat-session-meta'

/** 当前选中的模型 id 持久化 key(localStorage)。 */
export const STORAGE_MODEL_KEY = 'evopanel-chat-selected-model'

/** 最近一次手动选中的 session key(localStorage)。 */
export const LS_LAST_SELECTED_SESSION = 'evopanel_last_selected_session'

/**
 * 最近一次「员工对话」session key（非 dept:{id}:chat）。
 * 冷启动若 last_selected 被部门群聊占住，用它把主区拉回员工会话。
 */
export const LS_LAST_EMPLOYEE_SESSION = 'evopanel_last_employee_session'

/**
 * 用户最近主动进入的对话面：employee | dept | task。
 * first-selectable 误选部门群不会改这个；冷启动按它优先恢复员工会话。
 */
export const LS_LAST_CHAT_SURFACE = 'evopanel_last_chat_surface'

export type LastChatSurface = 'employee' | 'dept' | 'task'

export function loadLastChatSurface(): LastChatSurface | null {
  try {
    const raw = String(localStorage.getItem(LS_LAST_CHAT_SURFACE) || '').trim()
    if (raw === 'employee' || raw === 'dept' || raw === 'task') return raw
  } catch {
    /* ignore */
  }
  return null
}

export function saveLastChatSurface(surface: LastChatSurface): void {
  try {
    localStorage.setItem(LS_LAST_CHAT_SURFACE, surface)
  } catch {
    /* ignore */
  }
}

export function loadLastEmployeeSession(): string {
  try {
    return String(localStorage.getItem(LS_LAST_EMPLOYEE_SESSION) || '').trim()
  } catch {
    return ''
  }
}

export function saveLastEmployeeSession(sessionKey: string): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  try {
    localStorage.setItem(LS_LAST_EMPLOYEE_SESSION, sk)
  } catch {
    /* ignore */
  }
}

/** 模型切换分隔线持久化标记前缀(存为 user 消息,回放时识别并转成 system 分隔行)。 */
export const MODEL_SWITCH_SEPARATOR_PREFIX = '[MODEL_SWITCH]'

/** Thinking 强度档位枚举。 */
export type ThinkingLevel = 'auto' | 'off' | 'low' | 'medium' | 'high'

/** Thinking 强度档位 → UI 标签。 */
export const THINKING_LEVEL_OPTIONS: { value: ThinkingLevel; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'off', label: '关闭' },
  { value: 'low', label: '轻度' },
  { value: 'medium', label: '中度' },
  { value: 'high', label: '深度' },
]
