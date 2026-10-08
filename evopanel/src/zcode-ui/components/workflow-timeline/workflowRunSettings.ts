// ============================================================
// 「配置」弹层的纯规则
// ============================================================
// 弹层组件只管画与接线，这里是它的全部判断：哪些 run 能配、表单从哪儿起步、Apply 发什么、
// 被拒的 ACK 说哪句话。纯函数、不碰 store，逐条可穷举。

import {
  WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX,
  workflowRunSettingsRejectionReasonSchema,
  type AmendWorkflowRunSettingsPayload,
  type CommandAck,
  type WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import { formatModelPickerValue, parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";

/**
 * 会话当前模型（「会话模型」那一项的名字从它来）：优先会话持久的稀疏选择，退回 UI effective 的
 * provider / model 投影；两者都读不出即缺席。
 */
export function workflowSessionModelOf(
  config:
    | { modelSelection?: { providerId: string; modelId: string }; provider: string; model: string }
    | null
    | undefined,
): { providerId: string; modelId: string } | undefined {
  if (config === null || config === undefined) return undefined;
  const selection = config.modelSelection;
  if (selection !== undefined)
    return { providerId: selection.providerId, modelId: selection.modelId };
  const providerId = config.provider.trim();
  const modelId = config.model.trim();
  return providerId && modelId ? { providerId, modelId } : undefined;
}

/** 表单里的子代理模型：会话模型，或一个具体模型（可带思考档）。 */
export type WorkflowRunSettingsModel =
  | { kind: "session" }
  | { kind: "model"; providerId: string; modelId: string; level?: string };

/** 表单的两项设置。`bound` 为 null 即「本 run 没有自己的界」（跑在本机上限上）。 */
export interface WorkflowRunSettingsDraft {
  model: WorkflowRunSettingsModel;
  bound: number | null;
}

/** Apply 发出去的那部分载荷（workId 由宿主补）。 */
export type WorkflowRunSettingsChange = Omit<AmendWorkflowRunSettingsPayload, "workId">;

/**
 * 哪些 run 能配置：
 * pending / running 能（节流或换模型的主场景）；stopped 能，除非是被一次修订替代掉的（活的是它的
 * 后继）；errored 能（换个模型重试是最常见的修复）；completed 不能（每个 ask 都会从缓存重放，没有
 * 东西会在新设置下跑）；不在投影里的 run 没有设置可显示。宿主回调与灰度门由调用方另叠。
 */
export function isWorkflowRunConfigurable(run: WorkflowRunState | undefined): boolean {
  if (run === undefined) return false;
  switch (run.status) {
    case "pending":
    case "running":
    case "errored":
      return true;
    case "stopped":
      return run.supersededBy === undefined && run.stopReason !== "superseded";
    case "completed":
      return false;
  }
}

/**
 * 本机的并发天花板：优先 `run.concurrencyCeiling`（`run-started` 随带、恒在），老 CLI 没发它时退回
 * 读数芯片自己的水位 `concurrency.ceiling`。都没有即未知——步进器没有上限、不写提示。
 */
export function workflowRunSettingsCeiling(run: WorkflowRunState): number | undefined {
  return run.concurrencyCeiling ?? run.concurrency?.ceiling;
}

/** 规范串 → 表单模型；解析不动（坏串）按会话模型处理不成立，所以原样保留成一个查不到的具体模型。 */
export function workflowRunSettingsModelOf(
  canonical: string | undefined,
): WorkflowRunSettingsModel {
  const text = canonical?.trim();
  if (!text) return { kind: "session" };
  try {
    const parsed = parseModelPickerValue(text);
    const level = parsed.options?.reasoningLevel;
    return {
      kind: "model",
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      ...(level === undefined ? {} : { level }),
    };
  } catch {
    return { kind: "model", providerId: "", modelId: text };
  }
}

/** 表单模型 → 规范串 `providerId/modelId[$level]`；会话模型没有串（undefined）。 */
export function workflowRunSettingsModelCanonical(
  model: WorkflowRunSettingsModel,
): string | undefined {
  if (model.kind === "session") return undefined;
  if (model.providerId === "") return model.modelId;
  return formatModelPickerValue({
    providerId: model.providerId,
    modelId: model.modelId,
    ...(model.level === undefined ? {} : { options: { reasoningLevel: model.level } }),
  });
}

/** 打开弹层时的起点：两项都取 run 自己的当前设置。界缺席时停在天花板上（天花板也未知则为 null）。 */
export function initialWorkflowRunSettingsDraft(run: WorkflowRunState): WorkflowRunSettingsDraft {
  const limit = run.concurrency?.limit;
  return {
    model: workflowRunSettingsModelOf(run.subagentModel),
    bound: limit ?? workflowRunSettingsCeiling(run) ?? null,
  };
}

/** 界的归一：达到或超过天花板即「没有自己的界」。 */
function normalizedBound(bound: number | null, ceiling: number | undefined): number | null {
  if (bound === null) return null;
  return ceiling !== undefined && bound >= ceiling ? null : bound;
}

/**
 * Apply 发什么：只发**改过的**那几项（工具的同一条三态：省略 = 沿用）。模型按规范串比较——
 * 只改思考档也算改了模型；回到会话模型发 `null`。界等于天花板发 `null`（解除本 run 自己的界）。
 * 两项都没变 → undefined（Apply 禁用）。
 */
export function workflowRunSettingsChange(
  initial: WorkflowRunSettingsDraft,
  draft: WorkflowRunSettingsDraft,
  ceiling: number | undefined,
): WorkflowRunSettingsChange | undefined {
  const change: WorkflowRunSettingsChange = {};
  const fromModel = workflowRunSettingsModelCanonical(initial.model);
  const toModel = workflowRunSettingsModelCanonical(draft.model);
  if (fromModel !== toModel) change.subagentModel = toModel ?? null;
  const fromBound = normalizedBound(initial.bound, ceiling);
  const toBound = normalizedBound(draft.bound, ceiling);
  if (fromBound !== toBound) change.maxConcurrency = toBound;
  return Object.keys(change).length === 0 ? undefined : change;
}

/** 步进器夹界：下限 1，上限天花板（未知则不设上限）。 */
export function clampWorkflowRunSettingsBound(value: number, ceiling: number | undefined): number {
  const floor = Math.max(1, Math.floor(value));
  return ceiling === undefined ? floor : Math.min(floor, ceiling);
}

/**
 * 只动了并发上限（`null` = 解除本 run 自己的界，也算）。判据是载荷里**只有**这一个键——
 * 与 agent 侧的路由同一条：那里也只认这一种载荷，多一个字段就走原来的修订。
 */
function isConcurrencyOnlyChange(change: WorkflowRunSettingsChange | undefined): boolean {
  if (change === undefined) return false;
  return Object.keys(change).length === 1 && change.maxConcurrency !== undefined;
}

/**
 * 后果句的文案 key：随 run 状态换最后一句（completed 不会走到这里）。
 *
 * **正在跑**的 run 只改并发上限时会就地生效，不停止或另起 run，
 * 因此这里显示并发调整的后果说明。`pending` 不算在内：它的引擎可能还没建起来，就地设不上就照旧退回一次
 * 真正的修订，那时原句仍然是对的。
 */
export function workflowRunSettingsConsequenceId(
  status: WorkflowRunState["status"],
  change?: WorkflowRunSettingsChange,
): string {
  if (status === "running" && isConcurrencyOnlyChange(change))
    return "chat.toolCall.workflow.run.settings.consequence.concurrencyLive";
  switch (status) {
    case "pending":
      return "chat.toolCall.workflow.run.settings.consequence.pending";
    case "stopped":
      return "chat.toolCall.workflow.run.settings.consequence.stopped";
    case "errored":
      return "chat.toolCall.workflow.run.settings.consequence.errored";
    default:
      return "chat.toolCall.workflow.run.settings.consequence.running";
  }
}

/** 与 Stop / Resume 同一个能力缺席 fault（网关对 V4CapabilityUnsupportedError 的 reasonCode）。 */
const CAPABILITY_UNSUPPORTED_FAULT = "fault.command.capabilityUnsupported";
const KNOWN_REASONS: ReadonlySet<string> = new Set(
  workflowRunSettingsRejectionReasonSchema.options,
);

export interface WorkflowRunSettingsRejection {
  /** 词表内的 reason，或 `unsupported`（能力缺席）/ `generic`（词表外，文案带 code）。 */
  reason: string;
  /** 原始 reasonCode（缺席时是 ack.status）。 */
  code: string;
  /** ACK 携带的人可读细节（compile_failed 的有界诊断、start_failed 的原因）。 */
  message?: string;
}

/** accepted / noop 不是拒绝 → undefined；其余按 fault 前缀反查词表。 */
export function describeWorkflowRunSettingsRejection(
  ack: Pick<CommandAck, "status" | "reasonCode" | "message">,
): WorkflowRunSettingsRejection | undefined {
  if (ack.status === "accepted" || ack.status === "noop") return undefined;
  const code = ack.reasonCode ?? ack.status;
  let reason = "generic";
  if (ack.reasonCode === CAPABILITY_UNSUPPORTED_FAULT) reason = "unsupported";
  else if (ack.reasonCode?.startsWith(WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX)) {
    const suffix = ack.reasonCode.slice(WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX.length);
    if (KNOWN_REASONS.has(suffix)) reason = suffix;
  }
  return { reason, code, ...(ack.message ? { message: ack.message } : {}) };
}

/** 文案 key：`chat.toolCall.workflow.run.settings.rejection.<reason>`。 */
export function workflowRunSettingsRejectionMessageId(
  rejection: WorkflowRunSettingsRejection,
): string {
  return `chat.toolCall.workflow.run.settings.rejection.${rejection.reason}`;
}

/**
 * 细节块给不给：start_failed 的原因已经嵌进那句话（`{message}`），不再重复一遍；其余带 message 的
 * 拒绝（compile_failed 的诊断）放进有界等宽块。
 */
export function workflowRunSettingsRejectionDetail(
  rejection: WorkflowRunSettingsRejection,
): string | undefined {
  return rejection.reason === "start_failed" ? undefined : rejection.message;
}
