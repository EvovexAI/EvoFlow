/**
 * 主对话「用哪套面板 / 是否算空草稿」的判定。
 *
 * 产品约束：V4 开启时**对话区不回落老面板**（含发送乐观气泡、store failed）。
 * 打开有历史的会话就留在 V4，等首帧 hydration；connecting 用加载态，
 * 绝不能判成居中草稿。
 *
 * 老面板仅保留：
 * - 显式关闭 V4（?chatV4=0 / localStorage）
 * - 工作台首页（EvoFlowHomeDashboard，不是对话流）
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
  /**
   * 本轮刚发出的用户气泡尚未进 V4（由时间线注入合成 userInput）。
   * 只压制草稿问候，不再切老面板。
   */
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

  // V4 开启时对话永不回落。仅 kill-switch / 工作台首页走老面板壳。
  const useLegacyPane = v4Phase === 'disabled' || isHomeSurface

  // 只有「确认无本地行 + 历史已加载完 + V4 已给出结论（ready/no-thread）」才是真草稿。
  // connecting / historyLoading / failed / 乐观发送中 一律不算。
  const draftEmpty =
    !localOptimisticHold &&
    !localHasRows &&
    !historyLoading &&
    !v4HasRows &&
    (v4Phase === 'ready' || v4Phase === 'no-thread')

  return { useLegacyPane, draftEmpty }
}
