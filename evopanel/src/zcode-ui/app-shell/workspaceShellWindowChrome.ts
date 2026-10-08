interface WorkspaceShellWindowChromeOptions {
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isLinuxDesktop?: boolean;
  macOSMajorVersion?: number | null;
  isWindowsMaximized: boolean;
  supportsNativeRoundedCorners: boolean | null;
}

type WorkspaceShellPlatformRadiusOptions = Pick<
  WorkspaceShellWindowChromeOptions,
  "isMacDesktop" | "isWindowsDesktop" | "isLinuxDesktop" | "macOSMajorVersion"
>;

export function resolveWorkspaceShellPanelRadiusPx({
  isMacDesktop,
  isWindowsDesktop,
  macOSMajorVersion,
}: WorkspaceShellPlatformRadiusOptions): number {
  if (isWindowsDesktop) return 5;
  // 忽略 macOS 版本会让 Sequoia 的内层 12px 圆角与原生窗口小圆角不协调。
  // 保留 4px 外层留白，旧系统和未知版本用 6px，明确识别 Tahoe 26+ 才用 12px。
  if (isMacDesktop) return (macOSMajorVersion ?? 0) >= 26 ? 12 : 6;
  return 12;
}

export function resolveWorkspaceShellResizeHandleInsetPx(
  options: WorkspaceShellPlatformRadiusOptions,
): number {
  return resolveWorkspaceShellPanelRadiusPx(options) + 4;
}

export function resolveWorkspaceShellWindowChromeClass({
  isMacDesktop,
  isWindowsDesktop,
  isLinuxDesktop,
  macOSMajorVersion,
  supportsNativeRoundedCorners,
}: WorkspaceShellWindowChromeOptions): string {
  // Linux 与设置页一致使用 xl；面板已有独立留白，不承担系统窗口外沿。
  if (isLinuxDesktop) return "rounded-xl border border-border";
  if (!isWindowsDesktop) {
    const radius = resolveWorkspaceShellPanelRadiusPx({ isMacDesktop, macOSMajorVersion });
    return radius === 6 ? "rounded-[6px] border border-border" : "rounded-xl border border-border";
  }

  if (supportsNativeRoundedCorners === null) {
    // bridge 不可用或首次查询尚未完成时，不能把“未知”直接解释成 Windows 10。
    // 保持改动前样式，避免 Win11 在失败路径永久退化为直角外观。
    return "rounded-[5px] border border-border";
  }

  if (!supportsNativeRoundedCorners) {
    // 仅按 Windows 平台统一绘制右侧圆角，会在不支持原生圆角的 Windows 10
    // 上伪造一层窗口外形。只收直右侧外角，不能顺带删除面板原有的三条弱边框。
    return "rounded-l-[5px] border border-border";
  }

  // 旧最大化规则把面板当成系统窗口外沿，清除了圆角和三条边框。
  // 面板现有独立的 4px 留白，最大化时也必须保持完整圆角与边框。
  // Windows 外沿内缩 4px 后，12px 圆角会形成过厚的弧形留白；布局面板统一使用 5px。
  return "rounded-[5px] border border-border";
}
