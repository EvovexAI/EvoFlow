/**
 * 主对话「用哪套面板 / 是否算空草稿」的判定。
 *
 * 产品约束：对话区**永不**回落旧 AG-UI 面板（ToolCallList / ChatMessageStreamPane 对话流）。
 * 打开有历史的会话就留在 V4，等首帧 hydration；connecting 用加载态，
 * 绝不能判成居中草稿。
 *
 * `useLegacyPane` 仅剩工作台首页（EvoFlowHomeDashboard 壳，不是对话流）。
 * `?chatV4=0` 已退役，不再切回旧对话显示。
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
  /**
   * 侧栏「+」刚 mint 的空会话（员工新对话等）：调用方保证尚无历史。
   * 允许在 historyLoading / connecting 期间就按空草稿居中，避免输入框
   * 先贴底再跳到中间闪一下。
   */
  knownEmptyDraft?: boolean
}

export interface ChatPaneMode {
  /**
   * true = 仅工作台首页壳（ChatMessageStreamPane + HomeDashboard）。
   * 对话会话永远 false → V4 ConversationTimeline。
   */
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
    knownEmptyDraft = false,
  } = input

  // 对话永不回落旧 ToolCallList 面板；homepage 仍用旧壳挂工作台。
  // v4Phase === 'disabled' 也不再切老对话（开关已退役）。
  const useLegacyPane = isHomeSurface

  // 只有「确认无本地行 + 历史已加载完 + V4 已给出结论（ready/no-thread）」才是真草稿。
  // connecting / historyLoading / failed / 乐观发送中 一律不算。
  // 例外：knownEmptyDraft（刚 mint 的空会话）允许在加载中就居中，消掉贴底→居中闪跳。
  const phaseOkForDraft =
    v4Phase === 'ready' ||
    v4Phase === 'no-thread' ||
    v4Phase === 'disabled' ||
    (knownEmptyDraft && v4Phase === 'connecting')
  const draftEmpty =
    !localOptimisticHold &&
    !localHasRows &&
    !v4HasRows &&
    phaseOkForDraft &&
    (knownEmptyDraft || !historyLoading)

  return { useLegacyPane, draftEmpty }
}
