import { useServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskSnapshot } from "@zcode/shared";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

type GetTaskSnapshotParams = Parameters<IZCodeTaskService["getTaskSnapshot"]>[0];
type GetTaskSnapshotResult = Promise<ZCodeTaskSnapshot | null>;
type GetTaskSnapshotWithEtagParams = Parameters<IZCodeTaskService["getTaskSnapshotWithEtag"]>[0];

const zcodeTaskServiceProxyCache = new WeakMap<IZCodeTaskService, IZCodeTaskService>();
const snapshotInflightRequestsByService = new WeakMap<
  IZCodeTaskService,
  Map<string, GetTaskSnapshotResult>
>();
const snapshotCacheByService = new WeakMap<
  IZCodeTaskService,
  Map<string, { etag: string; snapshot: ZCodeTaskSnapshot }>
>();
const SNAPSHOT_CACHE_STORAGE_KEY = "zcode-task-snapshot-cache:v1";
const SNAPSHOT_CACHE_MAX_ENTRY_BYTES = 256 * 1024;
const SNAPSHOT_CACHE_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_CACHE_MAX_ENTRIES = 20;
type PersistedSnapshotCacheEntry = {
  key: string;
  etag: string;
  snapshot: ZCodeTaskSnapshot;
  updatedAt: number;
  sizeBytes: number;
};
let persistedSnapshotCacheLoaded = false;
const persistedSnapshotCache = new Map<string, PersistedSnapshotCacheEntry>();
// 内存诊断计数器：WeakMap 无法枚举，记住最近一个
// service 的内存缓存（renderer 内实际只有一个 task service 实例）。
let latestSnapshotCache: Map<string, { etag: string; snapshot: ZCodeTaskSnapshot }> | undefined;
uiMemoryDiagnosticsRegistry.register("taskSnapshotCache", () => ({
  entries: latestSnapshotCache?.size ?? 0,
  persisted: persistedSnapshotCache.size,
}));

function buildSnapshotDedupeKey(params: GetTaskSnapshotParams): string {
  return [
    params.workspacePath,
    params.workspaceIdentity ?? "",
    params.taskId,
    typeof params.messageLimit === "number" ? String(params.messageLimit) : "",
    typeof params.byteBudget === "number" ? String(params.byteBudget) : "",
    typeof params.toolLimit === "number" ? String(params.toolLimit) : "",
    // desktop continuous 和手机 remote replayable 的 snapshot 可能经过不同恢复逻辑。
    // 缓存 key 必须区分 clientMode，否则会把某一端的快照复用到另一端。
    params.clientMode ?? "desktop-continuous",
    // 手机只读恢复会刻意跳过 task-index 模型回填。
    // 策略不同代表 host 端恢复语义不同，不能共用同一份 snapshot cache。
    params.resumeModelPolicy ?? "task-index",
    // 手机首屏恢复会用历史模型 hint 激活 session。
    // 同一 task 若模型 hint 不同，context window 也可能不同，缓存必须隔离。
    params.model ?? "",
    // replayable snapshot 现在会携带 session settings 投影出的 configOptions。
    // 同一模型下 thoughtLevel 不同也会改变 toolbar 配置和后续发送 hint，不能复用旧快照。
    params.thoughtLevel ?? "",
  ].join("::");
}

function getOrCreateSnapshotInflightMap(
  service: IZCodeTaskService,
): Map<string, GetTaskSnapshotResult> {
  if (!service || typeof service !== "object") {
    return new Map();
  }
  const existing = snapshotInflightRequestsByService.get(service);
  if (existing) {
    return existing;
  }
  const created = new Map<string, GetTaskSnapshotResult>();
  snapshotInflightRequestsByService.set(service, created);
  return created;
}

