import type { Stats } from "node:fs";

export type ObserveLockInstance = (lockPath: string, lockStat: Stats, observedAt: number) => number;

export function createLockInstanceObserver(): ObserveLockInstance {
  const observations = new Map<string, { firstObservedAt: number; identity: string }>();

  return (lockPath, lockStat, observedAt) => {
    const identity = [lockStat.dev, lockStat.ino, lockStat.birthtimeMs, lockStat.mtimeMs].join(":");
    const previous = observations.get(lockPath);
    if (previous?.identity === identity) {
      return previous.firstObservedAt;
    }

    // 双重非法时间戳只能从当前锁实例首次被看见时起算 grace。
    // 锁被后来 writer 替换后必须重置，不能继承等待者在旧锁上的等待时长。
    observations.set(lockPath, { firstObservedAt: observedAt, identity });
    return observedAt;
  };
}
