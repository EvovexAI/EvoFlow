// ============================================================
// workflowRuns 里几张**有界表**的 upsert 语义
// ============================================================
// 纯函数，负责表项更新与容量判断，不读取时钟或执行 I/O。
//
// 这两个函数说的是同一句话的两半：一张表怎么认「这是同一条记录」，以及装不下时怎么办。
// 触界的语义是**拒新、仍更新已有**——把一个正在跑的实例的相位冻结在 "queued" 上，比少列一个
// 实例更容易误导读者（图上那一格会永远显示没开始）。谁可以为新人让位则是另一件事，在
// workflow-runs-eviction.ts。

import type { WorkflowRunPendingQuestion } from "./workflow-runs.js";

/** 一次有界 upsert 的结果。`truncated` = 这条记录**没能进表**（而不是「表里已有、原地更新」）。 */
export interface BoundedUpsert<T> {
  list: T[];
  truncated: boolean;
}

/**
 * 按 (siteId, ordinal) upsert 进有界列表（actors / nodes / reports 三张表的去重键都是它）。
 *
 * `admitNew: false` 把「不收新条目」这件事从界扩到别的理由（重放的事件、一条表外实例的中间
 * 相位；见归约里节点分支的 `born`），产出与触界被拒**逐字相同**——因为它说的是同一件事：
 * 这条实例不在表里。调用方据此照常计数。
 */
export function upsertBoundedByInstance<T extends { siteId: string; ordinal: number }>(
  list: readonly T[],
  entry: T,
  limit: number,
  options: { admitNew?: boolean } = {},
): BoundedUpsert<T> {
  const index = list.findIndex(
    (item) => item.siteId === entry.siteId && item.ordinal === entry.ordinal,
  );
  if (index >= 0) {
    const next = [...list];
    next[index] = entry;
    return { list: next, truncated: false };
  }
  if (options.admitNew === false || list.length >= limit) {
    return { list: [...list], truncated: true };
  }
  return { list: [...list, entry], truncated: false };
}

/**
 * 按 `qid` upsert 进有界的停驻问题表。
 *
 * 与 {@link upsertBoundedByInstance} 是同一条触界语义（拒新、仍更新已有），只是键不同：升级没有
 * 站点实例身份，qid 才是它的键。没有把两者合并成一个泛型函数，是因为键的**取法**正是这里
 * 唯一要说的事——合并之后调用点要传一个取键函数，读者反而看不出"这张表按什么去重"。
 */
export function upsertBoundedByQid(
  list: readonly WorkflowRunPendingQuestion[],
  entry: WorkflowRunPendingQuestion,
  limit: number,
): BoundedUpsert<WorkflowRunPendingQuestion> {
  const index = list.findIndex((item) => item.qid === entry.qid);
  if (index >= 0) {
    const next = [...list];
    next[index] = entry;
    return { list: next, truncated: false };
  }
  if (list.length >= limit) return { list: [...list], truncated: true };
  return { list: [...list, entry], truncated: false };
}
