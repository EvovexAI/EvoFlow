export const SIDE_PANE_DEFAULT_EXPANDED_SIZE = "45%";
export const SIDE_PANE_DEFAULT_EXPANDED_RATIO = 0.45;

const SIDE_PANE_TAB_MIN_WIDTH_PX = 60;
const SIDE_PANE_TAB_GAP_PX = 4;
const SIDE_PANE_TAB_OVERFLOW_TOLERANCE_PX = 1;

export function resolveSidePaneTabsOverflow({
  addButtonInside,
  addButtonWidth,
  tabCount,
  viewportWidth,
}: {
  addButtonInside: boolean;
  addButtonWidth: number;
  tabCount: number;
  viewportWidth: number;
}): boolean {
  const tabsWidth =
    tabCount * SIDE_PANE_TAB_MIN_WIDTH_PX + Math.max(0, tabCount - 1) * SIDE_PANE_TAB_GAP_PX;
  const addButtonGap = tabCount > 0 ? SIDE_PANE_TAB_GAP_PX : 0;
  const viewportWidthWithAddButtonInside = viewportWidth + (addButtonInside ? 0 : addButtonWidth);
  const contentWidthWithAddButtonInside = tabsWidth + addButtonGap + addButtonWidth;

  return (
    contentWidthWithAddButtonInside >
    viewportWidthWithAddButtonInside + SIDE_PANE_TAB_OVERFLOW_TOLERANCE_PX
  );
}
