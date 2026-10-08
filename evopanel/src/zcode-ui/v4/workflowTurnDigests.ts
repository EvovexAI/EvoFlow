import type {
  WorkflowLaunchMeta,
  WorkflowSettingsAmendMeta,
} from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/fileSummaryTypes.js";
import { readWorkflowName } from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import type { AssistantWorkRow } from "@/v4/conversationTurnFlowItems.js";

/**
 * 轮尾 run 卡的解析：这一轮里哪些**来源**点名了
 * 一条 run。纯函数，照 `resolveCronAutomationTurnCards` 的同一条缝。
 *
 * 三种来源，一条规则——凡点名了 runId 的来源都出一张卡：
 * - 直接启动轮（`unit.workflowLaunch`）：元数据自带 runId / toolCallId /
 *   名字；它是这一轮唯一的呈现（用户行不可见）。
 * - CreateWorkflow 行：按 toolCallId 联接（投影 `run.toolCallId` 就是发起行）；行本身不点名 runId，
 *   所以没联接到 run 的行（被拒绝 / 编不过）没有卡。
 * - ResumeWorkflowRun 行：display 载荷带 runId（投影的 toolCallId 跨 resume 沿用发起行，按 toolCallId
 *   永远查不到）。
 *
 * 图是 run 的属性：按 run 的**发起** toolCallId 到宿主建的图表里取，不问卡挂在哪种行上——resume 行
 * 因此与发起行同一张图。联接不到活投影（淘汰 / 冷恢复）的来源仍出卡，`summary` 缺席，卡退成中性
 * 单行。同一轮里同 run 只出一张（首见来源）。
 *
 * 一个例外：**就地生效的设置轮**（`rowOnly`）点名了一条 run，却既没启动它也没恢复它——它只是改了
 * 那条 run 的并发上限。那条 run 的卡已经在它启动的那一轮里，所以这条来源只出上方那一行。
 */
export interface WorkflowTurnDigest {
  key: string;
  /** 这张卡挂在的来源 id（打开侧板时经 `resolveWorkflowRunOpenToolCallId` 换成发起行 id）。 */
  toolCallId: string;
  runId: string;
  /** 脚本 `name`；缺席时由渲染方本地化兜底名。 */
  name: string | undefined;
  graph: WorkflowCausalityGraphData | undefined;
  /** 活投影的联接摘要；缺席 = run 不在投影里，卡退成中性单行（「已结束」）。 */
  summary: WorkflowRunCardSummary | undefined;
  /**
   * 设置轮：这张卡的 run 是「配置」
   * 从哪个 run 修订来的、改了什么。在场时卡上方多一行「已调整设置 · …」；`at` 是那一轮的时刻。
   */
  settings?: { amend: WorkflowSettingsAmendMeta; at?: number };
  /**
   * **只出那一行、不出卡**：就地生效的设置轮（只改并发上限、run 仍在运行，`amend` 不带 `predecessorRunId`）。它点名的 run 没有被替代、身份没变，
   * 卡已经在它启动的那一轮里——这里再画一张会读成第二次运行。恒与 `settings` 同在。
   */
  rowOnly?: true;
}

interface WorkflowTurnDigestSource {
  workflowLaunch?: WorkflowLaunchMeta;
  assistantWorkRows: readonly AssistantWorkRow[];
  /** 这一轮的开始时刻（设置轮那一行的时间）。 */
  startedAt?: number;
}

interface WorkflowTurnDigestJoin {
  byToolCallId?: ReadonlyMap<string, WorkflowRunCardSummary>;
  byRunId?: ReadonlyMap<string, WorkflowRunCardSummary>;
  graphByToolCallId?: ReadonlyMap<string, WorkflowCausalityGraphData>;
}

export function resolveWorkflowTurnDigests(
  unit: WorkflowTurnDigestSource,
  join: WorkflowTurnDigestJoin,
): WorkflowTurnDigest[] {
  const digests: WorkflowTurnDigest[] = [];
  const seen = new Set<string>();
  const graphOf = (originToolCallId: string | undefined) =>
    originToolCallId === undefined ? undefined : join.graphByToolCallId?.get(originToolCallId);

  const launch = unit.workflowLaunch;
  if (launch !== undefined) {
    // 就地生效的设置轮：`amend` 不带 predecessorRunId（缺席即「没有前驱、改的就是自己」，
    // workflow-row-meta.ts）。它是唯一一个点名了 run 却不是「启动 / 恢复了它」的来源，所以
    // **不占**这一轮的出卡名额——同一轮里真的发起了这条 run 的来源照常出它的卡。
    const rowOnly = launch.amend !== undefined && launch.amend.predecessorRunId === undefined;
    if (!rowOnly) seen.add(launch.runId);
    digests.push({
      graph: graphOf(launch.toolCallId),
      key: `launch:${launch.toolCallId}`,
      name: launch.name,
      runId: launch.runId,
      summary: join.byRunId?.get(launch.runId),
      toolCallId: launch.toolCallId,
      ...(rowOnly ? { rowOnly: true as const } : {}),
      ...(launch.amend === undefined
        ? {}
        : {
            settings: {
              amend: launch.amend,
              ...(unit.startedAt === undefined ? {} : { at: unit.startedAt }),
            },
          }),
    });
  }

  for (const row of unit.assistantWorkRows) {
    if (row.kind !== "toolCall") continue;
    const created = join.byToolCallId?.get(row.toolCallId);
    if (created !== undefined) {
      if (seen.has(created.runId)) continue;
      seen.add(created.runId);
      digests.push({
        graph: graphOf(row.toolCallId),
        key: `${row.rowId}:${row.toolCallId}`,
        name: readWorkflowName(row.input),
        runId: created.runId,
        summary: created,
        toolCallId: row.toolCallId,
      });
      continue;
    }
    if (row.display?.kind !== "resume_workflow_run") continue;
    const runId = row.display.runId;
    if (seen.has(runId)) continue;
    seen.add(runId);
    const resumed = join.byRunId?.get(runId);
    digests.push({
      // 发起行 id 只有联接到投影才知道；不在投影里的 resume 卡没有图可找。
      graph: graphOf(resumed?.toolCallId),
      key: `${row.rowId}:${row.toolCallId}`,
      name: undefined,
      runId,
      summary: resumed,
      toolCallId: row.toolCallId,
    });
  }
  return digests;
}
