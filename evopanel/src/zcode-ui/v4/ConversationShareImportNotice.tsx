import { memo } from "react";
import { SquareArrowRightEnter } from "lucide-react";

import type { Locale } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type { Theme } from "@/useTheme.js";
import { ConversationShareReadonlyTimeline } from "@/v4/ConversationShareReadonlyTimeline.js";
// 注入边界：只读时间线被匿名公开分享页共用，不能静态依赖 open-with 子树；
// OpenSplitButton（platform hooks、tab store、文件树模型等 Desktop 能力）只能在本 Desktop
// 消费侧引入并经 artifactOpenAction 注入，公开页入口图因此不含该子树。
import { OpenSplitButton } from "@/OpenSplitButton.js";

const EMPTY_ARTIFACT_NAMES: ReadonlyMap<string, string> = new Map();
const EMPTY_ARTIFACT_WORKSPACE_RELATIVE_PATHS: ReadonlyMap<string, string> = new Map();

/**
 * 导入分享后，会话顶部的只读块 + 分割线。
 * 使用导入图标，避免与 Fork 标记混淆。
 *
 * 只读块直接复用分享页的渲染器，因此不需要把公开 rows 反向映射成 Message
 * （那个方向有损且未定义；Fork 之所以简单是因为它克隆真实 Message）。
 *
 * 本地结果物不走分享页的 artifactUrls/window.open；只有导入端显式传入
 * workspaceRelativePath 与 Desktop 打开回调时，才复用正常预览卡片的打开控件。
 */
export const ConversationShareImportNotice = memo(function ConversationShareImportNotice({
  rows,
  locale,
  theme,
  codePreviewSettings,
  artifactNames = EMPTY_ARTIFACT_NAMES,
  artifactWorkspaceRelativePaths = EMPTY_ARTIFACT_WORKSPACE_RELATIVE_PATHS,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  unsupportedRowCount = 0,
  onOpenShareUrl,
  onOpenFileLink,
  onOpenCodeViewer,
}: {
  rows: readonly ConversationRow[];
  locale: Locale;
  theme?: Theme;
  codePreviewSettings?: CodePreviewSettings;
  artifactNames?: ReadonlyMap<string, string>;
  artifactWorkspaceRelativePaths?: ReadonlyMap<string, string>;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  unsupportedRowCount?: number;
  onOpenShareUrl?: () => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
}) {
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage({ id: "conversationShare.import.dividerLabel" });
  return (
    <div data-conversation-share-import-notice="true" className="flex w-full flex-col">
      <ConversationShareReadonlyTimeline
        rows={rows}
        locale={locale}
        {...(theme ? { theme } : {})}
        {...(codePreviewSettings ? { codePreviewSettings } : {})}
        artifactNames={artifactNames}
        artifactWorkspaceRelativePaths={artifactWorkspaceRelativePaths}
        {...(workspacePath ? { workspacePath } : {})}
        {...(workspaceIdentity ? { workspaceIdentity } : {})}
        {...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {})}
        unsupportedRowCount={unsupportedRowCount}
        artifactOpenAction={OpenSplitButton}
        onOpenFileLink={onOpenFileLink}
        onOpenCodeViewer={onOpenCodeViewer}
      />
      {onOpenShareUrl ? (
        <button
          type="button"
          data-conversation-share-import-divider="true"
          className="group/share-import flex w-full items-center gap-3 px-4 py-2 text-ui-base text-foreground-subtle hover:text-foreground"
          onClick={onOpenShareUrl}
        >
          <span aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
          <SquareArrowRightEnter aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 break-words text-center leading-5 underline-offset-4 group-hover/share-import:underline">
            {label}
          </span>
          <span aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
        </button>
      ) : (
        <div
          data-conversation-share-import-divider="true"
          className="flex w-full items-center gap-3 px-4 py-2 text-ui-base text-foreground-subtle"
        >
          <span aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
          <SquareArrowRightEnter aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 break-words text-center leading-5">{label}</span>
          <span aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
        </div>
      )}
    </div>
  );
});
