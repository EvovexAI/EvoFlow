import { BotIcon } from "lucide-react";
import { useCallback, useMemo, type ReactNode } from "react";
import type { AgentColor } from "@zcode/shared";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveSubagentColorFromName, SUBAGENT_TEXT_COLOR_CLASS } from "@/lib/subagentColors.js";
import { useSubagentsContextStore } from "@/store/subagentsContextStore.js";
import { useSubagentsStore } from "@/store/subagentsStore.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { getLatestExploreChildSummaryFromChildren } from "./explore.js";
import { AgentPromptSection } from "./agentPromptSection.js";
import {
  formatAgentMessage,
  getAgentColor,
  getAgentKindLabel,
  getAgentActivityContent,
  getAgentPrimaryText,
  getAgentPrompt,
  readBackgroundAgentInfo,
} from "./agentHelpers.js";

const AGENT_TOOL_ICON = <BotIcon className="size-4 shrink-0 text-foreground-subtle" />;

function AgentChildToolList({
  childToolCalls,
  workspacePath,
  theme,
  codePreviewSettings,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
  onOpenAutomationsMain,
  onLoadFullToolCallFields,
}: {
  childToolCalls: ToolCallBlockRenderContext["toolCallNode"]["childToolCalls"];
  workspacePath: string;
  theme?: ToolCallBlockRenderContext["theme"];
  codePreviewSettings?: ToolCallBlockRenderContext["codePreviewSettings"];
  onOpenCodeViewer?: ToolCallBlockRenderContext["onOpenCodeViewer"];
  onOpenFileLink?: ToolCallBlockRenderContext["onOpenFileLink"];
  onOpenBrowserUrl?: ToolCallBlockRenderContext["onOpenBrowserUrl"];
  onOpenAutomationsMain?: ToolCallBlockRenderContext["onOpenAutomationsMain"];
  onLoadFullToolCallFields?: ToolCallBlockRenderContext["onLoadFullToolCallFields"];
}) {
  if (childToolCalls.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      {childToolCalls.map((childToolCallNode) => (
        <ToolCallBlock
          key={childToolCallNode.toolCall.toolId}
          toolCallNode={childToolCallNode}
          depth={1}
          workspacePath={workspacePath}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          showIcon={false}
          onOpenCodeViewer={onOpenCodeViewer}
          onOpenFileLink={onOpenFileLink}
          onOpenBrowserUrl={onOpenBrowserUrl}
          onOpenAutomationsMain={onOpenAutomationsMain}
          onLoadFullToolCallFields={onLoadFullToolCallFields}
          suppressSourceLabel
        />
      ))}
    </div>
  );
}

function AgentActivitySection({
  label,
  content,
  workspacePath,
  theme,
  codePreviewSettings,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
}: {
  label: string;
  content: string;
  workspacePath: string;
  theme?: ToolCallBlockRenderContext["theme"];
  codePreviewSettings?: ToolCallBlockRenderContext["codePreviewSettings"];
  onOpenCodeViewer?: ToolCallBlockRenderContext["onOpenCodeViewer"];
  onOpenFileLink?: ToolCallBlockRenderContext["onOpenFileLink"];
  onOpenBrowserUrl?: ToolCallBlockRenderContext["onOpenBrowserUrl"];
}) {
  return (
    <section className="space-y-2">
      <div className="rounded-lg border border-border bg-background-alt/40 flex flex-col">
        <h4 className="p-3 text-ui-base font-medium tracking-wide text-foreground-subtlest uppercase">
          {label}
        </h4>
        <div className="overflow-auto max-h-64" data-markdown-table-sticky-scrollbar="disabled">
          {/* Agent 活动内容同样可能包含长代码/路径，允许横向滚动避免窄屏截断。*/}
          <MessageResponse
            className="px-3 py-2 min-w-0 break-words text-ui-base [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            workspacePath={workspacePath}
            theme={theme}
            codePreviewSettings={codePreviewSettings}
            onOpenCodeViewer={onOpenCodeViewer}
            onOpenFileLink={onOpenFileLink}
            onOpenExternalUrl={onOpenBrowserUrl}
          >
            {content}
          </MessageResponse>
        </div>
      </div>
    </section>
  );
}

function BackgroundAgentProcessRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-2">
      <div className="text-foreground-subtlest">{label}</div>
      <div className="min-w-0 text-foreground-subtle">{children}</div>
    </div>
  );
}

function AgentNameText({ color, name }: { color: AgentColor; name: string }) {
  return (
    <span
      className={cn(
        // 子智能体名在 tool summary 行内不能依赖字体基线对齐。
        // inline-flex 负责垂直居中，1.5 倍行高保持和周围摘要文字一致的阅读节奏。
        "inline-flex max-w-36 items-center truncate font-mono text-ui-base font-medium leading-[1.5]",
        SUBAGENT_TEXT_COLOR_CLASS[color],
      )}
      title={name}
    >
      {name}
    </span>
  );
}

