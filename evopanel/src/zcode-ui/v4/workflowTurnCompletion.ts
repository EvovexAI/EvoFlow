import type { TurnHeaderRow, WorkflowNotificationMeta } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/fileSummaryTypes.js";

/**
 * 完成卡的解析：这一轮是不是「主代理消化了一条
 * **completed** 工作流通知」的那一轮。纯函数，照 `resolveWorkflowTurnDigests` 的同一条缝。
 *
 * 只认三件事齐备：后台结果轮、来源是 workflow、载荷是 terminal 且 `status === "completed"`。
 * failed / cancelled 不画卡（通知行已说错误、已挂部分产物的 chips）；升级通知、批量轮（载荷
 * 整个缺席）、bash / subagent 通知都不是。
 *
 * 产物清单**以通知载荷为底**：它随通知持久化，冷恢复也在；投影 / journal 只是在它之上
 * 补字节数、出处、看板 spec。
 */
export type WorkflowTerminalNotification = Extract<WorkflowNotificationMeta, { kind: "terminal" }>;

export interface WorkflowTurnCompletion {
  runId: string;
  /** 通知标题（CLI 的 workflowTaskSubject，不本地化），与通知行 primaryText 同源。 */
  name: string;
  /** 通知里的墙钟时间；缺席即「时间」格写 `—`。 */
  durationMs?: number;
  artifacts: NonNullable<WorkflowTerminalNotification["artifacts"]>;
  /** 发射侧砍过（超 8 或被过滤）——溢出计数因此可能少报。 */
  artifactsTruncated: boolean;
  /** 投影联接到的 run；缺席（被 8 条上限淘汰）即三格 `—`、无 ⤢。重启不再让它缺席：CLI 冷物化从 journal 回放投影。 */
  summary: WorkflowRunCardSummary | undefined;
}

export function resolveWorkflowTurnCompletion(
  header: TurnHeaderRow | undefined,
  join: { byRunId?: ReadonlyMap<string, WorkflowRunCardSummary> },
): WorkflowTurnCompletion | undefined {
  if (header?.origin !== "backgroundResult") return undefined;
  const originMeta = header.originMeta;
  if (originMeta?.backgroundSource !== "workflow") return undefined;
  const notification = originMeta.workflowNotification;
  if (notification?.kind !== "terminal" || notification.status !== "completed") return undefined;
  const name = originMeta.title.trim();
  if (name.length === 0) return undefined;
  return {
    runId: originMeta.workId,
    name,
    ...(notification.durationMs === undefined ? {} : { durationMs: notification.durationMs }),
    artifacts: notification.artifacts ?? [],
    artifactsTruncated: notification.artifactsTruncated === true,
    summary: join.byRunId?.get(originMeta.workId),
  };
}
