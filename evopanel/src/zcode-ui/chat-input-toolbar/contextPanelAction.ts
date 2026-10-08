export function runContextPanelActionWithClose({
  action,
  close,
}: {
  action?: () => void;
  close: () => void;
}) {
  // HoverCard 内按钮点击不会像外部 hover leave 一样自动关闭面板。
  // 入口动作会切到设置页或 usage 详情，必须先收起 context 面板，避免旧浮层残留。
  close();
  action?.();
}
