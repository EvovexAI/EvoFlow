/* oxlint-disable eslint(max-lines) -- WorkbenchLeafPane 集中承载 pane focus、per-pane provider、恢复守卫和 session drop target；拆散会让 DnD/focus/session 绑定链路跨文件跳转，后续稳定后再按职责抽离。 */
// 分屏叶子 pane：Focus 层外壳 + per-pane 数据面接线 + 恢复守卫。宿主 = V4WorkspaceChatArea。
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from "react";
import { TID_V4_PANE_SHELL, testId } from "@zcode/shared";
import type {
  GitChangeSourceId,
  GitRepositorySummary,
  ZCodeProvider,
  ZCodeTaskChangeSummary,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useServices } from "@/hooks/useServices.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import type { OpenAutomationsMain } from "@/lib/taskNavigationHistory.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type {
  OpenScopedSubagentSideTabRequest,
  OpenBackgroundBashSideTabRequest,
  OpenScopedSubagentDirectorySideTabRequest,
  OpenSelectionSideChatRequest,
  OpenScopedPlanDetailSideTabRequest,
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenScopedWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  SyncSubagentSessionTabsRequest,
} from "@/lib/workspaceSidePane.js";
import { SessionPane } from "@/v4/SessionPane.js";
import type { PaneWorkspaceBadge } from "@/v4/ConversationHeader.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import {
  paneWorkspaceKey,
  V4_PRIMARY_PANE_ID,
  type PaneBinding,
  type PaneSplitSide,
  type PaneWorkspaceScope,
  type SplitDirection,
} from "@/v4/paneLayoutStore.js";
import type { WorkbenchSessionBinding } from "@/v4/workbenchGroupStore.js";
import {
  parseWorkbenchSessionDragPayload,
  resolveWorkbenchDropSide,
  type WorkbenchSessionDragPayload,
} from "@/v4/workbenchDragDrop.js";
import { registerWorkbenchPointerDropTarget } from "@/v4/workbenchPointerDragDrop.js";
import {
  acquireSessionsIndex,
  releaseSessionsIndex,
  type SessionsIndexScope,
} from "@/v4/sessionsIndexRegistry.js";
import { rectStyle, type RectExpr } from "@/v4/workbenchLayout.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";

interface ChatPaneShellProps {
  containerRef?: (element: HTMLDivElement | null) => void;
  paneId: string;
  focused: boolean;
  /** 单 pane 布局时不画焦点框（无歧义，避免视觉噪音）。 */
  showFocusIndicator: boolean;
  onFocusRequest: (paneId: string) => void;
  /** 绝对定位 rect（布局层计算的 calc 表达式）。 */
  style: CSSProperties;
  dropSide?: PaneSplitSide | null;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDragLeave?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
  children: ReactNode;
  restoredUnvalidated?: boolean;
}

const DROP_PREVIEW_STYLE: CSSProperties = {
  backgroundColor: "color-mix(in oklab, var(--color-brand) 14%, transparent)",
  boxShadow: "inset 0 0 0 1px color-mix(in oklab, var(--color-brand) 34%, transparent)",
};

const INACTIVE_PANE_OVERLAY_STYLE: CSSProperties = {
  backgroundColor: "color-mix(in oklab, var(--color-background) 34%, transparent)",
  backdropFilter: "brightness(0.94) saturate(0.94)",
};

function dropPreviewClassName(side: PaneSplitSide): string {
  switch (side) {
    case "left":
      return "left-1 top-1 bottom-1 w-1/2";
    case "right":
      return "right-1 top-1 bottom-1 w-1/2";
    case "up":
      return "left-1 right-1 top-1 h-1/2";
    case "down":
      return "left-1 right-1 bottom-1 h-1/2";
  }
}

/**
 * Focus 层外壳：点击/聚焦 pane 内任意处 → focus 该 pane（capture，不干扰子树交互）。
 * memo + 稳定回调：焦点切换只翻转 data-focused/边框类名，不牵动 pane 内容子树。
 */