function normalizeAgentLookupValue(value: string): string {
  return value.trim().toLowerCase();
}

function BackgroundAgentProcessSection({
  outputFile,
  hasActivity,
  isRunning,
  status,
}: {
  outputFile?: string;
  hasActivity: boolean;
  isRunning: boolean;
  status: string | undefined;
}) {
  const { intl } = useZCodeIntl();
  const msg = (id: string, fallback: string) => formatAgentMessage(intl, id, fallback);
  const launchStatus =
    status === "failed"
      ? msg("chat.toolCall.agent.backgroundLaunchFailed", "启动失败")
      : status === "pending"
        ? msg("chat.toolCall.agent.backgroundLaunching", "启动中")
        : msg("chat.toolCall.agent.backgroundLaunched", "已启动");
  const launchStatusKind =
    status === "failed" ? "failed" : status === "pending" ? "pending" : "launched";
  const activityStatus = isRunning
    ? hasActivity
      ? msg("chat.toolCall.agent.backgroundActivityStreaming", "后台运行中，正在同步输出")
      : msg("chat.toolCall.agent.backgroundActivityRunningWaiting", "后台运行中，等待输出")
    : hasActivity
      ? msg("chat.toolCall.agent.backgroundActivityReceived", "已收到子智能体回传")
      : msg("chat.toolCall.agent.backgroundActivityWaiting", "等待子智能体回传");
  const activityStatusKind = isRunning
    ? hasActivity
      ? "streaming"
      : "running_waiting"
    : hasActivity
      ? "received"
      : "waiting";

  return (
    <section
      data-background-agent-activity-status={activityStatusKind}
      data-background-agent-launch-status={launchStatusKind}
      className="rounded-lg border border-border bg-background-alt/40 p-3 text-ui-base"
    >
      <div className="font-medium text-foreground-subtle">
        {msg("chat.toolCall.agent.backgroundProcess", "后台 Agent 过程")}
      </div>
      <div className="mt-2 space-y-2">
        <BackgroundAgentProcessRow label={msg("chat.toolCall.agent.backgroundLaunch", "启动")}>
          {launchStatus}
        </BackgroundAgentProcessRow>
        <BackgroundAgentProcessRow label={msg("chat.toolCall.agent.backgroundActivity", "活动")}>
          {activityStatus}
        </BackgroundAgentProcessRow>
        {outputFile ? (
          <BackgroundAgentProcessRow label={msg("chat.toolCall.agent.outputFile", "输出文件")}>
            <span className="block break-all rounded-md bg-background px-2 py-1 font-mono text-foreground-subtle">
              {outputFile}
            </span>
          </BackgroundAgentProcessRow>
        ) : null}
      </div>
    </section>
  );
}

