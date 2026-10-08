import type {
  V4ConversationWorkflowRunSummary,
  WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * run 目录的纯模型，单一信源是 journal。
 *
 * 任务列表页脚行上的「已结束 · N」与目录页里的那几行**必须出自同一处过滤与同一套分桶**。
 * 若分成两份实现，页脚可能显示 5 条，打开目录却只有 4 行。
 * 所以这里只导出两个入口，且计数按构造 ≡ 已结束列表长度（见文件末尾的 `countEndedWorkflowRuns`）。
 */

/**
 * 一次目录取数的条数。
 *
 * **两个调用方必须用同一个值**：目录页与任务列表的计数各自持有一个 hook 实例，深度不同就等于
 * 口径不同（CLI 侧的缺省是 16、上限 64，见 `dynamic-workflow-run-service.ts` 的
 * `DEFAULT_LIST_RUNS_LIMIT`）。取上限而不取缺省：这一页就是用户能看到的全部历史，
 * 而 64 行 journal 摘要是有界的廉价读。
 */
export const WORKFLOW_RUN_DIRECTORY_LIMIT = 64;

/**
 * 目录里的一行。就是发现查询的摘要，只把 `toolCallId` 收紧成必有——**剔除发生在建表时**，
 * 于是下游（页面、计数）都拿不到一个开不出详情页的行，也就不需要各自再判一次。
 */
export type WorkflowRunDirectoryRow = V4ConversationWorkflowRunSummary & { toolCallId: string };

interface WorkflowRunDirectory {
  /** `pending` / `running`：还在动的。 */
  running: WorkflowRunDirectoryRow[];
  /** `completed` / `errored` / `stopped`：一个桶，行上的状态词负责说清结局。 */
  ended: WorkflowRunDirectoryRow[];
  /**
   * 这一页是否已经取满（后面可能还有）。按**查询返回的条数**判，不按过滤后的行数判：
   * 一页全是缺 `toolCallId` 的老 run 时，屏幕上零行、但「就这些」是假话。
   */
  truncated: boolean;
}

/**
 * 缺 `toolCallId` 的 run 开不出详情页（`workflow-run` tab 要它去父会话投影里找静态图那一行），
 * 用户选择把它们整条剔除而不是灰掉。代价：`tool_call_id` 落库之前
 * 的老 run 因此在 GUI 里不可达。
 */
function hasDetailAnchor(
  summary: V4ConversationWorkflowRunSummary,
): summary is WorkflowRunDirectoryRow {
  return summary.toolCallId !== undefined;
}

function isEnded(summary: V4ConversationWorkflowRunSummary): boolean {
  return summary.status !== "pending" && summary.status !== "running";
}

/**
 * 摘要缺席（还没查到 / 能力缺席）与零条一样是一个空目录：调用方靠 hook 的 `null` 与 `[]`
 * 去分辨那两件事，模型不掺和——它只做分桶。
 *
 * **不排序**：顺序 = 查询序 = 最近更新在前（排序在 CLI 存储层）。在这里重排等于和存储层
 * 抢同一个决定，而两处一旦不一致，列表会在每次重取时跳位。
 */
export function buildWorkflowRunDirectory(
  summaries: readonly V4ConversationWorkflowRunSummary[] | null | undefined,
): WorkflowRunDirectory {
  const rows = (summaries ?? []).filter(hasDetailAnchor);
  return {
    running: rows.filter((row) => !isEnded(row)),
    ended: rows.filter(isEnded),
    truncated: (summaries?.length ?? 0) >= WORKFLOW_RUN_DIRECTORY_LIMIT,
  };
}

/**
 * 任务列表页脚行上的计数。走同一个建表函数，所以它**恒等于**目录页已结束段的行数——
 * 这条不变量是这个模块存在的理由，别在调用点用 `summaries.filter(...)` 抄近路。
 */
export function countEndedWorkflowRuns(
  summaries: readonly V4ConversationWorkflowRunSummary[] | null | undefined,
): number {
  return buildWorkflowRunDirectory(summaries).ended.length;
}

/**
 * 「这份 journal 摘要该重取了吗」的触发键，从**活投影**派生。
 *
 * 形状是「run 条数 + 已结算条数」，因为目录只表达两件事：一行在不在、它在哪一段。于是
 * - 新起一个 run → 前者动（它要出现在「运行中」）；
 * - 跑完一个 run → 后者动（它要挪到「已结束」）；
 * - 节点级进度 → 两者都不动。
 *
 * 最后一条是这个键的重点。投影的 `revision` 每来一个引擎事件就抬一次，把它当触发器等于让
 * 一次分页读变成一条跟着事件走的流；而读者在目录页上看不出任何区别。
 *
 * **两个界面共用这一个派生**（任务列表的计数与目录页），理由与 `countEndedWorkflowRuns` 同：
 * 口径一致还不够，新鲜度也必须一致——实测过的失效正是「岛更新了、它开出来的页面没更新」。
 */
export function workflowRunDirectoryRefreshKey(
  runs: readonly WorkflowRunState[] | null | undefined,
): string {
  const all = runs ?? [];
  const settled = all.filter((run) => run.status !== "pending" && run.status !== "running").length;
  return `${all.length}:${settled}`;
}
