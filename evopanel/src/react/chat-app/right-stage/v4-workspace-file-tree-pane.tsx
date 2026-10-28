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

type DirEntry = { name: string; path: string; type: "file" | "directory" };

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
  /**
   * Optional file filter (e.g. knowledge base: only docs/text).
   * Directories always pass unless acceptDirectoryName rejects them.
   */
  acceptFileName?: (fileName: string) => boolean;
  /** Optional directory filter (e.g. hide `.git` / empty-after-filter dirs). */
  acceptDirectoryName?: (dirName: string) => boolean;
  /** When true with acceptFileName, hide dirs that contain no accepted files. */
  hideEmptyDirectories?: boolean;
}): React.JSX.Element {
  const {
    workspacePath,
    threadId,
    activePreviewPath,
    onClose,
    onOpenCodeViewer,
    acceptFileName,
    acceptDirectoryName,
    hideEmptyDirectories = false,
  } = props;
  // 访问器按 thread + workspace root 建，相对路径带 root 解析。
  const partialServices = useMemo(() => {
    const base = createEvoflowPartialServices(threadId ?? "", workspacePath);
    if (!acceptFileName && !acceptDirectoryName && !hideEmptyDirectories) return base;
    const fs = base.fileService as {
      readdir?: (params: { path: string; includeHidden?: boolean }) => Promise<DirEntry[]>;
      [key: string]: unknown;
    };
    if (!fs?.readdir) return base;
    const rawReaddir = fs.readdir.bind(fs);
    const contentCache = new Map<string, boolean>();

    const dirAllowed = (name: string) => {
      if (acceptDirectoryName && !acceptDirectoryName(name)) return false;
      return true;
    };

    const dirHasAcceptedContent = async (
      dirPath: string,
      includeHidden?: boolean,
      depth = 0,
    ): Promise<boolean> => {
      const key = `${dirPath}\0${includeHidden !== false}`;
      const cached = contentCache.get(key);
      if (cached !== undefined) return cached;
      // Bound recursion: deep code-only trees must not stall every expand/click.
      if (depth > 6) {
        contentCache.set(key, false);
        return false;
      }
      let entries: DirEntry[] = [];
      try {
        entries = (await rawReaddir({ path: dirPath, includeHidden })) || [];
      } catch {
        contentCache.set(key, false);
        return false;
      }
      const childDirs: DirEntry[] = [];
      for (const entry of entries) {
        const name = String(entry?.name || "");
        if (entry?.type === "directory") {
          if (dirAllowed(name)) childDirs.push(entry);
          continue;
        }
        if (!acceptFileName || acceptFileName(name)) {
          contentCache.set(key, true);
          return true;
        }
      }
      if (childDirs.length) {
        const results = await Promise.all(
          childDirs.map((entry) => dirHasAcceptedContent(entry.path, includeHidden, depth + 1)),
        );
        if (results.some(Boolean)) {
          contentCache.set(key, true);
          return true;
        }
      }
      contentCache.set(key, false);
      return false;
    };

    return {
      ...base,
      fileService: {
        ...fs,
        async readdir(params: { path: string; includeHidden?: boolean }) {
          const entries = (await rawReaddir(params)) || [];
          const files: DirEntry[] = [];
          const dirs: DirEntry[] = [];
          for (const entry of entries) {
            const name = String(entry?.name || "");
            if (entry?.type === "directory") {
              if (!dirAllowed(name)) continue;
              dirs.push(entry);
              continue;
            }
            if (acceptFileName && !acceptFileName(name)) continue;
            files.push(entry);
          }
          if (!(hideEmptyDirectories && acceptFileName) || dirs.length === 0) {
            return [...dirs, ...files];
          }
          const flags = await Promise.all(
            dirs.map((entry) => dirHasAcceptedContent(entry.path, params?.includeHidden)),
          );
          return [...dirs.filter((_, i) => flags[i]), ...files];
        },
      },
    };
  }, [threadId, workspacePath, acceptFileName, acceptDirectoryName, hideEmptyDirectories]);
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
