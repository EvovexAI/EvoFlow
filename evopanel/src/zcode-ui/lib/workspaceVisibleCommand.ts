export function runWorkspaceVisibleCommand({
  isWorkspaceVisible,
  onReturnToWorkspace,
  run,
}: {
  isWorkspaceVisible: boolean;
  onReturnToWorkspace?: () => void;
  run: () => void;
}) {
  if (!isWorkspaceVisible) {
    // 设置页只是覆盖 workspace，底层 App 仍会响应 quickpick/快捷键。
    // 如果直接执行侧边栏、终端、文件搜索等 workspace 命令，状态会在被覆盖的底层变化，用户看起来像命令没生效。
    // 这里先切回工作区再执行命令，让用户立即看到命令结果。
    onReturnToWorkspace?.();
  }

  run();
}
