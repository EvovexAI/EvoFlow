import {
  toolCallEvalWorkflowSnippetDisplaySchema,
  toolCallGetWorkflowRunDisplaySchema,
  toolCallListModelsDisplaySchema,
  toolCallListWorkflowRunsDisplaySchema,
  toolCallResumeWorkflowRunDisplaySchema,
  toolCallSavedWorkflowListDisplaySchema,
  type ToolCallEvalWorkflowSnippetDisplay,
  type ToolCallGetWorkflowRunDisplay,
  type ToolCallListModelsDisplay,
  type ToolCallListWorkflowRunsDisplay,
  type ToolCallResumeWorkflowRunDisplay,
  type ToolCallSavedWorkflowListDisplay,
} from "@zcode/shared/zcode-protocol-v4";

interface LocalAgentMessageToolResultDisplay {
  kind: "local_agent_message";
  status: "success" | "failed";
  error?: string;
  message?: string;
}

interface TaskStopToolResultDisplay {
  kind: "task_stop";
  taskId: string;
  taskType: string;
  command?: string;
  message: string;
  truncated?: boolean;
}

interface TaskOutputToolResultDisplay {
  kind: "task_output";
  retrievalStatus: "success" | "not_ready" | "timeout";
  taskStatus?: string;
  output?: string;
  truncated?: true;
}

interface RespondToCoordinatorToolResultDisplay {
  kind: "respond_to_coordinator";
  status: "success" | "failed";
}

interface CuaToolResultDisplay {
  kind: "cua";
  schemaVersion: 1;
  toolName: string;
  status: "success" | "failed";
  structuredContent?: string;
  text?: string;
  errorCode?: string;
  suggestedAction?: string;
  media?: Array<{ mimeType: string; data?: string; artifactUri?: string }>;
  truncated?: boolean;
  targetApp?: {
    schemaVersion: 1;
    displayName?: string;
    iconLocators: Array<
      | { kind: "darwin-bundle-id"; value: string }
      | { kind: "windows-executable-path"; value: string }
      | { kind: "windows-aumid"; value: string }
    >;
  };
}

/** platform 工具结构化展示：绑渠道扫码 / 进度 CTA / 生图生视频预览 */
export interface PlatformUiToolResultDisplay {
  kind: "platform_ui";
  schemaVersion: 1;
  action?: string;
  title?: string;
  qrUrl?: string;
  sessionId?: string;
  channel?: string;
  agentCode?: string;
  entityLabel?: string;
  bindStatus?: "pending" | "scanning" | "bound" | "failed" | "expired";
  media?: Array<{
    kind?: "image" | "video" | string;
    mimeType?: string;
    artifactUri?: string;
    absolutePath?: string;
    url?: string;
  }>;
  actions?: Array<{
    label: string;
    autoOpen?: boolean;
    route?: string;
    openStage?: {
      kind: string;
      title?: string;
      layout?: string;
      data?: Record<string, unknown>;
    };
  }>;
}

export type ToolResultDisplay =
  | LocalAgentMessageToolResultDisplay
  | TaskStopToolResultDisplay
  | TaskOutputToolResultDisplay
  | RespondToCoordinatorToolResultDisplay
  | CuaToolResultDisplay
  | PlatformUiToolResultDisplay
  | ToolCallGetWorkflowRunDisplay
  | ToolCallListWorkflowRunsDisplay
  | ToolCallEvalWorkflowSnippetDisplay
  | ToolCallSavedWorkflowListDisplay
  | ToolCallListModelsDisplay
  | ToolCallResumeWorkflowRunDisplay;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 工作流 display kind → 解析函数的查表（新增 kind 只改这一处）。每个条目用 shared 侧的
 * strict schema safeParse，输出类型即各自 schema 的推断类型——成员输出不是 ToolResultDisplay
 * 的 union 成员时这里直接编译失败，而不是靠运行时兜住。
 */
const WORKFLOW_DISPLAY_PARSERS_BY_KIND: Record<
  string,
  (value: Record<string, unknown>) => ToolResultDisplay | undefined
