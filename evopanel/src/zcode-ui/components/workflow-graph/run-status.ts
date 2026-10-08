import type {
  WorkflowRunActor,
  WorkflowRunNode,
  WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import { phaseBinder } from "./instance-phases.js";
import {
  isSyntheticLaneId,
  type StepRunStatus,
  type StepStatusTable,
  type WorkflowCausalityGraphData,
} from "./types.js";

/**
 * 实时叠加视图（live view v1）的纯选择器。
 *
 * 这个视图刻意**不展开**成实例图：它就是提交时那张静态因果图，加一层状态装饰。由此得到的最强性质是
 * **运行期间图的节点与边集合绝不变化**——rank 单调、无重排按构造成立，因为叠加从不摆卡片。
 * 代价只有一个，而且只有这一个：一个静态 step 对应 N 个运行时实例（循环 / fan-out），
 * 所以状态必须坍缩，「第 3 轮失败了、第 4 轮在跑」是单张卡片说不出的那句话。
 */
export interface WorkflowRunOverlay {
  /**
   * 按图上的 step id 索引的状态。偏表：没有观察到实例的 step **没有条目**。「每个 step 都有值」
   * 曾是给 React Flow 板面的承诺（每张卡都要装饰）；板面退役后没有消费者需要它，而它让
   * 「从没跑过」与「排队中」共用一个 `pending`。
   */
  statuses: StepStatusTable;
  /** 从 running 的 step 出发的排序边是否动画。 */
  animatedEdges: boolean;
}

/**
 * 引擎相位 → 四值 `StepRunStatus`。
 *
 * 词汇表按**引擎实际发出的**事件写：queued / dispatched / executing / waiting / repairing / nudged /
 * settled。`executing` / `waiting` 是 driver 的观察：
 * 模型请求真的发出去了 / 在等进程级槽位或退避。
 *
 * queued / dispatched / waiting 归入 pending 是有意的：这三段都是「还没有请求在 provider 那里跑」——
 * FIFO 与 per-run 上限的等待、会话就绪但首个请求尚未准入、闸门排队或退避。真正在动由 executing 说。
 */
export function statusOfRunNode(node: WorkflowRunNode): StepRunStatus {
  switch (node.phase) {
    case "executing":
    case "repairing":
    case "nudged":
      return "running";
    case "settled":
      // 失败与取消都画成 failed（journal 里两者语义不同，但叠加视图只用四值词汇表）。
      // outcome 缺省在引擎里不可达（settled 必带 outcome）；真出现时按「已结束」处理，
      // 因为谎报 pending（没开始）比少一格颜色更糟，而谎报 failed 会造成假警报。
      return node.outcome === "failed" || node.outcome === "cancelled" ? "failed" : "done";
    default:
      return "pending";
  }
}

/**
 * 唯一的折叠：实例状态的多重集 → 一个状态。
 *
 *   - 空集 → `undefined`。缺席不是状态，折叠不凭空造一个；由消费者按控制流解缺席。
 *   - 任一 running → running。**刻意优先于 failed**：读者最需要知道的是「还在动吗」。
 *   - 既有已结算又有排队 → running：开始了、没结束。旧规则把它读成 pending（「还没开始」），
 *     是同一个混淆换了件衣服。
 *   - 全部排队 → pending。
 *   - 全部结算：任一 failed → failed，否则 done。
 *
 * 四条都是 any 判定，所以先按站点折、再按参与者折与直接按实例折结果相同——两级折叠不会漂移。
 * 输入既可以是实例状态（`statusOfRunNode`），也可以是站点状态（本函数的输出），词汇表相同。
 */
export function aggregateRunStatuses(
  statuses: readonly StepRunStatus[],
): StepRunStatus | undefined {
  if (statuses.length === 0) return undefined;
  if (statuses.includes("running")) return "running";
  const queued = statuses.includes("pending");
  const settled = statuses.some((status) => status === "done" || status === "failed");
  if (queued) return settled ? "running" : "pending";
  return statuses.includes("failed") ? "failed" : "done";
}

/**
 * 一张卡片的收状态口子。`lane` 只有 may-set 展开的拷贝才有——它是这张卡片的**全部**主张
 * （「这次 ask 可能跑在这条车道上」），所以别的车道上的实例与它无关。`phase` 是阶段拷贝的
 * 同一种主张（「这次 ask 是在这个阶段里发的」）：出生在别的阶段的实例与它无关。
 */
interface OverlayTarget {
  instances: StepRunStatus[];
  lane?: string;
  phase?: string;
}

export function workflowRunOverlay(
  run: WorkflowRunState | undefined,
  graph: WorkflowCausalityGraphData,
): WorkflowRunOverlay {
  // 没有 run 就是静态渲染：返回空表而不是一张全 pending 的表，让组件保持"零运行时数据"的样子。
  if (!run) return { statuses: {}, animatedEdges: false };

  // 关联键是**站点 id**，不是卡片 id：may-set 车道展开后一个站点对应每候选车道一张卡片，
  // 阶段拷贝后一个站点对应每认领阶段一张卡片（`ask#1~phase#3`）；`source` 记下展开自的站点，
  // 两种拷贝都按它收，再各按自己的主张收窄——车道拷贝按 actor 车道，阶段拷贝按实例的出生阶段
  // （`phaseName`，与卡片绑定、站的观察同一个 `phaseBinder`）。漏掉后一条，一个共享 helper
  // 从五个阶段各派一批子代理时，第一批一动五站的灯全亮。
  const byStepId = new Map<string, StepRunStatus[]>();
  const targetsBySiteId = new Map<string, OverlayTarget[]>();
  for (const step of graph.steps) {
    const instances: StepRunStatus[] = [];
    byStepId.set(step.id, instances);
    // 不带 source 的 step **不做**车道收窄：>4 候选（或含 unknown）回退的单卡画在 lanes[0]，
    // 实例却可能落在任一候选车道上，收窄会把这类卡片永久熄灭。
    const target: OverlayTarget = {
      instances,
      ...(step.source === undefined ? {} : { lane: step.lane }),
      ...(step.phase === undefined ? {} : { phase: step.phase }),
    };
    const siteId = step.source ?? step.id;
    const targets = targetsBySiteId.get(siteId);
    if (targets === undefined) targetsBySiteId.set(siteId, [target]);
    else targets.push(target);
  }

  const binder = phaseBinder(graph, run);
  for (const node of run.nodes) {
    // 图里不存在的 site id 一律忽略：叠加绝不增删节点。
    const targets = targetsBySiteId.get(node.siteId);
    if (targets === undefined) continue;
    const status = statusOfRunNode(node);
    for (const target of targets) {
      // actorSiteId 缺席的实例进该站点的**全部**拷贝：退化成旧单卡的过度点亮，而不是死图——
      // liveness 线索宁可多亮一格，也不能一格都不亮。
      const belongsToOtherLane =
        target.lane !== undefined &&
        node.actorSiteId !== undefined &&
        node.actorSiteId !== target.lane;
      if (belongsToOtherLane) continue;
      // 出生阶段同理：无戳的实例（旧 run、标记前出生）由 binder 按既有规则归位——无词汇的 run
      // 落全部阶段，退化成今天的过度点亮，而不是熄灯。
      const belongsToOtherPhase =
        target.phase !== undefined && !binder.has(target.phase, node.phaseName);
      if (belongsToOtherPhase) continue;
      target.instances.push(status);
    }
  }

  const statuses: StepStatusTable = {};
  let anyRunning = false;
  for (const [stepId, instanceStatuses] of byStepId) {
    const status = aggregateRunStatuses(instanceStatuses);
    if (status === undefined) continue;
    statuses[stepId] = status;
    if (status === "running") anyRunning = true;
  }

  return { statuses, animatedEdges: anyRunning };
}

/**
 * 车道 → 该车道上的 actor 实例（phase 5 的 transcript 下钻：单实例直接开，多实例弹选择器）。
 *
 * 车道 site id 是身份，显示名只是展示（沿用 causality-graph 的命名契约）。
 * `workspace` 与 `unknown` 是合成车道，上面没有会话，所以恒返回空——world-read step
 * 因此只有选中态、没有下钻。
 */
export function workflowRunActorsForLane(
  run: WorkflowRunState | undefined,
  laneId: string,
): WorkflowRunActor[] {
  if (!run || isSyntheticLaneId(laneId)) return [];
  return run.actors
    .filter((actor) => actor.siteId === laneId)
    .sort((left, right) => left.ordinal - right.ordinal);
}
