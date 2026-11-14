/**
 * platform(action=domain.op) 工具卡：用注册表中文枚举，避免 Fallback 显示
 * 「Platform / 工具调用 / 已执行」。
 * 绑渠道扫码不塞进本卡：由轮尾 BindChannelTurnCards 单独挂出，工具行留在原位。
 */
import { Building2 } from "lucide-react";
import { useCallback, useMemo } from "react";
import {
  platformActionShortLabelZh,
  platformDomainLabelZh,
} from "../../../lib/platform-action-labels.js";
import type { PlatformUiFeedback } from "../../../lib/right-stage/platform-feedback.js";
import { ToolCallBody } from "@/ToolCallBlocks/ToolCallBody.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import {
  readToolResultDisplay,
  type PlatformUiToolResultDisplay,
} from "@/ToolCallBlocks/toolResultDisplay.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { PlatformMediaGeneratingPlaceholder } from "./PlatformMediaGeneratingPlaceholder.js";
import { PlatformMediaPreview } from "./PlatformMediaPreview.js";
import { logWorkflowProgress } from "../../../lib/workflow-progress-debug-log.js";
import { WorkflowToolSummary } from "@/v4/WorkflowToolSummary.js";
import {
  isPlatformWorkflowProgressAction,
  readPlatformWorkflowProgressRef,
} from "./platformWorkflowProgress.js";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";

/** 同步生图：一次工具调用内提交+轮询，适合挂「出图中」彩色占位。异步视频提交不走这里。 */
const SYNC_IMAGE_GENERATE_ACTIONS = new Set(["media.generate_image"]);

const PLATFORM_TOOL_ICON = <Building2 className="size-4 shrink-0 text-foreground-subtle" />;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 从 platform 入参取出 action（含流式半截 JSON）。 */
export function readPlatformToolAction(input: unknown): string {
  if (isPlainRecord(input)) {
    const direct = readTrimmedString(input.action);
    if (direct) return direct;
  }
  if (typeof input === "string") {
    const m = input.match(/"action"\s*:\s*"([^"]+)"/);
    if (m?.[1]) return m[1].trim();
  }
  return "";
}

