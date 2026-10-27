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
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

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
    payload.query,
    payload.search,
    payload.name,
    payload.title,
    payload.agent_name,
    payload.role_name,
    payload.status,
    input.query,
    input.domain,
  ];
  for (const c of candidates) {
    const s = readTrimmedString(c);
    if (s) return s.length > 40 ? `${s.slice(0, 40)}…` : s;
  }
  return "";
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

  const handleLoadFullToolCallFields = context.onLoadFullToolCallFields;
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

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={PLATFORM_TOOL_ICON}
      showIcon={context.showIcon !== false}
      canToggle={context.canToggle ?? true}
      forceOpen={context.forceOpen ?? false}
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
  );
}
