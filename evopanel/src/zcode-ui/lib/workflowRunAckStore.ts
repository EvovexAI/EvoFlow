// 已确认的工作流 run。
// 已结束的运行行要一直挂着直到用户打开那个会话——没有计时器、没有 settledAt，只有这一份有界、
// 持久化的 runId 集合：打开会话时把它当时所有已结束的 run 整批放进来。桌面走 localStorage，
// 手机远控在自己的浏览器里走同一份代码、自己的存储。
import { useMemo, useSyncExternalStore } from "react";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const WORKFLOW_RUN_ACK_STORAGE_KEY = "zcode-workflow-run-acknowledged";
/** 集合上限；满了淘汰最早确认的。256 远大于任何会话列表里同时挂着的已结束 run 数。 */
const WORKFLOW_RUN_ACK_LIMIT = 256;

interface WorkflowRunAckStore {
  isAcknowledged(runId: string): boolean;
  acknowledge(runIds: readonly string[]): void;
  subscribe(listener: () => void): () => void;
  /** 版本号快照：每次集合变化 +1，供 useSyncExternalStore 判等。 */
  getVersion(): number;
}

function readStored(storage: StorageLike | null): string[] {
  if (storage === null) return [];
  try {
    const raw = storage.getItem(WORKFLOW_RUN_ACK_STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

function createWorkflowRunAckStore(storage: StorageLike | null): WorkflowRunAckStore {
  // 插入序 = 确认序；Set 的迭代序保证淘汰最早的。
  const acknowledged = new Set<string>(readStored(storage).slice(-WORKFLOW_RUN_ACK_LIMIT));
  const listeners = new Set<() => void>();
  let version = 0;
  const persist = () => {
    if (storage === null) return;
    try {
      storage.setItem(WORKFLOW_RUN_ACK_STORAGE_KEY, JSON.stringify([...acknowledged]));
    } catch {
      // 存储不可用（隐私模式、配额）：本次会话内仍生效，只是不跨重启。
    }
  };
  return {
    isAcknowledged: (runId) => acknowledged.has(runId),
    acknowledge: (runIds) => {
      let changed = false;
      for (const runId of runIds) {
        if (acknowledged.has(runId)) continue;
        acknowledged.add(runId);
        changed = true;
      }
      if (!changed) return;
      while (acknowledged.size > WORKFLOW_RUN_ACK_LIMIT) {
        const oldest = acknowledged.values().next().value;
        if (oldest === undefined) break;
        acknowledged.delete(oldest);
      }
      version += 1;
      persist();
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getVersion: () => version,
  };
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

let defaultStore: WorkflowRunAckStore | null = null;

export function getWorkflowRunAckStore(): WorkflowRunAckStore {
  defaultStore ??= createWorkflowRunAckStore(getBrowserStorage());
  return defaultStore;
}

/** 订阅确认集合的版本；返回的谓词随版本变化换引用，调用方据此重算行选择。 */
export function useWorkflowRunAcknowledged(): (runId: string) => boolean {
  const store = getWorkflowRunAckStore();
  const version = useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  // 谓词随版本换引用：调用方把它放进 useMemo 依赖，集合一变行选择就重算。
  return useMemo(() => (runId: string) => store.isAcknowledged(runId), [store, version]);
}
