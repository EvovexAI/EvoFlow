export function resolveConversationSelectionTooltipEnabled({
  selectionActionsEnabled,
  partialShareActive,
}: {
  selectionActionsEnabled: boolean;
  partialShareActive: boolean;
}): boolean {
  // 局部勾选遮罩只改变视觉层级，未关闭全局 Selection 监听，
  // 因此底层消息仍能唤起跨功能工具条。勾选模式必须独占 message 选择交互。
  return selectionActionsEnabled && !partialShareActive;
}

export function resolveConversationShareBackgroundScrollLocked({
  partialShareActive,
  stage = "selection",
  view,
}: {
  partialShareActive: boolean;
  stage?: "selection" | "configuration";
  view: "selection" | "timeline" | undefined;
}): boolean {
  // 选择面板只用 scrim 隔离了正文指针事件，timeline 仍是
  // overflow-y-auto，背景 scrollbar 和键盘滚动仍可以改变 scrollTop。
  return resolveConversationShareSelectionPanelVisible({ partialShareActive, stage, view });
}

export function resolveConversationShareSelectionPanelVisible({
  partialShareActive,
  stage = "selection",
  view,
}: {
  partialShareActive: boolean;
  stage?: "selection" | "configuration";
  view: "selection" | "timeline" | undefined;
}): boolean {
  // 过去把视觉遮罩绑定到整个 partial scope，面板收起后遮罩仍在，
  // 只能靠局部抬高目标文本伪装成“定位完成”。遮罩必须跟面板可见状态同生共灭。
  return partialShareActive && stage === "selection" && view === "selection";
}