export function AgentToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall, childToolCalls } = context.toolCallNode;
  const prompt = getAgentPrompt(toolCall);
  const fallbackLabel = formatAgentMessage(intl, "chat.toolCall.agent.fallback", "SubAgent");
  const primaryText = getAgentPrimaryText(toolCall, fallbackLabel);
  const agentName = getAgentKindLabel(toolCall, "", context.authoritativeAgentType);
  const configuredAgentsFromContext = useSubagentsContextStore((state) => {
    const candidates = Object.values(state.contexts).filter(
      (candidate) => candidate.workspacePath === context.workspacePath && candidate.loaded,
    );
    // 同一 remote path 可能对应多个 workspaceIdentity；缺少 identity 时宁可回退默认色，
    // 也不能猜一个桶并把另一远端 workspace 的 Agent 配置串进来。
    return candidates.length === 1 ? candidates[0]?.agents : undefined;
  });
  const configuredAgentsFromHook = useSubagentsStore((state) => state.agents);
  const configuredAgents =
    configuredAgentsFromContext && configuredAgentsFromContext.length > 0
      ? configuredAgentsFromContext
      : configuredAgentsFromHook.length > 0
        ? configuredAgentsFromHook
        : useSubagentsStore.getState().agents;
  const configuredAgentColor = useMemo(() => {
    const lookupName = normalizeAgentLookupValue(agentName);
    if (!lookupName) {
      return undefined;
    }
    return configuredAgents.find((agent) => {
      const name = normalizeAgentLookupValue(agent.name);
      const id = normalizeAgentLookupValue(agent.id);
      return name === lookupName || id === lookupName;
    })?.color;
  }, [agentName, configuredAgents]);
  const agentColor = agentName
    ? (configuredAgentColor ?? getAgentColor(toolCall) ?? resolveSubagentColorFromName(agentName))
    : null;
  const agentNameDetail =
    agentName && agentColor ? <AgentNameText color={agentColor} name={agentName} /> : null;
  // Agent 父块的完成/进行中边界只由父 Agent tool 决定。
  // 子 tool 是展开区明细，不能反向续住父块运行态，否则父 Agent completed 后
  // 仍会显示渐变和子工具摘要，和协议里的父工具生命周期不一致。
  const isAgentVisuallyRunning = context.isRunning;
  const collapsedChildSummary = isAgentVisuallyRunning
    ? getLatestExploreChildSummaryFromChildren(intl, childToolCalls, context, {
        includeChildActionKindLabel: true,
      })
    : null;
  const backgroundAgentInfo = readBackgroundAgentInfo(toolCall);
  const activityContent = getAgentActivityContent(toolCall);
  const activityThought = toolCall.thought?.trim();
  // Agent 块和它内部的子工具都已经通过层级表达了来源，
  // 继续显示子智能体来源 badge 会制造重复噪音。
  const sourceLabel = undefined;
  const collapsedPrimaryText = useMemo(
    () => <span className="truncate">{primaryText}</span>,
    [primaryText],
  );
  const expandedPrimaryText = useMemo(
    () => <span className="truncate">{primaryText}</span>,
    [primaryText],
  );
  const summaryAction = useMemo(
    () =>
      context.agentSummaryAction
        ? {
            ...context.agentSummaryAction,
            ariaLabel: formatAgentMessage(
              intl,
              "chat.toolCall.agent.openInSidePane",
              "Open on the right",
            ),
          }
        : undefined,
    [context.agentSummaryAction, intl],
  );
  const renderContent = useCallback(
    () => (
      <div className="ml-2 space-y-3 border-border border-l pl-3.5">
        {backgroundAgentInfo ? (
          <BackgroundAgentProcessSection
            outputFile={backgroundAgentInfo.outputFile}
            hasActivity={Boolean(activityContent || activityThought)}
            isRunning={isAgentVisuallyRunning}
            status={toolCall.status}
          />
        ) : null}
        {prompt ? (
          <AgentPromptSection
            prompt={prompt}
            workspacePath={context.workspacePath}
            theme={context.theme}
            codePreviewSettings={context.codePreviewSettings}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
          />
        ) : null}
        {activityThought ? (
          <AgentActivitySection
            label={formatAgentMessage(intl, "chat.toolCall.agent.thought", "Agent thought")}
            content={activityThought}
            workspacePath={context.workspacePath}
            theme={context.theme}
            codePreviewSettings={context.codePreviewSettings}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
          />
        ) : null}
        {activityContent ? (
          <AgentActivitySection
            label={formatAgentMessage(intl, "chat.toolCall.agent.output", "Agent output")}
            content={activityContent}
            workspacePath={context.workspacePath}
            theme={context.theme}
            codePreviewSettings={context.codePreviewSettings}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
          />
        ) : null}
        <AgentChildToolList
          childToolCalls={childToolCalls}
          workspacePath={context.workspacePath}
          theme={context.theme}
          codePreviewSettings={context.codePreviewSettings}
          onOpenCodeViewer={context.onOpenCodeViewer}
          onOpenFileLink={context.onOpenFileLink}
          onOpenBrowserUrl={context.onOpenBrowserUrl}
          onOpenAutomationsMain={context.onOpenAutomationsMain}
          onLoadFullToolCallFields={context.onLoadFullToolCallFields}
        />
      </div>
    ),
    [
      activityContent,
      activityThought,
      backgroundAgentInfo,
      childToolCalls,
      context.codePreviewSettings,
      context.onLoadFullToolCallFields,
      context.onOpenBrowserUrl,
      context.onOpenCodeViewer,
      context.onOpenFileLink,
      context.theme,
      context.workspacePath,
      intl,
      isAgentVisuallyRunning,
      prompt,
      toolCall.status,
    ],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={AGENT_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={false}
        forceOpen={false}
        summaryAction={summaryAction}
        // 产品边界：Agent/Task 在父对话中只保留单行摘要；完整 child timeline 统一从
        // 右侧 tab / 手机抽屉查看，因此这里既不自动展开，也不提供手动展开入口。
        kindLabel={fallbackLabel}
        expandedKindLabel={fallbackLabel}
        kindDetail={agentNameDetail}
        expandedKindDetail={agentNameDetail}
        sourceLabel={sourceLabel}
        autoCollapseOnComplete
        primaryText={
          collapsedChildSummary ? collapsedChildSummary.primaryText : collapsedPrimaryText
        }
        expandedPrimaryText={expandedPrimaryText}
        secondaryText={collapsedChildSummary?.secondaryText}
        expandedSecondaryText={null}
        summaryContentSeparator="·"
        animateSummaryContent
        disableSummaryContentAnimation={context.disableSummaryContentAnimation}
        summaryContentKey={
          collapsedChildSummary?.animationKey ?? `agent:${toolCall.toolId}:${primaryText}`
        }
        statusLabel={context.statusLabel}
        statusTooltip={toolCall.status === "failed" ? context.errorText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={isAgentVisuallyRunning}
        title={collapsedChildSummary?.title ?? primaryText}
        expandedTitle={primaryText}
        renderContent={renderContent}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}