function getOrCreateSnapshotCacheMap(
  service: IZCodeTaskService,
): Map<string, { etag: string; snapshot: ZCodeTaskSnapshot }> {
  if (!service || typeof service !== "object") {
    return new Map();
  }
  const existing = snapshotCacheByService.get(service);
  if (existing) {
    latestSnapshotCache = existing;
    return existing;
  }
  const created = new Map<string, { etag: string; snapshot: ZCodeTaskSnapshot }>();
  snapshotCacheByService.set(service, created);
  latestSnapshotCache = created;
  return created;
}

function getBrowserStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function ensurePersistedSnapshotCacheLoaded() {
  if (persistedSnapshotCacheLoaded) {
    return;
  }
  persistedSnapshotCacheLoaded = true;
  const storage = getBrowserStorage();
  const raw = storage?.getItem(SNAPSHOT_CACHE_STORAGE_KEY);
  if (!raw) {
    return;
  }

  try {
    const parsed = JSON.parse(raw) as {
      entries?: PersistedSnapshotCacheEntry[];
    };
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    for (const entry of entries) {
      if (
        typeof entry?.key !== "string" ||
        typeof entry?.etag !== "string" ||
        !entry.snapshot ||
        typeof entry.updatedAt !== "number" ||
        typeof entry.sizeBytes !== "number"
      ) {
        continue;
      }
      persistedSnapshotCache.set(entry.key, entry);
    }
  } catch {
    // ignore storage parse errors
  }
}

function flushPersistedSnapshotCache() {
  const storage = getBrowserStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(
      SNAPSHOT_CACHE_STORAGE_KEY,
      JSON.stringify({ entries: [...persistedSnapshotCache.values()] }),
    );
  } catch {
    // ignore storage write errors (quota/private mode)
  }
}

function prunePersistedSnapshotCache() {
  const entries = [...persistedSnapshotCache.values()].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
  const nextEntries: PersistedSnapshotCacheEntry[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (nextEntries.length >= SNAPSHOT_CACHE_MAX_ENTRIES) {
      continue;
    }
    if (totalBytes + entry.sizeBytes > SNAPSHOT_CACHE_MAX_TOTAL_BYTES) {
      continue;
    }
    nextEntries.push(entry);
    totalBytes += entry.sizeBytes;
  }
  persistedSnapshotCache.clear();
  for (const entry of nextEntries) {
    persistedSnapshotCache.set(entry.key, entry);
  }
}

function readPersistedSnapshotEntry(key: string) {
  ensurePersistedSnapshotCacheLoaded();
  const entry = persistedSnapshotCache.get(key);
  if (!entry) {
    return null;
  }
  return { etag: entry.etag, snapshot: entry.snapshot };
}

function writePersistedSnapshotEntry(key: string, etag: string, snapshot: ZCodeTaskSnapshot): void {
  ensurePersistedSnapshotCacheLoaded();
  const serializedSnapshot = JSON.stringify(snapshot);
  const sizeBytes = new TextEncoder().encode(serializedSnapshot).byteLength;
  if (sizeBytes > SNAPSHOT_CACHE_MAX_ENTRY_BYTES) {
    // 大消息 task 的快照若直接写 localStorage，会很快触发配额上限并拖慢主线程。
    // 这里只持久化小体积快照，超限时删除旧缓存，避免“为了加速加载反而造成存储压力”。
    persistedSnapshotCache.delete(key);
    flushPersistedSnapshotCache();
    return;
  }

  persistedSnapshotCache.set(key, {
    key,
    etag,
    snapshot,
    updatedAt: Date.now(),
    sizeBytes,
  });
  prunePersistedSnapshotCache();
  flushPersistedSnapshotCache();
}

function deletePersistedSnapshotEntry(key: string): void {
  ensurePersistedSnapshotCacheLoaded();
  persistedSnapshotCache.delete(key);
  flushPersistedSnapshotCache();
}

