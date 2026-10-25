// V4WorkspaceFileTreePane — 右侧 workspace-browse 面板的 ZCode 正式文件树。
// 整棵 workspace-file-tree（虚拟化行 / 吸顶文件夹 / 搜索 / 只看已更改 / Git 着色 /
// 空目录自动合并 / watcher 刷新）都是 vendored ZCode 原实现；本文件只做宿主装配：
// Intl + Store + Platform + ServiceProvider（EvoFlow 沙箱数据通道，见
// createEvoflowPartialServices 的 readdir / gitService / 轮询 fileWatcherService）。
import { useMemo } from "react";
import { WorkspaceFileTree } from "@zcode/ui/workspace-file-tree/WorkspaceFileTree.js";
import { ZCodeIntlProvider } from "@zcode/ui/i18n/IntlProvider.js";
import { StoreProvider } from "@zcode/ui/store/StoreProvider.js";
import { PlatformProvider } from "@zcode/ui/hooks/usePlatform.js";
import { ServiceProvider } from "@zcode/ui/hooks/useServices.js";
import { TooltipProvider } from "@zcode/ui/components/ui/tooltip.js";
import type { IBroadcastService, BroadcastMessage } from "@zcode/services";
import type { CodeViewerSource } from "@zcode/ui/lib/codeViewer.js";
import { evoflowStubPlatform } from "../../../pages/settings/evoflow-bridge-services.js";
import { createEvoflowPartialServices } from "../../v4/V4ZCodeTimeline.js";

/** 同 V4PreviewPane：Web 端 no-op 广播（createZCodeStore 明确 Web 可传 no-op）。 */
const NOOP_BROADCAST: IBroadcastService = {
  async send() {},
  async acquireClaim() {
    return { status: "unavailable" } as const;
  },
  async commitClaim() {},
  async releaseClaim() {},
  async tryClaim() {
    return true;
  },
  onMessage: ((_listener: (message: BroadcastMessage) => void) => ({
    dispose() {},
  })) as IBroadcastService["onMessage"],
};

export function V4WorkspaceFileTreePane(props: {
  /** 会话工作区根（绝对路径）：树的根与所有相对化都依赖它；为空时不挂载。 */
  workspacePath: string;
  /** LangGraph thread id：listdir / git_status / list_files 按会话沙箱解析。 */
  threadId?: string;
  /** 右侧正在预览的文件路径：命中时展开祖先目录并滚动定位。 */
  activePreviewPath?: string | null;
  onClose: () => void;
  /** 点击文件行 → CodeViewerSource（type:"file"）交给宿主开右侧预览 tab。 */
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
}): React.JSX.Element {
  const { workspacePath, threadId, activePreviewPath, onClose, onOpenCodeViewer } = props;
  // 访问器按 thread + workspace root 建，相对路径带 root 解析。
  const partialServices = useMemo(
    () => createEvoflowPartialServices(threadId ?? "", workspacePath),
    [threadId, workspacePath],
  );
  return (
    <ZCodeIntlProvider initialLocale="zh-CN">
      <StoreProvider broadcastService={NOOP_BROADCAST}>
        <PlatformProvider platform={evoflowStubPlatform}>
          <ServiceProvider services={partialServices}>
            {/* zcode-bridge-root：styles-bridge 的 token / 暗色主题 / 滚动条作用域都收窄在此容器。 */}
            <div className="zcode-bridge-root h-full min-h-0">
              <TooltipProvider>
                <WorkspaceFileTree
                  workspacePath={workspacePath}
                  activePreviewPath={activePreviewPath ?? undefined}
                  onClose={onClose}
                  onOpenPreview={(source) => onOpenCodeViewer?.(source)}
                />
              </TooltipProvider>
            </div>
          </ServiceProvider>
        </PlatformProvider>
      </StoreProvider>
    </ZCodeIntlProvider>
  );
}
