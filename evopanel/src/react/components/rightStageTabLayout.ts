/**
 * 右侧标签条溢出判定（ZCode 同构）。
 *
 * tab 宽度策略是「基准 156px 等宽弹性 → 60px 下限」：空间不足时所有 tab
 * 同步收缩，而不是让长标题独占一行。只有 60px × N + gap 仍然放不下，
 * 才开始横向滚动；此时「新建」按钮从条内末尾搬到条外右侧，把宽度全让给 tab。
 *
 * 这里刻意不读 content.scrollWidth：溢出状态本身会改变 viewport 宽度
 * （新增按钮在条内/条外移动），直接读 scrollWidth 会和 ResizeObserver
 * 形成反馈环，导致临界区反复抖动。改为只用稳定的最小宽度预算推导。
 */

/** 单个 tab 的收缩下限，与 CSS `.react-chat-stage-tab { min-width }` 保持一致。 */
export const STAGE_TAB_MIN_WIDTH_PX = 60;
/** tab 之间与 tab→按钮的间距，与 CSS `gap` 保持一致。 */
export const STAGE_TAB_GAP_PX = 4;
/** 亚像素容差，避免 1px 抖动反复翻转溢出态。 */
const OVERFLOW_TOLERANCE_PX = 1;

export function resolveStageTabsOverflow({
  addButtonWidth,
  tabCount,
  viewportWidth,
}: {
  /**
   * 「新建」按钮当前是否在滚动条内。
   * 判定刻意不读它——按钮位置本身就是判定结果，把它当输入会形成自指反馈环。
   * 保留在签名里是为了让调用方能显式表达当前布局，也便于调用方自检。
   */
  addButtonInside?: boolean;
  /** 「新建」按钮实测宽度（条内/条外几何不同）。 */
  addButtonWidth: number;
  tabCount: number;
  viewportWidth: number;
}): boolean {
  // 0 tab 时只有按钮占位，不存在「tab 放不下」这回事，直接判定不溢出。
  if (tabCount <= 0) return false

  const tabsWidth =
    tabCount * STAGE_TAB_MIN_WIDTH_PX + Math.max(0, tabCount - 1) * STAGE_TAB_GAP_PX;
  // 按钮与最后一个 tab 之间的 gap 恒存在（两种布局下都紧邻末尾）。
  const addButtonGap = STAGE_TAB_GAP_PX;
  // 关键：把「按钮在条内」与「按钮在条外」归一到同一假想布局（按钮位于 tabs 末尾），
  // 否则两种状态会算出不同结论，状态切换本身就会改写判定依据 → ResizeObserver 反馈抖动。
  const requiredWidth = tabsWidth + addButtonGap + addButtonWidth;

  return requiredWidth > viewportWidth + OVERFLOW_TOLERANCE_PX;
}

export type StageTabsOverflowEdges = {
  left: boolean;
  right: boolean;
};

/**
 * 两侧渐隐只提示「仍可继续滚动」的一侧；滚到端点就撤掉，
 * 避免停在边界时仍像能继续滚。
 */
export function resolveStageTabsOverflowEdges({
  isOverflowing,
  scrollLeft,
  maxScrollLeft,
}: {
  isOverflowing: boolean;
  scrollLeft: number;
  maxScrollLeft: number;
}): StageTabsOverflowEdges {
  if (!isOverflowing) {
    return { left: false, right: false };
  }

  return {
    left: scrollLeft > 1,
    right: scrollLeft < maxScrollLeft - 1,
  };
}