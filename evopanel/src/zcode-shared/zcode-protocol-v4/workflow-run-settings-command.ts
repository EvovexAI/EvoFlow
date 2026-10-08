// ============================================================
// amendWorkflowRunSettings：从 GUI 改一个 run 的两项设置
// ============================================================
// 从 command.ts 拆出（max-lines 门）：载荷、accepted 结果与拒绝词表三件同属一个命令，
// bootstrap 铸 fault code、UI 反查文案，两侧共享这一份词表避免漂移。

import { z } from "zod";
import { WORKFLOW_RUNS_LIMITS } from "./workflow-runs.js";

/**
 * 命令载荷。两项设置守工具的同一条三态规则：省略 = 沿用，`null` = 回到默认（会话模型 / 本机上限），
 * 值 = 设定。GUI 只发用户改过的那几项。刻意不携 baseRevision：与 cancelBackgroundWork /
 * resumeWorkflowRun 同类（workflowRuns 面免 revision）。
 */
export const amendWorkflowRunSettingsPayloadSchema = z.object({
  /** ≡ runId，与取消、恢复同一个身份等式。 */
  workId: z.string(),
  /** 规范串 `providerId/modelId[$level]`；`null` = 子代理回到会话模型。 */
  subagentModel: z
    .string()
    .min(1)
    .max(WORKFLOW_RUNS_LIMITS.maxSubagentModelLength)
    .nullable()
    .optional(),
  /** 同时运行的子代理上限；`null` = 解除本 run 自己的界（回到本机上限）。agent 侧钳到 `[1, 天花板]`。 */
  maxConcurrency: z.number().int().min(1).nullable().optional(),
});
export type AmendWorkflowRunSettingsPayload = z.infer<typeof amendWorkflowRunSettingsPayloadSchema>;

/**
 * accepted ACK 的结果。`runId` / `toolCallId` 指**新** run（toolCallId = `settings-<uuid>`，
 * 联接设置轮的 run 卡与详情页）；`supersededRunId` 只在旧 run 仍在飞、被这次调整停下时在场。
 */
export const amendWorkflowRunSettingsResultSchema = z.object({
  type: z.literal("amendWorkflowRunSettings"),
  runId: z.string().min(1),
  toolCallId: z.string().min(1),
  supersededRunId: z.string().min(1).optional(),
});

/**
 * 拒绝词表。所有拒绝都发生在停下或新建任何东西之前：
 * not_found / not_configurable / unchanged / script_missing / model_unavailable / compile_failed
 * 是命令自己的检查，missing_boundaries 是端口预检，start_failed 是端口缺席或抛错。
 */
export const workflowRunSettingsRejectionReasonSchema = z.enum([
  "not_found",
  "not_configurable",
  "unchanged",
  "script_missing",
  "model_unavailable",
  "compile_failed",
  "missing_boundaries",
  "start_failed",
]);
export type WorkflowRunSettingsRejectionReason = z.infer<
  typeof workflowRunSettingsRejectionReasonSchema
>;

/** 完整 fault code = 前缀 + reason；与 workflowRunResumeRejected 同族。 */
export const WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX =
  "fault.command.workflowRunSettingsRejected." as const;
