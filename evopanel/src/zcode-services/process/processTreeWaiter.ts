import type { ChildProcess } from "node:child_process";
import type {
  ProcessIdentity,
  ProcessTreeOwnershipResolution,
  ProcessTreeTerminationResult,
  ProcessTreeTerminatorOptions,
  ProcessTreeTerminatorWaitOptions,
} from "#src/process/processTreeTypes.js";

const DEFAULT_FORCE_AFTER_MS = 2_000;
const DEFAULT_WAIT_AFTER_FORCE_MS = 250;
const DEFAULT_WINDOWS_TASKKILL_TIMEOUT_MS = 2_000;
const WINDOWS_LATE_EXIT_OBSERVATION_MS = 750;

interface WaitInternalOptions extends ProcessTreeTerminatorWaitOptions {
  knownIdentities?: readonly ProcessIdentity[];
  onForceCleanup?: (result: ForceCleanupResult) => void;
  onForceTimerScheduled?: (timer: ReturnType<typeof setTimeout>) => void;
  onGracefulCleanupScheduled?: (flight: Promise<void>) => void;
  resolvedOwnership?: ProcessTreeOwnershipResolution;
}

interface ForceCleanupResult {
  identities: ProcessIdentity[];
  unverifiedRootPid?: number;
}

type TerminateProcessTree = (child: ChildProcess, options: ProcessTreeTerminatorOptions) => void;

function warn(options: ProcessTreeTerminatorWaitOptions, message: string): void {
  options.log?.warn(options.traceId, message);
}

