// ============================================================
// 给**没有** `workflowRunDeltas` 能力的消费者的 workflowRuns 裁剪
// ============================================================
// 这一条不是展示预算，是 wire 兼容：旧消费者二进制里的 actors / nodes 校验界是 256
// （{@link WORKFLOW_RUNS_LEGACY_LIMITS}），而已知键上的解析错误**不会被剥掉一个键**——它让整个
// `state.updated` patch 失败、整帧被丢，那条订阅从此静默。所以我们把界抬到 1024 之后，发给旧
// 消费者的每一帧（增量折叠出来的整键 patch，以及快照）都必须先过这里。
//
// 留下的是哪 256 条，则与归约侧的腾位同一条道理（workflow-runs-eviction.ts）：**还在动的先留**。
// 旧手机画的和新客户端画的是同一件事——此刻谁在跑——而一刀切「前 256 条」会让一个宽 run 在
// 那一代客户端上永远停在最早那批已经结束的身上。名额有余时按表序补最早的条目，输出仍按原表序。

import { canonicalWorkflowRun } from "./workflow-runs-delta.js";
import {
  WORKFLOW_RUNS_LEGACY_LIMITS,
  type WorkflowRunActor,
  type WorkflowRunNode,
  type WorkflowRunsState,
} from "./workflow-runs.js";

/**
 * 按旧界裁剪；裁过的 run 置 `truncated: true`（读面据它显示「仅展示 N/M 步的详情」）。
 *
 * **不裁别的**：旧消费者认不出的新可选键是无害的（容器非 strict，多余的键被剥掉而已），
 * 而为了"干净"去剥它们反而要维护第二份字段表，增加字段不一致的风险。
 *
 * 无需裁剪时返回**同一个对象**：这个函数在每次 flush 上都会跑一遍，白白造一份新状态会让
 * 下游所有按引用 memo 的地方失效。
 */
export function clampWorkflowRunsForLegacy(state: WorkflowRunsState): WorkflowRunsState {
  let clamped = false;
  const runs = state.runs.map((run) => {
    const actors = clampKeepingLive(
      run.actors,
      WORKFLOW_RUNS_LEGACY_LIMITS.maxActors,
      (actor: WorkflowRunActor) => actor.status !== "completed",
    );
    const nodes = clampKeepingLive(
      run.nodes,
      WORKFLOW_RUNS_LEGACY_LIMITS.maxNodes,
      (node: WorkflowRunNode) => node.phase !== "settled",
    );
    if (actors === run.actors && nodes === run.nodes) return run;
    clamped = true;
    // 走规范键序：`truncated` 可能是这条 run 上的新键，直接展开会把它缀在对象尾部，
    // 而同一份状态在别处（归约出口、增量 apply）都是 schema 序。
    return canonicalWorkflowRun({ ...run, actors, nodes, truncated: true });
  });
  return clamped ? { revision: state.revision, runs } : state;
}

/**
 * 裁到 `limit` 条：先按表序收下**还在动的**，名额有余再按表序补最早的条目，最后按**原表序**
 * 输出（两遍取下标、一遍 filter，所以顺序是表序而不是「活的在前」）。
 *
 * 活条目本身多过名额时按表序取前 `limit` 条——这一条仍然要有界，旧消费者的校验界不接受
 * 任何解释。界内时返回同一个数组。
 */
function clampKeepingLive<T>(
  list: readonly T[],
  limit: number,
  isLive: (entry: T) => boolean,
): T[] {
  if (list.length <= limit) return list as T[];
  const kept = new Set<number>();
  for (let index = 0; index < list.length && kept.size < limit; index += 1) {
    if (isLive(list[index]!)) kept.add(index);
  }
  for (let index = 0; index < list.length && kept.size < limit; index += 1) {
    kept.add(index);
  }
  return list.filter((_, index) => kept.has(index));
}