> = {
  get_workflow_run: (value) => parseWorkflowDisplay(toolCallGetWorkflowRunDisplaySchema, value),
  list_workflow_runs: (value) => parseWorkflowDisplay(toolCallListWorkflowRunsDisplaySchema, value),
  eval_workflow_snippet: (value) =>
    parseWorkflowDisplay(toolCallEvalWorkflowSnippetDisplaySchema, value),
  saved_workflow_list: (value) =>
    parseWorkflowDisplay(toolCallSavedWorkflowListDisplaySchema, value),
  list_models: (value) => parseWorkflowDisplay(toolCallListModelsDisplaySchema, value),
  resume_workflow_run: (value) =>
    parseWorkflowDisplay(toolCallResumeWorkflowRunDisplaySchema, value),
};

function parseWorkflowDisplay<T extends ToolResultDisplay>(
  schema: { safeParse: (data: unknown) => { success: true; data: T } | { success: false } },
  value: Record<string, unknown>,
): ToolResultDisplay | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function readOptionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined | null {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string") return null;
  const normalized = candidate.trim();
  return normalized.length > 0 ? candidate : null;
}

function parseDisplay(value: unknown): ToolResultDisplay | undefined {
  if (!isRecord(value)) return undefined;

  if (value.kind === "local_agent_message") {
    if (value.status !== "success" && value.status !== "failed") return undefined;
    const error = readOptionalString(value, "error");
    const message = readOptionalString(value, "message");
    if (error === null || message === null) return undefined;
    return {
      kind: "local_agent_message",
      status: value.status,
      ...(error !== undefined ? { error } : {}),
      ...(message !== undefined ? { message } : {}),
    };
  }

  if (value.kind === "task_stop") {
    const taskId = readOptionalString(value, "taskId");
    const taskType = readOptionalString(value, "taskType");
    const command = readOptionalString(value, "command");
    const message = readOptionalString(value, "message");
    const truncated = value.truncated;
    if (
      !taskId ||
      !taskType ||
      command === null ||
      !message ||
      (truncated !== undefined && typeof truncated !== "boolean")
    ) {
      return undefined;
    }
    return {
      kind: "task_stop",
      taskId,
      taskType,
      ...(command !== undefined ? { command } : {}),
      message,
      ...(truncated !== undefined ? { truncated } : {}),
    };
  }

  if (value.kind === "task_output") {
    if (
      value.retrievalStatus !== "success" &&
      value.retrievalStatus !== "not_ready" &&
      value.retrievalStatus !== "timeout"
    ) {
      return undefined;
    }
    const taskStatus = readOptionalString(value, "taskStatus");
    const output = readOptionalString(value, "output");
    const truncated = value.truncated;
    if (
      taskStatus === null ||
      (taskStatus !== undefined && taskStatus.length > 64) ||
      output === null ||
      (output !== undefined && output.length > 2_000) ||
      (truncated !== undefined && truncated !== true)
    ) {
      return undefined;
    }
    return {
      kind: "task_output",
      retrievalStatus: value.retrievalStatus,
      ...(taskStatus !== undefined ? { taskStatus } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(truncated === true ? { truncated: true } : {}),
    };
  }

  if (value.kind === "respond_to_coordinator") {
    if (value.status !== "success" && value.status !== "failed") {
      return undefined;
    }
    return {
      kind: "respond_to_coordinator",
      status: value.status,
    };
  }

  if (value.kind === "platform_ui") {
    if (value.schemaVersion !== 1) return undefined;
    const action = readOptionalString(value, "action");
    const title = readOptionalString(value, "title");
    const qrUrl = readOptionalString(value, "qrUrl");
    const sessionId = readOptionalString(value, "sessionId");
    const channel = readOptionalString(value, "channel");
    const agentCode = readOptionalString(value, "agentCode");
    const entityLabel = readOptionalString(value, "entityLabel");
    const bindRaw = readOptionalString(value, "bindStatus");
    if (
      action === null ||
      title === null ||
      qrUrl === null ||
      sessionId === null ||
      channel === null ||
      agentCode === null ||
      entityLabel === null ||
      bindRaw === null
    ) {
      return undefined;
    }
    const bindStatus =
      bindRaw === "pending" ||
      bindRaw === "scanning" ||
      bindRaw === "bound" ||
      bindRaw === "failed" ||
      bindRaw === "expired"
        ? bindRaw
        : undefined;
    const mediaRaw = Array.isArray(value.media) ? value.media : [];
    const media: NonNullable<PlatformUiToolResultDisplay["media"]> = [];
    for (const row of mediaRaw) {
      if (!isRecord(row)) continue;
      const artifactUri = readOptionalString(row, "artifactUri");
      const absolutePath = readOptionalString(row, "absolutePath");
      const url = readOptionalString(row, "url");
      const mimeType = readOptionalString(row, "mimeType");
      const kindRaw = readOptionalString(row, "kind");
      if (artifactUri === null || absolutePath === null || url === null || mimeType === null || kindRaw === null) {
        continue;
      }
      const src = artifactUri || absolutePath || url;
      if (!src) continue;
      const kind =
        kindRaw === "video" || kindRaw === "image"
          ? kindRaw
          : mimeType?.startsWith("video/")
            ? "video"
            : "image";
      media.push({
        kind,
        ...(mimeType ? { mimeType } : {}),
        ...(src ? { artifactUri: src } : {}),
        ...(absolutePath ? { absolutePath } : {}),
        ...(url ? { url } : {}),
      });
      if (media.length >= 4) break;
    }
    const actionsRaw = Array.isArray(value.actions) ? value.actions : [];
    const actions: NonNullable<PlatformUiToolResultDisplay["actions"]> = [];
    for (const row of actionsRaw) {
      if (!isRecord(row)) continue;
      const label = readOptionalString(row, "label");
      if (!label) continue;
      const openRaw = isRecord(row.openStage) ? row.openStage : null;
      const openKind = openRaw ? readOptionalString(openRaw, "kind") : undefined;
      const openStage =
        openRaw && openKind
          ? {
              kind: openKind,
              ...(readOptionalString(openRaw, "title")
                ? { title: readOptionalString(openRaw, "title")! }
                : {}),
              ...(readOptionalString(openRaw, "layout")
                ? { layout: readOptionalString(openRaw, "layout")! }
                : {}),
              ...(isRecord(openRaw.data) ? { data: openRaw.data as Record<string, unknown> } : {}),
            }
          : undefined;
      const route = readOptionalString(row, "route");
      actions.push({
        label,
        ...(row.autoOpen === true ? { autoOpen: true } : {}),
        ...(route ? { route } : {}),
        ...(openStage ? { openStage } : {}),
      });
      if (actions.length >= 4) break;
    }
    // 绑渠道：要有码；进度 CTA：要有 openStage。二者至少命中一类。
    if (!qrUrl && !sessionId && !actions.some((a) => a.openStage)) return undefined;
    return {
      kind: "platform_ui",
      schemaVersion: 1,
      ...(action !== undefined ? { action } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(qrUrl !== undefined ? { qrUrl } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(channel !== undefined ? { channel } : {}),
      ...(agentCode !== undefined ? { agentCode } : {}),
      ...(entityLabel !== undefined ? { entityLabel } : {}),
      ...(bindStatus !== undefined
        ? { bindStatus }
        : qrUrl || sessionId
          ? { bindStatus: "pending" as const }
          : {}),
      ...(media.length ? { media } : {}),
      ...(actions.length ? { actions } : {}),
    };
  }

  if (value.kind === "cua") {
    const toolName = readOptionalString(value, "toolName");
    const legacyInput = readOptionalString(value, "input");
    const structuredContent = readOptionalString(value, "structuredContent");
    const text = readOptionalString(value, "text");
    const errorCode = readOptionalString(value, "errorCode");
    const suggestedAction = readOptionalString(value, "suggestedAction");
    const media = Array.isArray(value.media)
      ? value.media.flatMap((item) => {
          if (!isRecord(item)) return [];
          const mimeType = readOptionalString(item, "mimeType");
          const data = readOptionalString(item, "data");
          const artifactUri = readOptionalString(item, "artifactUri");
          // EvoFlow CUA 只带 artifactUri（落盘 URL）；ZCode 原生常带 data。
          // 任一通道合法即可，缺键为 undefined（放行），类型错误才为 null（拒收）。
          if (!mimeType || data === null || artifactUri === null) return [];
          if (!data && !artifactUri) return [];
          return [
            {
              mimeType,
              ...(data ? { data } : {}),
              ...(artifactUri ? { artifactUri } : {}),
            },
          ];
        })
      : undefined;
    const targetApp = parseCuaTargetApp(value.targetApp);
    if (
      value.schemaVersion !== 1 ||
      !toolName ||
      legacyInput === null ||
      (value.status !== "success" && value.status !== "failed") ||
      structuredContent === null ||
      text === null ||
      errorCode === null ||
      suggestedAction === null ||
      targetApp === null ||
      (value.truncated !== undefined && typeof value.truncated !== "boolean")
    )
      return undefined;
    return {
      kind: "cua",
      schemaVersion: 1,
      toolName,
      status: value.status,
      ...(structuredContent !== undefined ? { structuredContent } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(errorCode !== undefined ? { errorCode } : {}),
      ...(suggestedAction !== undefined ? { suggestedAction } : {}),
      ...(media?.length ? { media } : {}),
      ...(value.truncated !== undefined ? { truncated: value.truncated } : {}),
      ...(targetApp !== undefined ? { targetApp } : {}),
    };
  }

  // 工作流工具的 display kind（观察五件套 + ResumeWorkflowRun 恢复卡）：按 kind 查表后用
  // shared 的 strict schema 解析，保证 UI 消费侧与协议侧字段表永远同步——手写第二套结构
  // 校验是漂移温床。
  if (typeof value.kind === "string") {
    const parseWorkflowDisplayByKind = WORKFLOW_DISPLAY_PARSERS_BY_KIND[value.kind];
    if (parseWorkflowDisplayByKind !== undefined) {
      return parseWorkflowDisplayByKind(value);
    }
  }

  return undefined;
}

function parseCuaTargetApp(value: unknown): CuaToolResultDisplay["targetApp"] | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return null;
  }
  // 缺省按空数组：仅有 displayName、暂无 locator 时仍可展示应用名。
  const rawLocators = value.iconLocators === undefined ? [] : value.iconLocators;
  if (!Array.isArray(rawLocators)) return null;
  const displayName = readOptionalString(value, "displayName");
  if (displayName === null || (displayName !== undefined && displayName.length > 512)) return null;
  if (rawLocators.length > 3) return null;
  const iconLocators: NonNullable<CuaToolResultDisplay["targetApp"]>["iconLocators"] =
    rawLocators.flatMap((locator) => {
      if (!isRecord(locator)) return [];
      const locatorValue = readOptionalString(locator, "value");
      if (
        !locatorValue ||
        (locator.kind !== "darwin-bundle-id" &&
          locator.kind !== "windows-executable-path" &&
          locator.kind !== "windows-aumid")
      ) {
        return [];
      }
      return [{ kind: locator.kind, value: locatorValue }];
    });
  if (iconLocators.length !== rawLocators.length) return null;
  return {
    schemaVersion: 1,
    ...(displayName !== undefined ? { displayName } : {}),
    iconLocators,
  };
}

export function readToolResultDisplay(raw: unknown): ToolResultDisplay | undefined {
  if (!isRecord(raw)) return undefined;

  const result = isRecord(raw.result) ? raw.result : undefined;
  const metadata = isRecord(raw.metadata) ? raw.metadata : undefined;
  const rawOutput = isRecord(raw.rawOutput) ? raw.rawOutput : undefined;
  const output = isRecord(raw.output) ? raw.output : undefined;
  const candidates = [
    result?.display,
    raw.display,
    metadata?.display,
    rawOutput?.display,
    output?.display,
  ];

  for (const candidate of candidates) {
    const display = parseDisplay(candidate);
    if (display) return display;
  }

  return undefined;
}