const ChatPaneShell = memo(function ChatPaneShell({
  containerRef,
  paneId,
  focused,
  showFocusIndicator,
  onFocusRequest,
  style,
  dropSide,
  onDragOver,
  onDragLeave,
  onDrop,
  children,
  restoredUnvalidated = false,
}: ChatPaneShellProps) {
  const handleFocusRequest = useCallback(() => {
    onFocusRequest(paneId);
  }, [onFocusRequest, paneId]);

  return (
    <div
      ref={containerRef}
      data-testid={testId(TID_V4_PANE_SHELL, paneId)}
      data-pane-id={paneId}
      data-focused={focused ? "true" : "false"}
      data-restored-unvalidated={restoredUnvalidated ? "true" : "false"}
      onPointerDownCapture={handleFocusRequest}
      onFocusCapture={handleFocusRequest}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={style}
      className={cn(
        "absolute flex min-h-0 min-w-0 flex-col",
        showFocusIndicator && focused && "ring-1 ring-inset ring-[var(--color-brand)]",
      )}
    >
      {showFocusIndicator && !focused ? (
        <div
          aria-hidden="true"
          data-v4-pane-inactive-overlay="true"
          style={INACTIVE_PANE_OVERLAY_STYLE}
          className="pointer-events-none absolute inset-0 z-30 rounded-md transition-[background-color,backdrop-filter]"
        />
      ) : null}
      {dropSide ? (
        <div className="pointer-events-none absolute inset-0 z-50">
          <div
            aria-hidden="true"
            style={DROP_PREVIEW_STYLE}
            className={cn(
              "absolute rounded-md transition-[background-color,box-shadow]",
              dropPreviewClassName(dropSide),
            )}
          />
        </div>
      ) : null}
      {children}
    </div>
  );
});

interface PaneRestoredGuardProps {
  paneId: string;
  scope: PaneWorkspaceScope;
  sessionId: string;
  onConfirmed: (paneId: string) => void;
  onMissing: (paneId: string) => void;
}

/**
 * 持久化恢复守卫（per-pane 泛化）：localStorage 恢复的绑定可能指向已删 session
 * （删除发生在上次运行/其他窗口）。用 pane 自己 scope 的 sessions-index（按
 * endpoint + workspaceKey 隔离）等首个真 snapshot（workspaceId 就绪）后做一次
 * 存在性验证：在场 → 清 restoredUnvalidated；已删 → closePane 优雅塌缩。
 * 不用 useWorkspaceSessionsIndexItems——其聚合 memo 在
 * 订阅 effect 之前按空 store 集计算会误判「已加载且不在」；直连 registry store，
 * 订阅错误/远程 endpoint 不在场（断连代理 reject）时不判定，pane 保留为
 * error/等待连接态，交由 pane 自身 retry 兜底，不误关。
 * 必须挂在 V4PaneConversationProvider 内：useServices 取的是 pane 自己的 accessor
 * （远程 pane 走对应远程连接的 sessions-index，不误查本机 host）。
 */
function PaneRestoredGuard({
  paneId,
  scope,
  sessionId,
  onConfirmed,
  onMissing,
}: PaneRestoredGuardProps) {
  const services = useServices();
  const agentService = services.zcodeAgentService;
  const { workspacePath, workspaceIdentity, remoteSessionId } = scope;

  useEffect(() => {
    if (!agentService) {
      return;
    }
    const indexScope: SessionsIndexScope = {
      workspaceKey: paneWorkspaceKey({ workspacePath, workspaceIdentity }),
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { endpointKey: remoteSessionId } : {}),
    };
    const store = acquireSessionsIndex(indexScope, agentService);
    let disposed = false;
    let settled = false;
    const evaluate = () => {
      if (disposed || settled || store.getState().workspaceId === null) {
        return;
      }
      settled = true;
      const exists = store.getSessions().some((summary) => summary.sessionId === sessionId);
      if (exists) {
        onConfirmed(paneId);
      } else {
        onMissing(paneId);
      }
    };
    const unsubscribe = store.subscribe(evaluate);
    evaluate();
    return () => {
      disposed = true;
      unsubscribe();
      releaseSessionsIndex(indexScope, store);
    };
  }, [
    agentService,
    paneId,
    sessionId,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    onConfirmed,
    onMissing,
  ]);

  return null;
}

