import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { phaseNameMatches } from "./phase-name.js";
import type { WorkflowCausalityGraphData } from "./types.js";

/**
 * 运行时实例的归属阶段。
 *
 * 静态的 may-set 拷贝按阶段索引（`ask#1~phase#3`），运行时实例带同一个坐标——引擎在铸造
 * ordinal 的那一刻记下的当前阶段名（`phaseName`）。这里把「一个戳落在哪些 display 阶段上」
 * 收成一条规则，卡片绑定（participant-model.ts）与站的观察（timeline-model.ts）共用：
 * 一次**划分**，而不是一次广播。
 */

/** 这次 run 说过阶段的话吗：任一 actor / 节点带戳。旧 CLI、旧 run、无标记脚本都没有。 */
export function runHasPhaseVocabulary(run: WorkflowRunState | undefined): boolean {
  if (run === undefined) return false;
  return (
    run.actors.some((actor) => actor.phaseName !== undefined) ||
    run.nodes.some((node) => node.phaseName !== undefined)
  );
}

/**
 * 一个戳的归属阶段集：
 *   - 有戳 → 名字匹配的 display 阶段（`phaseNameMatches`，截断兜底在那里）；
 *   - 无戳且 run 有词汇 → **无名**的 display 阶段（`unphased` / 隐式 `workflow`）：首个标记
 *     之前的 step 分析器正是放在无名的 `unphased` 里，「无戳 ↔ 无名」是同一个事实的两面；
 *   - 无戳且 run 无词汇 → 全部阶段（今天的行为）。
 * 任一分支结果为空 → 全部阶段：宁可重复显示，也不把一个在跑的子代理藏起来。
 */
export function phasesOf(
  phaseName: string | undefined,
  graph: WorkflowCausalityGraphData,
  runHasVocabulary: boolean,
): Set<string> {
  const phases = graph.phases ?? [];
  const all = () => new Set(phases.map((phase) => phase.id));
  if (phaseName === undefined && !runHasVocabulary) return all();
  const matched = phases.filter((phase) =>
    phaseName === undefined ? phase.name === undefined : phaseNameMatches(phase.name, phaseName),
  );
  return matched.length === 0 ? all() : new Set(matched.map((phase) => phase.id));
}

/** 一次视图算一遍的解析器：词汇表判定与每个戳的结果都只算一次（每个节点都要问一遍）。 */
export interface PhaseBinder {
  phasesOf(phaseName: string | undefined): ReadonlySet<string>;
  /** 这个戳属于这一站 / 这张卡吗。 */
  has(phaseId: string, phaseName: string | undefined): boolean;
}

export function phaseBinder(
  graph: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
): PhaseBinder {
  const vocabulary = runHasPhaseVocabulary(run);
  // 图自己还没有阶段词汇表（无标记脚本的原图，UI 合成隐式阶段之前）：没有可划分的坐标，
  // 一律算属于——否则「归属集恒为空」会把每张卡的实例全部抹掉。
  const ungrouped = (graph.phases ?? []).length === 0;
  const cache = new Map<string | undefined, ReadonlySet<string>>();
  const resolve = (phaseName: string | undefined): ReadonlySet<string> => {
    const hit = cache.get(phaseName);
    if (hit !== undefined) return hit;
    const phases = phasesOf(phaseName, graph, vocabulary);
    cache.set(phaseName, phases);
    return phases;
  };
  return {
    has: (phaseId, phaseName) => ungrouped || resolve(phaseName).has(phaseId),
    phasesOf: resolve,
  };
}
