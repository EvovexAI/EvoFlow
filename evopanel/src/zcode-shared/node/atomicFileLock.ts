import { ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE } from "../errors.js";
import { mkdir, readFile, readdir, rmdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createLockInstanceObserver, type ObserveLockInstance } from "./lockInstanceObserver.js";

const MAX_LOCK_METADATA_CLOCK_SKEW_MS = 5 * 60_000;

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isFileExistsError(error: unknown): boolean {
  return getErrorCode(error) === "EEXIST";
}

interface FileLockMetadata {
  createdAt: number | null;
  pid: number | null;
}

function parseLockTimestamp(value: unknown, observedAt: number): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= observedAt + MAX_LOCK_METADATA_CLOCK_SKEW_MS
    ? value
    : null;
}

function parseLockMetadata(raw: string, observedAt: number): FileLockMetadata {
  try {
    const parsed = JSON.parse(raw) as { createdAt?: unknown; pid?: unknown };
    return {
      // 非有限、负数或明显未来的 createdAt 会让 ownerless 锁永久达不到 stale。
      // 元数据非法时交给调用方回退到同样受校验的文件 mtime。
      createdAt: parseLockTimestamp(parsed.createdAt, observedAt),
      // 0、负数、小数或非有限 PID 传给 process.kill 后可能被误判为活进程，
      // 导致损坏锁永久无法回收。只有操作系统可用的正安全整数才具有 owner 语义。
      pid:
        typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0
          ? parsed.pid
          : null,
    };
  } catch {
    return { createdAt: null, pid: null };
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return getErrorCode(error) !== "ESRCH";
  }
}

interface LockRemovalAttempt {
  removed: boolean;
  error?: unknown;
}

async function isOwnerFileReclaimable(
  ownerFile: string,
  ownerlessGraceMs: number,
  observeLockInstance: ObserveLockInstance,
): Promise<boolean> {
  const observedAt = Date.now();
  const raw = await readFile(ownerFile, "utf-8");
  const metadata = parseLockMetadata(raw, observedAt);
  let createdAt = metadata.createdAt;
  if (createdAt === null) {
    const ownerStat = await stat(ownerFile);
    createdAt =
      parseLockTimestamp(ownerStat.mtimeMs, observedAt) ??
      observeLockInstance(ownerFile, ownerStat, observedAt);
  }
  const ownerExited = metadata.pid !== null && !isProcessAlive(metadata.pid);
  const ownerlessLockIsStale = metadata.pid === null && observedAt - createdAt >= ownerlessGraceMs;
  return ownerExited || ownerlessLockIsStale;
}

async function removeAbandonedLock(
  lockFile: string,
  ownerlessGraceMs: number,
  observeLockInstance: ObserveLockInstance,
): Promise<LockRemovalAttempt> {
  try {
    const lockStat = await stat(lockFile);
    if (lockStat.isDirectory()) {
      const entries = await readdir(lockFile);
      const owners = entries.filter(
        (entry) => entry.startsWith("owner-") && entry.endsWith(".json"),
      );
      if (owners.length === 1) {
        const ownerFile = join(lockFile, owners[0]!);
        if (!(await isOwnerFileReclaimable(ownerFile, ownerlessGraceMs, observeLockInstance))) {
          return { removed: false };
        }

        // 按唯一 owner 文件删除相当于所有权校验。旧锁目录被替换后，新 owner 的
        // 文件名不同，当前 rm 不会命中新锁；随后 rmdir 也会因目录非空而拒绝删除。
        await rm(ownerFile, { force: true });
        await rmdir(lockFile);
        return { removed: true };
      }

      const observedAt = Date.now();
      const directoryTimestamp =
        parseLockTimestamp(lockStat.mtimeMs, observedAt) ??
        observeLockInstance(lockFile, lockStat, observedAt);
      if (observedAt - directoryTimestamp < ownerlessGraceMs) {
        return { removed: false };
      }
      for (const owner of owners) {
        if (
          !(await isOwnerFileReclaimable(
            join(lockFile, owner),
            ownerlessGraceMs,
            observeLockInstance,
          ))
        ) {
          return { removed: false };
        }
      }

      // mkdir 成功后、owner 文件落盘前崩溃会留下空目录；损坏目录也可能
      // 包含多个 owner。只清理 stale 时观察到的条目，后来 owner 新增会让 rmdir 失败。
      await Promise.all(entries.map((entry) => rm(join(lockFile, entry), { force: true })));
      await rmdir(lockFile);
      return { removed: true };
    }

    const raw = await readFile(lockFile, "utf-8");
    if (!(await isOwnerFileReclaimable(lockFile, ownerlessGraceMs, observeLockInstance))) {
      return { removed: false };
    }

    // 兼容升级前遗留的单文件锁。新实现创建的是非空目录，旧路径删除无法移除新 owner。
    if ((await readFile(lockFile, "utf-8")) !== raw) {
      return { removed: false };
    }
    await rm(lockFile, { force: true });
    return { removed: true };
  } catch (error) {
    if (getErrorCode(error) === "ENOENT" || getErrorCode(error) === "ENOTEMPTY") {
      return { removed: false };
    }
    return { removed: false, error };
  }
}

