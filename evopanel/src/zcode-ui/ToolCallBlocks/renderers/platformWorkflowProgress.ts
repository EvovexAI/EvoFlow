/**
 * platform workflow.run（及 resume/recover/run_status）→ 对话内进度卡的身份解析。
 * 与右栏 autoOpen 同源：优先 display.actions[].openStage.kind=collab-workflow，再回落正文 JSON。
 */

import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";

const WORKFLOW_PROGRESS_ACTIONS = new Set([
  "workflow.run",
  "workflow.resume",
  "workflow.recover",
  "workflow.run_status",
]);

export function isPlatformWorkflowProgressAction(action: string): boolean {
  return WORKFLOW_PROGRESS_ACTIONS.has(String(action || "").trim());
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstString(...values: unknown[]): string {
  for (const v of values) {
    const s = readTrimmedString(v);
    if (s) return s;
  }
  return "";
}

/** 从任意 platform 工具 raw / display / display.display 抽出可读 JSON 根。 */
export function parsePlatformToolBlob(raw: unknown): Record<string, unknown> | null {
  let blob: unknown = raw;
  if (isPlainRecord(blob) && typeof blob.rawOutput === "string") blob = blob.rawOutput;
  else if (isPlainRecord(blob) && typeof blob.output === "string") blob = blob.output;
  else if (
    isPlainRecord(blob) &&
    isPlainRecord(blob.output) &&
    typeof blob.output.text === "string"
  ) {
    blob = blob.output.text;
  }
  if (typeof blob === "string") {
    const t = blob.trim();
    if (!t.startsWith("{")) return null;
    try {
      blob = JSON.parse(t) as unknown;
    } catch {
      return null;
    }
  }
  return isPlainRecord(blob) ? blob : null;
}

export type PlatformWorkflowProgressRef = {
  mainTaskId: string;
  runId?: string;
  appId?: string;
  /** 应用 / 工作流展示名 */
  name: string;
  leadThreadId?: string;
};

/**
 * 何时显示进度卡：能解出 mainTaskId，且属于 workflow 运行族。
 *
 * 门控不能只信入参 `action`：V4 行上 action 偶发只在 `output.display.action` /
 * 正文 JSON 里，而右栏 autoOpen 读的是 `display.actions[].openStage`——两边不一致就会
 * 「右栏能开、对话里没卡」。与 autoOpen 同源：先抽 openStage / task_id，再认 action。
 */
export function readPlatformWorkflowProgressRef(input: {
  action: string;
  raw: unknown;
  outputText?: string | null;
  display?: unknown;
}): PlatformWorkflowProgressRef | null {
  const display = readToolResultDisplay(input.raw) ||
    (isPlainRecord(input.display) && input.display.kind === "platform_ui"
      ? (input.display as ReturnType<typeof readToolResultDisplay>)
      : null);

  let mainTaskId = "";
  let stageTitle = "";
  let hasCollabOpenStage = false;
  if (display?.kind === "platform_ui" && Array.isArray(display.actions)) {
    for (const row of display.actions) {
      const open = row?.openStage;
      if (!open || String(open.kind || "").trim() !== "collab-workflow") continue;
      hasCollabOpenStage = true;
      const data = isPlainRecord(open.data) ? open.data : null;
      mainTaskId = firstString(data?.mainTaskId, data?.main_task_id, data?.taskId, data?.task_id);
      stageTitle = firstString(open.title, row.label);
      if (mainTaskId) break;
    }
  }

  const blob =
    parsePlatformToolBlob(input.raw) ||
    parsePlatformToolBlob(input.outputText) ||
    parsePlatformToolBlob({ display: input.display, rawOutput: input.outputText });

  if (!mainTaskId && blob) {
    const ui = isPlainRecord(blob.ui) ? blob.ui : null;
    if (ui && Array.isArray(ui.actions)) {
      for (const row of ui.actions) {
        if (!isPlainRecord(row)) continue;
        const open = isPlainRecord(row.openStage) ? row.openStage : null;
        if (!open || firstString(open.kind) !== "collab-workflow") continue;
        hasCollabOpenStage = true;
        const data = isPlainRecord(open.data) ? open.data : null;
        mainTaskId = firstString(data?.mainTaskId, data?.main_task_id, data?.taskId, data?.task_id);
        stageTitle = firstString(open.title, row.label, stageTitle);
        if (mainTaskId) break;
      }
    }
    if (!mainTaskId) {
      const run = isPlainRecord(blob.run) ? blob.run : null;
      mainTaskId = firstString(
        blob.task_id,
        blob.taskId,
        run?.task_id,
        run?.taskId,
      );
    }
  }

  if (!mainTaskId) return null;

  const displayAction =
    display?.kind === "platform_ui" ? firstString(display.action) : "";
  const blobAction = blob ? firstString(blob.action) : "";
  const resolvedAction = firstString(input.action, displayAction, blobAction);
  // 入参 action 缺失时：有 collab-workflow openStage + taskId 也认（与右栏同源）
  if (
    !isPlatformWorkflowProgressAction(resolvedAction) &&
    !(hasCollabOpenStage && mainTaskId)
  ) {
    return null;
  }

  const run = blob && isPlainRecord(blob.run) ? blob.run : null;
  const app = blob && isPlainRecord(blob.app) ? blob.app : null;
  const runId = firstString(
    blob?.runId,
    blob?.run_id,
    run?.run_id,
    run?.runId,
    run?.id,
  );
  const appId = firstString(blob?.appId, blob?.app_id, run?.app_id, run?.appId, app?.id);
  const name =
    firstString(
      stageTitle,
      blob?.name,
      blob?.app_name,
      app?.name,
      run?.app_name,
      run?.name,
      display?.kind === "platform_ui" ? display.title : "",
      display?.kind === "platform_ui" ? display.entityLabel : "",
    ) || "工作流";

  const leadThreadId = firstString(
    blob?.leadThreadId,
    blob?.lead_thread_id,
    blob?.thread_id,
    blob?.threadId,
  );

  return {
    mainTaskId,
    name,
    ...(runId ? { runId } : {}),
    ...(appId ? { appId } : {}),
    ...(leadThreadId ? { leadThreadId } : {}),
  };
}

/** 协作任务态 → 卡上用的 ZCode 风格 run status 词表键。 */
export type PlatformWorkflowCardStatus =
  | "pending"
  | "running"
  | "completed"
  | "errored"
  | "stopped";

export function mapTaskStatusToWorkflowCardStatus(
  status: string | undefined | null,
): PlatformWorkflowCardStatus {
  const s = String(status || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (!s) return "pending";
  if (
    s === "completed" ||
    s === "done" ||
    s === "success" ||
    s === "reviewed" ||
    s === "archived"
  ) {
    return "completed";
  }
  if (s === "failed" || s === "error" || s === "timed_out") return "errored";
  if (s === "cancelled" || s === "canceled" || s === "deleted") return "stopped";
  if (
    s === "executing" ||
    s === "in_progress" ||
    s === "running" ||
    s === "active" ||
    s === "verifying" ||
    s === "reflecting" ||
    s === "waiting_dispatch" ||
    s === "waiting_confirmation" ||
    s === "req_confirm" ||
    s === "waiting_user" ||
    s === "awaiting_close"
  ) {
    return "running";
  }
  return "pending";
}

export function workflowCardKindMessageId(status: PlatformWorkflowCardStatus): string {
  switch (status) {
    case "running":
      return "chat.toolCall.workflow.card.running";
    case "completed":
      return "chat.toolCall.workflow.card.completed";
    case "errored":
      return "chat.toolCall.workflow.card.errored";
    case "stopped":
      return "chat.toolCall.workflow.card.stopped";
    default:
      return "chat.toolCall.workflow.card.started";
  }
}
