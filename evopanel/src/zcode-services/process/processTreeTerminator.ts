/* eslint-disable max-lines -- Windows 进程树清理需要集中维护跨阶段的安全边界与 deadline。 */
import type { ChildProcess } from "node:child_process";
import {
  captureProcessGroupSnapshot,
  captureExitedRootDescendantsSnapshot,
} from "#src/process/processTreeSnapshot.js";
import {
  captureExitedRootDescendantsSnapshotAsync,
  captureProcessTreeSnapshotAsync,
  verifyWindowsProcessIdentityAsync,
} from "#src/process/processTreeSnapshotAsync.js";
import {
  resolveCurrentOwnedIdentities,
  resolveCurrentOwnedIdentitiesAsync,
} from "#src/process/processTreeOwnership.js";
import { waitForProcessTreeTermination } from "#src/process/processTreeWaiter.js";
import { defaultWindowsTaskkillRunner } from "#src/process/windowsTaskkillRunner.js";
import type {
  ProcessIdentity,
  ProcessTreeOwnershipResolution,
  ProcessTreeTerminationResult,
  ProcessTreeTerminatorOptions,
  ProcessTreeTerminatorWaitOptions,
} from "#src/process/processTreeTypes.js";

export {
  captureProcessGroupSnapshot,
  captureExitedRootDescendantsSnapshot,
  captureProcessTreeSnapshot,
} from "#src/process/processTreeSnapshot.js";
export {
  captureExitedRootDescendantsSnapshotAsync,
  captureProcessTreeSnapshotAsync,
  filterCurrentProcessIdentitiesAsync,
} from "#src/process/processTreeSnapshotAsync.js";
export type {
  ProcessIdentity,
  ProcessTreeSnapshot,
  ProcessTreeTerminationResult,
  ProcessTreeTerminatorLogger,
  ProcessTreeTerminatorOptions,
  ProcessTreeTerminatorWaitOptions,
  WindowsTaskkillRequest,
  WindowsTaskkillResult,
  WindowsTaskkillRunner,
} from "#src/process/processTreeTypes.js";

const POSIX_TERMINATION_SIGNAL = "SIGTERM";
const POSIX_FORCE_SIGNAL = "SIGKILL";
const WINDOWS_TASKKILL_TIMEOUT_MS = 2_000;
const WINDOWS_FORCE_IDENTITY_RECHECK_BUDGET_MS = 750;
const DEFAULT_FORCE_AFTER_MS = 2_000;

interface InternalProcessTreeTerminatorOptions extends ProcessTreeTerminatorOptions {
  knownIdentities?: readonly ProcessIdentity[];
  onForceCleanup?: (result: ForceCleanupResult) => void;
  onForceTimerScheduled?: (timer: ReturnType<typeof setTimeout>) => void;
  onGracefulCleanupScheduled?: (flight: Promise<void>) => void;
  resolvedOwnership?: ProcessTreeOwnershipResolution;
  /** 进程身份查询失败，只观察原 ChildProcess，禁止向裸 PID 发送 taskkill。 */
  unverifiedRootOnly?: boolean;
}

interface ForceCleanupResult {
  identities: ProcessIdentity[];
  unverifiedRootPid?: number;
}

export function shouldSpawnInDetachedProcessGroup(): boolean {
  return process.platform !== "win32";
}

function warn(options: ProcessTreeTerminatorOptions, message: string, ...args: unknown[]): void {
  options.log?.warn(options.traceId, message, ...args);
}

function debug(options: ProcessTreeTerminatorOptions, message: string, ...args: unknown[]): void {
  options.log?.debug?.(options.traceId, message, ...args);
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isMissingProcessError(error: unknown): boolean {
  return getErrorCode(error) === "ESRCH";
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function scheduleForceCleanup(
  callback: () => void,
  timeoutMs: number,
  keepTimerRef: boolean,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, Math.max(timeoutMs, 0));
  if (!keepTimerRef) {
    timer.unref();
  }
  return timer;
}

function killPid(
  pid: number,
  signal: NodeJS.Signals,
  options: ProcessTreeTerminatorOptions,
): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (!isMissingProcessError(error)) {
      warn(options, `发送 runtime 进程终止信号失败 pid=${pid} signal=${signal}:`, error);
    }
    return false;
  }
}

function killPosixProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  options: ProcessTreeTerminatorOptions,
): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (!isMissingProcessError(error)) {
      warn(options, `发送 runtime 进程组终止信号失败 pgid=${pid} signal=${signal}:`, error);
    }
    return false;
  }
}

