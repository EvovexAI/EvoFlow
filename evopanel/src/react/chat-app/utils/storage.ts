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