function createZCodeTaskServiceProxy(service: IZCodeTaskService): IZCodeTaskService {
  const inflight = getOrCreateSnapshotInflightMap(service);
  const snapshotCache = getOrCreateSnapshotCacheMap(service);

  return new Proxy(service, {
    get(target, prop, receiver) {
      if (prop !== "getTaskSnapshot") {
        return Reflect.get(target, prop, receiver);
      }

      return (params: GetTaskSnapshotParams) => {
        const requestKey = buildSnapshotDedupeKey(params);
        const existing = inflight.get(requestKey);
        if (existing) {
          return existing;
        }
        const cachedSnapshotEntry =
          snapshotCache.get(requestKey) ?? readPersistedSnapshotEntry(requestKey);
        if (cachedSnapshotEntry && !snapshotCache.has(requestKey)) {
          snapshotCache.set(requestKey, cachedSnapshotEntry);
        }

        // 远控首屏恢复时，多个 hook 会并发请求同一 task snapshot，
        // 导致 host 连续执行多次 getTaskSnapshot，并把超大快照重复回传到 relay。
        // 这里按“同一 service + 同一参数”做并发去重，命中时复用同一个 Promise，
        // 保证同一时刻只发起一次 RPC；同时携带 if-none-match，未变化时复用本地缓存快照，
        // 避免重复下发大 JSON。
        const request = (async () => {
          const firstResult = await target.getTaskSnapshotWithEtag({
            ...(params as GetTaskSnapshotWithEtagParams),
            ...(cachedSnapshotEntry?.etag ? { ifNoneMatch: cachedSnapshotEntry.etag } : {}),
          });
          if (firstResult.notModified) {
            if (cachedSnapshotEntry?.snapshot) {
              return cachedSnapshotEntry.snapshot;
            }
            // 仅持久化了 etag 但没有可用快照正文时，不能把 notModified 直接透传给上层，
            // 否则首屏会拿到空数据。这里回退一次“无 if-none-match”硬拉取，确保数据完整性优先。
            const fallbackResult = await target.getTaskSnapshotWithEtag(
              params as GetTaskSnapshotWithEtagParams,
            );
            if (fallbackResult.snapshot && fallbackResult.etag) {
              const nextEntry = {
                etag: fallbackResult.etag,
                snapshot: fallbackResult.snapshot,
              };
              snapshotCache.set(requestKey, nextEntry);
              writePersistedSnapshotEntry(requestKey, fallbackResult.etag, fallbackResult.snapshot);
            }
            return fallbackResult.snapshot;
          }
          if (firstResult.snapshot && firstResult.etag) {
            const nextEntry = {
              etag: firstResult.etag,
              snapshot: firstResult.snapshot,
            };
            snapshotCache.set(requestKey, nextEntry);
            writePersistedSnapshotEntry(requestKey, firstResult.etag, firstResult.snapshot);
          } else if (!firstResult.snapshot) {
            snapshotCache.delete(requestKey);
            deletePersistedSnapshotEntry(requestKey);
          }
          return firstResult.snapshot;
        })().finally(() => {
          if (inflight.get(requestKey) === request) {
            inflight.delete(requestKey);
          }
        });
        inflight.set(requestKey, request);
        return request;
      };
    },
  });
}

/** 获取 ZCode task wrapper 服务实例 */
export function useZCodeTaskService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeTaskService {
  // ZCode task 服务按 workspace 身份解析，保证所有 task RPC 都落到对应的 host。
  const services = workspacePath
    ? useWorkspaceServices(workspacePath, preferredRemoteSessionId, workspaceIdentity)
    : useServices();
  const rawService = services.zcodeTaskService;
  if (!rawService || typeof rawService !== "object") {
    return rawService;
  }
  const cachedProxy = zcodeTaskServiceProxyCache.get(rawService);
  if (cachedProxy) {
    return cachedProxy;
  }
  const nextProxy = createZCodeTaskServiceProxy(rawService);
  zcodeTaskServiceProxyCache.set(rawService, nextProxy);
  return nextProxy;
}
