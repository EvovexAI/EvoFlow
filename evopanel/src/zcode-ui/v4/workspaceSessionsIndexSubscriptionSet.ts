import {
  LOCAL_SESSIONS_INDEX_ENDPOINT,
  acquireSessionsIndex,
  buildSessionsIndexEntryKey,
  releaseSessionsIndex,
  type SessionsIndexAgentService,
  type SessionsIndexScope,
} from "@/v4/sessionsIndexRegistry.js";
import type { SessionsIndexStore } from "@/v4/sessionsIndexStore.js";
import { logger } from "@/logger.js";

export interface WorkspaceSessionsIndexBinding {
  scope: SessionsIndexScope;
  agentService: SessionsIndexAgentService;
}

interface ActiveWorkspaceSessionsIndexEntry extends WorkspaceSessionsIndexBinding {
  store: SessionsIndexStore;
  unsubscribeStore: () => void;
}

function scopeLogKey(scope: SessionsIndexScope): string {
  return `${scope.endpointKey ?? "__base__"}:${scope.workspaceKey}`;
}

function isSameBinding(
  current: ActiveWorkspaceSessionsIndexEntry,
  next: WorkspaceSessionsIndexBinding,
): boolean {
  return (
    current.agentService === next.agentService &&
    current.scope.workspaceKey === next.scope.workspaceKey &&
    current.scope.workspacePath === next.scope.workspacePath &&
    current.scope.workspaceIdentity === next.scope.workspaceIdentity &&
    current.scope.endpointKey === next.scope.endpointKey
  );
}

/**
 * 按 endpoint + workspaceKey 持有 sessions-index 订阅。
 *
 * 旧 hook 把整个 scopes 数组放进一个带 cleanup 的 effect；删除一个 workspace 时，
 * React 会先释放全部 sibling 订阅，再重新 acquire 剩余项，导致已有 snapshot/水位被空状态替换。
 * 这里把 scope 数组解释成 desired set，只对真正新增、删除或 endpoint 换代的 key 做副作用。
 */
export class WorkspaceSessionsIndexSubscriptionSet {
  private readonly active = new Map<string, ActiveWorkspaceSessionsIndexEntry>();

  constructor(private readonly onStoreChange: () => void) {}

  reconcile(bindings: readonly WorkspaceSessionsIndexBinding[]): boolean {
    const desired = new Map<string, WorkspaceSessionsIndexBinding>();
    for (const binding of bindings) {
      desired.set(buildSessionsIndexEntryKey(binding.scope), binding);
    }

    let changed = false;
    const releasedScopeKeys: string[] = [];
    const acquiredScopeKeys: string[] = [];
    for (const [entryKey, current] of this.active) {
      const next = desired.get(entryKey);
      if (next && isSameBinding(current, next)) {
        continue;
      }
      if (
        next &&
        current.agentService !== next.agentService &&
        (current.scope.endpointKey ?? LOCAL_SESSIONS_INDEX_ENDPOINT) !==
          LOCAL_SESSIONS_INDEX_ENDPOINT
      ) {
        // 远程 service 换代若先 release 唯一 lease，registry 会立即关闭旧 store，
        // 随后的 acquire 只能从空 store 重建。先 acquire 让 registry 在旧 entry 仍存活时
        // 原地 rebind transport，再释放旧 lease，投影和 consumer listener 均不中断。
        const store = acquireSessionsIndex(next.scope, next.agentService);
        const sameStore = store === current.store;
        const unsubscribeStore = sameStore
          ? current.unsubscribeStore
          : store.subscribe(this.onStoreChange);
        if (sameStore) {
          releaseSessionsIndex(current.scope, current.store);
        } else {
          this.disposeEntry(current);
        }
        this.active.set(entryKey, {
          ...next,
          store,
          unsubscribeStore,
        });
        releasedScopeKeys.push(scopeLogKey(current.scope));
        acquiredScopeKeys.push(scopeLogKey(next.scope));
        changed = true;
        continue;
      }
      releasedScopeKeys.push(scopeLogKey(current.scope));
      this.disposeEntry(current);
      this.active.delete(entryKey);
      changed = true;
    }

    for (const [entryKey, binding] of desired) {
      if (this.active.has(entryKey)) {
        continue;
      }
      const store = acquireSessionsIndex(binding.scope, binding.agentService);
      acquiredScopeKeys.push(scopeLogKey(binding.scope));
      this.active.set(entryKey, {
        ...binding,
        store,
        unsubscribeStore: store.subscribe(this.onStoreChange),
      });
      changed = true;
    }

    if (changed) {
      logger.info("[v4-sessions-index] workspace subscription set reconciled", {
        acquiredScopeKeys,
        releasedScopeKeys,
        activeCount: this.active.size,
      });
      this.onStoreChange();
    } else {
      logger.debug("[v4-sessions-index] workspace subscription set unchanged", {
        activeCount: this.active.size,
      });
    }
    return changed;
  }

  getStore(
    scope: Pick<SessionsIndexScope, "workspaceKey" | "endpointKey">,
  ): SessionsIndexStore | undefined {
    return this.active.get(buildSessionsIndexEntryKey(scope))?.store;
  }

  size(): number {
    return this.active.size;
  }

  /** hook 真正卸载（含 StrictMode cleanup）时统一释放；后续 reconcile 仍可重新建立。 */
  dispose(): void {
    if (this.active.size > 0) {
      logger.info("[v4-sessions-index] workspace subscription set disposed", {
        releasedScopeKeys: [...this.active.values()].map((entry) => scopeLogKey(entry.scope)),
      });
    }
    for (const entry of this.active.values()) {
      this.disposeEntry(entry);
    }
    this.active.clear();
  }

  private disposeEntry(entry: ActiveWorkspaceSessionsIndexEntry): void {
    entry.unsubscribeStore();
    releaseSessionsIndex(entry.scope, entry.store);
  }
}
