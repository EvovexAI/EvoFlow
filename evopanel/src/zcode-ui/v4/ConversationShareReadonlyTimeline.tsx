/* oxlint-disable eslint(max-lines) -- Share 与 Desktop 共用的只读 Row/turn presentation 需要保持在同一安全边界。
 * 安全边界约束：本文件被匿名公开分享页（packages/web/src/share）直接引用，新增依赖必须考虑
 * 公开页 bundle 体积与无 Desktop 宿主（window.zcode / PlatformProvider / tab store）的运行环境；
 * Desktop 专属能力（如 open-with 子树）一律由消费方经组件注入，不得静态 import。 */
import {
  createContext,
  Fragment,
  memo,
  type ComponentType,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  ChevronRightIcon,
  FilePenLineIcon,
  FileTextIcon,
  FilesIcon,
  InfoIcon,
  MonitorIcon,
  SearchIcon,
  SquareTerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { getCompactToolCallStatusMessageId, type Locale } from "@zcode/shared";
import type {
  ArtifactRow,
  AssistantTextRow,
  ConversationRow,
  ReasoningRow,
  TimelineMarkerRow,
  ToolCallRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { MessageResponse, type MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { ConversationUserInputBody } from "@/v4/ConversationUserInputBody.js";
import { ConversationUserInputContent } from "@/v4/ConversationUserInputContent.js";
import { PluginReferenceIconProvider } from "@/v4/pluginReferenceIconContext.js";
import {
  buildAssistantWorkRenderItems,
  type ConversationAssistantWorkRenderItem,
} from "@/v4/conversationAssistantWorkItems.js";
import type { ConversationCuaGroupRenderItem } from "@/v4/conversationCuaGroups.js";
import {
  buildConversationTurnRenderUnits,
  type ConversationTurnRenderUnit,
} from "@/v4/conversationTurnRenderUnits.js";
import type { AssistantWorkRow, ConversationTurnFlowItem } from "@/v4/conversationTurnFlowItems.js";
import type { ConversationTurnWorkSegment } from "@/v4/conversationTurnWorkSegments.js";
import { formatConversationWorkDuration } from "@/v4/conversationWorkDuration.js";
import { normalizeConversationShareMarkdown } from "@/v4/conversationShareMarkdown.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import {
  DEFAULT_CODE_PREVIEW_SETTINGS,
  type CodePreviewSettings,
} from "@/lib/codePreviewSettings.js";
import { ZCodeIntlProvider, useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { Theme } from "@/useTheme.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { formatAttachmentSize } from "@/lib/chatAttachmentMetadata.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { isAbsoluteFilePath, joinFilePath } from "@/lib/path.js";
// 仅类型引用，构建期擦除：静态 import OpenSplitButton 会把其整棵 open-with 子树
// （platform hooks、tab store、workspace-file-tree/model、editorPreference）打进匿名
// 公开页 bundle，因此打开动作组件改由 Desktop 消费方经 artifactOpenAction 注入。
import type { OpenSplitButtonTarget } from "@/OpenSplitButton.js";

export interface ConversationShareReadonlyTimelineProps {
  rows: readonly ConversationRow[];
  locale?: Locale;
  theme?: Theme;
  codePreviewSettings?: CodePreviewSettings;
  artifactUrls?: ReadonlyMap<string, string>;
  artifactNames?: ReadonlyMap<string, string>;
  artifactWorkspaceRelativePaths?: ReadonlyMap<string, string>;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  /**
   * Desktop 侧注入的 artifact 打开动作组件（实现即 OpenSplitButton）。
   * 公开分享页不传：一是公开页没有本地打开能力，二是避免 open-with 子树进公开页 bundle。
   */
  artifactOpenAction?: ConversationShareArtifactOpenAction;
  /**
   * 本 build 认不出、已被跳过的行数（见 decodeConversationShareRows）。
   *
   * >0 时在时间线顶部出一条中性提示。必须提示：分享内容是跨版本流动的，老客户端/老落地页
   * 镜像遇到新 row kind 时会静默少几行，用户没法自己发现——他会以为分享者就发了这些。
   */
  unsupportedRowCount?: number;
}

/** 注入契约：Desktop 侧提供的「带本地打开动作」组件，与 OpenSplitButton 的关键 props 对齐。 */
export type ConversationShareArtifactOpenAction = ComponentType<{
  target: OpenSplitButtonTarget;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
}>;

interface ReadonlyLabels {
  history: string;
  computerUse: string;
  explore: string;
  execute: string;
  changes: string;
  artifactPreview: string;
  markerCompact: string;
  markerModelChange: string;
  unsupportedRows: string;
}

/**
 * 只读时间线里 marker 的文案。
 *
 * 这里刻意不复刻实时时间线的全部状态细分（compact 的 started/failed/interrupted、
 * modelChange 的 from→to、goalVerify 的迭代序号）：发布会拦掉运行中的 marker，
 * 而 from→to 需要 model-provider store 才能解析显示名，只读历史里价值很低。
 * 识别不了的类型返回 null，由调用方整行不渲染 —— 绝不回退成打印枚举名。
 */
function resolveReadonlyMarkerLabel(
  marker: TimelineMarkerRow["marker"],
  labels: ReadonlyLabels,
): string | null {
  switch (marker.type) {
    case "compact":
      return marker.status === "success" ? labels.markerCompact : null;
    case "modelChange":
      return labels.markerModelChange;
    default:
      return null;
  }
}

const EMPTY_ARTIFACT_URLS: ReadonlyMap<string, string> = new Map();
const EMPTY_ARTIFACT_NAMES: ReadonlyMap<string, string> = new Map();
const EMPTY_ARTIFACT_WORKSPACE_RELATIVE_PATHS: ReadonlyMap<string, string> = new Map();
const EMPTY_ATTACHMENTS: readonly unknown[] = [];

interface ArtifactOpenContextValue {
  artifactWorkspaceRelativePaths: ReadonlyMap<string, string>;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  openAction?: ConversationShareArtifactOpenAction;
}

const ArtifactOpenContext = createContext<ArtifactOpenContextValue | null>(null);

function resolveImportedArtifactPath(
  workspacePath: string,
  workspaceRelativePath: string | undefined,
): string | null {
  // 取舍：这里只校验形状（.zcode-share/<dir>/shared-artifacts/<file> 四段），刻意不把
  // 段 2 与导入记录的 shareId 交叉比对。元数据由本端导入服务自写（conversationShareService
  // 落盘时用 sanitizeFileSegment(share_id) 作目录名），自洽；若在 UI 侧比对，就得复制
  // service 层的 sanitize 规则，两边漂移会让合法导入静默丢打开按钮，而收益仅是防住
  // 「指向另一 share 目录」这种一致性噪声——路径仍被限制在 workspace 的
  // .zcode-share/*/shared-artifacts/ 内，无越权读放大。
  const normalizedPath = workspaceRelativePath?.trim();
  if (!normalizedPath || isAbsoluteFilePath(normalizedPath)) {
    return null;
  }

  const segments = normalizedPath.replace(/\\/g, "/").split("/");
  if (
    segments.length !== 4 ||
    segments.some((segment) => !segment || segment === "." || segment === "..") ||
    segments[0] !== ".zcode-share" ||
    segments[2] !== "shared-artifacts"
  ) {
    return null;
  }

  return joinFilePath(workspacePath, segments.join("/"));
}

function UserInputPresentation({
  row,
  artifactUrls,
}: {
  row: UserInputRow;
  artifactUrls: ReadonlyMap<string, string>;
}) {
  const attachments = (row.attachments ?? []).map((attachment) => {
    const artifactId = attachment.ref.split("/").at(-1) ?? "";
    return { attachment, url: artifactUrls.get(artifactId) };
  });
  return (
    <div className="flex flex-col items-end" data-conversation-share-row-kind="userInput">
      {attachments.length > 0 ? (
        <div
          className="mb-2 flex max-w-xl flex-wrap justify-end gap-2"
          data-v4-user-input-attachments="true"
        >
          {attachments.map(({ attachment, url }) => (
            <a
              key={attachment.ref}
              href={url}
              target={url ? "_blank" : undefined}
              rel={url ? "noopener noreferrer" : undefined}
              aria-disabled={url ? undefined : "true"}
              className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-sm text-foreground hover:bg-surface-hover"
              data-v4-user-input-attachment-pill="true"
            >
              <FileTextIcon aria-hidden="true" className="size-4 shrink-0" />
              <span className="min-w-0 max-w-64 truncate">{attachment.fileName}</span>
              <span className="shrink-0 text-foreground-subtlest">
                {formatAttachmentSize(attachment.bytes)}
              </span>
            </a>
          ))}
        </div>
      ) : null}
      <div
        data-v4-user-input-bubble="true"
        className="flex max-w-xl flex-col gap-2 rounded-xl rounded-tr-xs border border-border bg-surface px-4 py-3 text-ui-base text-foreground"
      >
        <ConversationUserInputBody contentText={row.text} rowId={row.rowId}>
          <ConversationUserInputContent
            text={row.text}
            attachments={row.attachments ?? EMPTY_ATTACHMENTS}
          />
        </ConversationUserInputBody>
      </div>
    </div>
  );
}

const AssistantTextPresentation = memo(function AssistantTextPresentation({
  row,
  theme,
  codePreviewSettings,
  artifactNames,
  onOpenExternalUrl,
}: {
  row: AssistantTextRow;
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  artifactNames: ReadonlyMap<string, string>;
  onOpenExternalUrl: (url: string) => void;
}) {
  const markdown = useMemo(
    () => normalizeConversationShareMarkdown(row.text, artifactNames),
    [artifactNames, row.text],
  );
  return (
    <div data-conversation-share-row-kind="assistantText" className="group/assistant-row">
      <div data-conversation-selectable="true" className="w-full text-ui-base">
        <MessageResponse
          streaming={false}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          renderZCodeFileCitations={false}
          onOpenExternalUrl={onOpenExternalUrl}
        >
          {markdown}
        </MessageResponse>
      </div>
    </div>
  );
});

const ReasoningPresentation = memo(function ReasoningPresentation({ row }: { row: ReasoningRow }) {
  const durationSeconds =
    row.durationMs === undefined ? undefined : Math.max(1, Math.ceil(row.durationMs / 1000));
  return (
    <div data-conversation-share-row-kind="reasoning">
      <Reasoning
        className="w-full"
        isStreaming={false}
        autoCollapseKey={row.state}
        {...(durationSeconds === undefined ? {} : { duration: durationSeconds })}
      >
        <ReasoningTrigger streamingText={row.text} />
        <div data-conversation-selectable="true">
          <ReasoningContent>{row.text}</ReasoningContent>
        </div>
      </Reasoning>
    </div>
  );
});

function resolveToolStatusLabel(
  status: ToolCallRow["status"],
  formatMessage: (descriptor: { id: string }) => string,
) {
  const compactState =
    status === "inputStreaming" || status === "pendingApproval"
      ? "input-streaming"
      : status === "running"
        ? "input-available"
        : status === "success"
          ? "output-available"
          : "output-error";
  return formatMessage({
    id: getCompactToolCallStatusMessageId(
      compactState,
      status === "cancelled" ? "stopped" : undefined,
    ),
  });
}

function readToolInputSummary(input: unknown, keys: readonly string[]): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

const ToolCallPresentation = memo(function ToolCallPresentation({
  row,
  theme,
  codePreviewSettings,
  artifactNames,
  onOpenExternalUrl,
}: {
  row: ToolCallRow;
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  artifactNames: ReadonlyMap<string, string>;
  onOpenExternalUrl: (url: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const output = row.output?.text?.trim();
  const markdown = useMemo(
    () => (output ? normalizeConversationShareMarkdown(output, artifactNames) : ""),
    [artifactNames, output],
  );
  const statusLabel = resolveToolStatusLabel(row.status, intl.formatMessage);
  const identity = useMemo(
    () => resolveToolCallIdentity({ toolName: row.toolName, kind: row.toolName, input: row.input }),
    [row.input, row.toolName],
  );
  const searchSummary =
    identity.family === "search"
      ? readToolInputSummary(row.input, ["query", "pattern", "prompt"])
      : null;
  const presentation =
    identity.family === "search"
      ? {
          icon: <SearchIcon className="size-4 shrink-0" aria-hidden="true" />,
          kindLabel: intl.formatMessage({ id: "chat.toolCall.kind.search" }),
          primaryText: searchSummary ?? statusLabel,
        }
      : identity.family === "shell"
        ? {
            icon: <SquareTerminalIcon className="size-4 shrink-0" aria-hidden="true" />,
            kindLabel: intl.formatMessage({ id: "chat.toolCall.kind.terminal" }),
            primaryText: statusLabel,
          }
        : identity.family === "file-read"
          ? {
              icon: <FileTextIcon className="size-4 shrink-0" aria-hidden="true" />,
              kindLabel: intl.formatMessage({ id: "chat.toolCall.kind.read" }),
              primaryText: statusLabel,
            }
          : identity.family === "file-write"
            ? {
                icon: <FilePenLineIcon className="size-4 shrink-0" aria-hidden="true" />,
                kindLabel: intl.formatMessage({ id: "chat.toolCall.kind.edit" }),
                primaryText: statusLabel,
              }
            : {
                icon: <WrenchIcon className="size-4 shrink-0" aria-hidden="true" />,
                kindLabel: row.toolName,
                primaryText: statusLabel,
              };
  const content: ReactNode = markdown ? (
    <MessageResponse
      theme={theme}
      codePreviewSettings={codePreviewSettings}
      renderZCodeFileCitations={false}
      onOpenExternalUrl={onOpenExternalUrl}
    >
      {markdown}
    </MessageResponse>
  ) : (
    <span className="text-ui-sm text-foreground-subtle">{statusLabel}</span>
  );
  const isRunning =
    row.status === "inputStreaming" || row.status === "pendingApproval" || row.status === "running";
  return (
    <div data-conversation-share-row-kind="toolCall" data-conversation-selectable="true">
      <ToolLayout
        toolId={row.toolCallId}
        icon={presentation.icon}
        kindLabel={presentation.kindLabel}
        primaryText={presentation.primaryText}
        isRunning={isRunning}
        canToggle={Boolean(markdown)}
        content={content}
        disableSummaryContentAnimation
      />
    </div>
  );
});

/** 与正文的 AssistantPreviewCards 对齐：同一套 chat.previewCards.* 副标题词汇。 */
const ARTIFACT_SUBTITLE_MESSAGE_IDS: Readonly<Record<string, string>> = {
  pdf: "chat.previewCards.pdf",
  docx: "chat.previewCards.docx",
  xlsx: "chat.previewCards.xlsx",
  pptx: "chat.previewCards.pptx",
  md: "chat.previewCards.markdown",
  text: "chat.previewCards.text",
  html: "chat.previewCards.htmlWebsite",
};

const ArtifactPresentation = memo(function ArtifactPresentation({
  row,
  url,
  previewLabel,
}: {
  row: ArtifactRow;
  url?: string;
  previewLabel: string;
}) {
  const { intl } = useZCodeIntl();
  const artifactOpenContext = useContext(ArtifactOpenContext);
  const OpenAction = artifactOpenContext?.openAction;
  // 与 AssistantPreviewCards 保持同一视觉：44px 图标底板 + 真实文件类型图标 + 中粗标题 + 类型副标题。
  const descriptor = resolveFileDisplayDescriptor(row.displayName);
  const subtitleMessageId = ARTIFACT_SUBTITLE_MESSAGE_IDS[row.artifactType];
  const typeLabel = subtitleMessageId
    ? intl.formatMessage({ id: subtitleMessageId })
    : row.artifactType.toUpperCase();
  const localPath =
    artifactOpenContext && !url
      ? resolveImportedArtifactPath(
          artifactOpenContext.workspacePath,
          artifactOpenContext.artifactWorkspaceRelativePaths.get(row.artifactVersionId),
        )
      : null;
  const previewSource: CodeViewerSource | null =
    artifactOpenContext && localPath
      ? {
          type: "file",
          title: row.displayName,
          path: localPath,
          workspacePath: artifactOpenContext.workspacePath,
          ...(artifactOpenContext.workspaceIdentity
            ? { workspaceIdentity: artifactOpenContext.workspaceIdentity }
            : {}),
          ...(artifactOpenContext.workspaceRemoteSessionId
            ? { workspaceRemoteSessionId: artifactOpenContext.workspaceRemoteSessionId }
            : {}),
        }
      : null;
  return (
    // ReadonlyTurn 已提供与正文一致的水平 inset，这里再加 px-4 会让资源卡片两侧各多缩进 16px。
    <div data-conversation-share-row-kind="artifact" className="py-1">
      <div className="flex w-full items-center gap-3 rounded-xl border border-card-border bg-card p-3 pr-4 text-foreground">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-md bg-background text-foreground-subtle">
          {descriptor ? (
            <FileDisplayIcon src={descriptor.fileIconSrc} size={24} />
          ) : (
            <FileTextIcon className="size-6" aria-hidden="true" />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="truncate text-ui-base font-medium leading-5">{row.displayName}</p>
          <p className="truncate text-ui-base leading-5 text-foreground-subtlest">
            {typeLabel} · {formatAttachmentSize(row.sizeBytes)}
          </p>
        </div>
        {url ? (
          // 与正文卡片右侧的 OpenSplitButton 同一视觉（h-7 圆角描边 + input 底色）；
          // 资源 URL 实际触发下载，原「预览文件」文案会误导用户；分享页只保留「下载文件」动作。
          // data-share-preview-button 是测试断言用的结构性标记：语义锁定不依赖 Tailwind 类字符串。
          <div
            data-share-preview-button="true"
            className="flex h-7 shrink-0 items-center overflow-hidden rounded-lg border border-border bg-input transition-all hover:border-border-hover"
          >
            <button
              type="button"
              className="flex h-7 items-center gap-1 px-2 text-ui-sm text-foreground"
              onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
            >
              {previewLabel}
            </button>
          </div>
        ) : previewSource && OpenAction ? (
          <OpenAction
            target={{
              type: "file",
              path: previewSource.path,
              title: row.displayName,
              label: row.displayName,
              previewSource,
            }}
            onOpenFileLink={artifactOpenContext?.onOpenFileLink}
            onOpenCodeViewer={artifactOpenContext?.onOpenCodeViewer}
          />
        ) : null}
      </div>
    </div>
  );
});

function renderReadonlyRow(
  row: ConversationRow,
  theme: Theme,
  codePreviewSettings: CodePreviewSettings,
  artifactUrls: ReadonlyMap<string, string>,
  artifactNames: ReadonlyMap<string, string>,
  labels: ReadonlyLabels,
  onOpenExternalUrl: (url: string) => void,
): ReactNode {
  switch (row.kind) {
    case "userInput":
      return <UserInputPresentation key={row.rowId} row={row} artifactUrls={artifactUrls} />;
    case "assistantText":
      return (
        <AssistantTextPresentation
          key={row.rowId}
          row={row}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          artifactNames={artifactNames}
          onOpenExternalUrl={onOpenExternalUrl}
        />
      );
    case "reasoning":
      return <ReasoningPresentation key={row.rowId} row={row} />;
    case "toolCall":
      return (
        <ToolCallPresentation
          key={row.rowId}
          row={row}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          artifactNames={artifactNames}
          onOpenExternalUrl={onOpenExternalUrl}
        />
      );
    case "artifact":
      return (
        <ArtifactPresentation
          key={row.rowId}
          row={row}
          url={artifactUrls.get(row.artifactVersionId)}
          previewLabel={labels.artifactPreview}
        />
      );
    case "timelineMarker": {
      // 这里原本直接把 row.marker.type 当文案渲染，于是分享页会出现一条写着
      // 字面量 compact / modelChange / goalVerify 的分割线（发布只剥掉 fork/checkpoint 类）。
      // 改为取本地化文案；识别不了的类型不渲染，不再泄漏枚举名。
      const markerLabel = resolveReadonlyMarkerLabel(row.marker, labels);
      if (!markerLabel) return null;
      return (
        <div
          key={row.rowId}
          data-conversation-share-row-kind="timelineMarker"
          data-marker-type={row.marker.type}
          className="flex w-full items-center gap-3 px-4 py-2 text-ui-base text-foreground-subtle"
        >
          <div aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
          <span className="min-w-0 break-words text-center leading-5">{markerLabel}</span>
          <div aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
        </div>
      );
    }
    case "subagent":
    case "hookInvocation":
    case "turnHeader":
      return null;
  }
}

type GroupedToolItem = Extract<
  ConversationAssistantWorkRenderItem,
  { kind: "cuaGroup" | "exploreGroup" | "executeGroup" | "changesGroup" }
>;

function GroupedToolPresentation({
  item,
  theme,
  codePreviewSettings,
  artifactUrls,
  artifactNames,
  labels,
  onOpenExternalUrl,
}: {
  item: GroupedToolItem;
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  artifactUrls: ReadonlyMap<string, string>;
  artifactNames: ReadonlyMap<string, string>;
  labels: ReadonlyLabels;
  onOpenExternalUrl: (url: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const rows = item.rows;
  const groupLabel =
    item.kind === "cuaGroup"
      ? labels.computerUse
      : item.kind === "exploreGroup"
        ? labels.explore
        : item.kind === "executeGroup"
          ? labels.execute
          : labels.changes;
  const groupIcon =
    item.kind === "cuaGroup" ? (
      <MonitorIcon className="size-4 shrink-0" aria-hidden="true" />
    ) : item.kind === "executeGroup" ? (
      <SquareTerminalIcon className="size-4 shrink-0" aria-hidden="true" />
    ) : item.kind === "changesGroup" ? (
      <FilesIcon className="size-4 shrink-0" aria-hidden="true" />
    ) : (
      <SearchIcon className="size-4 shrink-0" aria-hidden="true" />
    );
  const hasRunningRow = rows.some(
    (row) =>
      row.status === "inputStreaming" ||
      row.status === "pendingApproval" ||
      row.status === "running",
  );
  const hasFailedRow = rows.some((row) => row.status === "error" || row.status === "cancelled");
  const groupStatus: ToolCallRow["status"] = hasRunningRow
    ? "running"
    : hasFailedRow
      ? "error"
      : "success";
  const content = (
    <div className="flex flex-col gap-4">
      {item.kind === "cuaGroup"
        ? item.events.map((event) =>
            event.kind === "tool" ? (
              <ToolCallPresentation
                key={event.row.rowId}
                row={event.row}
                theme={theme}
                codePreviewSettings={codePreviewSettings}
                artifactNames={artifactNames}
                onOpenExternalUrl={onOpenExternalUrl}
              />
            ) : event.kind === "assistantMessage" ? (
              <AssistantTextPresentation
                key={event.row.rowId}
                row={event.row}
                theme={theme}
                codePreviewSettings={codePreviewSettings}
                artifactNames={artifactNames}
                onOpenExternalUrl={onOpenExternalUrl}
              />
            ) : (
              <ReasoningPresentation key={event.row.rowId} row={event.row} />
            ),
          )
        : rows.map((row) =>
            renderReadonlyRow(
              row,
              theme,
              codePreviewSettings,
              artifactUrls,
              artifactNames,
              labels,
              onOpenExternalUrl,
            ),
          )}
    </div>
  );
  const statusLabel = resolveToolStatusLabel(groupStatus, intl.formatMessage);
  return (
    <div data-conversation-share-work-group={item.kind} data-conversation-selectable="true">
      <ToolLayout
        toolId={item.key}
        icon={groupIcon}
        kindLabel={groupLabel}
        primaryText={statusLabel}
        isRunning={hasRunningRow}
        canToggle={rows.length > 0}
        content={content}
        disableSummaryContentAnimation
      />
    </div>
  );
}

function ReadonlyAssistantWorkItems({
  rows,
  stageTailIsRunning,
  theme,
  codePreviewSettings,
  artifactUrls,
  artifactNames,
  labels,
  onOpenExternalUrl,
}: {
  rows: readonly AssistantWorkRow[];
  stageTailIsRunning: boolean;
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  artifactUrls: ReadonlyMap<string, string>;
  artifactNames: ReadonlyMap<string, string>;
  labels: ReadonlyLabels;
  onOpenExternalUrl: (url: string) => void;
}) {
  const items = useMemo(
    () =>
      buildAssistantWorkRenderItems(
        rows,
        { messageStreamShowReasoning: true },
        {
          stageTailIsRunning,
          enableCuaGrouping: true,
          enableExploreGrouping: true,
          enableTerminalGrouping: true,
          enableChangesGrouping: false,
        },
      ),
    [rows, stageTailIsRunning],
  );
  return (
    <div className="flex flex-col gap-4" data-conversation-share-work-items>
      {items.map((item) => {
        if (item.kind === "row") {
          return renderReadonlyRow(
            item.row,
            theme,
            codePreviewSettings,
            artifactUrls,
            artifactNames,
            labels,
            onOpenExternalUrl,
          );
        }
        if (item.kind === "agentToolCall") {
          return (
            <ToolCallPresentation
              key={item.key}
              row={item.row}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              artifactNames={artifactNames}
              onOpenExternalUrl={onOpenExternalUrl}
            />
          );
        }
        return (
          <GroupedToolPresentation
            key={item.key}
            item={item}
            theme={theme}
            codePreviewSettings={codePreviewSettings}
            artifactUrls={artifactUrls}
            artifactNames={artifactNames}
            labels={labels}
            onOpenExternalUrl={onOpenExternalUrl}
          />
        );
      })}
    </div>
  );
}

function ReadonlyHistoryStatus({
  segment,
  open,
  labels,
  locale,
}: {
  segment: ConversationTurnWorkSegment;
  open: boolean;
  labels: ReadonlyLabels;
  locale: Locale;
}) {
  const { intl } = useZCodeIntl();
  const duration = formatConversationWorkDuration(segment.workStatus?.durationMs, intl, locale);
  const label =
    segment.workStatus?.state === "interrupted"
      ? intl.formatMessage({ id: "chat.history.stopped" })
      : segment.workStatus?.state === "running"
        ? intl.formatMessage({ id: "chat.history.workingFor" }, { duration: duration ?? "" })
        : duration
          ? intl.formatMessage({ id: "chat.history.workedFor" }, { duration })
          : labels.history;
  return (
    <div className="flex w-full border-b border-border/50 pb-2">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          data-conversation-share-history-trigger="true"
          data-history-open={String(open)}
          className="group/history-message inline-flex max-w-full items-center gap-2 text-left text-ui-base text-foreground-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
        >
          <span className="truncate">{label}</span>
          {!segment.assistantHistoryDefaultOpen ? (
            <ChevronRightIcon
              aria-hidden="true"
              className={`size-4 shrink-0 text-foreground-subtlest opacity-70 transition-transform ${open ? "rotate-90" : "rotate-0"}`}
            />
          ) : null}
        </button>
      </CollapsibleTrigger>
    </div>
  );
}

function ReadonlyCuaGroup({
  item,
  theme,
  codePreviewSettings,
  artifactUrls,
  artifactNames,
  labels,
  onOpenExternalUrl,
}: {
  item: ConversationCuaGroupRenderItem;
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  artifactUrls: ReadonlyMap<string, string>;
  artifactNames: ReadonlyMap<string, string>;
  labels: ReadonlyLabels;
  onOpenExternalUrl: (url: string) => void;
}) {
  return (
    <GroupedToolPresentation
      item={item}
      theme={theme}
      codePreviewSettings={codePreviewSettings}
      artifactUrls={artifactUrls}
      artifactNames={artifactNames}
      labels={labels}
      onOpenExternalUrl={onOpenExternalUrl}
    />
  );
}

function ReadonlySegment({
  segment,
  locale,
  theme,
  codePreviewSettings,
  artifactUrls,
  artifactNames,
  labels,
  onOpenExternalUrl,
}: {
  segment: ConversationTurnWorkSegment;
  locale: Locale;
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  artifactUrls: ReadonlyMap<string, string>;
  artifactNames: ReadonlyMap<string, string>;
  labels: ReadonlyLabels;
  onOpenExternalUrl: (url: string) => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(segment.assistantHistoryDefaultOpen);
  useEffect(() => {
    setHistoryOpen(segment.assistantHistoryDefaultOpen);
  }, [segment.assistantHistoryDefaultOpen, segment.key]);
  const hasHistory = segment.flowItems.some(
    (item) =>
      item.kind === "assistantHistory" ||
      (item.kind === "cuaGroup" && item.flowKind === "assistantHistory"),
  );
  const open = segment.assistantHistoryDefaultOpen || historyOpen;
  const firstAssistantFlowItemIndex = segment.flowItems.findIndex(
    (flowItem) => flowItem.kind !== "userInput",
  );
  return (
    <Collapsible
      open={open}
      onOpenChange={segment.assistantHistoryDefaultOpen ? undefined : setHistoryOpen}
      className="history-message flex flex-col [&>*+*:not([data-slot='collapsible-content'])]:mt-5"
    >
      {segment.flowItems.map((item: ConversationTurnFlowItem, index) => {
        let content: ReactNode;
        if (item.kind === "userInput") {
          content = <UserInputPresentation row={item.row} artifactUrls={artifactUrls} />;
        } else if (item.kind === "assistantText") {
          content = (
            <AssistantTextPresentation
              row={item.row}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              artifactNames={artifactNames}
              onOpenExternalUrl={onOpenExternalUrl}
            />
          );
        } else if (item.kind === "cuaGroup") {
          const group = (
            <ReadonlyCuaGroup
              item={item}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              artifactUrls={artifactUrls}
              artifactNames={artifactNames}
              labels={labels}
              onOpenExternalUrl={onOpenExternalUrl}
            />
          );
          content =
            item.flowKind === "assistantHistory" ? (
              <CollapsibleContent data-history-open={String(open)}>
                <div className="pt-5">{group}</div>
              </CollapsibleContent>
            ) : (
              <div>{group}</div>
            );
        } else if (item.kind === "assistantHistory") {
          content = (
            <CollapsibleContent data-history-open={String(open)}>
              <div className="pt-5">
                <ReadonlyAssistantWorkItems
                  rows={item.rows}
                  stageTailIsRunning={false}
                  theme={theme}
                  codePreviewSettings={codePreviewSettings}
                  artifactUrls={artifactUrls}
                  artifactNames={artifactNames}
                  labels={labels}
                  onOpenExternalUrl={onOpenExternalUrl}
                />
              </div>
            </CollapsibleContent>
          );
        } else {
          content = (
            <ReadonlyAssistantWorkItems
              rows={item.rows}
              stageTailIsRunning={
                segment.workStatus?.state === "running" && index === segment.flowItems.length - 1
              }
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              artifactUrls={artifactUrls}
              artifactNames={artifactNames}
              labels={labels}
              onOpenExternalUrl={onOpenExternalUrl}
            />
          );
        }
        const showHistoryStatus = hasHistory && index === firstAssistantFlowItemIndex;
        return (
          <Fragment key={`${segment.key}:${item.kind}:${index}`}>
            {showHistoryStatus ? (
              <ReadonlyHistoryStatus
                segment={segment}
                open={open}
                labels={labels}
                locale={locale}
              />
            ) : null}
            {content}
          </Fragment>
        );
      })}
      {hasHistory && segment.flowItems.length === 0 ? (
        <ReadonlyHistoryStatus segment={segment} open={open} labels={labels} locale={locale} />
      ) : null}
    </Collapsible>
  );
}

function fallbackWorkSegment(unit: ConversationTurnRenderUnit): ConversationTurnWorkSegment {
  return {
    key: unit.key,
    flowItems: unit.flowItems,
    assistantWorkRows: unit.assistantWorkRows,
    assistantHistoryRows: unit.assistantHistoryRows,
    assistantFollowingRows: unit.assistantFollowingRows,
    assistantHistoryDefaultOpen: unit.assistantHistoryDefaultOpen,
    ...(unit.workStatus ? { workStatus: unit.workStatus } : {}),
  };
}

function ReadonlyTurn({
  unit,
  locale,
  theme,
  codePreviewSettings,
  artifactUrls,
  artifactNames,
  labels,
  onOpenExternalUrl,
}: {
  unit: ConversationTurnRenderUnit;
  locale: Locale;
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  artifactUrls: ReadonlyMap<string, string>;
  artifactNames: ReadonlyMap<string, string>;
  labels: ReadonlyLabels;
  onOpenExternalUrl: (url: string) => void;
}) {
  const segments = unit.workSegments?.length ? unit.workSegments : [fallbackWorkSegment(unit)];
  return (
    <section
      data-conversation-share-turn={unit.turnId}
      className="mx-auto flex w-full flex-col gap-5 px-4 pb-5 pt-14 @md/conversation:px-6 [content-visibility:auto] [contain-intrinsic-size:0_420px]"
    >
      {unit.leadingBoundaryRows.map((row) =>
        renderReadonlyRow(
          row,
          theme,
          codePreviewSettings,
          artifactUrls,
          artifactNames,
          labels,
          onOpenExternalUrl,
        ),
      )}
      <div className="group/assistant-turn flex w-full flex-col gap-5">
        {segments.map((segment) => (
          <ReadonlySegment
            key={segment.key}
            segment={segment}
            locale={locale}
            theme={theme}
            codePreviewSettings={codePreviewSettings}
            artifactUrls={artifactUrls}
            artifactNames={artifactNames}
            labels={labels}
            onOpenExternalUrl={onOpenExternalUrl}
          />
        ))}
        {unit.browserTurnEndRows.length > 0 ? (
          <ReadonlyAssistantWorkItems
            rows={unit.browserTurnEndRows}
            stageTailIsRunning={false}
            theme={theme}
            codePreviewSettings={codePreviewSettings}
            artifactUrls={artifactUrls}
            artifactNames={artifactNames}
            labels={labels}
            onOpenExternalUrl={onOpenExternalUrl}
          />
        ) : null}
        {unit.assistantTailRows.length > 0 ? (
          <ReadonlyAssistantWorkItems
            rows={unit.assistantTailRows}
            stageTailIsRunning={false}
            theme={theme}
            codePreviewSettings={codePreviewSettings}
            artifactUrls={artifactUrls}
            artifactNames={artifactNames}
            labels={labels}
            onOpenExternalUrl={onOpenExternalUrl}
          />
        ) : null}
      </div>
    </section>
  );
}

export function ConversationShareReadonlyTimeline({
  rows,
  locale = "zh-CN",
  theme = "system",
  codePreviewSettings = DEFAULT_CODE_PREVIEW_SETTINGS,
  artifactUrls = EMPTY_ARTIFACT_URLS,
  artifactNames = EMPTY_ARTIFACT_NAMES,
  artifactWorkspaceRelativePaths = EMPTY_ARTIFACT_WORKSPACE_RELATIVE_PATHS,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  onOpenFileLink,
  onOpenCodeViewer,
  artifactOpenAction,
  unsupportedRowCount = 0,
}: ConversationShareReadonlyTimelineProps) {
  const units = buildConversationTurnRenderUnits(rows);
  const openShareExternalUrl = useCallback((url: string) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      window.open(parsed.toString(), "_blank", "noopener,noreferrer");
    } catch {
      // 外链来自不可信 Markdown；解析失败时保持不可操作，不交给浏览器未知协议。
    }
  }, []);
  const labels: ReadonlyLabels =
    locale === "zh-CN"
      ? {
          history: "思考过程",
          computerUse: "电脑操作",
          explore: "探索",
          execute: "执行",
          changes: "修改",
          artifactPreview: "下载文件",
          markerCompact: "上下文已压缩",
          markerModelChange: "模型已切换",
          unsupportedRows: "部分内容需要更新 ZCode 查看",
        }
      : {
          history: "Reasoning",
          computerUse: "Computer use",
          explore: "Explore",
          execute: "Execute",
          changes: "Changes",
          artifactPreview: "Download file",
          markerCompact: "Context compacted",
          markerModelChange: "Model switched",
          unsupportedRows: "Some content requires a newer version of ZCode",
        };
  const artifactOpenContext = useMemo<ArtifactOpenContextValue | null>(() => {
    if (
      !workspacePath ||
      artifactWorkspaceRelativePaths.size === 0 ||
      (!onOpenFileLink && !onOpenCodeViewer) ||
      !artifactOpenAction
    ) {
      return null;
    }

    return {
      artifactWorkspaceRelativePaths,
      workspacePath,
      openAction: artifactOpenAction,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {}),
      ...(onOpenFileLink ? { onOpenFileLink } : {}),
      ...(onOpenCodeViewer ? { onOpenCodeViewer } : {}),
    };
  }, [
    artifactOpenAction,
    artifactWorkspaceRelativePaths,
    onOpenCodeViewer,
    onOpenFileLink,
    workspaceIdentity,
    workspacePath,
    workspaceRemoteSessionId,
  ]);
  return (
    <TooltipProvider delayDuration={0}>
      <ZCodeIntlProvider initialLocale={locale}>
        <PluginReferenceIconProvider value={null}>
          <ArtifactOpenContext.Provider value={artifactOpenContext}>
            <div className="@container/conversation flex flex-col" data-conversation-share-timeline>
              {unsupportedRowCount > 0 ? (
                // 中性信息语义，不用黄色 warning：分享本身没出错，只是这个 build 认不出其中几行。
                <div
                  data-conversation-share-unsupported-notice="true"
                  className="mx-4 mb-2 flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-ui-xs text-foreground-subtle"
                >
                  <InfoIcon aria-hidden="true" className="size-3.5 shrink-0" />
                  <span className="min-w-0 break-words">{labels.unsupportedRows}</span>
                </div>
              ) : null}
              {units.map((unit) => (
                <ReadonlyTurn
                  key={unit.key}
                  unit={unit}
                  locale={locale}
                  theme={theme}
                  codePreviewSettings={codePreviewSettings}
                  artifactUrls={artifactUrls}
                  artifactNames={artifactNames}
                  labels={labels}
                  onOpenExternalUrl={openShareExternalUrl}
                />
              ))}
            </div>
          </ArtifactOpenContext.Provider>
        </PluginReferenceIconProvider>
      </ZCodeIntlProvider>
    </TooltipProvider>
  );
}