function createFileLockTimeoutError(
  filePath: string,
  lockFile: string,
  waitedMs: number,
  cause?: unknown,
): NodeJS.ErrnoException {
  const error = new Error(
    `Timed out after ${waitedMs}ms waiting for the ZCode file lock: ${lockFile}`,
  ) as NodeJS.ErrnoException & { cause?: unknown };
  error.code = ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE;
  error.path = filePath;
  error.syscall = "mkdir";
  error.cause = cause;
  return error;
}

export async function acquireFileLock(
  filePath: string,
  retryDelaysMs: readonly number[],
  ownerlessGraceMs: number,
  maxWaitMs: number,
): Promise<() => Promise<void>> {
  const lockFile = `${filePath}.lock`;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ownerFile = join(lockFile, `owner-${token}.json`);
  const payload = `${JSON.stringify({
    pid: process.pid,
    createdAt: Date.now(),
    token,
  })}\n`;
  const startedAt = Date.now();
  const effectiveOwnerlessGraceMs = Math.min(
    Math.max(ownerlessGraceMs, 0),
    Math.max(Math.floor(maxWaitMs / 2), 0),
  );
  const observeLockInstance = createLockInstanceObserver();
  let lastRemovalError: unknown;

  for (let attempt = 0; ; attempt += 1) {
    let createdLock = false;
    try {
      await mkdir(lockFile);
      createdLock = true;
      const createdLockStat = await stat(lockFile);
      await writeFile(ownerFile, payload, { encoding: "utf-8", flag: "wx" });
      const currentLockStat = await stat(lockFile);
      const currentOwners = (await readdir(lockFile)).filter(
        (entry) => entry.startsWith("owner-") && entry.endsWith(".json"),
      );
      if (
        currentLockStat.dev !== createdLockStat.dev ||
        currentLockStat.ino !== createdLockStat.ino ||
        currentOwners.length !== 1 ||
        currentOwners[0] !== `owner-${token}.json`
      ) {
        throw Object.assign(new Error("ZCode file lock ownership changed during acquire"), {
          code: "EEXIST",
        });
      }
      return async () => {
        // 只删除本 writer 的唯一 owner 文件；锁已被接管时不会碰到后来 writer 的 token。
        await rm(ownerFile, { force: true }).catch(() => {});
        await rmdir(lockFile).catch(() => {
          // best-effort cleanup
        });
      };
    } catch (error) {
      if (createdLock) {
        await rm(ownerFile, { force: true }).catch(() => {});
        await rmdir(lockFile).catch(() => {});
      }
      const lostCreatedLock = createdLock && getErrorCode(error) === "ENOENT";
      if (!isFileExistsError(error) && !lostCreatedLock) {
        throw error;
      }

      // 等待者自身已等待多久不能证明当前锁 stale，否则旧锁释放后可能误删
      // 后来 writer 的新锁。这里只回收 owner 已退出或无 PID 且超过短 grace 的锁，
      // 其余竞争等待到 maxWaitMs，并保留明确的权限错误或锁超时。
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= maxWaitMs) {
        // 旧顺序会在达到 maxWaitMs 后仍先做一次 stale 回收。
        // 损坏 ownerless 锁可能恰好在这次检查跨过 grace，导致超时 waiter 越过
        // 等待上限删除后来 writer 的锁。达到上限后直接超时，避免跨实例误删。
        const removalErrorCode = getErrorCode(lastRemovalError);
        if (removalErrorCode === "EACCES" || removalErrorCode === "EPERM") {
          throw lastRemovalError;
        }
        throw createFileLockTimeoutError(filePath, lockFile, elapsedMs, error);
      }
      const removalAttempt = await removeAbandonedLock(
        lockFile,
        effectiveOwnerlessGraceMs,
        observeLockInstance,
      );
      if (removalAttempt.removed) {
        continue;
      }
      if (removalAttempt.error) {
        lastRemovalError = removalAttempt.error;
      }

      const remainingMs = Math.max(maxWaitMs - elapsedMs, 0);
      if (retryDelaysMs.length === 0 || remainingMs === 0) {
        const removalErrorCode = getErrorCode(lastRemovalError);
        if (removalErrorCode === "EACCES" || removalErrorCode === "EPERM") {
          throw lastRemovalError;
        }
        throw createFileLockTimeoutError(filePath, lockFile, elapsedMs, lastRemovalError ?? error);
      }

      const retryDelayMs =
        retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)] ?? remainingMs;
      await sleep(Math.min(retryDelayMs, remainingMs));
    }
  }
}