function parseArgsJson(input: Record<string, unknown>): Record<string, unknown> | null {
  const raw = input.args_json ?? input.argsJson;
  if (isPlainRecord(raw)) return raw;
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t || t === "{}") return null;
  try {
    const parsed = JSON.parse(t) as unknown;
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 折叠条右侧摘要：query / name 等可读字段，不暴露 id。 */
export function readPlatformToolBrief(input: unknown): string {
  if (!isPlainRecord(input)) return "";
  const payload = parseArgsJson(input) || {};
  const candidates = [
    payload.prompt,
    payload.query,
    payload.search,
    payload.name,
    payload.title,
    payload.agent_name,
    payload.role_name,
    payload.status,
    payload.task_id,
    payload.taskId,
    input.query,
    input.domain,
  ];
  for (const c of candidates) {
    const s = readTrimmedString(c);
    if (s) return s.length > 40 ? `${s.slice(0, 40)}…` : s;
  }
  return "";
}

/** 从 platform 入参取生图宽高比（占位框比例）。 */
export function readPlatformMediaAspectRatio(input: unknown): string | undefined {
  if (!isPlainRecord(input)) return undefined;
  const payload = parseArgsJson(input) || {};
  const ratio =
    readTrimmedString(payload.aspect_ratio) ||
    readTrimmedString(payload.aspectRatio) ||
    readTrimmedString(input.aspect_ratio) ||
    readTrimmedString(input.aspectRatio);
  return ratio || undefined;
}

export function isPlatformToolCall(toolCall: {
  toolName?: string | null;
  kind?: string | null;
}): boolean {
  const name = String(toolCall.toolName || "").trim().toLowerCase();
  const kind = String(toolCall.kind || "").trim().toLowerCase();
  return name === "platform" || kind === "platform";
}

/**
 * V4 ``output.display.kind:"platform_ui"`` → 绑渠道扫码反馈。
 * 供轮尾挂码；工具卡本身不渲染二维码。
 */
export function readPlatformBindChannelFeedback(
  raw: unknown,
): PlatformUiFeedback | null {
  const display = readToolResultDisplay(raw);
  if (!display || display.kind !== "platform_ui") return null;
  const qrUrl = String(display.qrUrl || "").trim();
  const sessionId = String(display.sessionId || "").trim();
  if (!qrUrl && !sessionId) return null;
  const action = String(display.action || "").trim();
  if (action && action !== "employees.bind_channel_begin" && !display.bindStatus) {
    return null;
  }
  return {
    kind: "success",
    action: action || "employees.bind_channel_begin",
    title: String(display.title || "扫码绑定本岗 AI 员工").trim(),
    qrUrl: qrUrl || undefined,
    sessionId: sessionId || undefined,
    channel: String(display.channel || "feishu").trim() || "feishu",
    agentCode: String(display.agentCode || "").trim() || undefined,
    entityLabel: String(display.entityLabel || "").trim() || undefined,
    entityId: String(display.agentCode || "").trim() || undefined,
    bindStatus: display.bindStatus || "pending",
  };
}

/**
 * V4 platform 结果 → 进度侧栏反馈（workflow.run autoOpen 等）。
 * 优先读 ``output.display.actions``；否则回落解析正文 JSON 的 ``ui``。
 */
export function readPlatformProgressFeedback(raw: unknown): PlatformUiFeedback | null {
  const display = readToolResultDisplay(raw);
  if (display?.kind === "platform_ui" && Array.isArray(display.actions) && display.actions.length) {
    const actions = display.actions
      .filter((a) => a && a.openStage && String(a.openStage.kind || "").trim())
      .map((a) => ({
        label: String(a.label || "").trim() || "查看进度",
        autoOpen: a.autoOpen === true,
        route: a.route,
        openStage: a.openStage
          ? {
              kind: String(a.openStage.kind || "").trim(),
              title: a.openStage.title,
              layout: a.openStage.layout,
              data: a.openStage.data || null,
            }
          : undefined,
      }));
    if (actions.some((a) => a.autoOpen && a.openStage)) {
      const actionName = String(display.action || "").trim();
      const entityLabel = String(display.entityLabel || display.agentCode || "").trim();
      const domainGuess = actionName.includes(".")
        ? actionName.split(".")[0]
        : entityLabel
          ? "employees"
          : "workflow";
      return {
        kind: "success",
        action: actionName || undefined,
        title: String(display.title || "平台操作成功").trim(),
        domain: domainGuess,
        entityLabel: entityLabel || undefined,
        entityId: String(display.agentCode || "").trim() || undefined,
        actions,
      };
    }
  }

  // 冷路径 / 旧镜像：display 未带 actions 时从正文 ui 解
  let blob: unknown = raw;
  if (isPlainRecord(raw) && typeof raw.rawOutput === "string") {
    blob = raw.rawOutput;
  } else if (isPlainRecord(raw) && typeof raw.output === "string") {
    blob = raw.output;
  } else if (isPlainRecord(raw) && isPlainRecord(raw.output) && typeof raw.output.text === "string") {
    blob = raw.output.text;
  }
  if (typeof blob === "string") {
    const t = blob.trim();
    if (t.startsWith("{")) {
      try {
        blob = JSON.parse(t) as unknown;
      } catch {
        return null;
      }
    }
  }
  if (!isPlainRecord(blob) || blob.ok === false || blob.pending_confirm === true) return null;
  const ui = isPlainRecord(blob.ui) ? blob.ui : null;
  if (!ui || !Array.isArray(ui.actions)) return null;
  const actions = ui.actions
    .filter((row): row is Record<string, unknown> => isPlainRecord(row))
    .map((row) => {
      const open = isPlainRecord(row.openStage) ? row.openStage : null;
      const kind = open ? readTrimmedString(open.kind) : "";
      return {
        label: readTrimmedString(row.label) || "查看进度",
        autoOpen: row.autoOpen === true,
        route: readTrimmedString(row.route) || undefined,
        openStage: kind
          ? {
              kind,
              title: readTrimmedString(open?.title) || undefined,
              layout: readTrimmedString(open?.layout) || undefined,
              data: isPlainRecord(open?.data) ? open.data : null,
            }
          : undefined,
      };
    })
    .filter((a) => a.openStage);
  if (!actions.some((a) => a.autoOpen && a.openStage)) return null;
  return {
    kind: "success",
    action: readTrimmedString(ui.action) || readTrimmedString(blob.action) || undefined,
    title: readTrimmedString(ui.title) || "平台操作成功",
    domain: readTrimmedString(ui.domain) || undefined,
    actions,
  };
}

/** 从 display 或工具正文 JSON 抽出 media.* 预览列表。 */
export function readPlatformMediaPreview(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): NonNullable<PlatformUiToolResultDisplay["media"]> {
  const display = readToolResultDisplay(toolCall.raw);
  if (display?.kind === "platform_ui" && Array.isArray(display.media) && display.media.length) {
    return display.media;
  }

  let blob: unknown = toolCall.raw;
  if (isPlainRecord(blob) && typeof blob.rawOutput === "string") blob = blob.rawOutput;
  else if (isPlainRecord(blob) && typeof blob.output === "string") blob = blob.output;
  else if (isPlainRecord(blob) && isPlainRecord(blob.output) && typeof blob.output.text === "string") {
    blob = blob.output.text;
  }
  if (typeof blob === "string") {
    const t = blob.trim();
    if (t.startsWith("{")) {
      try {
        blob = JSON.parse(t) as unknown;
      } catch {
        return [];
      }
    }
  }
  if (!isPlainRecord(blob) || blob.ok === false) return [];

  const nestedUi = isPlainRecord(blob.ui) ? blob.ui : null;
  if (nestedUi && Array.isArray(nestedUi.media) && nestedUi.media.length) {
    return nestedUi.media.filter(isPlainRecord).map((row) => ({
      kind: readTrimmedString(row.kind) || undefined,
      mimeType: readTrimmedString(row.mimeType) || undefined,
      artifactUri: readTrimmedString(row.artifactUri) || undefined,
      absolutePath: readTrimmedString(row.absolutePath) || undefined,
      url: readTrimmedString(row.url) || undefined,
    }));
  }

  const preview = isPlainRecord(blob.preview) ? blob.preview : null;
  let src =
    readTrimmedString(preview?.src) ||
    readTrimmedString(blob.absolute_path) ||
    readTrimmedString(blob.local_path) ||
    readTrimmedString(blob.url);
  if (!src && Array.isArray(blob.urls) && blob.urls.length) {
    src = readTrimmedString(blob.urls[0]);
  }
  // Cold / vendor-shaped payloads: walk common URL keys before giving up.
  if (!src) {
    const queue: unknown[] = [blob];
    const seen = new Set<unknown>();
    const KEYS = [
      "download_url",
      "video_url",
      "image_url",
      "content_url",
      "file_url",
      "result_url",
      "url",
      "src",
      "absolute_path",
      "local_path",
    ];
    while (queue.length && !src) {
      const node = queue.shift();
      if (!node || seen.has(node)) continue;
      seen.add(node);
      if (typeof node === "string") {
        const s = node.trim();
        if (/^(https?:|data:|file:)/i.test(s) || /\.(png|jpe?g|gif|webp|mp4|webm|mov)(\?|$)/i.test(s)) {
          src = s;
        }
        continue;
      }
      if (Array.isArray(node)) {
        for (const item of node.slice(0, 20)) queue.push(item);
        continue;
      }
      if (!isPlainRecord(node)) continue;
      for (const key of KEYS) {
        const v = node[key];
        if (typeof v === "string" && v.trim()) {
          src = v.trim();
          break;
        }
      }
      if (src) break;
      for (const nest of ["data", "output", "content", "result", "task", "file", "preview"]) {
        if (node[nest] != null) queue.push(node[nest]);
      }
    }
  }
  if (!src) return [];
  const kind =
    readTrimmedString(preview?.kind) ||
    readTrimmedString(blob.media_kind) ||
    (/\.(mp4|webm|mov|mkv|m4v)(\?|$)/i.test(src) ? "video" : "image");
  return [
    {
      kind,
      mimeType: kind === "video" ? "video/mp4" : "image/png",
      artifactUri: src,
      absolutePath: readTrimmedString(blob.absolute_path) || undefined,
      url: readTrimmedString(blob.url) || undefined,
    },
  ];
}

export function PlatformToolCallBlock(context: ToolCallBlockRenderContext) {
  const {
    toolCallNode,
    isRunning,
    statusLabel,
    errorText,
    childToolList,
    displayModel,
    workspacePath,
    theme,
    codePreviewSettings,
    onOpenCodeViewer,
    onOpenFileLink,
    onOpenBrowserUrl,
  } = context;
  const { toolCall } = toolCallNode;
  const action = readPlatformToolAction(toolCall.input);
  const domain = action.includes(".") ? action.slice(0, action.indexOf(".")) : "";
  const actionLabel =
    platformActionShortLabelZh(action, { max: 24 }) ||
    platformDomainLabelZh(domain) ||
    "平台管理";
  const brief = readPlatformToolBrief(toolCall.input);
  const kindLabel = context.kindLabelOverride ?? "平台";
  const primaryText = brief ? `${actionLabel} · ${brief}` : actionLabel;
  const mediaPreview = useMemo(() => readPlatformMediaPreview(toolCall), [toolCall]);
  const aspectRatio = useMemo(() => readPlatformMediaAspectRatio(toolCall.input), [toolCall.input]);
  const showGeneratingPlaceholder =
    isRunning &&
    SYNC_IMAGE_GENERATE_ACTIONS.has(action) &&
    mediaPreview.length === 0 &&
    toolCall.status !== "failed";
  // 有媒体结果：只出预览画廊（对齐 CUA / browser_turn_end），整卡已提到轮尾。
  const mediaOnly = mediaPreview.length > 0;
  // workflow.run 族：有 mainTaskId 即挂进度卡。
  // 1) display/openStage（与右栏 autoOpen 同源）
  // 2) 兜底：snapshot.workflowRuns join —— 底部「运行中工作流」图标亮时投影已在，
  //    不能因 display 解析慢/缺 openStage 只剩工具图标、对话里却没有进度卡。
  const workflowProgressRef = useMemo(() => {
    const display =
      toolCall.raw &&
      typeof toolCall.raw === "object" &&
      "display" in toolCall.raw
        ? (toolCall.raw as { display?: unknown }).display
        : undefined;
    const displayAction =
      display &&
      typeof display === "object" &&
      display !== null &&
      "action" in display &&
      typeof (display as { action?: unknown }).action === "string"
        ? String((display as { action: string }).action).trim()
        : "";
    const fromDisplay = readPlatformWorkflowProgressRef({
      action: action || displayAction,
      raw: toolCall.raw,
      display,
      outputText:
        typeof toolCall.raw === "object" &&
        toolCall.raw &&
        "rawOutput" in toolCall.raw &&
        typeof (toolCall.raw as { rawOutput?: unknown }).rawOutput === "string"
          ? (toolCall.raw as { rawOutput: string }).rawOutput
          : typeof toolCall.output === "string"
            ? toolCall.output
            : undefined,
    });
    if (fromDisplay) {
      logWorkflowProgress(
        "platform.progressRef:fromDisplay",
        {
          toolId: toolCall.toolId,
          action: action || displayAction,
          mainTaskId: fromDisplay.mainTaskId,
          hasJoin: Boolean(context.workflowRun?.runId),
          joinRunId: context.workflowRun?.runId ?? null,
        },
        { dedupeKey: `ref-display:${toolCall.toolId}:${fromDisplay.mainTaskId}` },
      );
      return fromDisplay;
    }
    const joined = context.workflowRun;
    const runId = String(joined?.runId || "").trim();
    if (!runId) {
      logWorkflowProgress(
        "platform.progressRef:null",
        {
          toolId: toolCall.toolId,
          action: action || displayAction,
          status: toolCall.status,
          hasRaw: Boolean(toolCall.raw),
          hasDisplay: Boolean(display),
          displayKind:
            display && typeof display === "object" && display !== null && "kind" in display
              ? String((display as { kind?: unknown }).kind || "")
              : "",
          joinMissing: true,
        },
        { dedupeKey: `ref-null:${toolCall.toolId}:${action || displayAction}` },
      );
      return null;
    }
    const label =
      readTrimmedString(
        (display as { title?: unknown } | undefined)?.title ||
          (display as { entityLabel?: unknown } | undefined)?.entityLabel,
      ) || "工作流";
    logWorkflowProgress(
      "platform.progressRef:fromJoin",
      {
        toolId: toolCall.toolId,
        action: action || displayAction,
        runId,
        joinStatus: joined?.status ?? null,
      },
      { dedupeKey: `ref-join:${toolCall.toolId}:${runId}` },
    );
    return {
      mainTaskId: runId,
      runId,
      name: label,
    };
  }, [action, context.workflowRun, toolCall.output, toolCall.raw, toolCall.status, toolCall.toolId]);

  const handleLoadFullToolCallFields = context.onLoadFullToolCallFields;
  // 媒体预览挂在工具卡外侧，避免 forceOpen 把入参/结果 JSON 一起摊开。
  const renderContent = useCallback(
    () => (
      <>
        <ToolCallBody
          childToolList={childToolList}
          displayModel={displayModel}
          toolCall={toolCall}
          workspacePath={workspacePath}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          onOpenCodeViewer={onOpenCodeViewer}
          onOpenFileLink={onOpenFileLink}
          onOpenBrowserUrl={onOpenBrowserUrl}
        />
        <ToolSnapshotFieldNotice
          refs={toolCall.snapshotRefs ?? []}
          onLoadFullToolCallFields={
            handleLoadFullToolCallFields
              ? () => handleLoadFullToolCallFields(toolCall.toolId)
              : undefined
          }
        />
      </>
    ),
    [
      childToolList,
      codePreviewSettings,
      displayModel,
      handleLoadFullToolCallFields,
      onOpenBrowserUrl,
      onOpenCodeViewer,
      onOpenFileLink,
      theme,
      toolCall,
      workspacePath,
    ],
  );

  const primaryTextNode = useMemo(
    () => <span className="min-w-0 truncate text-foreground-subtlest">{primaryText}</span>,
    [primaryText],
  );

  if (mediaOnly) {
    return (
      <PlatformMediaPreview media={mediaPreview} label={actionLabel || "生成媒体"} />
    );
  }

  // workflow.run：工具行只出一行摘要（对齐 CreateWorkflow → WorkflowToolSummary）；
  // 完整进度卡只在轮尾 digests，避免「工具下一块 + 轮尾再一块」。
  if (workflowProgressRef) {
    const joined = context.workflowRun;
    const summary: WorkflowRunCardSummary = joined ?? {
      runId: workflowProgressRef.mainTaskId,
      status: isRunning ? "running" : "pending",
      nodesSettled: 0,
      nodesTotal: 0,
      toolCallId: toolCall.toolId,
    };
    logWorkflowProgress(
      "platform.render:toolSummary",
      {
        toolId: toolCall.toolId,
        mainTaskId: workflowProgressRef.mainTaskId,
        hasJoin: Boolean(joined?.runId),
        joinStatus: joined?.status ?? null,
      },
      { dedupeKey: `ref-summary:${toolCall.toolId}:${workflowProgressRef.mainTaskId}` },
    );
    return (
      <WorkflowToolSummary
        toolCallId={toolCall.toolId}
        summary={summary}
        onOpen={
          context.onOpenWorkflowRun
            ? () =>
                context.onOpenWorkflowRun?.({
                  workflowName: workflowProgressRef.name,
                })
            : undefined
        }
      />
    );
  }

  if (isPlatformWorkflowProgressAction(action)) {
    logWorkflowProgress(
      "platform.render:toolLayoutOnly",
      {
        toolId: toolCall.toolId,
        action,
        status: toolCall.status,
        isRunning,
      },
      { dedupeKey: `render-layout:${toolCall.toolId}:${action}` },
    );
  }

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={PLATFORM_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={context.canToggle ?? true}
        forceOpen={context.forceOpen}
        kindLabel={kindLabel}
        sourceLabel={context.sourceLabel}
        primaryText={primaryTextNode}
        secondaryText={toolCall.status === "failed" ? undefined : statusLabel}
        statusLabel={toolCall.status === "failed" ? statusLabel : undefined}
        statusTooltip={toolCall.status === "failed" ? errorText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={isRunning}
        title={primaryText}
        renderContent={renderContent}
      />
      {showGeneratingPlaceholder ? (
        <PlatformMediaGeneratingPlaceholder
          aspectRatio={aspectRatio}
          label={`${actionLabel || "生图"}中`}
        />
      ) : null}
    </>
  );
}
