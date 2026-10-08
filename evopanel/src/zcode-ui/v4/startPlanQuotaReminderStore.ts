import { logger } from "@/logger.js";

const PREFIX = "zcode:start-plan-reminder:v1:";
interface RecordEntry {
  expiresAt: number;
  owner: object | null;
}

/** 10% 提醒记录唯一 owner；已展示事实持久化，当前展示实例只留在内存。 */
function createStartPlanQuotaReminderStore(
  options: {
    storage?: () => Storage | null;
  } = {},
) {
  const entries = new Map<string, RecordEntry>();
  const listeners = new Set<() => void>();
  let version = 0;
  function storage(): Storage | null {
    try {
      return options.storage
        ? options.storage()
        : typeof window === "undefined"
          ? null
          : window.localStorage;
    } catch {
      return null;
    }
  }
  function emit() {
    version += 1;
    for (const listener of listeners) listener();
  }
  // 修复：设备时间可能已越过服务端周期，必须与候选桶共用快照时间。
  function read(key: string, referenceTime: number): RecordEntry | undefined {
    const cached = entries.get(key);
    if (cached && cached.expiresAt > referenceTime) return cached;
    entries.delete(key);
    try {
      const expiresAt = Number(storage()?.getItem(PREFIX + key));
      if (Number.isFinite(expiresAt) && expiresAt > referenceTime) {
        const entry = { expiresAt, owner: null };
        entries.set(key, entry);
        return entry;
      }
    } catch {
      /* 存储损坏或禁用时仍可使用当前 Renderer 的内存记录。 */
    }
    return undefined;
  }
  function prune(referenceTime: number) {
    for (const [key, entry] of entries) if (entry.expiresAt <= referenceTime) entries.delete(key);
    try {
      const target = storage();
      if (!target) return;
      for (let index = target.length - 1; index >= 0; index--) {
        const key = target.key(index);
        if (key?.startsWith(PREFIX) && !(Number(target.getItem(key)) > referenceTime))
          target.removeItem(key);
      }
    } catch {
      /* 清理失败不影响显示和内存去重。 */
    }
  }
  return {
    isHidden(key: string, owner: object, referenceTime: number): boolean {
      const entry = read(key, referenceTime);
      return Boolean(entry && entry.owner !== owner);
    },
    markShown(key: string, expiresAt: number, owner: object, referenceTime: number): void {
      if (
        !key ||
        !Number.isFinite(expiresAt) ||
        !Number.isFinite(referenceTime) ||
        expiresAt <= referenceTime ||
        read(key, referenceTime)
      )
        return;
      prune(referenceTime);
      entries.set(key, { expiresAt, owner });
      try {
        storage()?.setItem(PREFIX + key, String(expiresAt));
      } catch {
        logger.debug("start plan reminder persistence unavailable");
      }
      logger.debug("start plan bucket reminder shown", { key });
      emit();
    },
    dismiss(key: string): void {
      // 已展示事实不由关闭时的墙钟重新裁决；这里只释放当前展示 owner。
      const entry = entries.get(key);
      if (!entry || entry.owner === null) return;
      entry.owner = null;
      logger.debug("start plan bucket reminder dismissed", { key });
      emit();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => version,
  };
}

export const startPlanQuotaReminderStore = createStartPlanQuotaReminderStore();
