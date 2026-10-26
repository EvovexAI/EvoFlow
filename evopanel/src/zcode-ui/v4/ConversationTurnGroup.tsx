/* eslint-disable max-lines -- turn group 需要在同一处维护普通 assistant 与后台结果的严格行序，拆分会重复 actions/preview/tail 协议。 */
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { Fragment, memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import {
  TID_CHAT_ASSISTANT_HISTORY_CONTENT,
  TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
  TID_CHAT_BACKGROUND_RESULT_TITLE,
  TID_CHAT_LOADING,
  TID_V4_ROW,
  testId,
  type ZCodeApiRetryStatus,
} from "@zcode/shared";
import type {
  ApiRetryState,
  AttachmentRef,
  CommandAck,
  ConversationRowTarget,
  WorkflowNotificationMeta,
} from "@zcode/shared/zcode-protocol-v4";
import { ChatLoading } from "@/components/ai-elements/chat-loading.js";
import { ChatApiRetryStatus } from "@/chat-input-toolbar/display.js";
import { cn } from "@/components/lib/utils.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { MessageActions } from "@/components/ai-elements/message.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import {
  CronCreateAutomationCard,
  isCronAutomationCardToolCall,
  readCronCreateAutomationSummary,
  type CronCreateAutomationSummary,
} from "@/ToolCallBlocks/renderers/cron-create.js";
import {
  isOffPeakCreateToolCall,
  OffPeakCreateTaskCard,
  readOffPeakCreateTaskSummary,
  type OffPeakCreateTaskSummary,
} from "@/ToolCallBlocks/renderers/offpeak-create.js";
import {
  readPlatformBindChannelFeedback,
  readPlatformProgressFeedback,
} from "@/ToolCallBlocks/renderers/platform.js";
import { EmployeeBindChannelQr } from "../../react/components/EmployeeBindChannelQr.js";
import {
  maybeAutoOpenPlatformProgress,
  type PlatformUiFeedback,
} from "../../lib/right-stage/platform-feedback.js";
import { showRightStageScreenshot } from "../../lib/right-stage/open-right-stage-screenshot.js";
import { getCurrentRightStageSessionKey } from "../../lib/right-stage/right-stage-scope.js";
import { isRightStageTabVisibleForSession } from "../../lib/right-stage/right-stage-session-visibility.js";
import { rightStageStore } from "../../lib/right-stage/right-stage-store.js";
import { logRightStage } from "../../lib/right-stage/panel-set-debug-log.js";
import { buildNodeReplDisplayModel } from "@/lib/nodeReplToolDisplay.js";
import { applyXiaomiVoiceReadAutoOpen } from "@/v4/xiaomiVoiceReadAutoOpen.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { AssistantPreviewCard } from "@/lib/assistantPreviewCards.js";
import { useAssistantCodeCommentFeatureEnabled } from "@/AssistantCodeCommentFeatureProvider.js";
import {
  buildAssistantCodeCommentCards,
  projectAssistantCodeComments,
  type AssistantCodeCommentCard,
} from "@/lib/assistantCodeComment.js";
import { useAssistantPreviewCardsForAssistantTextRow } from "@/v4/useAssistantPreviewCardsForRow.js";
import { shouldShowTurnChatLoading } from "@/v4/chatLoadingVisibility.js";
import {
  buildAssistantWorkRenderItems,
  ENABLE_CHANGES_TOOL_CALL_GROUPING,
  ENABLE_CUA_TOOL_CALL_GROUPING,
  ENABLE_EXPLORE_TOOL_CALL_GROUPING,
  ENABLE_TERMINAL_TOOL_CALL_GROUPING,
  type ConversationAssistantWorkRenderItem,
} from "@/v4/conversationAssistantWorkItems.js";
import type { ConversationCuaGroupEvent } from "@/v4/conversationCuaGroups.js";
import { ConversationAgentToolCallRow } from "@/v4/ConversationAgentToolCallRow.js";
import { ConversationFileSummaryPanel } from "@/v4/ConversationFileSummaryPanel.js";
import { WorkflowNotificationToolRow } from "@/v4/WorkflowNotificationToolRow.js";
import { ConversationWorkflowDigests } from "@/v4/ConversationWorkflowDigests.js";
import { ConversationWorkflowCompletion } from "@/v4/ConversationWorkflowCompletion.js";
import { resolveWorkflowTurnDigests } from "@/v4/workflowTurnDigests.js";
import { resolveWorkflowTurnCompletion } from "@/v4/workflowTurnCompletion.js";
import { ConversationAssistantTextActions } from "@/v4/ConversationRowView.js";
import { readAssistantFeedback } from "@/v4/ConversationRowView.js";
import type {
  AssistantFeedbackHandler,
  EditWorkspaceRewindAvailability,
} from "@/v4/ConversationRowView.js";
import {
  isConversationReasoningRowVisible,
  type ConversationRowRenderContext,
} from "@/v4/conversationRowContext.js";
import type {
  AssistantWorkRow,
  ConversationTurnFlowItem,
  ConversationTurnRenderUnit,
  ConversationTurnWorkSegment,
} from "@/v4/conversationTurnRenderUnits.js";
import { formatConversationWorkDuration } from "@/v4/conversationWorkDuration.js";
import { ConversationTurnRow, resolveAssistantCopyText } from "@/v4/ConversationTurnRow.js";
import { ConversationHookDetailsAction } from "@/v4/ConversationHookDetailsAction.js";

interface ConversationTurnGroupProps {
  unit: ConversationTurnRenderUnit;
  /** 仅由 Timeline 注入给当前 live turn；历史 turn 永远不携带运行时 retry。 */
  apiRetry?: ApiRetryState | null;
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onFeedbackChange?: AssistantFeedbackHandler;
  onEdit?: (
    target: ConversationRowTarget,
    newText: string,
    attachments?: readonly AttachmentRef[],
    workspaceMode?: "preserve" | "rewind",
  ) => Promise<CommandAck | boolean | void> | CommandAck | boolean | void;
  /** 分享选择阶段在正文左侧显示本轮勾选入口。 */
  shareSelection?: {
    eligibleRowIds: ReadonlySet<number>;
    selectedRowIds: ReadonlySet<number>;
    onToggle: (rowId: number) => void;
  };
}

interface CronAutomationTurnCard {
  rowId: number;
  toolCallId: string;
  automation: CronCreateAutomationSummary;
}

interface OffPeakTurnCard {
  rowId: number;
  toolCallId: string;
  task: OffPeakCreateTaskSummary;
}

interface BindChannelTurnCard {
  rowId: number;
  toolCallId: string;
  feedback: PlatformUiFeedback;
}

const BIND_CHANNEL_LABELS: Record<string, string> = {
  feishu: "飞书",
  wecom: "企业微信",
  dingtalk: "钉钉",
  weixin: "微信",
};

const MIN_VISIBLE_API_RETRY_ATTEMPT = 1;

function toRetryStatus(apiRetry: ApiRetryState): ZCodeApiRetryStatus {
  const attempt = Math.max(1, Math.floor(apiRetry.attempt));
  // v4 maxAttempts 包含首次请求，而展示口径是重试次数；直接展示会把
  // 默认 10 次重试写成 1/11。
  const maxRetries = Math.max(Math.floor(apiRetry.maxAttempts) - 1, attempt);
  return {
    kind: "api_retry",
    attempt,
    maxRetries,
    retryDelayMs: 0,
    errorStatus: null,
    error: apiRetry.reasonCode,
  };
}

function TurnChatLoadingSlot({
  apiRetry,
  eligible,
}: {
  apiRetry: ApiRetryState | null;
  eligible: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  const retryStatus = useMemo(() => (apiRetry ? toRetryStatus(apiRetry) : null), [apiRetry]);
  // Show vendor error + retry count from the first retry so V4 matches AG-UI SSE.
  const visibleRetryStatus =
    retryStatus && retryStatus.attempt >= MIN_VISIBLE_API_RETRY_ATTEMPT ? retryStatus : null;
  if (!visibleRetryStatus && !eligible) return null;
  return (
    <div data-zcode-chat-loading-slot="true" className="min-h-5">
      {visibleRetryStatus ? (
        <ChatApiRetryStatus apiRetry={visibleRetryStatus} intl={intl} locale={locale} />
      ) : (
        // running 是 ChatLoading 的权威事实；额外静默计时会让 projection
        // 更新反复重启可见性，并使 UI 晚于真实状态。
        <ChatLoading loading data-testid={TID_CHAT_LOADING} size="sm" />
      )}
    </div>
  );
}

function ConversationExploreGroupRow({
  item,
  context,
}: {
  item: Extract<ConversationAssistantWorkRenderItem, { kind: "exploreGroup" }>;
  context: ConversationRowRenderContext;
}) {
  // explore 分组行已经处在 turn 容器的统一边距内，单独再加 px-4
  // 会让同一串工具调用有的内缩、有的不内缩。
  return (
    <div
      data-row-id={item.rowId}
      data-conversation-selectable="true"
      data-testid={testId(TID_V4_ROW, String(item.rowId))}
    >
      <ToolCallBlock
        toolCallNode={item.node}
        workspacePath={context.workspacePath}
        theme={context.theme}
        codePreviewSettings={context.codePreviewSettings}
        showTodoToolCalls={context.messageStreamShowTodos === true}
        onOpenCodeViewer={context.onOpenCodeViewer}
        onOpenFileLink={context.onOpenFileLink}
        onOpenBrowserUrl={context.onOpenBrowserUrl}
        onOpenAutomationsMain={context.onOpenAutomationsMain}
      />
    </div>
  );
}

function ConversationToolGroupRow({
  item,
  context,
}: {
  item: Extract<
    ConversationAssistantWorkRenderItem,
    { kind: "cuaGroup" | "executeGroup" | "changesGroup" }
  >;
  context: ConversationRowRenderContext;
}) {
  const renderAssistantMessage = useCallback(
    (event: Extract<ConversationCuaGroupEvent, { kind: "assistantMessage" }>) => (
      <ConversationTurnRow
        row={event.row}
        context={context}
        hideAssistantActions
        assistantCodeCommentProjectionEnabled={false}
      />
    ),
    [context],
  );
  const renderReasoning = useCallback(
    (event: Extract<ConversationCuaGroupEvent, { kind: "reasoning" }>) => (
      <ConversationTurnRow row={event.row} context={context} reasoningContentVariant="nested" />
    ),
    [context],
  );
  const visibleCuaEvents = useMemo(
    () =>
      item.kind === "cuaGroup"
        ? item.events.filter(
            (event) =>
              event.kind !== "reasoning" ||
              isConversationReasoningRowVisible(event.row.rowId, context),
          )
        : undefined,
    [context, item],
  );
  return (
    <div
      data-row-id={item.rowId}
      data-conversation-selectable="true"
      data-testid={testId(TID_V4_ROW, String(item.rowId))}
    >
      <ToolCallBlock
        toolCallNode={item.node}
        workspacePath={context.workspacePath}
        theme={context.theme}
        codePreviewSettings={context.codePreviewSettings}
        showTodoToolCalls={context.messageStreamShowTodos === true}
        onOpenCodeViewer={context.onOpenCodeViewer}
        onOpenFileLink={context.onOpenFileLink}
        onOpenBrowserUrl={context.onOpenBrowserUrl}
        onOpenAutomationsMain={context.onOpenAutomationsMain}
        // history/background 兼容路径只传虚拟父节点时，已被分组投影消费的
        // Assistant message / reasoning 没有交给 renderer，展开后会永久丢失。
        cuaGroupEvents={visibleCuaEvents}
        renderCuaAssistantMessage={item.kind === "cuaGroup" ? renderAssistantMessage : undefined}
        renderCuaReasoning={item.kind === "cuaGroup" ? renderReasoning : undefined}
      />
      {item.rows.map((child) => (
        <div key={child.toolCallId}>{context.renderToolCallApproval?.(child.toolCallId)}</div>
      ))}
    </div>
  );
}

function ConversationCuaGroupRow({
  item,
  context,
}: {
  item: Extract<ConversationTurnFlowItem, { kind: "cuaGroup" }>;
  context: ConversationRowRenderContext;
}) {
  const renderAssistantMessage = useCallback(
    (event: Extract<(typeof item.events)[number], { kind: "assistantMessage" }>) => (
      <ConversationTurnRow
        row={event.row}
        context={context}
        hideAssistantActions
        assistantCodeCommentProjectionEnabled={false}
      />
    ),
    [context],
  );
  const renderReasoning = useCallback(
    (event: Extract<(typeof item.events)[number], { kind: "reasoning" }>) => (
      <ConversationTurnRow row={event.row} context={context} reasoningContentVariant="nested" />
    ),
    [context],
  );
  const visibleCuaEvents = useMemo(
    () =>
      item.events.filter(
        (event) =>
          event.kind !== "reasoning" || isConversationReasoningRowVisible(event.row.rowId, context),
      ),
    [context, item.events],
  );
  return (
    <div
      data-row-id={item.rowId}
      data-conversation-selectable="true"
      data-testid={testId(TID_V4_ROW, String(item.rowId))}
    >
      <ToolCallBlock
        toolCallNode={item.node}
        workspacePath={context.workspacePath}
        theme={context.theme}
        codePreviewSettings={context.codePreviewSettings}
        showTodoToolCalls={context.messageStreamShowTodos === true}
        onOpenCodeViewer={context.onOpenCodeViewer}
        onOpenFileLink={context.onOpenFileLink}
        onOpenBrowserUrl={context.onOpenBrowserUrl}
        onOpenAutomationsMain={context.onOpenAutomationsMain}
        cuaGroupEvents={visibleCuaEvents}
        renderCuaAssistantMessage={renderAssistantMessage}
        renderCuaReasoning={renderReasoning}
      />
    </div>
  );
}

function ConversationAssistantWorkItems({
  rows,
  context,
  stageTailIsRunning = false,
  assistantCodeCommentProjectionEnabled = false,
  historyContainer,
}: {
  rows: readonly AssistantWorkRow[];
  context: ConversationRowRenderContext;
  stageTailIsRunning?: boolean;
  /** running turn 的正文可能暂时落在 history renderer，仍需隐藏特化协议原文。 */
  assistantCodeCommentProjectionEnabled?: boolean;
  historyContainer?: {
    chunkKey: string;
    open: boolean;
  };
}) {
  const showReasoning = context.messageStreamShowReasoning === true;
  const firstReasoningRowId = context.messageStreamFirstReasoningRowId;
  const items = useMemo(
    () =>
      buildAssistantWorkRenderItems(
        rows,
        {
          messageStreamShowReasoning: showReasoning,
          ...(firstReasoningRowId !== undefined
            ? { messageStreamFirstReasoningRowId: firstReasoningRowId }
            : {}),
        },
        {
          stageTailIsRunning,
          enableCuaGrouping: ENABLE_CUA_TOOL_CALL_GROUPING,
          enableExploreGrouping:
            context.toolGroupingExploreEnabled ?? ENABLE_EXPLORE_TOOL_CALL_GROUPING,
          enableTerminalGrouping:
            context.toolGroupingTerminalEnabled ?? ENABLE_TERMINAL_TOOL_CALL_GROUPING,
          enableChangesGrouping:
            context.toolGroupingChangesEnabled ?? ENABLE_CHANGES_TOOL_CALL_GROUPING,
        },
      ),
    [
      context.toolGroupingChangesEnabled,
      context.toolGroupingExploreEnabled,
      context.toolGroupingTerminalEnabled,
      stageTailIsRunning,
      firstReasoningRowId,
      rows,
      showReasoning,
    ],
  );

  // history 外壳不能在这层投影前创建：当 CUA 消费原 message
  // 或运行中 shell 被延迟分类时，会留下 pt-5 和空的 gap-4 容器。只有确认
  // 内层存在可渲染项后才创建 CollapsibleContent，让外壳与内容一起消失。
  if (items.length === 0) {
    return null;
  }

  // 连续工作项（工具/explore/reasoning）统一 gap-4 组容器（对齐旧版 tool-call-group），
  // 取代继承父级 gap-5/gap-2 + 每行 py-2 的双重且不一致的间距。
  const content = (
    <div className="flex flex-col gap-4">
      {items.map((item) =>
        item.kind === "row" ? (
          <ConversationTurnRow
            key={item.key}
            row={item.row}
            context={context}
            hideAssistantActions={item.row.kind === "assistantText"}
            assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
          />
        ) : item.kind === "agentToolCall" ? (
          <ConversationAgentToolCallRow key={item.key} item={item} context={context} />
        ) : item.kind === "exploreGroup" ? (
          <ConversationExploreGroupRow key={item.key} item={item} context={context} />
        ) : (
          <ConversationToolGroupRow key={item.key} item={item} context={context} />
        ),
      )}
    </div>
  );

  if (!historyContainer) {
    return content;
  }

  return (
    <CollapsibleContent
      data-testid={testId(TID_CHAT_ASSISTANT_HISTORY_CONTENT, historyContainer.chunkKey)}
      data-history-open={String(historyContainer.open)}
    >
      <div className="pt-5">{content}</div>
    </CollapsibleContent>
  );
}

function resolveCronAutomationTurnCards(
  rows: readonly AssistantWorkRow[],
): CronAutomationTurnCard[] {
  let cards: CronAutomationTurnCard[] = [];

  for (const row of rows) {
    if (row.kind !== "toolCall" || row.status !== "success") {
      continue;
    }

    const normalizedToolName = row.toolName.toLowerCase().replace(/[^a-z0-9]/gu, "");
    if (normalizedToolName === "crondelete") {
      const deletedAutomationId = readCronDeleteAutomationId(row);
      if (deletedAutomationId) {
        // 只累计本轮成功的 Create/Update 会忽略后续 CronDelete，导致已经
        // 撤销的中间结果仍被提升成轮尾成功卡片。
        cards = cards.filter((card) => card.automation.automationId !== deletedAutomationId);
      }
      continue;
    }

    const node = toolCallRowToLegacyNode(row);
    if (!isCronAutomationCardToolCall(node.toolCall)) {
      continue;
    }

    const automation = readCronCreateAutomationSummary(node.toolCall);
    if (!automation) {
      continue;
    }

    if (automation.automationId) {
      cards = cards.filter((card) => card.automation.automationId !== automation.automationId);
    }
    cards.push({
      rowId: row.rowId,
      toolCallId: row.toolCallId,
      automation,
    });
  }

  return cards;
}

// 只收本轮 status==="success" 的 OffPeakCreate；同 id 重复输出保留最新一次。
// 刻意不复用 resolveCronAutomationTurnCards——那套带 CronDelete 撤销过滤语义，闲时无对应工具。
function resolveOffPeakTurnCards(rows: readonly AssistantWorkRow[]): OffPeakTurnCard[] {
  let cards: OffPeakTurnCard[] = [];

  for (const row of rows) {
    if (row.kind !== "toolCall" || row.status !== "success") {
      continue;
    }
    const node = toolCallRowToLegacyNode(row);
    if (!isOffPeakCreateToolCall(node.toolCall)) {
      continue;
    }
    const task = readOffPeakCreateTaskSummary(node.toolCall);
    if (!task) {
      continue;
    }
    if (task.offPeakTaskId) {
      cards = cards.filter((card) => card.task.offPeakTaskId !== task.offPeakTaskId);
    }
    cards.push({
      rowId: row.rowId,
      toolCallId: row.toolCallId,
      task,
    });
  }

  return cards;
}

/** 工具行留在「已工作」原位；只把扫码挂到对话轮尾（与 Cron/OffPeak 成功卡同级）。 */
function resolveBindChannelTurnCards(rows: readonly AssistantWorkRow[]): BindChannelTurnCard[] {
  const cards: BindChannelTurnCard[] = [];
  const seenSessions = new Set<string>();

  for (const row of rows) {
    if (row.kind !== "toolCall") continue;
    if (String(row.toolName || "").trim().toLowerCase() !== "platform") continue;
    if (row.status === "inputStreaming" || row.status === "running") continue;

    const node = toolCallRowToLegacyNode(row);
    const feedback = readPlatformBindChannelFeedback(node.toolCall.raw);
    if (!feedback) continue;

    const dedupeKey = String(feedback.sessionId || feedback.qrUrl || row.toolCallId).trim();
    if (dedupeKey && seenSessions.has(dedupeKey)) continue;
    if (dedupeKey) seenSessions.add(dedupeKey);

    cards.push({
      rowId: row.rowId,
      toolCallId: row.toolCallId,
      feedback,
    });
  }

  return cards;
}

/**
 * 【V4 权威】platform 结果带 autoOpen+openStage → 拉开右栏（workflow.run 等）。
 * 旧 AG-UI 的 publish-platform-from-agui-result / tools-scan 是双轨旁路，改侧栏别只改旧文件。
 */
const v4PlatformProgressAutoOpenedIds = new Set<string>();

function applyV4PlatformProgressAutoOpen(rows: readonly AssistantWorkRow[]): void {
  for (const row of rows) {
    if (row.kind !== "toolCall") continue;
    if (String(row.toolName || "").trim().toLowerCase() !== "platform") continue;
    if (row.status === "inputStreaming" || row.status === "running") continue;
    const toolCallId = String(row.toolCallId || row.rowId || "").trim();
    if (!toolCallId || v4PlatformProgressAutoOpenedIds.has(toolCallId)) continue;

    const node = toolCallRowToLegacyNode(row);
    // display 优先（agui_mirror 上浮的 actions）；raw 含 output.text 作回落
    const feedback =
      readPlatformProgressFeedback(node.toolCall.raw) ||
      readPlatformProgressFeedback({
        display: row.output?.display,
        rawOutput: row.output?.text,
        output: row.output?.text,
      });
    if (!feedback) continue;
    const opened = maybeAutoOpenPlatformProgress(feedback);
    logRightStage("V4 autoOpen:platform progress", {
      toolCallId,
      opened,
      actions: feedback.actions?.map((a) => ({
        label: a.label,
        autoOpen: a.autoOpen,
        kind: a.openStage?.kind,
      })),
    });
    if (!opened) continue;
    v4PlatformProgressAutoOpenedIds.add(toolCallId);
    if (v4PlatformProgressAutoOpenedIds.size > 256) {
      const oldest = v4PlatformProgressAutoOpenedIds.values().next().value;
      if (oldest !== undefined) v4PlatformProgressAutoOpenedIds.delete(oldest);
    }
  }
}

/**
 * 【V4 权威】轮尾 CUA / browser_turn_end 截图 → 右栏大图（与对话内缩略图同源）。
 * 每个 toolCallId 只自动开一次；多图取最后一张。
 */
const v4CuaScreenshotAutoOpenedIds = new Set<string>();

function readToolCallVisualDisplay(row: Extract<AssistantWorkRow, { kind: "toolCall" }>) {
  return row.display ?? row.output?.display;
}

function extractLatestScreenshotFromDisplay(
  display: unknown,
): { uri: string; mimeType: string } | null {
  if (!display || typeof display !== "object" || Array.isArray(display)) return null;
  const d = display as Record<string, unknown>;
  const kind = String(d.kind || "").trim();

  if (kind === "cua" && Array.isArray(d.media)) {
    for (let i = d.media.length - 1; i >= 0; i -= 1) {
      const item = d.media[i];
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const m = item as Record<string, unknown>;
      const mimeType = String(m.mimeType || "").trim() || "image/png";
      if (mimeType && !mimeType.startsWith("image/")) continue;
      const artifactUri = String(m.artifactUri || "").trim();
      if (artifactUri) return { uri: artifactUri, mimeType };
      const data = String(m.data || "").trim();
      if (data) return { uri: `data:${mimeType};base64,${data}`, mimeType };
    }
  }

  if (kind === "node_repl_images" && Array.isArray(d.images)) {
    for (let i = d.images.length - 1; i >= 0; i -= 1) {
      const item = d.images[i];
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const img = item as Record<string, unknown>;
      const mimeType = String(img.mimeType || "").trim() || "image/png";
      const url = String(img.url || img.artifactUri || "").trim();
      if (url) return { uri: url, mimeType };
      const base64 = String(img.base64 || img.data || "").trim();
      if (base64) return { uri: `data:${mimeType};base64,${base64}`, mimeType };
    }
  }

  return null;
}

/** 与对话内 NodeReplImageGrid 同源：display 缺字段时仍能从 CUA / 正文推断出图。 */
function extractLatestScreenshotFromToolRow(
  row: Extract<AssistantWorkRow, { kind: "toolCall" }>,
): { uri: string; mimeType: string } | null {
  const fromDisplay = extractLatestScreenshotFromDisplay(readToolCallVisualDisplay(row));
  if (fromDisplay) return fromDisplay;
  try {
    const node = toolCallRowToLegacyNode(row);
    const model = buildNodeReplDisplayModel(node.toolCall);
    for (let i = model.images.length - 1; i >= 0; i -= 1) {
      const img = model.images[i];
      if (!img) continue;
      const mimeType = String(img.mimeType || "").trim() || "image/png";
      const url = String(img.url || "").trim();
      if (url) return { uri: url, mimeType };
      const base64 = String(img.base64 || "").trim();
      if (base64) return { uri: `data:${mimeType};base64,${base64}`, mimeType };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function applyV4CuaScreenshotAutoOpen(rows: readonly AssistantWorkRow[]): void {
  // 必须用当前 UI 会话 key 打戳；绝不能传 threadId（context.sessionId）——
  // 否则标签写入后被会话过滤掉，对话里有图、右栏空白。
  const sessionKey = getCurrentRightStageSessionKey() || undefined;
  for (const row of rows) {
    if (row.kind !== "toolCall") continue;
    const toolCallId = String(row.toolCallId || row.rowId || "").trim();
    if (!toolCallId) continue;

    // 已开过且对当前会话可见 → 跳过；曾用错 sessionKey 导致不可见时允许再开一次。
    if (v4CuaScreenshotAutoOpenedIds.has(toolCallId)) {
      const existing = rightStageStore.findTab(`screenshot:${toolCallId}`);
      if (existing && isRightStageTabVisibleForSession(existing, sessionKey)) continue;
    }

    const shot = extractLatestScreenshotFromToolRow(row);
    if (!shot) continue;

    const key = showRightStageScreenshot(shot.uri, {
      sessionKey,
      mimeType: shot.mimeType,
      title: "截图",
      dedupeKey: toolCallId,
      layout: "half",
    });
    logRightStage("V4 autoOpen:cua screenshot", {
      toolCallId,
      opened: Boolean(key),
      uri: shot.uri.slice(0, 120),
      sessionKey: sessionKey || "(空→stamp current)",
    });
    if (!key) continue;
    v4CuaScreenshotAutoOpenedIds.add(toolCallId);
    if (v4CuaScreenshotAutoOpenedIds.size > 256) {
      const oldest = v4CuaScreenshotAutoOpenedIds.values().next().value;
      if (oldest !== undefined) v4CuaScreenshotAutoOpenedIds.delete(oldest);
    }
  }
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : null;
}

function readCronDeleteAutomationId(
  row: Extract<AssistantWorkRow, { kind: "toolCall" }>,
): string | undefined {
  for (const candidate of [row.output?.text, row.input, row.inputText]) {
    const record = parseJsonRecord(candidate);
    const id = record?.id;
    if (typeof id === "string" && id.trim()) {
      return id.trim();
    }
  }
  return undefined;
}

function CronAutomationTurnCards({
  cards,
  context,
}: {
  cards: readonly CronAutomationTurnCard[];
  context: ConversationRowRenderContext;
}) {
  if (cards.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      {cards.map((card) => (
        <CronCreateAutomationCard
          key={`${card.rowId}:${card.toolCallId}`}
          automation={card.automation}
          onOpenAutomationsMain={context.onOpenAutomationsMain}
        />
      ))}
    </div>
  );
}

function OffPeakTurnCards({
  cards,
  context,
}: {
  cards: readonly OffPeakTurnCard[];
  context: ConversationRowRenderContext;
}) {
  if (cards.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      {cards.map((card) => (
        <OffPeakCreateTaskCard
          key={`${card.rowId}:${card.toolCallId}`}
          task={card.task}
          onOpenAutomationsMain={context.onOpenAutomationsMain}
        />
      ))}
    </div>
  );
}

function BindChannelTurnCards({ cards }: { cards: readonly BindChannelTurnCard[] }) {
  if (cards.length === 0) {
    return null;
  }

  return (
    <div className="msg-platform-results-hoist flex flex-col gap-3">
      {cards.map((card) => {
        const channelLabel =
          BIND_CHANNEL_LABELS[String(card.feedback.channel || "").toLowerCase()] || "渠道";
        const employeeName = String(
          card.feedback.entityLabel || card.feedback.agentCode || "本岗 AI 员工",
        ).trim();
        return (
          <div key={`${card.rowId}:${card.toolCallId}`} className="msg-bind-employee-qr">
            <div className="msg-bind-employee-qr-caption">
              扫码绑定本岗 AI 员工「{employeeName}」· {channelLabel}
            </div>
            <EmployeeBindChannelQr data={card.feedback} />
          </div>
        );
      })}
    </div>
  );
}

function AssistantHistoryStatus({
  segment,
  open,
}: {
  segment: ConversationTurnWorkSegment;
  open: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  const durationLabel = formatConversationWorkDuration(
    segment.workStatus?.durationMs,
    intl,
    locale,
  );
  const label =
    segment.workStatus?.state === "interrupted"
      ? intl.formatMessage({ id: "chat.history.stopped" })
      : segment.workStatus?.state === "running"
        ? intl.formatMessage({ id: "chat.history.workingFor" }, { duration: durationLabel ?? "" })
        : durationLabel
          ? intl.formatMessage({ id: "chat.history.workedFor" }, { duration: durationLabel })
          : intl.formatMessage({ id: "chat.history.worked" });

  return (
    <div className="flex w-full border-b border-[var(--color-border)]/50 pb-2">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          data-testid={testId(TID_CHAT_ASSISTANT_HISTORY_TRIGGER, segment.key)}
          data-history-open={String(open)}
          className="group/history-message inline-flex max-w-full items-center gap-2 text-left text-ui-base text-foreground-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-input-border-focused)]"
        >
          <span className="truncate">{label}</span>
          {!segment.assistantHistoryDefaultOpen ? (
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-4 shrink-0 text-[var(--color-foreground-subtlest)] opacity-70 transition-transform",
                open ? "rotate-90" : "rotate-0",
              )}
            />
          ) : null}
        </button>
      </CollapsibleTrigger>
    </div>
  );
}

function ConversationWorkSegmentFlow({
  segment,
  context,
  onFork,
  onRetry,
  onEdit,
  editWorkspaceRewindAvailability,
  assistantCopyText,
  assistantPreviewCards,
  assistantPreviewCardsAutoOpenKey,
  assistantCodeCommentCards,
  assistantCodeCommentProjectionEnabled,
  canForkLatestAssistant,
  canRetryLatestAssistant,
  shareSelectionToggle,
  shareSelectionRowId,
}: {
  segment: ConversationTurnWorkSegment;
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onEdit?: ConversationTurnGroupProps["onEdit"];
  editWorkspaceRewindAvailability: EditWorkspaceRewindAvailability;
  assistantCopyText?: string;
  assistantPreviewCards: AssistantPreviewCard[];
  assistantPreviewCardsAutoOpenKey?: string;
  assistantCodeCommentCards: AssistantCodeCommentCard[];
  assistantCodeCommentProjectionEnabled: boolean;
  canForkLatestAssistant: boolean;
  canRetryLatestAssistant: boolean;
  shareSelectionToggle?: ReactNode;
  shareSelectionRowId?: number;
}) {
  const [historyOpen, setHistoryOpen] = useState(segment.assistantHistoryDefaultOpen);
  useEffect(() => {
    setHistoryOpen(segment.assistantHistoryDefaultOpen);
  }, [segment.assistantHistoryDefaultOpen, segment.key]);

  const shouldShowHistoryStatus = segment.workStatus !== undefined;
  const firstAssistantFlowItemIndex = segment.flowItems.findIndex(
    (item) => item.kind !== "userInput",
  );
  let historyChunkIndex = 0;
  const open = segment.assistantHistoryDefaultOpen ? true : historyOpen;

  return (
    <Collapsible
      open={open}
      onOpenChange={segment.assistantHistoryDefaultOpen ? undefined : setHistoryOpen}
      // 外层 flex gap 不属于 Radix 测量的 content 高度，收起到 0 后会在
      // display:none 的最后一帧再少 20px。普通兄弟用外边距保持原盒模型，history
      // 的间距则放进动画层。
      className="history-message flex flex-col [&>*+*:not([data-slot='collapsible-content'])]:mt-5"
    >
      {segment.flowItems.map((item, index) => {
        const stageTailIsRunning =
          segment.workStatus?.state === "running" &&
          index === segment.flowItems.length - 1 &&
          (item.kind === "assistantHistory" || item.kind === "assistantWork");
        const showHistoryStatus = shouldShowHistoryStatus && index === firstAssistantFlowItemIndex;
        const itemKey =
          item.kind === "userInput" || item.kind === "assistantText"
            ? `${item.kind}:${item.row.rowId}`
            : `${item.kind}:${item.rows[0]?.rowId ?? index}`;
        let content: React.ReactNode;

        if (item.kind === "userInput") {
          const userRow = (
            <ConversationTurnRow
              row={item.row}
              context={context}
              onEdit={item.row.actions?.canEdit === true ? onEdit : undefined}
              editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
            />
          );
          content =
            shareSelectionToggle && item.row.rowId === shareSelectionRowId ? (
              <div className="relative">
                {shareSelectionToggle}
                {userRow}
              </div>
            ) : (
              userRow
            );
        } else if (item.kind === "cuaGroup") {
          const group = <ConversationCuaGroupRow item={item} context={context} />;
          if (item.flowKind === "assistantHistory") {
            const chunkKey =
              historyChunkIndex === 0 ? segment.key : `${segment.key}:chunk-${historyChunkIndex}`;
            historyChunkIndex += 1;
            content = (
              <CollapsibleContent
                data-testid={testId(TID_CHAT_ASSISTANT_HISTORY_CONTENT, chunkKey)}
                data-history-open={String(open)}
              >
                <div className="pt-5">{group}</div>
              </CollapsibleContent>
            );
          } else {
            content = group;
          }
        } else if (item.kind === "assistantHistory") {
          const chunkKey =
            historyChunkIndex === 0 ? segment.key : `${segment.key}:chunk-${historyChunkIndex}`;
          historyChunkIndex += 1;
          content = (
            <ConversationAssistantWorkItems
              rows={item.rows}
              context={context}
              stageTailIsRunning={stageTailIsRunning}
              assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
              historyContainer={{ chunkKey, open }}
            />
          );
        } else if (item.kind === "assistantText") {
          content = (
            <ConversationTurnRow
              row={item.row}
              context={context}
              onFork={item.latest && canForkLatestAssistant ? onFork : undefined}
              onRetry={item.latest && canRetryLatestAssistant ? onRetry : undefined}
              hideAssistantActions={!item.latest}
              deferAssistantActions={item.latest}
              assistantCopyText={item.latest ? assistantCopyText : undefined}
              assistantPreviewCards={item.latest ? assistantPreviewCards : undefined}
              assistantPreviewCardsAutoOpenKey={
                item.latest ? assistantPreviewCardsAutoOpenKey : undefined
              }
              assistantCodeCommentCards={item.latest ? assistantCodeCommentCards : undefined}
              assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
            />
          );
        } else {
          content = (
            <ConversationAssistantWorkItems
              rows={item.rows}
              context={context}
              stageTailIsRunning={stageTailIsRunning}
              assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
            />
          );
        }

        return (
          <Fragment key={itemKey}>
            {showHistoryStatus ? <AssistantHistoryStatus segment={segment} open={open} /> : null}
            {content}
          </Fragment>
        );
      })}
      {shouldShowHistoryStatus && firstAssistantFlowItemIndex < 0 ? (
        <AssistantHistoryStatus segment={segment} open={open} />
      ) : null}
    </Collapsible>
  );
}

function ConversationTurnFlow({
  unit,
  apiRetry,
  context,
  onFork,
  onRetry,
  onEdit,
  editWorkspaceRewindAvailability,
  assistantCopyText,
  assistantCodeCommentCards,
  assistantCodeCommentProjectionEnabled,
  assistantPreviewCardsAutoOpenKey,
  shareSelectionToggle,
  shareSelectionRowId,
}: {
  unit: ConversationTurnRenderUnit;
  apiRetry: ApiRetryState | null;
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onEdit?: ConversationTurnGroupProps["onEdit"];
  editWorkspaceRewindAvailability: EditWorkspaceRewindAvailability;
  assistantCopyText?: string;
  assistantCodeCommentCards: AssistantCodeCommentCard[];
  assistantCodeCommentProjectionEnabled: boolean;
  assistantPreviewCardsAutoOpenKey?: string;
  shareSelectionToggle?: ReactNode;
  shareSelectionRowId?: number;
}) {
  // 产品语义：可见正文或工具不代表主轮已经结束；ChatLoading 跟随最后一轮
  // running 生命周期，但等待用户回答/授权时由交互 UI 独占进度反馈。
  const showLoading = shouldShowTurnChatLoading({
    blockedByActiveWork: context.chatLoadingBlockedByActiveWork === true,
    blockedByInteraction: context.chatLoadingBlockedByInteraction === true,
    isLastTurn: unit.isLastTurn,
    isRunning: unit.isRunning,
    rows: unit.assistantWorkRows,
  });
  const assistantPreviewCards = useAssistantPreviewCardsForAssistantTextRow({
    row: unit.latestAssistantTextRow,
    assistantTextRows: unit.assistantTextRows,
    latestAssistantTextRow: unit.latestAssistantTextRow,
    workspacePath: context.workspacePath,
    workspaceHomePath: context.workspaceHomePath,
    fileChangesTarget:
      unit.header && (unit.header.entityId || unit.header.turnId)
        ? {
            rowId: unit.header.rowId,
            entityId: String(unit.header.entityId || unit.header.turnId),
          }
        : null,
    fileChangesState: unit.header?.fileChanges?.state,
    fetchFileChanges: context.fetchFileChanges,
  });

  if (unit.timelineOnly) {
    return (
      <div className="flex flex-col gap-2">
        <ConversationAssistantWorkItems
          rows={unit.assistantWorkRows}
          context={context}
          stageTailIsRunning={unit.isRunning}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        />
        <TurnChatLoadingSlot apiRetry={apiRetry} eligible={showLoading} />
      </div>
    );
  }

  const projectedWorkSegments = unit.workSegments ?? [];
  const workSegments: ConversationTurnWorkSegment[] =
    projectedWorkSegments.length > 0
      ? projectedWorkSegments.length === 1
        ? [
            {
              ...projectedWorkSegments[0]!,
              // 兼容仍直接构造/覆写旧 render unit 的调用方；真实 guide 多段不走这个分支。
              assistantHistoryDefaultOpen: unit.assistantHistoryDefaultOpen,
            },
          ]
        : projectedWorkSegments
      : [
          {
            key: unit.key,
            flowItems: unit.flowItems,
            assistantWorkRows: unit.assistantWorkRows,
            assistantHistoryRows: unit.assistantHistoryRows,
            assistantFollowingRows: unit.assistantFollowingRows,
            assistantHistoryDefaultOpen: unit.assistantHistoryDefaultOpen,
            ...(unit.workStatus ? { workStatus: unit.workStatus } : {}),
          },
        ];
  if (
    workSegments.every(
      (segment) => segment.flowItems.length === 0 && segment.workStatus === undefined,
    ) &&
    !showLoading
  ) {
    return null;
  }

  const latestAssistantTextRow = unit.latestAssistantTextRow;
  const canRetryLatestAssistant = latestAssistantTextRow?.actions?.canRetry === true;
  const canForkLatestAssistant = latestAssistantTextRow?.actions?.canFork === true;

  // 即使恢复了 guide 的 row 全序，也不能让所有 history chunk 共享同一个
  // Collapsible。accepted guide 现在由 CLI workSegments 定界，每段组件自行维护折叠状态。
  return (
    <div className="flex flex-col gap-5">
      {workSegments.map((segment) => (
        <ConversationWorkSegmentFlow
          key={segment.key}
          segment={segment}
          context={context}
          onFork={onFork}
          onRetry={onRetry}
          onEdit={onEdit}
          editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
          assistantCopyText={assistantCopyText}
          assistantPreviewCards={assistantPreviewCards}
          assistantPreviewCardsAutoOpenKey={assistantPreviewCardsAutoOpenKey}
          assistantCodeCommentCards={assistantCodeCommentCards}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
          canForkLatestAssistant={canForkLatestAssistant}
          canRetryLatestAssistant={canRetryLatestAssistant}
          shareSelectionToggle={shareSelectionToggle}
          shareSelectionRowId={shareSelectionRowId}
        />
      ))}
      <TurnChatLoadingSlot apiRetry={apiRetry} eligible={showLoading} />
    </div>
  );
}

/**
 * 能撑起「后台结果头」这套渲染的来源白名单。
 *
 * 这里刻意仍是白名单而不是直接信任 schema：`originMeta` 在 userInputRow 上是 optional，
 * 跨版本仍可能出现第四个取值，而没见过的来源拿不到合适的标题语义，退回普通 assistant
 * 分支比谎报一个标题好。
 *
 * workflow run 的 `backgroundSource` 是 `"workflow"`（CLI 侧
 * `background-tasks.ts` 在 CreateWorkflow 终态上报，title 由 `workflowTaskSubject` 铸造），
 * 原本落在白名单外，于是一条 run 跑完之后那一轮**既没有标题、也退化成按工时折叠的普通
 * assistant 段落**——后台结果分组整个消失。标题不需要本地化：它由 CLI 权威给出，
 * bash / subagent 同样直接透传。
 */
const BACKGROUND_RESULT_TITLE_SOURCES: ReadonlySet<string> = new Set([
  "bash",
  "subagent",
  "workflow",
]);

function resolveBackgroundResultTitle(unit: ConversationTurnRenderUnit): string | undefined {
  if (unit.header?.origin !== "backgroundResult") return undefined;
  const originMeta = unit.header.originMeta;
  if (!originMeta?.workId.trim() || !originMeta.title.trim()) return undefined;
  if (!BACKGROUND_RESULT_TITLE_SOURCES.has(originMeta.backgroundSource)) {
    return undefined;
  }
  return originMeta.title.trim();
}

/**
 * 该轮是否以 workflow 通知卡（ToolLayout 行）开头。
 *
 * 用于两处：`ConversationBackgroundResultWork` 决定渲染通知行还是裸标题行；轮容器决定是否
 * 去掉轮顶 `pt-14`。后台结果轮没有可见的 user 行，通知卡就是轮内第一个节点——若照常保留
 * 轮顶 padding，卡片上方会叠出 56px + 上一轮 pb-5 共约 76px 的空白，用户判为多余。
 */
function resolveWorkflowNotification(
  unit: ConversationTurnRenderUnit,
): WorkflowNotificationMeta | undefined {
  if (unit.header?.origin !== "backgroundResult") return undefined;
  const originMeta = unit.header.originMeta;
  return originMeta?.backgroundSource === "workflow" ? originMeta.workflowNotification : undefined;
}

function ConversationBackgroundResultWork({
  unit,
  apiRetry,
  context,
  onFork,
  onRetry,
  title,
  assistantCopyText,
  assistantCodeCommentCards,
  assistantCodeCommentProjectionEnabled,
  assistantPreviewCardsAutoOpenKey,
}: {
  unit: ConversationTurnRenderUnit;
  apiRetry: ApiRetryState | null;
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  title: string;
  assistantCopyText?: string;
  assistantCodeCommentCards: AssistantCodeCommentCard[];
  assistantCodeCommentProjectionEnabled: boolean;
  assistantPreviewCardsAutoOpenKey?: string;
}) {
  const hasHistory = unit.assistantHistoryRows.length > 0;
  const hasFollowing = unit.assistantFollowingRows.length > 0;
  const showLoading = shouldShowTurnChatLoading({
    blockedByActiveWork: context.chatLoadingBlockedByActiveWork === true,
    blockedByInteraction: context.chatLoadingBlockedByInteraction === true,
    isLastTurn: unit.isLastTurn,
    isRunning: unit.isRunning,
    rows: unit.assistantWorkRows,
  });
  const latestAssistantTextRow = unit.latestAssistantTextRow;
  const assistantPreviewCards = useAssistantPreviewCardsForAssistantTextRow({
    row: latestAssistantTextRow,
    assistantTextRows: unit.assistantTextRows,
    latestAssistantTextRow,
    workspacePath: context.workspacePath,
    workspaceHomePath: context.workspaceHomePath,
    fileChangesTarget:
      unit.header && (unit.header.entityId || unit.header.turnId)
        ? {
            rowId: unit.header.rowId,
            entityId: String(unit.header.entityId || unit.header.turnId),
          }
        : null,
    fileChangesState: unit.header?.fileChanges?.state,
    fetchFileChanges: context.fetchFileChanges,
  });

  // 后台结果已经由独立唤醒轮总结过；复用普通 assistant 的工时折叠
  // 会显示不准确的分段耗时，并让一段短总结产生没有意义的收起状态。
  //
  // workflow run 的 workflow 通知带结构化载荷时改渲染既有工具卡语法的通知行（替换裸标题行）；
  // 载荷缺席（批量轮、旧 transcript、bash/subagent）→ 原样退回标题行。
  const workflowNotification = resolveWorkflowNotification(unit);
  const workflowRunId = unit.header?.originMeta?.workId;
  // 打开 run 详情：宿主注入 onOpenWorkflowRun + 联查到 toolCallId 才可点；冷恢复查不到时
  // 展开体内不渲染链接。toolCallId 走投影/journal 联查表，与 CreateWorkflow 工具卡同一条打开路径。
  const workflowRunSummary =
    workflowNotification && workflowRunId
      ? context.workflowRunByRunId?.get(workflowRunId)
      : undefined;
  const openWorkflowRun =
    workflowNotification &&
    workflowRunId &&
    context.onOpenWorkflowRun &&
    context.sessionId &&
    workflowRunSummary?.toolCallId
      ? () =>
          context.onOpenWorkflowRun?.({
            parentSessionId: context.sessionId!,
            toolCallId: workflowRunSummary.toolCallId!,
            runId: workflowRunId,
            workflowName: title,
          })
      : undefined;
  const workflowPendingQids =
    workflowNotification && workflowRunId
      ? context.workflowRunPendingQuestionsByRunId?.get(workflowRunId)
      : undefined;
  // 产物 chip → 全尺寸查看 tab。门比 `openWorkflowRun` 松一格：产物 tab 只需要
  // (parentSessionId, runId, artifactId)，**不需要** toolCallId——它不画因果图，也就不必
  // 回到那条 CreateWorkflow 工具行。冷恢复后联查不到 toolCallId 的通知行因此仍能开产物。
  const openWorkflowArtifact =
    workflowNotification && workflowRunId && context.onOpenWorkflowArtifact && context.sessionId
      ? (artifactId: string) => {
          // 载荷里那一枚的 `contentType`（终态通知才有产物清单）：宿主据它决定 html 产物
          // 直接开浏览器 tab 还是开产物 tab，所以这里带得到就带上。载荷刻意不带 `sourcePath`
          // （状态帧体积），宿主缺席时自己查 journal 补。
          const contentType =
            workflowNotification.kind === "terminal"
              ? workflowNotification.artifacts?.find((candidate) => candidate.id === artifactId)
                  ?.contentType
              : undefined;
          context.onOpenWorkflowArtifact?.({
            parentSessionId: context.sessionId!,
            runId: workflowRunId,
            artifactId,
            ...(contentType === undefined ? {} : { contentType }),
          });
        }
      : undefined;

  return (
    <div className="flex flex-col gap-5">
      {workflowNotification ? (
        <WorkflowNotificationToolRow
          notification={workflowNotification}
          runName={title}
          testIdKey={unit.key}
          theme={context.theme}
          onOpenRun={openWorkflowRun}
          onOpenArtifact={openWorkflowArtifact}
          pendingQids={workflowPendingQids}
        />
      ) : (
        <div className="flex w-full border-b border-[var(--color-border)]/50 pb-2">
          <div
            data-testid={testId(TID_CHAT_BACKGROUND_RESULT_TITLE, unit.key)}
            className="min-w-0 whitespace-pre-wrap break-words text-left text-ui-base text-[var(--color-foreground-subtle)]"
          >
            {title}
          </div>
        </div>
      )}
      {hasHistory ? (
        <div className="flex flex-col gap-2">
          <ConversationAssistantWorkItems
            rows={unit.assistantHistoryRows}
            context={context}
            assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
          />
        </div>
      ) : null}
      {latestAssistantTextRow ? (
        <ConversationTurnRow
          key={`${latestAssistantTextRow.rowId}:${latestAssistantTextRow.entityId ?? ""}`}
          row={latestAssistantTextRow}
          context={context}
          onFork={latestAssistantTextRow.actions?.canFork === true ? onFork : undefined}
          onRetry={latestAssistantTextRow.actions?.canRetry === true ? onRetry : undefined}
          deferAssistantActions
          assistantCopyText={assistantCopyText}
          assistantPreviewCards={assistantPreviewCards}
          assistantPreviewCardsAutoOpenKey={assistantPreviewCardsAutoOpenKey}
          assistantCodeCommentCards={assistantCodeCommentCards}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        />
      ) : null}
      {hasFollowing ? (
        <ConversationAssistantWorkItems
          rows={unit.assistantFollowingRows}
          context={context}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        />
      ) : null}
      <TurnChatLoadingSlot apiRetry={apiRetry} eligible={showLoading} />
    </div>
  );
}

function ConversationTurnGroupImpl({
  unit,
  apiRetry = null,
  context,
  onFork,
  onRetry,
  onFeedbackChange,
  onEdit,
  shareSelection,
}: ConversationTurnGroupProps) {
  const isOfficeMode = useIsOfficeMode();
  const { intl } = useZCodeIntl();
  const visibleUserRows = useMemo(() => unit.visibleUserInputs, [unit.visibleUserInputs]);
  const firstReasoningRowId = useMemo(
    () => unit.assistantWorkRows.find((row) => row.kind === "reasoning")?.rowId,
    [unit.assistantWorkRows],
  );
  const assistantRowContext = useMemo<ConversationRowRenderContext>(
    () => ({
      ...context,
      ...(firstReasoningRowId !== undefined
        ? { messageStreamFirstReasoningRowId: firstReasoningRowId }
        : {}),
    }),
    [context, firstReasoningRowId],
  );
  const latestAssistantTextRow = unit.latestAssistantTextRow;
  const assistantPreviewPptxAutoOpenTarget = context.assistantPreviewPptxAutoOpenTarget;
  const codeCommentCardsEnabled = useAssistantCodeCommentFeatureEnabled();
  const assistantCodeCommentProjectionEnabled =
    codeCommentCardsEnabled &&
    (unit.isRunning ||
      latestAssistantTextRow?.state === "complete" ||
      latestAssistantTextRow?.state === "interrupted");
  const assistantRawCopyText = useMemo(
    () => resolveAssistantCopyText(unit),
    [unit.assistantTextRows, unit.assistantWorkRows, unit.latestAssistantTextRow],
  );
  const assistantCopyText = useMemo(
    () =>
      assistantCodeCommentProjectionEnabled && assistantRawCopyText !== undefined
        ? projectAssistantCodeComments(assistantRawCopyText, {
            streaming: unit.isRunning,
          }).visibleText
        : assistantRawCopyText,
    [assistantRawCopyText, assistantCodeCommentProjectionEnabled, unit.isRunning],
  );
  const assistantCodeCommentCards = useMemo(
    () =>
      codeCommentCardsEnabled &&
      assistantRawCopyText !== undefined &&
      // 卡片与 zcode-file-citation 的预览卡片保持一致：流式期间只投影正文，
      // 只有终态 row 才生成卡片，避免运行中卡片先出现又因模型续写而回滚。
      (latestAssistantTextRow?.state === "complete" ||
        latestAssistantTextRow?.state === "interrupted")
        ? buildAssistantCodeCommentCards(assistantRawCopyText, context.workspacePath, 50, {
            homePath: context.workspaceHomePath,
          })
        : [],
    [
      assistantRawCopyText,
      codeCommentCardsEnabled,
      context.workspaceHomePath,
      context.workspacePath,
      latestAssistantTextRow?.state,
    ],
  );
  const cronAutomationTurnCards = useMemo(
    () => (unit.isRunning ? [] : resolveCronAutomationTurnCards(unit.assistantWorkRows)),
    [unit.assistantWorkRows, unit.isRunning],
  );
  // 上方已是工具摘要；下方运行卡在联接到 run 后立即显示，不能再等主代理回复结束。
  // 依赖联接表保持实时更新，并由解析器按 runId 去重。直接启动轮
  // 的 run 卡也从这里出：那一轮没有用户气泡、没有助手内容，run 卡就是它的全部呈现。
  const workflowRunByToolCallId = context.workflowRunByToolCallId;
  const workflowRunByRunId = context.workflowRunByRunId;
  const workflowGraphByToolCallId = context.workflowGraphByToolCallId;
  const workflowTurnDigests = useMemo(
    () =>
      resolveWorkflowTurnDigests(unit, {
        byToolCallId: workflowRunByToolCallId,
        byRunId: workflowRunByRunId,
        graphByToolCallId: workflowGraphByToolCallId,
      }),
    [unit, workflowGraphByToolCallId, workflowRunByRunId, workflowRunByToolCallId],
  );
  // 完成卡：主代理消化 completed 通知的那一轮，轮尾落卡。
  // 同一条门（轮结束）；联接只认 byRunId——通知轮里没有 CreateWorkflow 行可按 toolCallId 联。
  const workflowTurnCompletion = useMemo(
    () =>
      unit.isRunning
        ? undefined
        : resolveWorkflowTurnCompletion(unit.header, { byRunId: workflowRunByRunId }),
    [unit.header, unit.isRunning, workflowRunByRunId],
  );
  const offPeakTurnCards = useMemo(
    () => (unit.isRunning ? [] : resolveOffPeakTurnCards(unit.assistantWorkRows)),
    [unit.assistantWorkRows, unit.isRunning],
  );
  // 绑渠道扫码：工具一出结果就挂轮尾，不必等整轮结束（扫码要趁热）。
  const bindChannelTurnCards = useMemo(
    () => resolveBindChannelTurnCards(unit.assistantWorkRows),
    [unit.assistantWorkRows],
  );
  // 【V4 权威】workflow.run 等 platform 进度 CTA 在此拉开右栏（勿只改旧 AG-UI 热路径）。
  useEffect(() => {
    applyV4PlatformProgressAutoOpen(unit.assistantWorkRows);
  }, [unit.assistantWorkRows]);
  // 【V4 权威】轮尾截图同步开右栏大图；仅当前尾轮，避免冷加载历史连开多标签。
  useEffect(() => {
    if (!unit.isLastTurn) return;
    applyV4CuaScreenshotAutoOpen(unit.browserTurnEndRows);
  }, [unit.isLastTurn, unit.browserTurnEndRows]);
  // 小V语音特例：语音全屏中 Read 文件 → 右栏预览（闸门在 applyXiaomiVoiceReadAutoOpen）。
  useEffect(() => {
    if (!unit.isLastTurn) return;
    applyXiaomiVoiceReadAutoOpen(unit.assistantWorkRows, {
      workspacePath: context.workspacePath,
      sessionKey: context.sessionId,
    });
  }, [unit.isLastTurn, unit.assistantWorkRows, context.workspacePath, context.sessionId]);
  const canRenderAssistantActions =
    !unit.timelineOnly &&
    latestAssistantTextRow?.state === "complete" &&
    assistantCopyText !== undefined;
  const hasHookActions =
    // Hook action 与 copy/feedback/fork 共用 turn eligibility；
    // timelineOnly 维护 turn（compact/modelChange marker 轮）即使带历史遗留的
    // didExecute=true Hook row 也不得露出图标，否则 /compact 轮会凭 SessionStart
    // Hook 误挂出一个不可解释的操作栏。
    !unit.timelineOnly &&
    !unit.isRunning &&
    unit.hookInvocations.some((row) => row.executions.some((execution) => execution.didExecute));
  const canRetryLatestAssistant = latestAssistantTextRow?.actions?.canRetry === true;
  const canForkLatestAssistant = latestAssistantTextRow?.actions?.canFork === true;
  const backgroundResultTitle = resolveBackgroundResultTitle(unit);
  const hasAssistantWorkContent = unit.timelineOnly
    ? unit.assistantWorkRows.length > 0
    : unit.assistantWorkRows.length > 0 ||
      unit.workSegments?.some((segment) => segment.workStatus?.state === "running") === true ||
      unit.workStatus?.state === "running";
  const hasAssistantTurnContent =
    hasAssistantWorkContent ||
    Boolean(unit.header?.fileChanges) ||
    canRenderAssistantActions ||
    hasHookActions ||
    workflowTurnDigests.length > 0;
  const editWorkspaceRewindAvailability = useMemo<EditWorkspaceRewindAvailability>(() => {
    const fileChanges = unit.header?.fileChanges;
    if (!fileChanges || fileChanges.files <= 0) return { enabled: false, reason: "noFiles" };
    if (fileChanges.state === "reverted") return { enabled: false, reason: "reverted" };
    if (unit.isRunning) return { enabled: false, reason: "running" };
    if (unit.header?.actions?.canRewindFiles !== true) {
      return { enabled: false, reason: "unavailable" };
    }
    return { enabled: true, reason: "available" };
  }, [unit.header?.actions?.canRewindFiles, unit.header?.fileChanges, unit.isRunning]);

  // workflow 通知卡开头的轮去掉轮顶 padding：卡片只贴上一轮 pb-5 的常规流内间距。
  const startsWithWorkflowNotificationCard =
    backgroundResultTitle !== undefined && resolveWorkflowNotification(unit) !== undefined;

  const shareSelectionRows = shareSelection
    ? unit.visibleUserInputs.filter(
        (row) => row.origin === "realUser" && shareSelection.eligibleRowIds.has(row.rowId),
      )
    : [];
  // 一个 turn 可以有多条 realUser 输入（steer/排队消息），而这里只渲染一个
  // turn 级 checkbox。用 every() 折叠成布尔值会让部分选中显示为"未选中"，
  // 用户看到未选中却点一下让计数跳 2。半选必须显式呈现为 indeterminate。
  const shareSelectionSelectedCount = shareSelection
    ? shareSelectionRows.filter((row) => shareSelection.selectedRowIds.has(row.rowId)).length
    : 0;
  const shareSelectionChecked: boolean | "indeterminate" =
    shareSelection === undefined || shareSelectionRows.length === 0
      ? false
      : shareSelectionSelectedCount === shareSelectionRows.length
        ? true
        : shareSelectionSelectedCount === 0
          ? false
          : "indeterminate";
  const shareSelectionToggle =
    shareSelectionRows.length > 0 ? (
      <div
        data-conversation-share-turn-toggle="true"
        data-conversation-share-turn-toggle-state={
          shareSelectionChecked === true
            ? "selected"
            : shareSelectionChecked === "indeterminate"
              ? "partial"
              : "unselected"
        }
        className="absolute left-0 top-1/2 z-10 flex size-8 -translate-y-1/2 items-center justify-center"
      >
        <label className="flex size-8 cursor-pointer items-center justify-center">
          <Checkbox
            checked={shareSelectionChecked}
            aria-label={
              shareSelectionRows[0]?.text ||
              intl.formatMessage({ id: "conversationShare.partial.panelLabel" })
            }
            onCheckedChange={(checked) => {
              if (!shareSelection) return;
              // Radix 从 indeterminate 点击后给出 true，半选状态因此会补齐整个 turn。
              if (checked === true) {
                for (const row of shareSelectionRows) {
                  if (!shareSelection.selectedRowIds.has(row.rowId))
                    shareSelection.onToggle(row.rowId);
                }
              } else if (checked === false) {
                for (const row of shareSelectionRows) {
                  if (shareSelection.selectedRowIds.has(row.rowId))
                    shareSelection.onToggle(row.rowId);
                }
              }
            }}
            checkIconStrokeWidth={1.33}
            className="size-4 rounded-sm border-foreground bg-transparent data-[state=checked]:border-foreground data-[state=checked]:bg-foreground data-[state=checked]:text-background data-[state=indeterminate]:border-foreground data-[state=indeterminate]:bg-foreground data-[state=indeterminate]:text-background"
          />
        </label>
      </div>
    ) : null;

  return (
    <section
      data-turn-id={unit.turnId}
      data-turn-key={unit.key}
      className={cn(
        // 与 composer dock（ConversationTimeline `px-4`）左右对齐；
        // 以前 @md 升到 px-6 会让 AI 正文比输入框多缩进 8px。
        "relative mx-auto flex w-full flex-col gap-5 px-4 pb-5",
        startsWithWorkflowNotificationCard ? "pt-0" : "pt-14",
      )}
    >
      {unit.leadingBoundaryRows.map((row) => (
        <ConversationTurnRow
          key={`${row.rowId}:${row.entityId ?? ""}`}
          row={row}
          context={context}
        />
      ))}
      {hasAssistantTurnContent ? (
        // deferAssistantActions 后工具栏被移到文件 summary 之后，
        // 之前 hover group 只包住工具栏自己，导致必须悬停到不可见按钮位置才出现。
        // 这里把 assistant work、summary 和工具栏放进同一轮 hover 容器，对齐旧版。
        <div className="group/assistant-turn flex w-full flex-col gap-5">
          {backgroundResultTitle ? (
            <>
              {visibleUserRows.map((row) =>
                shareSelectionToggle && row.rowId === shareSelectionRows[0]?.rowId ? (
                  <div className="relative" key={`${row.rowId}:${row.entityId ?? ""}`}>
                    {shareSelectionToggle}
                    <ConversationTurnRow
                      row={row}
                      context={context}
                      onEdit={row.actions?.canEdit === true ? onEdit : undefined}
                      editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
                    />
                  </div>
                ) : (
                  <ConversationTurnRow
                    key={`${row.rowId}:${row.entityId ?? ""}`}
                    row={row}
                    context={context}
                    onEdit={row.actions?.canEdit === true ? onEdit : undefined}
                    editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
                  />
                ),
              )}
              <ConversationBackgroundResultWork
                unit={unit}
                apiRetry={apiRetry}
                context={assistantRowContext}
                onFork={canForkLatestAssistant ? onFork : undefined}
                onRetry={onRetry}
                title={backgroundResultTitle}
                assistantCopyText={assistantCopyText}
                assistantCodeCommentCards={assistantCodeCommentCards}
                assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
                assistantPreviewCardsAutoOpenKey={
                  assistantPreviewPptxAutoOpenTarget?.turnId === unit.turnId
                    ? assistantPreviewPptxAutoOpenTarget.key
                    : undefined
                }
              />
            </>
          ) : (
            <ConversationTurnFlow
              unit={unit}
              apiRetry={apiRetry}
              context={assistantRowContext}
              onFork={canForkLatestAssistant ? onFork : undefined}
              onRetry={onRetry}
              onEdit={onEdit}
              editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
              shareSelectionToggle={shareSelectionToggle}
              shareSelectionRowId={shareSelectionRows[0]?.rowId}
              assistantCopyText={assistantCopyText}
              assistantCodeCommentCards={assistantCodeCommentCards}
              assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
              assistantPreviewCardsAutoOpenKey={
                assistantPreviewPptxAutoOpenTarget?.turnId === unit.turnId
                  ? assistantPreviewPptxAutoOpenTarget.key
                  : undefined
              }
            />
          )}
          {/* 完成卡：这一轮消化的那条 run 做了什么、花了多少，紧跟最后一段正文。 */}
          {workflowTurnCompletion === undefined ? null : (
            <ConversationWorkflowCompletion
              completion={workflowTurnCompletion}
              context={context}
              turnKey={unit.key}
            />
          )}
          {/* 轮尾摘要：这一轮留下在跑的 run，排在完成卡之后、其余轮尾块之前。 */}
          <ConversationWorkflowDigests
            context={context}
            digests={workflowTurnDigests}
            turnKey={unit.key}
          />
          {/* CronCreate/CronUpdate 工具本身仍按普通工具行展示；成功卡片属于整轮
              完成后的结果摘要，必须等回复结束再跟随最终 assistant 正文收尾。 */}
          <CronAutomationTurnCards cards={cronAutomationTurnCards} context={context} />
          <OffPeakTurnCards cards={offPeakTurnCards} context={context} />
          <BindChannelTurnCards cards={bindChannelTurnCards} />
          {!isOfficeMode && unit.header?.fileChanges ? (
            <ConversationFileSummaryPanel header={unit.header} context={context} />
          ) : null}
          {unit.browserTurnEndRows.length > 0 ? (
            // 自动截图表达轮次结束时页面最终状态；放在 assistant work 内会
            // 穿插到 Website 预览和 file diff 摘要之间。它应是操作栏之前的最后一个内容块。
            <ConversationAssistantWorkItems
              rows={unit.browserTurnEndRows}
              context={assistantRowContext}
              assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
            />
          ) : null}
          {canRenderAssistantActions && latestAssistantTextRow ? (
            // 文件 summary 是整轮完成后的聚合结果；轮尾工具栏如果跟着
            // assistant text 内联渲染，会插到 summary 前面，读起来像 summary 不是本轮收尾。
            <ConversationAssistantTextActions
              rowId={latestAssistantTextRow.rowId}
              entityId={latestAssistantTextRow.entityId}
              text={assistantCopyText}
              createdAt={latestAssistantTextRow.createdAt}
              feedback={readAssistantFeedback(latestAssistantTextRow)}
              sessionId={context.sessionId}
              onFork={canForkLatestAssistant ? onFork : undefined}
              onRetry={canRetryLatestAssistant ? onRetry : undefined}
              onFeedbackChange={onFeedbackChange}
              hookInvocations={unit.hookInvocations}
              turnId={unit.turnId}
              className="opacity-0 transition-opacity group-hover/assistant-turn:opacity-100 focus-within:opacity-100"
            />
          ) : hasHookActions ? (
            <MessageActions className="opacity-0 transition-opacity group-hover/assistant-turn:opacity-100 focus-within:opacity-100">
              <ConversationHookDetailsAction rows={unit.hookInvocations} turnId={unit.turnId} />
            </MessageActions>
          ) : null}
          {unit.assistantTailRows.length > 0 ? (
            // turnTailBoundary 之前虽然从工作历史中拆出，却仍在 flow 内渲染，
            // 使 CronCreate、文件 summary 与操作栏看起来落在 fork 分割线之后。boundary
            // 必须统一收在全部 turn-local 附属 UI 之后，才是真正的 logical turn 结尾。
            <ConversationAssistantWorkItems
              rows={unit.assistantTailRows}
              context={assistantRowContext}
              assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
            />
          ) : null}
        </div>
      ) : (
        <ConversationTurnFlow
          unit={unit}
          apiRetry={apiRetry}
          context={assistantRowContext}
          onEdit={onEdit}
          editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
          shareSelectionToggle={shareSelectionToggle}
          shareSelectionRowId={shareSelectionRows[0]?.rowId}
          assistantCopyText={assistantCopyText}
          assistantCodeCommentCards={assistantCodeCommentCards}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        />
      )}
    </section>
  );
}

export const ConversationTurnGroup = memo(ConversationTurnGroupImpl);
