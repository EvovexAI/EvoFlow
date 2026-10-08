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

export type ToolResultDisplay =
  | LocalAgentMessageToolResultDisplay
  | TaskStopToolResultDisplay
  | TaskOutputToolResultDisplay
  | RespondToCoordinatorToolResultDisplay
  | CuaToolResultDisplay
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
          return mimeType && data !== null && artifactUri !== null
            ? [
                {
                  mimeType,
                  ...(data ? { data } : {}),
                  ...(artifactUri ? { artifactUri } : {}),
                },
              ]
            : [];
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
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.iconLocators)) {
    return null;
  }
  const displayName = readOptionalString(value, "displayName");
  if (displayName === null || (displayName !== undefined && displayName.length > 512)) return null;
  if (value.iconLocators.length > 3) return null;
  const iconLocators: NonNullable<CuaToolResultDisplay["targetApp"]>["iconLocators"] =
    value.iconLocators.flatMap((locator) => {
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
  if (iconLocators.length !== value.iconLocators.length) return null;
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
