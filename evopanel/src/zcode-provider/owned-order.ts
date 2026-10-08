/**
 * 规范化 Built-in/Personal 共同拥有的可排序成员。
 *
 * 未排序 Built-in 必须留在用户顺序之前，未排序 Personal 必须留在之后；否则远端新增
 * Built-in 成员后，下一次 Personal 写入会把它错误地挪到整个列表末尾。
 */
export function resolveOwnedOrder<T extends string>(
  builtinIds: readonly T[],
  personalIds: readonly T[],
  requestedOrder: readonly T[],
): readonly T[] {
  const builtin = uniqueInOrder(builtinIds);
  const builtinSet = new Set(builtin);
  const personal = uniqueInOrder(personalIds).filter((id) => !builtinSet.has(id));
  const members = new Set([...builtin, ...personal]);
  const ordered = uniqueInOrder(requestedOrder).filter((id) => members.has(id));
  const orderedSet = new Set(ordered);
  return [
    ...builtin.filter((id) => !orderedSet.has(id)),
    ...ordered,
    ...personal.filter((id) => !orderedSet.has(id)),
  ];
}

function uniqueInOrder<T extends string>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
