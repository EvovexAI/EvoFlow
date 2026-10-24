/**
 * 主对话「用哪套面板 / 是否算空草稿」的判定。
 *
 * 产品约束：V4 开启时**不以历史回落老面板**。打开有历史的会话就留在 V4，
 * 等首帧 hydration；connecting 期间用加载态，绝不能判成居中草稿。
 *
 * 背景（真实缺陷）：旧实现把「当前 V4 窗口没有行」直接当成空会话，于是
 * connecting 期间 draftEmpty=true → 输入框+问候语居中，有历史的会话被误呈现成新对话。
 *
 * 正确语义：**居中只属于「确认过的空草稿」**。区分「还没拿到数据」和「确认没有数据」。
 */

export interface ChatPaneModeInput {
  /** V4 桥接阶段：disabled / no-thread / connecting / ready / failed。 */
  v4Phase: 'disabled' | 'no-thread' | 'connecting' | 'ready' | 'failed'
  /** 本地 AG-UI 行是否已有内容（仅用于 draftEmpty，不驱动回落老面板）。 */
  localHasRows: boolean
  /** 历史接口是否仍在加载——加载中不能断言「这是空会话」。 */
  historyLoading: boolean
  /** V4 快照是否属于当前选中会话且已有行。 */
  v4HasRows: boolean
  /** 工作台首页（独立 surface，不参与对话面板切换）。 */
  isHomeSurface: boolean
  /** 本轮刚发出的用户气泡尚未进 V4，需要先沿用本地行渲染（发送瞬间）。 */
  localOptimisticHold: boolean
}

export interface ChatPaneMode {
  /** true = 老面板；false = V4 ConversationTimeline。 */
  useLegacyPane: boolean
  /** true = 可显示居中问候语的真正空草稿。 */
  draftEmpty: boolean
}

export function resolveChatPaneMode(input: ChatPaneModeInput): ChatPaneMode {
  const {
    v4Phase,
    localHasRows,
    historyLoading,
    v4HasRows,
    isHomeSurface,
    localOptimisticHold,
  } = input

  // 默认坚持 V4。开关关闭 / 工作台首页 / 乐观气泡 / store 失败 才走老面板。
  // connecting 仍不回落（加载态）；failed=投影 store 已 error 且无快照，必须回落否则永远「连接中」。
  const useLegacyPane =
    v4Phase === 'disabled' ||
    v4Phase === 'failed' ||
    isHomeSurface ||
    localOptimisticHold

  // 只有「确认无本地行 + 历史已加载完 + V4 已给出结论（ready/no-thread）」才是真草稿。
  // connecting / historyLoading / failed 一律不算——failed 走老面板展示本地行。
  const draftEmpty =
    !localOptimisticHold &&
    !localHasRows &&
    !historyLoading &&
    !v4HasRows &&
    (v4Phase === 'ready' || v4Phase === 'no-thread')

  return { useLegacyPane, draftEmpty }
}