/** primary pane 的 shell 侧绑定（activeTaskId 选择态 + 回调，不进 paneLayoutStore）。 */
export interface WorkbenchShellBinding {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** Prompt 模板埋点当前仅覆盖 Desktop。 */
  isDesktop?: boolean;
  readOnly?: boolean;
  sessionId: string | null;
  /** Shell 当前真正激活的 task；split pane 接管 active task 时不等于 primary sessionId。 */
  activeSessionId?: string | null;
  activeSelectionSideChatSessionId?: string | null;
  provider?: ZCodeProvider;
  onSessionCreated?: (sessionId: string) => void;
  onSessionDeleted?: () => void;
  draftComposerHeader?: ReactNode;
  onPrimaryDraftDropTargetControllerChange?: (
    controller: ConversationDropTargetController | null,
  ) => void;
  gitSummary?: GitRepositorySummary | null;
  gitDirtyFileCount?: number;
  gitWorktreeReviewSourceId?: GitChangeSourceId | null;
  gitWorktreeChangeSummary?: { added: number; removed: number } | null;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  summaryPanelVariantOverride?: ChatViewSummaryPanelVariant | null;
  onSummaryPanelVariantOverrideChange?: (variant: ChatViewSummaryPanelVariant | null) => void;
  onRefreshGit?: () => void;
  onOpenGitReview?: (sourceId?: GitChangeSourceId) => void;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenAutomationsMain?: OpenAutomationsMain;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onAutoOpenAssistantPptx?: (request: AssistantPreviewCardsAutoOpenRequest) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBackgroundBash?: (request: OpenBackgroundBashSideTabRequest) => void;
  onOpenSubagentSession?: (request: OpenScopedSubagentSideTabRequest) => void;
  onOpenSubagentDirectory?: (request: OpenScopedSubagentDirectorySideTabRequest) => void;
  onSyncSubagentSessionTabs?: (request: SyncSubagentSessionTabsRequest) => void;
  onOpenSelectionSideChat?: (request: OpenSelectionSideChatRequest) => void;
  onOpenPlanDetail?: (request: OpenScopedPlanDetailSideTabRequest) => void;
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  onOpenWorkflowRunDirectory?: (request: OpenScopedWorkflowRunDirectorySideTabRequest) => void;
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
  conversationFindQuery?: string;
  conversationFindActiveIndex?: number;
  conversationFindNavigationRequestId?: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
}

interface WorkbenchLeafPaneProps {
  paneId: string;
  rect: RectExpr;
  focused: boolean;
  showFocusIndicator: boolean;
  canSplit: boolean;
  shellWorkspaceKey: string;
  /** 非 primary pane 的绑定；primary 传 null（用 shell 绑定）。 */
  binding: PaneBinding | null;
  /** session workbench group 中 primary pane 的显式绑定；无 group 时为 null。 */
  primaryBinding?: WorkbenchSessionBinding | null;
  shell: WorkbenchShellBinding;
  onFocusRequest: (paneId: string) => void;
  onSplit?: (paneId: string, direction: SplitDirection, scope: PaneWorkspaceScope) => void;
  onClosePane: (paneId: string) => void;
  onConfirmRestoredSession: (paneId: string) => void;
  onBindSession: (paneId: string, sessionId: string) => boolean | void;
  onPaneActiveSessionChange?: (scope: PaneWorkspaceScope, sessionId: string) => void;
  canDropSession?: (payload: WorkbenchSessionDragPayload) => boolean;
  onDropSession?: (
    paneId: string,
    side: PaneSplitSide,
    payload: WorkbenchSessionDragPayload,
  ) => void;
}