async function runWindowsTaskkill(
  pid: number,
  force: boolean,
  options: ProcessTreeTerminatorOptions,
): Promise<void> {
  const timeoutMs = Math.max(options.windowsTaskkillTimeoutMs ?? WINDOWS_TASKKILL_TIMEOUT_MS, 1);
  const runner = options.windowsTaskkillRunner ?? defaultWindowsTaskkillRunner;
  const startedAt = Date.now();
  debug(options, "Windows runtime 进程树 taskkill started", { force, pid, timeoutMs });
  let result;
  try {
    result = await runner({ force, pid, timeoutMs });
  } catch (error) {
    result = { error };
  }
  debug(options, "Windows runtime 进程树 taskkill completed", {
    durationMs: Date.now() - startedAt,
    force,
    pid,
    success: !result.error,
  });
  if (result.error && isPidAlive(pid)) {
    warn(
      options,
      `${force ? "强制清理" : "请求"} runtime 进程树退出失败 pid=${pid} status=${String(
        typeof result.error === "object" && result.error !== null && "code" in result.error
          ? ((result.error as { code?: unknown }).code ?? "unknown")
          : "unknown",
      )}:`,
      result.error,
      result.stderr,
    );
  }
}

async function forceTerminateWindowsProcessTree(
  child: ChildProcess,
  knownIdentities: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
  verifiedOwnership?: ProcessTreeOwnershipResolution,
  deadlineSnapshotOnly = false,
  deadlineVerifiedIdentities: readonly ProcessIdentity[] = [],
): Promise<ForceCleanupResult> {
  const { childStillOwned, currentIdentities } =
    verifiedOwnership ??
    (await resolveCurrentOwnedIdentitiesAsync(child, knownIdentities, options, false));
  // 旧快照和滞后的 Node exitCode 都不能证明 deadline 时 PID 仍属于原进程树。
  // deadline 路径只允许强杀预留窗口内重新核对过 CreationDate 的 root/后代；查询失败的
  // 旧身份继续交给 waiter 报告残留，但绝不作为 /F 目标，避免 PID 复用误杀。
  const targets = new Set(
    deadlineSnapshotOnly
      ? deadlineVerifiedIdentities.map((identity) => identity.pid)
      : currentIdentities.map((identity) => identity.pid),
  );
  const unverifiedRootOnly = (options as InternalProcessTreeTerminatorOptions).unverifiedRootOnly;
  if (childStillOwned && child.pid != null && !unverifiedRootOnly && !deadlineSnapshotOnly) {
    targets.add(child.pid);
  }
  // 定向 CIM 复核超时不应让仍由 ChildProcess 句柄持有的 root 永久残留。
  // 句柄确认 root 仍存活后，taskkill /T 只针对该 root，不会按失效快照认领新 PID。
  if (
    deadlineSnapshotOnly &&
    !unverifiedRootOnly &&
    child.pid != null &&
    typeof child.kill === "function" &&
    child.exitCode === null &&
    child.signalCode === null &&
    isPidAlive(child.pid)
  ) {
    targets.add(child.pid);
  }
  await Promise.all([...targets].map((targetPid) => runWindowsTaskkill(targetPid, true, options)));
  const hasVerifiedRoot = currentIdentities.some((identity) => identity.pid === child.pid);
  return {
    identities: currentIdentities,
    ...(childStillOwned && !hasVerifiedRoot ? { unverifiedRootPid: child.pid } : {}),
  };
}

