// ============================================================
// 详情页 Cancel / Resume 被拒时的结构化解释
// ============================================================
// 老 run 被误留在 running 时，Cancel 点下去 CLI 查无此任务、
// Resume 撞上不再编译的老脚本——两条命令都只在控制台记一行 warn，用户面前是「点了没反应」。
// 现在 ACK 上的 reasonCode 按两张词表反查成一句话，挂在状态头下面；词表之外一律通用文案带 code。

import {
  BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX,
  WORKFLOW_RUN_RESUME_REJECTED_FAULT_PREFIX,
  type CommandAck,
} from "@zcode/shared/zcode-protocol-v4";

export type WorkflowRunAction = "cancel" | "resume";

/** 与 useSavedWorkflowLauncher 同一个能力缺席 fault（网关对 V4CapabilityUnsupportedError 的 reasonCode）。 */
const CAPABILITY_UNSUPPORTED_FAULT = "fault.command.capabilityUnsupported";

/** core stopBackgroundTask 的 reason 去掉 `background_task_` 前缀后的闭集（bootstrap handler 铸造）。 */
const CANCEL_REASONS: ReadonlySet<string> = new Set([
  "not_found",
  "not_running",
  "cancel_not_supported",
]);
/** 端口 DynamicWorkflowRunResumeErrorReason 的闭集。 */
const RESUME_REASONS: ReadonlySet<string> = new Set([
  "not_found",
  "not_resumable",
  "superseded",
  "already_running",
  "script_missing",
  "script_mismatch",
  "compile_failed",
]);

export interface WorkflowRunActionRejection {
  action: WorkflowRunAction;
  /** 词表内的 reason，或 `unsupported`（能力缺席）/ `generic`（词表外，文案带 code）。 */
  reason: string;
  /** 原始 reasonCode（缺席时是 ack.status），通用文案里展示，日志里也是它。 */
  code: string;
  /** ACK 携带的人可读细节（compile_failed 的有界诊断）。 */
  message?: string;
}

/** accepted / noop 不是拒绝 → undefined；其余按词表归一。 */
export function describeWorkflowRunActionRejection(
  action: WorkflowRunAction,
  ack: Pick<CommandAck, "status" | "reasonCode" | "message">,
): WorkflowRunActionRejection | undefined {
  if (ack.status === "accepted" || ack.status === "noop") return undefined;
  const code = ack.reasonCode ?? ack.status;
  const prefix =
    action === "cancel"
      ? BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX
      : WORKFLOW_RUN_RESUME_REJECTED_FAULT_PREFIX;
  const known = action === "cancel" ? CANCEL_REASONS : RESUME_REASONS;
  let reason = "generic";
  if (ack.reasonCode === CAPABILITY_UNSUPPORTED_FAULT) reason = "unsupported";
  else if (ack.reasonCode?.startsWith(prefix)) {
    const suffix = ack.reasonCode.slice(prefix.length);
    if (known.has(suffix)) reason = suffix;
  }
  return { action, reason, code, ...(ack.message ? { message: ack.message } : {}) };
}

/** 文案 key：`chat.toolCall.workflow.run.rejection.<action>.<reason>`，两张词表 + unsupported + generic 全在 locale 里。 */
export function workflowRunActionRejectionMessageId(rejection: WorkflowRunActionRejection): string {
  return `chat.toolCall.workflow.run.rejection.${rejection.action}.${rejection.reason}`;
}
