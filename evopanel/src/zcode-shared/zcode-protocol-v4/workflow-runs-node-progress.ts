// ============================================================
// 一次 ask 的**任务与进度读数**：node-queued 的 instructionsHead + node-progress 的三个计数
// ============================================================
// 住在 reducer 主文件之外，与 workflow-runs-phases.ts 同一个理由：主文件的 max-lines 门。
//
// 这几个键回答的是相位回答不了的问题：一个 ask 可以在 `executing` 上待十分钟，光看相位分不出
// 「在干一件长活」与「已经死了」。`turn` / `toolCalls` / `lastTool` 是那条分界线，
// `instructionsHead` 则回答「这个子代理被派去干什么」。
//
// 两条容易踩的结构性事实：
//   1. 归约在每条 `node-*` 事件上**整个重建**节点对象（只有 kind / actor ref / phaseName 靠
//      previousNode 向前携带）。所以这四个键必须显式携带——否则 `node-progress` 的下一条
//      生命周期事件就把刚落下的读数擦干净了。
//   2. 一次 ask 的**出生**事件有两条：`node-queued`，以及 replay 命中时直接发的
//      `node-settled { cached: true }`（那条节点没有 queued，它就是出生事件——与主文件里
//      phaseName 的先例逐字同一条）。同一个站点实例在 resume 里被重新 queue 时是一次全新的
//      ask，轮次从 1 重新数；缓存命中的结算则根本没有跑过。所以**出生事件清掉**上一世的三个
//      计数，而不是把它们继承下来——继承会让一个这一世一步没走的节点显示「第 9 轮、40 次工具
//      调用」，那正是这几个读数要用来排除的假象。

import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunNode,
  type WorkflowRunNodeLastTool,
  type WorkflowRunState,
} from "./workflow-runs.js";

/** 一次 ask 的任务与进度读数，即本模块负责的那四个键。 */
type NodeProgressFields = Pick<
  WorkflowRunNode,
  "instructionsHead" | "turn" | "toolCalls" | "lastTool"
>;

/**
 * 生命周期事件（`node-queued` … `node-settled`）上这四个键的取值。
 *
 * 三个计数只向前携带（由 {@link reduceNodeProgress} 写入），**两条出生事件上清空**——见文件头
 * 第 2 条。`instructionsHead` 只在 `node-queued` 的载荷上到达（那一刻的 instructions 是作者原文，
 * 引擎的尾注由 driver 稍后追加），其余事件向前携带。
 *
 * 任务摘要与三个计数在缓存命中的结算上**刻意不同步**：完结缓存按输入哈希命中，所以那条 ask 的
 * 指令与上一世逐字相同，继承摘要说的是同一件事；而计数描述的是一次**这一世没有发生**的执行。
 * 重新 queue 则连摘要也只认新载荷：那是一条可能被修订过的新指令。
 */
export function carryNodeProgress(
  eventType: string,
  payload: Record<string, unknown>,
  previousNode: WorkflowRunNode | undefined,
): Partial<NodeProgressFields> {
  const requeued = eventType === "node-queued";
  const born = requeued || (eventType === "node-settled" && payload.cached === true);
  const carried = born ? undefined : previousNode;
  const head = boundedText(
    payload.instructionsHead,
    WORKFLOW_RUNS_LIMITS.maxInstructionsHeadLength,
  );
  const instructionsHead = requeued ? head : (head ?? previousNode?.instructionsHead);
  return {
    ...(instructionsHead === undefined ? {} : { instructionsHead }),
    ...(carried?.turn === undefined ? {} : { turn: carried.turn }),
    ...(carried?.toolCalls === undefined ? {} : { toolCalls: carried.toolCalls }),
    ...(carried?.lastTool === undefined ? {} : { lastTool: carried.lastTool }),
  };
}

/**
 * `node-progress` 的归约：一个已解析轮次的读数落到**已在表里**的那个节点上。
 *
 * **只动这三个键**——不改相位、不计步、不动 actor 状态：一个轮次解析完不是生命周期跃迁，
 * 相位仍由 `node-executing` / `node-waiting` 那几条事件说了算。表里没有的实例（触界被拒，
 * 或进度早于它的 `node-queued`）整条忽略、不建条目，与其他节点事件对未知实例同族。
 *
 * 读不出的单个字段**保持已知值**而不是擦掉：一条只报 toolCalls 的事件不该让轮次数消失。
 * 写入是**后来者覆盖**而不是取 max（与 `phases[].rounds` 相反），理由见文件头第 2 条。
 */
export function reduceNodeProgress(
  run: WorkflowRunState,
  ref: { siteId: string; ordinal: number },
  payload: Record<string, unknown>,
): WorkflowRunState {
  const index = run.nodes.findIndex(
    (node) => node.siteId === ref.siteId && node.ordinal === ref.ordinal,
  );
  if (index < 0) return run;
  const node = run.nodes[index]!;
  const turn = readPositiveInt(payload.turn) ?? node.turn;
  const toolCalls = readNonNegativeInt(payload.toolCalls) ?? node.toolCalls;
  const lastTool = readLastTool(payload.lastTool) ?? node.lastTool;
  const nodes = [...run.nodes];
  nodes[index] = {
    ...node,
    ...(turn === undefined ? {} : { turn }),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(lastTool === undefined ? {} : { lastTool }),
  };
  return { ...run, nodes };
}

/** 轮次是 1 起的正整数：没有「第 0 轮」这回事，0 / 小数 / NaN 一律按读不出处理。 */
function readPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** 工具调用数可以是 0——「一个工具都没调过」是事实，不是缺席。 */
function readNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** 工具名是这条记录存在的理由，读不出即整条不落（只有 target 的 lastTool 说不出任何事）。 */
function readLastTool(value: unknown): WorkflowRunNodeLastTool | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const name = boundedText(record.name, WORKFLOW_RUNS_LIMITS.maxLastToolNameLength);
  if (name === undefined) return undefined;
  const target = boundedText(record.target, WORKFLOW_RUNS_LIMITS.maxLastToolTargetLength);
  return { name, ...(target === undefined ? {} : { target }) };
}

/**
 * 按线上界裁剪，空串按缺席处理。
 *
 * 生产侧已经切过一遍（引擎的 `INSTRUCTIONS_HEAD_MAX_CHARS` / `LAST_TOOL_TARGET_MAX_CHARS`），
 * 这里是第二道闸，与 `boundedActorName` / `boundedPhaseName` 同族同理由：超界字符串会让父会话
 * 之后的每一帧被渲染端拒收。**直接截断、不加省略号**——
 * 摘要本来就是个头，续写标记是渲染侧的事，协议这条只保证合法。
 */
function boundedText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.slice(0, limit);
  return text.length > 0 ? text : undefined;
}