function terminateWindowsProcessTreeWithOwnership(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions,
  ownership: ProcessTreeOwnershipResolution,
  startedAtMs: number,
): void {
  const pid = child.pid!;
  const internalOptions = options as InternalProcessTreeTerminatorOptions;
  const childHandleOwnsLiveRoot =
    !internalOptions.unverifiedRootOnly &&
    typeof child.kill === "function" &&
    child.exitCode === null &&
    child.signalCode === null &&
    isPidAlive(pid);
  const gracefulTargets =
    ownership.childStillOwned && !internalOptions.unverifiedRootOnly
      ? [pid]
      : ownership.currentIdentities.map((identity) => identity.pid);
  // CIM 查询在系统高负载下可能超过一次 cleanup deadline，但仍存活的
  // ChildProcess 句柄可以证明 root 属于当前 Host。此时允许用 root /T 作为安全兜底，
  // 只扩大到该句柄对应的活进程，不沿裸 PID 重新发现或认领进程树。
  if (gracefulTargets.length === 0 && childHandleOwnsLiveRoot) gracefulTargets.push(pid);
  const gracefulFlight = Promise.all(
    [...new Set(gracefulTargets)].map((targetPid) => runWindowsTaskkill(targetPid, false, options)),
  ).then(() => undefined);
  // 等待式清理过去把 graceful taskkill fire-and-forget 后只等 force 窗口，
  // taskkill callback/ChildProcess exit 稍晚到达时会把正常退出误报为 remaining PID。
  // 非等待式调用仍不 await；等待式 waiter 通过回调把同一 flight 纳入完成屏障。
  internalOptions.onGracefulCleanupScheduled?.(gracefulFlight);
  void gracefulFlight;
  const forceDelayMs = Math.max(
    (options.forceAfterMs ?? DEFAULT_FORCE_AFTER_MS) - (Date.now() - startedAtMs),
    0,
  );
  const identitiesToRecheck = ownership.currentIdentities.filter(
    (identity) => !internalOptions.unverifiedRootOnly || identity.pid !== pid,
  );
  const canRecheckIdentitiesWithinDeadline =
    identitiesToRecheck.length > 0 && forceDelayMs >= WINDOWS_FORCE_IDENTITY_RECHECK_BUDGET_MS;
  const forceTimer = scheduleForceCleanup(
    () => {
      // 非等待式关闭不会注入观察回调；强制回收必须先独立执行，
      // 不能作为 optional call 的参数，否则回调缺失时参数也不会求值。
      void (async () => {
        // 只定向复核并强杀 root 是不够的：当 graceful /T 失败或后代已经
        // reparent 时，已知 MCP/runtime 后代永远没有 force flight。这里在 force 前预留的
        // 同一份预算内并发复核所有已知身份，不增加总 deadline；每个 PID 只有 CreationDate
        // 本次仍匹配才进入 /F，查询失败继续 fail-closed。
        const deadlineVerifiedIdentities = canRecheckIdentitiesWithinDeadline
          ? (
              await Promise.all(
                identitiesToRecheck.map(async (identity) =>
                  (await verifyWindowsProcessIdentityAsync(
                    identity,
                    WINDOWS_FORCE_IDENTITY_RECHECK_BUDGET_MS,
                    options,
                  ))
                    ? identity
                    : undefined,
                ),
              )
            ).filter((identity): identity is ProcessIdentity => identity !== undefined)
          : [];
        return await forceTerminateWindowsProcessTree(
          child,
          ownership.knownIdentities,
          options,
          ownership,
          true,
          deadlineVerifiedIdentities,
        );
      })().then((result) => internalOptions.onForceCleanup?.(result));
    },
    canRecheckIdentitiesWithinDeadline
      ? forceDelayMs - WINDOWS_FORCE_IDENTITY_RECHECK_BUDGET_MS
      : forceDelayMs,
    Boolean(options.keepForceTimerRef),
  );
  internalOptions.onForceTimerScheduled?.(forceTimer);
}

function terminateWindowsProcessTree(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions,
): void {
  const internalOptions = options as InternalProcessTreeTerminatorOptions;
  const startedAtMs = Date.now();
  if (internalOptions.resolvedOwnership) {
    terminateWindowsProcessTreeWithOwnership(
      child,
      options,
      internalOptions.resolvedOwnership,
      startedAtMs,
    );
    return;
  }
  void resolveCurrentOwnedIdentitiesAsync(
    child,
    internalOptions.knownIdentities ?? [],
    options,
  ).then((ownership) => {
    terminateWindowsProcessTreeWithOwnership(child, options, ownership, startedAtMs);
  });
}

function forceTerminatePosixProcessTree(
  child: ChildProcess,
  knownIdentities: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
): ForceCleanupResult {
  const pid = child.pid!;
  const { childStillOwned, currentIdentities } = resolveCurrentOwnedIdentities(
    child,
    knownIdentities,
    options,
    false,
  );
  const canSignalOwnedGroup =
    childStillOwned || currentIdentities.some((identity) => identity.processGroupId === pid);
  if (canSignalOwnedGroup) {
    killPosixProcessGroup(pid, POSIX_FORCE_SIGNAL, options);
  }
  for (const identity of currentIdentities.toReversed()) {
    if (identity.pid !== pid) {
      killPid(identity.pid, POSIX_FORCE_SIGNAL, options);
    }
  }
  if (!canSignalOwnedGroup) {
    const rootIdentity = currentIdentities.find((identity) => identity.pid === pid);
    if (rootIdentity) {
      killPid(rootIdentity.pid, POSIX_FORCE_SIGNAL, options);
    }
  }
  const hasVerifiedRoot = currentIdentities.some((identity) => identity.pid === pid);
  return {
    identities: currentIdentities,
    ...(childStillOwned && !hasVerifiedRoot ? { unverifiedRootPid: pid } : {}),
  };
}

