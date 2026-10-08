import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  EMPTY_SCROLL_MASK_STATE,
  getVerticalScrollMaskStyle,
  resolveVerticalScrollMaskState,
  type ScrollMaskState,
} from "@/mentions/components/scrollMask.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { buildCuaSummaryPresentation } from "@/ToolCallBlocks/renderers/cua.js";
import { CUA_TOOL_ICON } from "@/ToolCallBlocks/renderers/cuaIcon.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import type { ConversationCuaGroupEvent } from "@/v4/conversationCuaGroups.js";

const TERMINAL_CUA_STATUSES = new Set(["completed", "failed", "stopped"]);
const STICK_TO_BOTTOM_THRESHOLD_PX = 8;

function scrollCuaGroupToBottom(viewport: Pick<HTMLElement, "scrollHeight" | "scrollTop">) {
  viewport.scrollTop = viewport.scrollHeight;
}

function isCuaGroupViewportAtBottom(
  viewport: Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">,
) {
  return (
    viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <=
    STICK_TO_BOTTOM_THRESHOLD_PX
  );
}

interface CuaGroupRenderProps extends ToolCallBlockRenderContext {
  events?: readonly ConversationCuaGroupEvent[];
  renderAssistantMessage?: (
    event: Extract<ConversationCuaGroupEvent, { kind: "assistantMessage" }>,
  ) => ReactNode;
  renderReasoning?: (event: Extract<ConversationCuaGroupEvent, { kind: "reasoning" }>) => ReactNode;
}

function CuaGroupChildren({
  events,
  context,
  renderAssistantMessage,
  renderReasoning,
}: {
  events: readonly ConversationCuaGroupEvent[];
  context: ToolCallBlockRenderContext;
  renderAssistantMessage?: CuaGroupRenderProps["renderAssistantMessage"];
  renderReasoning?: CuaGroupRenderProps["renderReasoning"];
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const [scrollMaskState, setScrollMaskState] = useState<ScrollMaskState>(EMPTY_SCROLL_MASK_STATE);
  const updateScrollState = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      setScrollMaskState(EMPTY_SCROLL_MASK_STATE);
      return;
    }
    shouldStickToBottomRef.current = isCuaGroupViewportAtBottom(viewport);
    setScrollMaskState(
      resolveVerticalScrollMaskState({
        clientHeight: viewport.clientHeight,
        scrollHeight: viewport.scrollHeight,
        scrollTop: viewport.scrollTop,
      }),
    );
  }, []);
  const scrollToBottom = useCallback(() => {
    if (!viewportRef.current) return;
    scrollCuaGroupToBottom(viewportRef.current);
    updateScrollState();
  }, [updateScrollState]);

  useLayoutEffect(() => {
    if (shouldStickToBottomRef.current) scrollToBottom();
  }, [events.length, scrollToBottom]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content || typeof ResizeObserver === "undefined") return;

    // 每次尺寸变化都强制吸底会让用户向上查看历史时被截图加载或流式
    // message 拉回底部。只有用户原本位于底部时才跟随新内容。
    const observer = new ResizeObserver(() => {
      if (shouldStickToBottomRef.current) scrollToBottom();
      else updateScrollState();
    });
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollToBottom, updateScrollState]);

  const scrollMaskData =
    scrollMaskState.showTop && scrollMaskState.showBottom
      ? "both"
      : scrollMaskState.showTop
        ? "top"
        : scrollMaskState.showBottom
          ? "bottom"
          : "none";

  return (
    <div
      ref={viewportRef}
      className="max-h-72 overflow-y-auto overscroll-contain"
      data-cua-group-scroll-mask={scrollMaskData}
      onScroll={updateScrollState}
      style={getVerticalScrollMaskStyle(scrollMaskState)}
    >
      <div ref={contentRef} className="ml-2 space-y-2 border-border border-l pl-3.5">
        {events.map((event) =>
          event.kind === "tool" ? (
            <ToolCallBlock
              key={`tool:${event.row.toolCallId}`}
              toolCallNode={event.node}
              workspacePath={context.workspacePath}
              theme={context.theme}
              codePreviewSettings={context.codePreviewSettings}
              showIcon
              cuaAppIconClassName="size-5"
              onOpenCodeViewer={context.onOpenCodeViewer}
              onOpenFileLink={context.onOpenFileLink}
              onOpenBrowserUrl={context.onOpenBrowserUrl}
              onOpenAutomationsMain={context.onOpenAutomationsMain}
              onLoadFullToolCallFields={context.onLoadFullToolCallFields}
            />
          ) : event.kind === "assistantMessage" ? (
            <div
              key={`message:${event.row.rowId}`}
              className="min-w-0 py-1 text-ui-base text-foreground-subtle"
            >
              <div className="min-w-0">
                {renderAssistantMessage?.(event) ?? (
                  <span className="whitespace-pre-wrap break-words">{event.row.text}</span>
                )}
              </div>
            </div>
          ) : (
            <div key={`reasoning:${event.row.rowId}`} className="min-w-0 py-1">
              {renderReasoning?.(event) ?? (
                <span className="whitespace-pre-wrap break-words">{event.row.text}</span>
              )}
            </div>
          ),
        )}
      </div>
    </div>
  );
}

