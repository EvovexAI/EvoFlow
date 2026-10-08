import { useMemo } from "react";
import type { GitDiffResult } from "@zcode/shared";
import { ChevronDownIcon, CopyIcon, FolderOpenIcon, ListTreeIcon } from "lucide-react";
import { DiffViewer } from "@/components/ui/diff-viewer.js";
import { cn } from "@/components/lib/utils.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { getDiffFallbackMessageId, getGitPaneDiffPreviewPlan } from "@/GitPane/helpers.js";
import { FileDisplayInline } from "@/lib/fileDisplay.js";
import type { GitPaneFileChange } from "@/hooks/useGitRepository.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodePreviewSettings } from "@/store/index.js";
import type { ResolvedTheme } from "@/useTheme.js";
import { LightweightDiffPreview } from "@/components/ui/lightweight-diff-preview.js";

export function GitPaneChangeCard({
  change,
  contextMenuLabels,
  diffState,
  isDiffLoading,
  isExpanded,
  canRevealInFileManager,
  codePreviewSettings,
  resolvedTheme,
  onCopyAbsolutePath,
  onCopyRelativePath,
  onOpenChange,
  onRevealInFileManager,
  onRevealInFileTree,
}: {
  change: GitPaneFileChange;
  contextMenuLabels: {
    copyAbsolutePath: string;
    copyRelativePath: string;
    revealInFileManager: string;
    revealInFileTree: string;
  };
  diffState: GitDiffResult | null;
  isDiffLoading: boolean;
  isExpanded: boolean;
  canRevealInFileManager: boolean;
  codePreviewSettings: CodePreviewSettings;
  resolvedTheme: ResolvedTheme;
  onCopyAbsolutePath: (change: GitPaneFileChange) => void;
  onCopyRelativePath: (change: GitPaneFileChange) => void;
  onOpenChange: (change: GitPaneFileChange, nextOpen: boolean) => void;
  onRevealInFileManager: (change: GitPaneFileChange) => void;
  onRevealInFileTree?: (change: GitPaneFileChange) => void;
}) {
  const { intl } = useZCodeIntl();
  const diffPreviewPlan = useMemo(() => getGitPaneDiffPreviewPlan(diffState), [diffState]);
  const multiFileDiffFiles = useMemo(() => {
    if (diffState?.availability !== "patch" || diffState.afterContent === null) {
      return null;
    }

    // DiffViewer 是 memo 组件，oldFile/newFile 如果在 JSX 里内联创建，
    // 父级任意刷新都会让大 diff 视图浅比较失效。
    return {
      oldFile: {
        name: change.workspaceRelativePath,
        contents: diffState.beforeContent ?? "",
        cacheKey: `old:${diffState.path}:${diffState.beforeContent?.length ?? 0}:${diffState.beforeContent?.slice(0, 100) ?? ""}:${diffState.beforeContent?.slice(-100) ?? ""}`,
      },
      newFile: {
        name: change.workspaceRelativePath,
        contents: diffState.afterContent,
        cacheKey: `new:${diffState.path}:${diffState.afterContent.length}:${diffState.afterContent.slice(0, 100)}:${diffState.afterContent.slice(-100)}`,
      },
    };
  }, [
    change.workspaceRelativePath,
    diffState?.afterContent,
    diffState?.availability,
    diffState?.beforeContent,
    diffState?.path,
  ]);

  return (
    <div className="w-full min-w-0">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            aria-expanded={isExpanded}
            className={cn(
              "sticky top-0 z-10 flex h-8 w-full items-center gap-3 bg-background px-3 text-left transition-colors hover:bg-surface-hover supports-[backdrop-filter]:backdrop-blur-sm",
              isExpanded && "bg-surface-hover",
            )}
            onClick={() => onOpenChange(change, !isExpanded)}
          >
            {/* Review 打开会一次性挂载几十个可视/overscan 行；每行都用 Radix Collapsible
                会额外创建 provider/presence 和测量链路，CDP CPU profile 里 click 后主线程集中耗在
                React 提交阶段。这里改成普通按钮 + 仅展开行渲染内容，保留交互同时减少打开成本。 */}
            <div className="min-w-0 flex-1 overflow-hidden">
              <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                <FileDisplayInline
                  path={change.workspaceRelativePath}
                  options={{
                    showFilePath: true,
                    className: "inline-flex min-w-0 max-w-full items-center gap-2",
                    fileNameClassName: "truncate text-ui-base text-foreground",
                    filePathClassName: "truncate text-ui-base text-foreground-subtlest",
                  }}
                />
              </div>
            </div>
            <div className="flex shrink-0 items-center justify-end gap-3 pl-3">
              <div className="shrink-0 whitespace-nowrap text-ui-base">
                <span className="text-diff-added">+{change.added}</span>
                <span className="ml-2 text-diff-removed">-{change.removed}</span>
              </div>
              <ChevronDownIcon
                className={cn(
                  "size-4 shrink-0 text-foreground-subtle transition-transform",
                  isExpanded && "rotate-180",
                )}
              />
            </div>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <ContextMenuItem
            disabled={!canRevealInFileManager}
            onSelect={() => onRevealInFileManager(change)}
          >
            <FolderOpenIcon className="size-4" />
            {contextMenuLabels.revealInFileManager}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onCopyAbsolutePath(change)}>
            <CopyIcon className="size-4" />
            {contextMenuLabels.copyAbsolutePath}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onCopyRelativePath(change)}>
            <CopyIcon className="size-4" />
            {contextMenuLabels.copyRelativePath}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={!onRevealInFileTree}
            onSelect={() => onRevealInFileTree?.(change)}
          >
            <ListTreeIcon className="size-4" />
            {contextMenuLabels.revealInFileTree}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {isExpanded ? (
        <div className="w-full min-w-0 overflow-x-auto overflow-y-hidden bg-background">
          {isDiffLoading ? (
            <div className="flex items-center justify-center py-4 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "common.loading" })}
            </div>
          ) : diffState?.availability === "patch" && diffPreviewPlan.kind === "plain-text" ? (
            <div className="w-full min-w-0">
              <GitPanePlainTextDiffPreview
                lines={diffPreviewPlan.lines}
                codePreviewSettings={codePreviewSettings}
              />
            </div>
          ) : diffState?.availability === "patch" &&
            diffPreviewPlan.kind === "patch" &&
            diffState.patch ? (
            <div className="w-full min-w-0">
              {/* 大文件展开只需要先看到变更 hunk。继续走 before/after 的 MultiFileDiff
                会同步比较整文件并拖慢点击反馈；这里改走 patch 输入，让高亮继续由 worker 异步完成。 */}
              <DiffViewer
                patch={diffState.patch}
                diffClassName="block"
                fontSizePx={codePreviewSettings.fontSizePx}
                lightTheme={codePreviewSettings.lightTheme}
                darkTheme={codePreviewSettings.darkTheme}
                themeType={resolvedTheme}
              />
            </div>
          ) : diffState?.availability === "patch" &&
            diffState.afterContent !== null &&
            multiFileDiffFiles ? (
            <div className="w-full min-w-0">
              {/* 手机远控右侧栏宽度较窄，展开的文件 diff 不能依赖父级隐藏溢出。
                外层允许横向滚动，长行 diff 才不会在窄屏被裁掉。 */}
              <DiffViewer
                oldFile={multiFileDiffFiles.oldFile}
                newFile={multiFileDiffFiles.newFile}
                diffClassName="block"
                fontSizePx={codePreviewSettings.fontSizePx}
                lightTheme={codePreviewSettings.lightTheme}
                darkTheme={codePreviewSettings.darkTheme}
                themeType={resolvedTheme}
              />
            </div>
          ) : (
            <div className="px-4 py-3 text-ui-base text-foreground-subtle">
              {intl.formatMessage({
                id: getDiffFallbackMessageId(diffState?.availability ?? "unavailable"),
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function GitPanePlainTextDiffPreview({
  lines,
  codePreviewSettings,
}: {
  lines: readonly string[];
  codePreviewSettings: CodePreviewSettings;
}) {
  // 超大 patch 或深 hunk 进入富 diff 渲染会把主线程耗在同步解析/DOM 构建上。
  // 轻量 hunk 预览复用共享 diff 行号/gutter 样式，避免和右侧 DiffViewer 视觉分叉。
  return (
    <LightweightDiffPreview
      codePreviewSettings={codePreviewSettings}
      data-git-plain-text-diff-preview
      lines={lines}
    />
  );
}
