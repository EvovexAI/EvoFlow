// lineage 字段的读法：reducer 从进度载荷上
// 搬运 `resumedFrom` / `supersededBy` 与停止原因时用的两个窄读器。单独成文件是因为 reducer 本体已顶到
// oxlint 的 400 行上限。

import { WORKFLOW_RUN_STOP_REASONS } from "./workflow-observation-display.js";
import type { WorkflowRunState } from "./workflow-runs.js";

/** 载荷上的 run id 字段：非空字符串才算在场。 */
export function readRunIdField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 载荷上的停止原因：白名单之外（老 CLI 不认识的新词、或损坏的载荷）读作缺席，而不是整帧被丢。 */
export function readWorkflowRunStopReason(value: unknown): WorkflowRunState["stopReason"] {
  return typeof value === "string" &&
    (WORKFLOW_RUN_STOP_REASONS as readonly string[]).includes(value)
    ? (value as WorkflowRunState["stopReason"])
    : undefined;
}
