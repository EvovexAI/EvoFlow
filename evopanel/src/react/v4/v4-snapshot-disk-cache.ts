/**
 * V4 投影本地缓存：从未打开 / keep-warm 过期后仍能先画一帧，再等 subscribe 校准。
 * 对齐「零延迟体感」——不能消灭服务端 hydrate，但首屏不必白等。
 */
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";

const DB_NAME = "evoflow-v4-snap";
const STORE = "snapshots";
const DB_VERSION = 1;
/** 单条最多保留的窗口行（防 IDB 撑爆）。 */
const MAX_WINDOW_ROWS = 120;
/** 最多缓存多少个 thread。 */
const MAX_ENTRIES = 24;
const WRITE_DEBOUNCE_MS = 1_200;

type CacheEntry = {
  threadId: string;
  at: number;
  /** 瘦身后的快照（截尾窗）。 */
  snapshot: ConversationSnapshot;
};

const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const memoryFallback = new Map<string, CacheEntry>();

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => resolve(null);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "threadId" });
        }
      };
      req.onsuccess = () => resolve(req.result);
    } catch {
      resolve(null);
    }
  });
}

function slimSnapshot(snapshot: ConversationSnapshot): ConversationSnapshot {
  const window = Array.isArray(snapshot.rows?.window) ? snapshot.rows.window : [];
  const trimmed =
    window.length > MAX_WINDOW_ROWS ? window.slice(-MAX_WINDOW_ROWS) : window;
  return {
    ...snapshot,
    rows: {
      ...snapshot.rows,
      window: trimmed,
      totalCount: snapshot.rows?.totalCount ?? trimmed.length,
    },
  };
}

async function idbPut(entry: CacheEntry): Promise<void> {
  const db = await openDb();
  if (!db) {
    memoryFallback.set(entry.threadId, entry);
    return;
  }
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  // LRU 裁剪
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const allReq = store.getAll();
    allReq.onsuccess = () => {
      const rows = (allReq.result || []) as CacheEntry[];
      if (rows.length <= MAX_ENTRIES) return;
      rows
        .sort((a, b) => a.at - b.at)
        .slice(0, rows.length - MAX_ENTRIES)
        .forEach((r) => store.delete(r.threadId));
    };
  } catch {
    /* ignore */
  }
}

async function idbGet(threadId: string): Promise<CacheEntry | null> {
  const db = await openDb();
  if (!db) return memoryFallback.get(threadId) || null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(threadId);
      req.onsuccess = () => resolve((req.result as CacheEntry) || null);
      req.onerror = () => resolve(memoryFallback.get(threadId) || null);
    } catch {
      resolve(memoryFallback.get(threadId) || null);
    }
  });
}

/** 有真快照时防抖写入（流式每帧不打盘）。 */
export function scheduleV4SnapshotDiskCache(
  threadId: string,
  snapshot: ConversationSnapshot | null | undefined,
): void {
  const id = String(threadId || "").trim();
  if (!id || !snapshot) return;
  const prev = writeTimers.get(id);
  if (prev) clearTimeout(prev);
  writeTimers.set(
    id,
    setTimeout(() => {
      writeTimers.delete(id);
      const entry: CacheEntry = {
        threadId: id,
        at: Date.now(),
        snapshot: slimSnapshot(snapshot),
      };
      memoryFallback.set(id, entry);
      void idbPut(entry);
    }, WRITE_DEBOUNCE_MS),
  );
}

/** 冷开前读盘：命中则立刻 sticky 可画。 */
export async function loadV4SnapshotDiskCache(
  threadId: string,
): Promise<ConversationSnapshot | null> {
  const id = String(threadId || "").trim();
  if (!id) return null;
  const mem = memoryFallback.get(id);
  if (mem?.snapshot) return mem.snapshot;
  const hit = await idbGet(id);
  if (!hit?.snapshot) return null;
  memoryFallback.set(id, hit);
  return hit.snapshot;
}
