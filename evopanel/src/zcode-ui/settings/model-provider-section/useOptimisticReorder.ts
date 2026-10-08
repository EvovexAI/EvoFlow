import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

interface PendingReorder {
  readonly operationId: number;
  readonly ids: readonly string[];
}

interface OptimisticReorderController {
  readonly renderedIds: readonly string[];
  commit(ids: readonly string[]): Promise<void>;
}

export function useOptimisticReorder({
  authoritativeIds,
  persist,
}: {
  authoritativeIds: readonly string[];
  persist: (ids: readonly string[]) => Promise<void>;
}): OptimisticReorderController {
  const [pending, setPending] = useState<PendingReorder | null>(null);
  const nextOperationIdRef = useRef(0);
  const persistenceTailRef = useRef<Promise<void>>(Promise.resolve());
  const persistOwnerRef = useRef(persist);

  useLayoutEffect(() => {
    if (persistOwnerRef.current === persist) return;
    persistOwnerRef.current = persist;
    // 切换 Environment/Service Owner 时，即使 Provider 成员完全相同，也不能继续
    // 展示或串行等待旧环境的 pending 操作。推进 operation id 使旧 Promise 的迟到结果失效。
    nextOperationIdRef.current += 1;
    persistenceTailRef.current = Promise.resolve();
    setPending(null);
  }, [persist]);

  const renderedIds = useMemo(
    () =>
      pending && haveSameMembers(authoritativeIds, pending.ids) ? pending.ids : authoritativeIds,
    [authoritativeIds, pending],
  );

  useEffect(() => {
    setPending((current) => {
      if (!current) return current;
      if (
        haveSameOrder(authoritativeIds, current.ids) ||
        !haveSameMembers(authoritativeIds, current.ids)
      ) {
        return null;
      }
      return current;
    });
  }, [authoritativeIds]);

  const commit = useCallback(
    (ids: readonly string[]): Promise<void> => {
      const nextIds = [...ids];
      const operationId = nextOperationIdRef.current + 1;
      nextOperationIdRef.current = operationId;
      setPending({ operationId, ids: nextIds });

      // 拖拽库在 pointer up 时会立即清除 transform，而正式 Settings View
      // 要等文件写入和 Registry refresh 后才到达。这里先保留用户最新排序作为纯 UI
      // pending intent，并串行写入，避免旧请求迟到覆盖连续拖拽的最终顺序。
      const operation = persistenceTailRef.current
        .catch(() => undefined)
        .then(() => persist(nextIds));
      persistenceTailRef.current = operation;

      return operation.catch((error: unknown) => {
        setPending((current) => (current?.operationId === operationId ? null : current));
        throw error;
      });
    },
    [persist],
  );

  return { renderedIds, commit };
}

function haveSameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function haveSameMembers(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const leftIds = new Set(left);
  return leftIds.size === right.length && right.every((id) => leftIds.has(id));
}