function terminatePosixProcessTree(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions,
): void {
  const pid = child.pid!;
  const internalOptions = options as InternalProcessTreeTerminatorOptions;
  const ownership =
    internalOptions.resolvedOwnership ??
    resolveCurrentOwnedIdentities(child, internalOptions.knownIdentities ?? [], options);
  const canSignalOwnedGroup =
    ownership.childStillOwned ||
    ownership.currentIdentities.some((identity) => identity.processGroupId === pid);
  const signaledProcessGroup = canSignalOwnedGroup
    ? killPosixProcessGroup(pid, POSIX_TERMINATION_SIGNAL, options)
    : false;

  // detached runtime/MCP 后代不在 root 进程组内；只对创建标识仍匹配的
  // 生前快照成员发信号，避免延迟回收把复用后的同 PID 进程当成旧后代误杀。
  for (const identity of ownership.currentIdentities) {
    if (identity.pid !== pid) {
      killPid(identity.pid, POSIX_TERMINATION_SIGNAL, options);
    }
  }
  if (!signaledProcessGroup && ownership.childStillOwned) {
    killPid(pid, POSIX_TERMINATION_SIGNAL, options);
  }

  const forceTimer = scheduleForceCleanup(
    () => {
      // 非等待式关闭不会注入观察回调；强制回收必须先独立执行，
      // 不能作为 optional call 的参数，否则回调缺失时参数也不会求值。
      const result = forceTerminatePosixProcessTree(child, ownership.knownIdentities, options);
      internalOptions.onForceCleanup?.(result);
    },
    options.forceAfterMs ?? DEFAULT_FORCE_AFTER_MS,
    Boolean(options.keepForceTimerRef),
  );
  internalOptions.onForceTimerScheduled?.(forceTimer);
}

export function terminateProcessTree(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions = {},
): void {
  if (child.pid == null) {
    // 测试替身或极早期 spawn 失败场景可能拿不到 pid。
    // 这时无法按进程组/进程树兜底，但仍保留旧的 child.kill() 关闭语义。
    try {
      child.kill(POSIX_TERMINATION_SIGNAL);
    } catch (error) {
      warn(options, "发送 runtime 进程终止信号失败 pid=unknown:", error);
    }
    return;
  }

  if (process.platform === "win32") {
    terminateWindowsProcessTree(child, options);
    return;
  }
  terminatePosixProcessTree(child, options);
}

export async function terminateProcessTreeAndWait(
  child: ChildProcess,
  options: ProcessTreeTerminatorWaitOptions = {},
): Promise<ProcessTreeTerminationResult> {
  if (child.pid == null) return { remainingPids: [] };
  const cleanupSnapshot =
    options.snapshot?.rootPid === child.pid
      ? options.snapshot
      : options.ownedProcessGroupId === child.pid
        ? captureProcessGroupSnapshot(options.ownedProcessGroupId, options)
        : process.platform === "win32"
          ? await captureExitedRootDescendantsSnapshotAsync(child.pid, options)
          : captureExitedRootDescendantsSnapshot(child.pid, options);
  const snapshotIdentities = cleanupSnapshot?.identities ?? [];
  const identityVerificationUnavailable = cleanupSnapshot?.identityVerification === "unavailable";
  // 刚取得的异步快照已经固定了 Windows 创建标识，避免在 EOF 前立刻重复执行一次
  // 代价较高的 CIM 查询。force 阶段仍会异步复核身份，防止 PID 复用误杀。
  const initialOwnership =
    process.platform === "win32" &&
    cleanupSnapshot &&
    child.exitCode === null &&
    child.signalCode === null
      ? {
          // 查询失败不等于进程不存在。保留未验证 root 让 waiter 在整个
          // 有界预算内观察 ChildProcess，并在仍存活时通过 remainingPids 报告失败。
          childStillOwned:
            identityVerificationUnavailable ||
            snapshotIdentities.some((identity) => identity.pid === child.pid),
          currentIdentities: [...snapshotIdentities],
          knownIdentities: [...snapshotIdentities],
        }
      : await resolveCurrentOwnedIdentitiesAsync(child, snapshotIdentities, options);
  return await waitForProcessTreeTermination(
    child,
    identityVerificationUnavailable
      ? ({ ...options, unverifiedRootOnly: true } as ProcessTreeTerminatorWaitOptions)
      : options,
    initialOwnership,
    // 身份查询失败且没有已验证 identity 时，terminator 的 graceful/force
    // targets 都为空。只有存在真实信号目标才为 taskkill flight 预留命令超时；其余
    // 情况保持完整预算，禁止按 Promise 的瞬时 settle 状态激进缩短边界。
    initialOwnership.currentIdentities.length > 0 ||
      (!identityVerificationUnavailable && initialOwnership.childStillOwned),
    terminateProcessTree,
  );
}
