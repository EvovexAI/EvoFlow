// ============================================================
// 表外条目的归属账：`unlistedByPhase` 的每一格怎么加、怎么减、什么时候整格消失
// ============================================================
// 本模块是纯函数，不读取时钟或执行 I/O。淘汰规则决定谁离开表，这里维护离开后的分阶段计数。
//
// 读面是按**站**画的：一个站点
// 的花名册、计数环和「N more」都得把自己那一格的表外条目加回去。run 级的两个计数器
// （workflow-runs-caps.ts）说得出一条 run 总共少列了多少，说不出少在哪一站——这张格子表就是
// 那个缺口。
//
// 一格里四个数各回答一个问题，四个都只描述**此刻**（而不是历史累计）：
//   - `actors`：这个出生阶段有多少个子代理**此刻不在表上**，不论它是被拒、被淘汰，还是
//     出生即结算的孤儿。它可加可减——一个被淘汰的子代理在下一次被派活时会回到表上
//     （workflow-runs-eviction.ts 的 activation），那一刻这一格要减回去；
//   - `actorsSettled` / `actorsFailed`：其中已经**结束**的、以及结束时失败的；
//   - `settled`：记在这一格上的表外**已结算节点**数。
// 四个数全为零的格子整个丢掉，最后一格也丢掉时整个键消失——与本族其余「无则缺席」同规。
//
// 每次改动之后整格夹到 `actorsFailed ≤ actorsSettled ≤ actors`，这是这一格的**法律**而不是
// 一道补丁：它正是让 `actorsSettled` 既能涨也能落的那条规则。它必须能落——一个子代理在它两次
// ask 之间看上去就是「已完成」，淘汰于是给它盖了个已结束的戳，而它的下一次派发又把它接回表上。这一格不记录**是谁**回来了，所以在 activation 那一刻去减
// `actorsSettled` 只能靠猜，而在宽 fan-out 里会猜得离谱：那个阶段有几百个子代理是**出生时**
// 就被拒的、根本没结算过，每一次回表都会去扣一笔不属于它的账。夹取只在一格拥挤时错，而且是
// 暂时的——回表的那个已完成子代理把自己的已结束标记留给同阶段另一个未列出的子代理，直到这一格
// 排空为止；随着子代理陆续上表，每个阶段的数字自己会走正。run 级两个计数器全程精确。

import type { WorkflowRunState, WorkflowRunUnlistedPhase } from "./workflow-runs.js";

/** 往一格上加的增量。`actors` 可以是负数（子代理回表），其余只会是正数。 */
export interface WorkflowRunUnlistedDelta {
  actors?: number;
  actorsSettled?: number;
  actorsFailed?: number;
  settled?: number;
}

/**
 * 往某个出生阶段那一格上加数。
 *
 * **格子表满了就丢归属**（返回原表）：一个站点可以少一个它本来就没有的数字，run 级计数不可以
 * 说假话——后者由调用方照加不误。表长比 `maxPhases` 多一格：多出来的那格是「无阶段」，它与
 * 具名阶段共用同一张表。
 *
 * 返回 `undefined` 恒等于「一格都没有」（键缺席），所以减到全零的最后一格会把整张表收掉。
 */
export function addToUnlistedBucket(
  buckets: readonly WorkflowRunUnlistedPhase[] | undefined,
  phaseName: string | undefined,
  delta: WorkflowRunUnlistedDelta,
  maxPhases: number,
): WorkflowRunUnlistedPhase[] | undefined {
  const current = buckets ?? [];
  const index = current.findIndex((bucket) => bucket.phaseName === phaseName);
  if (index < 0 && current.length >= maxPhases + 1) {
    return buckets === undefined ? undefined : [...buckets];
  }
  const base = index < 0 ? undefined : current[index]!;
  // 夹零：`actors` 的减法有两处够不着的前提（归属在格子表满时被丢过、事实上的出生阶段与
  // 派发重发的那个对不上），夹一下只会少算一格，不夹会在协议线上发出一个负数。
  const actors = atLeastZero((base?.actors ?? 0) + (delta.actors ?? 0));
  // 夹到 `actorsFailed ≤ actorsSettled ≤ actors`（文件头的那条法律）：这一格认不出是谁回的表，
  // 所以「已结束」的数目只能跟着「不在表上」的数目一起落。
  const actorsSettled = Math.min(
    atLeastZero((base?.actorsSettled ?? 0) + (delta.actorsSettled ?? 0)),
    actors,
  );
  const actorsFailed = Math.min(
    atLeastZero((base?.actorsFailed ?? 0) + (delta.actorsFailed ?? 0)),
    actorsSettled,
  );
  const settled = atLeastZero((base?.settled ?? 0) + (delta.settled ?? 0));
  if (actors === 0 && actorsSettled === 0 && actorsFailed === 0 && settled === 0) {
    if (index < 0) return buckets === undefined ? undefined : [...buckets];
    const remaining = current.filter((_, position) => position !== index);
    return remaining.length > 0 ? remaining : undefined;
  }
  // 键序 = schema 声明序：这份对象会原样被增量搬上线，两边的字节必须对得上。
  const merged: WorkflowRunUnlistedPhase = {
    ...(phaseName === undefined ? {} : { phaseName }),
    actors,
    ...(actorsSettled > 0 ? { actorsSettled } : {}),
    ...(actorsFailed > 0 ? { actorsFailed } : {}),
    settled,
  };
  if (index < 0) return [...current, merged];
  const next = [...current];
  next[index] = merged;
  return next;
}

/**
 * 把一张格子表落回 run 上：**空表摘键**（而不是留一个空数组）。
 *
 * 「零条 ⇒ 键缺席」是这个字段的协议约定（见 schema 注释），也是幂等的支点：一次什么都没改的
 * 归约要得到逐字节相同的 run 对象，顶层的结构比对才会返回 null。
 */
export function withUnlistedBuckets(
  run: WorkflowRunState,
  buckets: readonly WorkflowRunUnlistedPhase[] | undefined,
): WorkflowRunState {
  if (buckets === run.unlistedByPhase) return run;
  if (buckets === undefined || buckets.length === 0) {
    if (run.unlistedByPhase === undefined) return run;
    const { unlistedByPhase: _emptied, ...withoutKey } = run;
    return withoutKey;
  }
  return { ...run, unlistedByPhase: [...buckets] };
}

function atLeastZero(value: number): number {
  return value > 0 ? value : 0;
}
