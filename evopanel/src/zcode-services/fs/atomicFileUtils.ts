import { mkdir, writeFile, rename, rm, readdir, stat } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { acquireFileLock } from "@zcode/shared/node";
import { isInjectedFsFaultError, maybeThrowInjectedFsFault } from "./fsFaultInjection.js";

const DEFAULT_RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1600, 3200] as const;
const DEFAULT_LOCK_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;
const DEFAULT_LOCK_OWNERLESS_GRACE_MS = 100;
const DEFAULT_LOCK_MAX_WAIT_MS = 8_000;
const DEFAULT_TEMP_FILE_STALE_MS = 60_000;

interface AtomicWriteTextOptions {
  renameRetryDelaysMs?: readonly number[];
  lockRetryDelaysMs?: readonly number[];
  lockOwnerlessGraceMs?: number;
  lockMaxWaitMs?: number;
  tempFileStaleMs?: number;
  useFileLock?: boolean;
  beforeRename?: () => void | Promise<void>;
  runRename?: (renameFile: () => Promise<void>) => Promise<void>;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isRetryableAtomicRenameError(error: unknown): boolean {
  if (isInjectedFsFaultError(error)) {
    return false;
  }
  const code = getErrorCode(error);
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

async function renameWithRetry(
  tempFile: string,
  filePath: string,
  retryDelaysMs: readonly number[] = DEFAULT_RENAME_RETRY_DELAYS_MS,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      maybeThrowInjectedFsFault({ operation: "rename", path: filePath });
      await rename(tempFile, filePath);
      return;
    } catch (error) {
      const retryDelayMs = retryDelaysMs[attempt];
      if (retryDelayMs === undefined || !isRetryableAtomicRenameError(error)) {
        throw error;
      }

      await sleep(retryDelayMs);
    }
  }
}

async function cleanupStaleTempFilesForTarget(
  filePath: string,
  excludeTempFile: string,
  staleMs: number,
): Promise<void> {
  const dir = dirname(filePath);
  const targetBasename = basename(filePath);
  const tempPrefix = `${targetBasename}.`;
  const now = Date.now();

  try {
    const entries = await readdir(dir);
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.startsWith(tempPrefix) || !entry.endsWith(".tmp")) {
          return;
        }

        const tempPath = join(dir, entry);
        if (tempPath === excludeTempFile) {
          return;
        }

        try {
          const info = await stat(tempPath);
          if (now - info.mtimeMs < staleMs) {
            return;
          }
          await rm(tempPath, { force: true });
        } catch {
          // best-effort cleanup
        }
      }),
    );
  } catch {
    // best-effort cleanup
  }
}

/**
 * 使用临时文件 + rename 实现原子写入。
 * rename 在同文件系统上是原子的，可避免 read-modify-write 并发时的数据覆盖风险。
 * 临时文件写在目标文件同目录下，避免 Windows 跨卷 rename 失败。
 */
export async function atomicWriteText(
  filePath: string,
  content: string,
  options?: AtomicWriteTextOptions,
): Promise<void> {
  const dir = dirname(filePath);
  const tempFile = join(
    dir,
    `${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  maybeThrowInjectedFsFault({ operation: "mkdir", path: dir });
  await mkdir(dir, { recursive: true });
  // Windows 上多个窗口/host process 可能同时保存同一个 task JSON，
  // 进程内 writeChains 无法覆盖这种抢写，最终在 rename 替换目标文件时高频 EPERM。
  // 这里用同目录 lock 文件做 ZCode 进程间协作串行化，再保留 rename 重试处理杀软/索引器的短暂占用。
  const releaseLock =
    options?.useFileLock === false
      ? null
      : await acquireFileLock(
          filePath,
          options?.lockRetryDelaysMs ?? DEFAULT_LOCK_RETRY_DELAYS_MS,
          options?.lockOwnerlessGraceMs ?? DEFAULT_LOCK_OWNERLESS_GRACE_MS,
          options?.lockMaxWaitMs ?? DEFAULT_LOCK_MAX_WAIT_MS,
        );
  try {
    // 旧版本或崩溃后的失败 rename 会留下 config.json.*.tmp。
    // 只清理同一目标文件且超过阈值的临时文件，避免误删另一个进程刚创建的 active temp。
    await cleanupStaleTempFilesForTarget(
      filePath,
      tempFile,
      options?.tempFileStaleMs ?? DEFAULT_TEMP_FILE_STALE_MS,
    );
    maybeThrowInjectedFsFault({ operation: "writeFile", path: tempFile });
    await writeFile(tempFile, content, "utf-8");
    await options?.beforeRename?.();
    // Windows Defender、索引服务或另一个窗口可能短暂占用目标 JSON，
    // 导致原子替换 rename 抛 EPERM/EBUSY/EACCES。这里只对这类临时锁做短暂重试，
    // 仍然把真实权限问题原样抛出，避免静默丢失会话快照。
    const renameFile = () => renameWithRetry(tempFile, filePath, options?.renameRetryDelaysMs);
    if (options?.runRename) {
      await options.runRename(renameFile);
    } else {
      await renameFile();
    }
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => {
      // best-effort cleanup
    });
    throw error;
  } finally {
    await releaseLock?.();
  }
}

export async function atomicWriteJson(
  filePath: string,
  data: Record<string, unknown>,
  options?: AtomicWriteTextOptions,
): Promise<void> {
  await atomicWriteText(filePath, JSON.stringify(data, null, 2), options);
}