function debug(
  options: ProcessTreeTerminatorWaitOptions,
  message: string,
  context?: Record<string, unknown>,
): void {
  options.log?.debug?.(options.traceId, message, context);
}

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForProcessTreeTermination(
  child: ChildProcess,
  options: ProcessTreeTerminatorWaitOptions,
  initialOwnership: ProcessTreeOwnershipResolution,
  hasWindowsTaskkillTargets: boolean,
  terminateProcessTree: TerminateProcessTree,
): Promise<ProcessTreeTerminationResult> {
  if (child.pid == null) {
    return { remainingPids: [] };
  }

  const waiterStartedAtMs = Date.now();
  const forceAfterMs = Math.max(options.forceAfterMs ?? DEFAULT_FORCE_AFTER_MS, 0);
  const waitAfterForceMs = Math.max(options.waitAfterForceMs ?? DEFAULT_WAIT_AFTER_FORCE_MS, 0);
  const isWindows = process.platform === "win32";
  const windowsTaskkillBudgetMs = hasWindowsTaskkillTargets
    ? Math.max(options.windowsTaskkillTimeoutMs ?? DEFAULT_WINDOWS_TASKKILL_TIMEOUT_MS, 1)
    : 0;
  // Windows 的 graceful taskkill 与 force timer 并发；只要存在已验证信号目标，就保守地
  // 保留一份终态 taskkill 上限。身份不可用且目标集为空时，两条 taskkill flight 都必然
  // 为空，继续预留命令超时只会让 Host 在无法执行任何动作的状态下白等。
  const windowsRelativeDeadlineMs = forceAfterMs + windowsTaskkillBudgetMs + waitAfterForceMs;
  const windowsTransportDeadlineRemainingMs =
    options.windowsCleanupDeadlineAtMs === undefined
      ? windowsRelativeDeadlineMs
      : Math.max(options.windowsCleanupDeadlineAtMs - waiterStartedAtMs, 0);
  // transport 只扣减 forceAfterMs 时，慢 CIM 一旦耗尽 2s force 窗口，waiter
  // 会重新追加完整 taskkill + exit 宽限，导致总 cleanup 突破 Host 3.5s phase。这里把
  // waiter 相对边界夹在 transport 从 cleanup 起点固定的绝对边界内；扣减只来自确定的
  // wall-clock 消耗，不依赖 Promise 的瞬时 settle 状态。
  // 最终重试无法取得可验证身份时没有 taskkill 目标，不能把 transport
  // 尚余的观察预算压缩成 waitAfterForceMs（生产为 250ms），把随后 code=0 的 exit
  // 误报成持久残留。此路径不发送裸 PID 信号，只在既有绝对 deadline 内继续观察；
  // 750ms 上限同时保证新增的纯观察路径与首次 3.25s cleanup 组合不突破 4s 强杀点。
  const windowsObservationDeadlineMs = Math.max(
    windowsRelativeDeadlineMs,
    WINDOWS_LATE_EXIT_OBSERVATION_MS,
  );
  const windowsCleanupDeadlineMs =
    !hasWindowsTaskkillTargets && options.windowsCleanupDeadlineAtMs !== undefined
      ? Math.min(windowsObservationDeadlineMs, windowsTransportDeadlineRemainingMs)
      : Math.min(windowsRelativeDeadlineMs, windowsTransportDeadlineRemainingMs);
  const knownIdentities = initialOwnership.knownIdentities;

  // 根 child 退出不代表 detached MCP 已退出；等待边界只使用生前快照。
  // 强杀回调会用已复核身份替换跟踪集，禁止等待或重新认领裸 PID。
  return await new Promise<ProcessTreeTerminationResult>((resolve) => {
    let settled = false;
    let trackedIdentities = initialOwnership.currentIdentities;
    let unverifiedRootPid =
      initialOwnership.childStillOwned &&
      !trackedIdentities.some((identity) => identity.pid === child.pid)
        ? child.pid
        : undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let forceWaitTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let treePollTimer: ReturnType<typeof setInterval> | undefined;

    const cleanup = () => {
      child.off?.("exit", onExit);
      if (forceTimer) clearTimeout(forceTimer);
      if (forceWaitTimer) clearTimeout(forceWaitTimer);
      if (cleanupDeadlineTimer) clearTimeout(cleanupDeadlineTimer);
      if (treePollTimer) clearInterval(treePollTimer);
      forceTimer = undefined;
      forceWaitTimer = undefined;
      cleanupDeadlineTimer = undefined;
      treePollTimer = undefined;
    };
    const settle = (remainingPids: number[] = []) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ remainingPids });
    };
    const settleIfTreeExited = () => {
      const hasRunningVerifiedProcess = trackedIdentities.some((identity) =>
        isPidAlive(identity.pid),
      );
      const hasRunningUnverifiedRoot =
        unverifiedRootPid !== undefined && !hasChildExited(child) && isPidAlive(unverifiedRootPid);
      if (!hasRunningVerifiedProcess && !hasRunningUnverifiedRoot) {
        // Windows 的 taskkill callback 可能先于 Node ChildProcess exit 事件。
        // OS 已无 PID 时继续等一轮 exit 投递，避免 transport/lifecycle 在清理 Promise
        // 返回后仍看见旧状态；若 exit 丢失，绝对 deadline 仍会按 OS 事实成功收口。
        if (isWindows && !hasChildExited(child)) return;
        settle();
      }
    };
    const startTreePolling = () => {
      if (!treePollTimer && !settled) {
        treePollTimer = setInterval(settleIfTreeExited, 25);
      }
    };
    const collectRemainingPids = (): number[] => {
      const remainingPids = trackedIdentities
        .filter((identity) => isPidAlive(identity.pid))
        .map((identity) => identity.pid);
      if (
        unverifiedRootPid !== undefined &&
        !hasChildExited(child) &&
        isPidAlive(unverifiedRootPid)
      ) {
        remainingPids.push(unverifiedRootPid);
      }
      return remainingPids;
    };
    const onExit = () => {
      unverifiedRootPid = undefined;
      // Windows exit 回调中同步刷新 CIM 进程表会再次阻塞 Host deadline。
      // 此处只观察已固定身份 PID 是否仍存活；真正发送 force 前仍会复核创建标识。
      settleIfTreeExited();
      if (!settled) startTreePolling();
    };
    const scheduleForceWait = () => {
      if (forceWaitTimer || settled) return;
      if (waitAfterForceMs === 0) {
        settle(collectRemainingPids());
        return;
      }
      forceWaitTimer = setTimeout(() => {
        const remainingPids = collectRemainingPids();
        if (remainingPids.length > 0) {
          warn(options, `runtime 进程树强制回收后仍有残留 pid=${remainingPids.join(",")}`);
        }
        settle(remainingPids);
      }, waitAfterForceMs);
    };
    const scheduleWindowsCleanupDeadline = () => {
      if (!isWindows || cleanupDeadlineTimer || settled) return;
      debug(options, "Windows runtime 进程树 cleanup deadline scheduled", {
        forceAfterMs,
        hasWindowsTaskkillTargets,
        waitAfterForceMs,
        windowsRelativeDeadlineMs,
        windowsTaskkillBudgetMs,
        windowsCleanupDeadlineMs,
        windowsCleanupDeadlineAtMs: options.windowsCleanupDeadlineAtMs,
      });
      cleanupDeadlineTimer = setTimeout(() => {
        const remainingPids = collectRemainingPids();
        if (remainingPids.length > 0) {
          warn(options, `runtime 进程树绝对 deadline 后仍有残留 pid=${remainingPids.join(",")}`);
        }
        settle(remainingPids);
      }, windowsCleanupDeadlineMs);
    };
    const onForceCleanup = (result: ForceCleanupResult) => {
      debug(options, "Windows runtime 进程树 force cleanup completed", {
        trackedPids: result.identities.map((identity) => identity.pid),
        unverifiedRootPid: result.unverifiedRootPid,
      });
      // 这里必须替换而不是合并：旧快照身份可能已经失效，继续保留会把新进程
      // 错当成残留，并让后续等待/日志失去进程所有权语义。
      trackedIdentities = result.identities;
      unverifiedRootPid = result.unverifiedRootPid;
      settleIfTreeExited();
      if (!settled) {
        startTreePolling();
        if (!isWindows) scheduleForceWait();
      }
    };

    child.once("exit", onExit);
    const waitOptions: WaitInternalOptions = {
      ...options,
      forceAfterMs,
      keepForceTimerRef: true,
      knownIdentities,
      resolvedOwnership: initialOwnership,
      onForceCleanup,
      onForceTimerScheduled: (timer) => {
        forceTimer = timer;
      },
      onGracefulCleanupScheduled: (flight) => {
        // runner 自身有 timeout 且 runWindowsTaskkill 会把 rejection 归一化；无论命令结果，
        // flight settle 后都重新观察 OS/ChildProcess 事实，最终失败仍由绝对 deadline 决定。
        void flight.then(() => {
          debug(options, "Windows runtime 进程树 graceful cleanup flight settled");
          settleIfTreeExited();
          if (!settled) startTreePolling();
        });
      },
    };
    scheduleWindowsCleanupDeadline();
    terminateProcessTree(child, waitOptions);

    settleIfTreeExited();
    if (!settled && hasChildExited(child)) {
      startTreePolling();
    }
  });
}
