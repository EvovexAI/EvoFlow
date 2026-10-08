import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";

/**
 * 缓存 `timeline-model.ts` 的计算结果，同一对 (graph, run) 只构建一次。
 *
 * 为什么按**对象身份**做键是对的：两个输入都是不可变的协议对象——图是行上那份已校验的
 * display 载荷里的 `causalityGraph`，run 是 `workflowRuns` 投影里的一条；投影的归约与键级
 * 增量都是浅重建（变了的那条换新对象，没变的元素引用原样保留）。于是「同一个对象」等价于
 * 「同一份内容」，而内容一变必然换新对象——缓存不会喂出过期的模型。
 *
 * 为什么不靠各自的 `useMemo`：run 卡与 run 详情页在同一帧里画同一条 run，各自的 useMemo 只
 * 认自己那一份，一帧就建两遍（表界上每遍十几毫秒）。两级 WeakMap（先 run 后 graph）让第二处
 * 退成一次查表。键是弱引用：投影每帧发新 run 对象，上一帧的条目随之可回收，表不会长。
 */
const BY_RUN = new WeakMap<object, WeakMap<object, unknown>>();

/** 无 run 的静态图（确认窗、编译反馈卡）也走同一张表，用模块级哨兵占住 run 那一级。 */
const NO_RUN: object = {};

export function sharedTimelineModel<Model>(
  graph: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
  build: () => Model,
): Model {
  const runKey: object = run ?? NO_RUN;
  let byGraph = BY_RUN.get(runKey);
  if (byGraph === undefined) {
    byGraph = new WeakMap<object, unknown>();
    BY_RUN.set(runKey, byGraph);
  }
  // `has` 而不是 `get() !== undefined`：模型恒是对象，但判定不该依赖这一点。
  if (byGraph.has(graph)) return byGraph.get(graph) as Model;
  const model = build();
  byGraph.set(graph, model);
  return model;
}