export function CuaGroupToolCallBlock(context: CuaGroupRenderProps) {
  const { intl } = useZCodeIntl();
  const { toolCall, childToolCalls } = context.toolCallNode;
  const events: readonly ConversationCuaGroupEvent[] =
    context.events ??
    childToolCalls.map((node) => ({
      kind: "tool" as const,
      row: {
        rowId: 0,
        turnId: "",
        createdAt: 0,
        createdAtSeq: 0,
        kind: "toolCall" as const,
        toolCallId: node.toolCall.toolId,
        toolName: node.toolCall.toolName ?? node.toolCall.kind ?? "Computer Use",
        status: "success" as const,
        input: node.toolCall.input,
        inputText: "",
      },
      node,
    }));
  const latestSummaryEvent = events.findLast(
    (event): event is Extract<ConversationCuaGroupEvent, { kind: "tool" }> =>
      event.kind === "tool" && TERMINAL_CUA_STATUSES.has(event.node.toolCall.status),
  );
  const latestToolSummary =
    latestSummaryEvent !== undefined
      ? buildCuaSummaryPresentation(latestSummaryEvent.node.toolCall, intl, {
          appIconClassName: "size-5",
        })
      : null;
  const isRunning = context.isRunning || toolCall.status === "in_progress";
  const eventCount = events.length;
  const messageCount = events.filter((event) => event.kind === "assistantMessage").length;
  const eventCountText = intl.formatMessage(
    {
      id:
        eventCount === 1
          ? "chat.toolCall.cua.group.event.one"
          : "chat.toolCall.cua.group.event.other",
    },
    { count: eventCount },
  );
  const messageCountText =
    messageCount > 0 || !isRunning
      ? intl.formatMessage(
          {
            id:
              messageCount === 1
                ? "chat.toolCall.cua.group.message.one"
                : "chat.toolCall.cua.group.message.other",
          },
          { count: messageCount },
        )
      : null;
  const animatedTextClass = isRunning
    ? "cua-group-gradient-text min-w-0 truncate"
    : "min-w-0 truncate text-foreground-subtlest";
  const primaryText = latestSummaryEvent ? (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span className="shrink-0 size-4 flex items-center justify-center [&_svg]:size-4">
        {latestToolSummary?.icon ?? CUA_TOOL_ICON}
      </span>
      <span className={animatedTextClass}>
        {latestToolSummary ? (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 font-medium">{latestToolSummary.appName}</span>
            <span className="min-w-0 truncate">{latestToolSummary.primaryText}</span>
          </span>
        ) : null}
      </span>
      {latestToolSummary?.isFailed ? (
        <span className="shrink-0 text-foreground-subtlest">
          {intl.formatMessage({ id: "chat.toolCall.status.failed" })}
        </span>
      ) : null}
    </span>
  ) : null;
  const diffCount = (
    <span className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap">
      {latestSummaryEvent || !isRunning ? <span>·</span> : null}
      <span>
        {eventCountText}
        {messageCountText ? `, ${messageCountText}` : null}
      </span>
    </span>
  );
  const renderContent = useCallback(
    () => (
      <CuaGroupChildren
        events={events}
        context={context}
        renderAssistantMessage={context.renderAssistantMessage}
        renderReasoning={context.renderReasoning}
      />
    ),
    [context, events],
  );

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={isRunning ? null : CUA_TOOL_ICON}
      showIcon={!isRunning}
      canToggle={context.canToggle ?? true}
      forceOpen={!isRunning && (context.forceOpen ?? false)}
      kindLabel={
        isRunning ? null : intl.formatMessage({ id: "chat.toolCall.cua.group.completedLabel" })
      }
      primaryText={isRunning ? primaryText : null}
      prioritizePrimaryText
      diffCount={diffCount}
      animateSummaryContent={isRunning}
      disableSummaryContentAnimation={context.disableSummaryContentAnimation}
      summaryContentKey={
        latestSummaryEvent
          ? `cua:${toolCall.toolId}:tool:${latestSummaryEvent.row.toolCallId}:${latestSummaryEvent.node.toolCall.status}`
          : `cua:${toolCall.toolId}:empty`
      }
      isRunning={isRunning}
      title={
        isRunning
          ? (latestToolSummary?.title ?? toolCall.title)
          : intl.formatMessage({ id: "chat.toolCall.cua.group.completedLabel" })
      }
      renderContent={renderContent}
    />
  );
}