function workspaceBadgeFor(scope: PaneWorkspaceScope): PaneWorkspaceBadge {
  const label = scope.workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? scope.workspacePath;
  return {
    label,
    workspacePath: scope.workspacePath,
    remote: Boolean(scope.workspaceIdentity || scope.remoteSessionId),
  };
}

export function WorkbenchLeafPane({
  paneId,
  rect,
  focused,
  showFocusIndicator,
  canSplit,
  shellWorkspaceKey,
  binding,
  primaryBinding,
  shell,
  onFocusRequest,
  onSplit,
  onClosePane,
  onConfirmRestoredSession,
  onBindSession,
  onPaneActiveSessionChange,
  canDropSession,
  onDropSession,
}: WorkbenchLeafPaneProps) {
  const [dropSide, setDropSide] = useState<PaneSplitSide | null>(null);
  const isPrimary = paneId === V4_PRIMARY_PANE_ID;
  const isGroupPrimary = isPrimary && Boolean(primaryBinding);
  const scope = useMemo<PaneWorkspaceScope>(() => {
    if (!isPrimary && binding) {
      return binding.workspaceScope;
    }
    if (isPrimary && primaryBinding) {
      return primaryBinding.workspaceScope;
    }
    return {
      workspacePath: shell.workspacePath,
      ...(shell.workspaceIdentity ? { workspaceIdentity: shell.workspaceIdentity } : {}),
      ...(shell.remoteSessionId ? { remoteSessionId: shell.remoteSessionId } : {}),
    };
  }, [
    isPrimary,
    binding,
    primaryBinding,
    shell.workspacePath,
    shell.workspaceIdentity,
    shell.remoteSessionId,
  ]);

  const style = useMemo(() => rectStyle(rect), [rect]);

  const handleSplitRight = useCallback(() => {
    onSplit?.(paneId, "row", scope);
  }, [onSplit, paneId, scope]);
  const handleSplitDown = useCallback(() => {
    onSplit?.(paneId, "column", scope);
  }, [onSplit, paneId, scope]);
  const handleClosePane = useCallback(() => {
    onClosePane(paneId);
  }, [onClosePane, paneId]);
  const handleSessionDeleted = useCallback(() => {
    if (isGroupPrimary) {
      // group primary 删除过去只关闭布局，shell 仍指向已删除 session。
      // accepted 后必须先解散 group，再让 shell 回当前 workspace draft；secondary
      // 仅恢复普通 session 身份，不能在这里被隐式提升。
      handleClosePane();
      shell.onSessionDeleted?.();
      return;
    }
    if (isPrimary) {
      shell.onSessionDeleted?.();
      return;
    }
    handleClosePane();
  }, [handleClosePane, isGroupPrimary, isPrimary, shell.onSessionDeleted]);
  const handleBindSession = useCallback(
    (createdSessionId: string) => {
      const shouldSyncShellActive = onBindSession(paneId, createdSessionId) !== false;
      if (shouldSyncShellActive) {
        onPaneActiveSessionChange?.(scope, createdSessionId);
      }
    },
    [onBindSession, onPaneActiveSessionChange, paneId, scope],
  );
  const handleSessionCreated = useCallback(
    (createdSessionId: string) => {
      if (isPrimary && !primaryBinding) {
        // primary draft 旁边已经有拖入的 session 时，首发不能只更新 shell。
        // 必须先让 workbench 宿主把 draft pane 原地绑定并接管整个布局；否则随后
        // focus secondary 会改写 shell activeTaskId，primary 就因没有独立 binding 退回 draft。
        onBindSession(paneId, createdSessionId);
        shell.onSessionCreated?.(createdSessionId);
        return;
      }
      handleBindSession(createdSessionId);
    },
    [handleBindSession, isPrimary, onBindSession, paneId, primaryBinding, shell.onSessionCreated],
  );
  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!onDropSession || !canSplit) {
        return;
      }
      const payload = parseWorkbenchSessionDragPayload(event.dataTransfer);
      if (!payload || (canDropSession && !canDropSession(payload))) {
        setDropSide(null);
        return;
      }
      const side = resolveWorkbenchDropSide(
        event.currentTarget.getBoundingClientRect(),
        event.clientX,
        event.clientY,
      );
      if (!side) {
        setDropSide(null);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      setDropSide(side);
    },
    [canDropSession, canSplit, onDropSession],
  );
  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
      return;
    }
    setDropSide(null);
  }, []);
  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!onDropSession || !canSplit) {
        setDropSide(null);
        return;
      }
      const payload = parseWorkbenchSessionDragPayload(event.dataTransfer);
      const side =
        dropSide ??
        resolveWorkbenchDropSide(
          event.currentTarget.getBoundingClientRect(),
          event.clientX,
          event.clientY,
        );
      setDropSide(null);
      if (!payload || !side || (canDropSession && !canDropSession(payload))) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onDropSession(paneId, side, payload);
    },
    [canDropSession, canSplit, dropSide, onDropSession, paneId],
  );
  const pointerDropTargetRef = useRef<HTMLDivElement | null>(null);
  const setPointerDropTargetRef = useCallback((element: HTMLDivElement | null) => {
    pointerDropTargetRef.current = element;
  }, []);
  useEffect(() => {
    const element = pointerDropTargetRef.current;
    if (!element || !onDropSession || !canSplit) {
      return undefined;
    }
    return registerWorkbenchPointerDropTarget(element, {
      canDrop: (payload) => !canDropSession || canDropSession(payload),
      onPreview: setDropSide,
      onDrop: (side, payload) => onDropSession(paneId, side, payload),
    });
  }, [canDropSession, canSplit, onDropSession, paneId]);

  if (!isPrimary && !binding) {
    // sanitize/迁移保证非 primary 叶子必有绑定；此处是转移瞬间的防御渲染。
    return null;
  }

  const isShellWorkspace = paneWorkspaceKey(scope) === shellWorkspaceKey;
  const sessionId = isPrimary
    ? (primaryBinding?.sessionId ?? shell.sessionId)
    : (binding?.sessionId ?? null);
  const readOnly = Boolean(
    (isPrimary ? primaryBinding?.readOnly : binding?.readOnly) ||
    (isShellWorkspace && shell.readOnly),
  );
  const shouldUseShellStatusPanel = isShellWorkspace;
  const paneSearchResultHighlightRequest =
    sessionId === shell.searchResultHighlightRequest?.taskId
      ? shell.searchResultHighlightRequest
      : null;

  return (
    <ChatPaneShell
      containerRef={setPointerDropTargetRef}
      paneId={paneId}
      focused={focused}
      showFocusIndicator={showFocusIndicator}
      onFocusRequest={onFocusRequest}
      style={style}
      dropSide={dropSide}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      restoredUnvalidated={Boolean((isPrimary ? primaryBinding : binding)?.restoredUnvalidated)}
    >
      <V4PaneConversationProvider scope={scope}>
        {(isPrimary ? primaryBinding : binding)?.restoredUnvalidated && sessionId ? (
          <PaneRestoredGuard
            paneId={paneId}
            scope={scope}
            sessionId={sessionId}
            onConfirmed={onConfirmRestoredSession}
            onMissing={onClosePane}
          />
        ) : null}
        <SessionPane
          paneId={paneId}
          readOnly={readOnly}
          sessionId={sessionId}
          openTrigger={isPrimary ? "sidebar" : "split"}
          activeSelectionSideChatSessionId={resolvePaneActiveSelectionSideChatSessionId(
            sessionId,
            shell.activeSessionId ?? shell.sessionId,
            shell.activeSelectionSideChatSessionId,
          )}
          workspacePath={scope.workspacePath}
          workspaceIdentity={scope.workspaceIdentity}
          remoteSessionId={scope.remoteSessionId}
          isDesktop={shell.isDesktop}
          provider={isPrimary && isShellWorkspace ? shell.provider : undefined}
          onSessionCreated={handleSessionCreated}
          onSessionDeleted={handleSessionDeleted}
          focused={focused}
          onSplitRight={canSplit && onSplit ? handleSplitRight : undefined}
          onSplitDown={canSplit && onSplit ? handleSplitDown : undefined}
          onClosePane={isPrimary ? undefined : handleClosePane}
          workspaceBadge={!isPrimary && !isShellWorkspace ? workspaceBadgeFor(scope) : undefined}
          draftComposerHeader={isPrimary && !primaryBinding ? shell.draftComposerHeader : undefined}
          onDropTargetControllerChange={
            isPrimary && !primaryBinding
              ? shell.onPrimaryDraftDropTargetControllerChange
              : undefined
          }
          gitSummary={shouldUseShellStatusPanel ? shell.gitSummary : undefined}
          gitDirtyFileCount={shouldUseShellStatusPanel ? shell.gitDirtyFileCount : undefined}
          gitWorktreeReviewSourceId={
            shouldUseShellStatusPanel ? shell.gitWorktreeReviewSourceId : undefined
          }
          gitWorktreeChangeSummary={
            shouldUseShellStatusPanel ? shell.gitWorktreeChangeSummary : undefined
          }
          activeTaskChangeSummary={isPrimary ? shell.activeTaskChangeSummary : undefined}
          summaryPanelVariantOverride={
            shouldUseShellStatusPanel ? shell.summaryPanelVariantOverride : undefined
          }
          onSummaryPanelVariantOverrideChange={
            shouldUseShellStatusPanel ? shell.onSummaryPanelVariantOverrideChange : undefined
          }
          onRefreshGit={shouldUseShellStatusPanel ? shell.onRefreshGit : undefined}
          onOpenGitReview={shouldUseShellStatusPanel ? shell.onOpenGitReview : undefined}
          onOpenBrowserUrl={shell.onOpenBrowserUrl}
          onOpenAutomationsMain={shell.onOpenAutomationsMain}
          onOpenCodeViewer={shell.onOpenCodeViewer}
          onAutoOpenAssistantPptx={shell.onAutoOpenAssistantPptx}
          onOpenFileLink={shell.onOpenFileLink}
          onOpenSubagentSession={shell.onOpenSubagentSession}
          onOpenBackgroundBash={shell.onOpenBackgroundBash}
          onOpenSubagentDirectory={shell.onOpenSubagentDirectory}
          onSyncSubagentSessionTabs={shell.onSyncSubagentSessionTabs}
          onOpenSelectionSideChat={shell.onOpenSelectionSideChat}
          onOpenPlanDetail={shell.onOpenPlanDetail}
          onOpenWorkflowRun={shell.onOpenWorkflowRun}
          onOpenWorkflowArtifact={shell.onOpenWorkflowArtifact}
          onOpenWorkflowRunDirectory={shell.onOpenWorkflowRunDirectory}
          onOpenWorkflowActorSession={shell.onOpenWorkflowActorSession}
          onOpenWorkflowWorkspace={shell.onOpenWorkflowWorkspace}
          conversationFindQuery={focused ? shell.conversationFindQuery : ""}
          conversationFindActiveIndex={focused ? (shell.conversationFindActiveIndex ?? -1) : -1}
          conversationFindNavigationRequestId={
            focused ? (shell.conversationFindNavigationRequestId ?? 0) : 0
          }
          onConversationFindMatchStateChange={
            focused ? shell.onConversationFindMatchStateChange : undefined
          }
          searchResultHighlightRequest={paneSearchResultHighlightRequest}
          onSearchResultHighlightDone={shell.onSearchResultHighlightDone}
        />
      </V4PaneConversationProvider>
    </ChatPaneShell>
  );
}

function resolvePaneActiveSelectionSideChatSessionId(
  paneSessionId: string | null,
  shellActiveSessionId: string | null,
  activeSelectionSideChatSessionId: string | null | undefined,
): string | null {
  return paneSessionId && paneSessionId === shellActiveSessionId
    ? (activeSelectionSideChatSessionId ?? null)
    : null;
}
