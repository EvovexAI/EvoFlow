import { useCallback } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { TerminalSession } from "@/terminal/TerminalSession.js";

export function SidePaneTerminalPane({
  services,
  sessionId,
  workspaceKey,
  cwd,
  isVisible,
  isWindowsDesktop = false,
  onOpenBrowserUrl,
}: {
  services: IServiceAccessor;
  /**
   * 保活：sessionId 复用 tab.id（跨 workspace 稳定），同时作为 TerminalSession 的 persistentKey。
   * 让 xterm+PTY 所有权进 sidePaneTerminalSessionRegistry 模块级单例，
   * 组件卸载只 detach、不 dispose；重挂按 key 复用，scrollback 跨 workspace 保活。
   */
  sessionId: string;
  /**
   * workspace 身份隔离 key（= workspaceIdentity?.trim() || workspacePath）。
   * 写入 registry entry.workspaceKey，workspace tab 关闭时按此批量回收 PTY。
   */
  workspaceKey?: string;
  cwd?: string;
  isVisible: boolean;
  isWindowsDesktop?: boolean;
  onOpenBrowserUrl: (url: string) => void;
}) {
  const handleShellLabelChange = useCallback(() => {
    // 业务说明：side pane 外层 tab 已经承载终端标题，这里只需要单个 shell 实例，
    // 不再显示或同步第二层 terminal tab 标题，避免形成嵌套 tabs。
  }, []);

  return (
    <section className="h-full min-h-0 overflow-hidden bg-background p-3">
      <TerminalSession
        sessionId={sessionId}
        persistentKey={sessionId}
        workspaceKey={workspaceKey}
        services={services}
        cwd={cwd}
        isVisible={isVisible}
        isWindowsDesktop={isWindowsDesktop}
        onShellLabelChange={handleShellLabelChange}
        onOpenBrowserUrl={onOpenBrowserUrl}
      />
    </section>
  );
}
