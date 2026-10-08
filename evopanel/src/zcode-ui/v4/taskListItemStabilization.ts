// task list 行的引用稳定化（跨 lane 共享）。
//
// sessions-index / Controller tasks-index 每个内容帧都会全量重建 ZCodeTaskMeta[]，
// 即使内容完全没变（例如只改了列表不消费的 activity 时间戳）。下游把「全新数组引用」当成新数据：
// grouped 视图整树 refresh、虚拟器重测量、workspace 行缓存被 invalidate——表现为
// 「右侧输出 tool 结果时左侧列表整个重新加载」。这里做逐条引用稳定化：内容等价复用旧对象；
// 整表等价复用旧数组，让依赖数组/元素身份的 memo 与 effect 全部短路。
import type { ZCodeTaskMeta } from "@zcode/shared";

export function buildTaskListItemIdentityKey(meta: ZCodeTaskMeta): string {
  return `${meta.workspaceIdentity?.trim() || meta.workspacePath}::${meta.taskId}`;
}

/**
 * 结构等价：忽略 key 插入顺序，把 `undefined` 值视同缺省（与 JSON 序列化口径一致）。
 *
 * 这里刻意不用 `JSON.stringify` 比较：上游 Controller / tasks-index join 大量使用条件展开
 * （`...(x ? { k: v } : {})`）构造对象，同内容不同 key 顺序在字符串上恒不相等，稳定化会
 * 静默退化成「每帧全新引用」——「整列表闪一下」无声回归，而且不报错、无日志、无指标。
 * 逐字段比较让等价判断不依赖构造顺序这一隐式假设，顺带在首个差异处短路。
 */
export function areStabilizedValuesEquivalent(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => areStabilizedValuesEquivalent(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key) => areStabilizedValuesEquivalent(leftRecord[key], rightRecord[key]));
}

/** 逐字段等价（嵌套字段结构比较；task meta 是小对象，代价可忽略）。 */
export function areTaskListItemsEquivalent(left: ZCodeTaskMeta, right: ZCodeTaskMeta): boolean {
  return areStabilizedValuesEquivalent(left, right);
}

/** 引用稳定化：等价条目复用旧对象；顺序与内容全等时复用整个旧数组。 */
export function stabilizeTaskListItems<T extends ZCodeTaskMeta>(previous: T[], next: T[]): T[] {
  if (previous.length === 0) {
    return next;
  }
  const previousByKey = new Map(
    previous.map((meta) => [buildTaskListItemIdentityKey(meta), meta] as const),
  );
  let identical = previous.length === next.length;
  const stabilized = next.map((meta, index) => {
    const previousMeta = previousByKey.get(buildTaskListItemIdentityKey(meta));
    if (previousMeta && areTaskListItemsEquivalent(previousMeta, meta)) {
      if (identical && previous[index] !== previousMeta) {
        identical = false;
      }
      return previousMeta;
    }
    identical = false;
    return meta;
  });
  return identical ? previous : stabilized;
}
