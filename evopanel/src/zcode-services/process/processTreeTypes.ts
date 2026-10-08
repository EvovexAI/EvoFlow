import type { TraceId } from "@zcode/shared";

export interface ProcessTreeTerminatorLogger {
  debug?: (traceId: TraceId | undefined, ...args: unknown[]) => void;
  warn: (traceId: TraceId | undefined, ...args: unknown[]) => void;
}

export interface WindowsTaskkillRequest {
  force: boolean;
  pid: number;
  timeoutMs: number;
}

export interface WindowsTaskkillResult {
  error?: unknown;
  stderr?: string;
}

export type WindowsTaskkillRunner = (
  request: WindowsTaskkillRequest,
) => Promise<WindowsTaskkillResult>;

export interface ProcessTreeTerminatorOptions {
  traceId?: TraceId;
  log?: ProcessTreeTerminatorLogger;
  forceAfterMs?: number;
  keepForceTimerRef?: boolean;
  /** POSIX Host 在 spawn(detached=true) 时拥有的独立进程组；仅用于 cleanup 边界。 */
  ownedProcessGroupId?: number;
  /** Windows Host 发起 spawn 的时间；与退出时间共同约束 root 退出后的后代归属。 */
  ownedProcessStartedAtMs?: number;
  /** Windows root 被观察到退出的时间；禁止认领此后由复用 PID 创建的新后代。 */
  ownedProcessExitedAtMs?: number;
  /** 异步查询完成时读取受管 ChildProcess 的真实 exit 事件时间。 */
  resolveOwnedProcessExitedAtMs?: () => number | undefined;
  /** Windows taskkill 依赖注入；生产默认仍使用异步 execFile，确定性时序测试可替换。 */
  windowsTaskkillRunner?: WindowsTaskkillRunner;
  /** Windows taskkill 单次命令预算；默认 2 秒，测试可缩短。 */
  windowsTaskkillTimeoutMs?: number;
  /** Windows cleanup 全链路绝对截止时间（Unix epoch ms）；覆盖快照、EOF、taskkill 与 exit 观察。 */
  windowsCleanupDeadlineAtMs?: number;
}

export interface ProcessIdentity {
  parentPid: number;
  pid: number;
  processGroupId?: number;
  startTime: string;
}

export interface ProcessTreeOwnershipResolution {
  childStillOwned: boolean;
  currentIdentities: ProcessIdentity[];
  knownIdentities: ProcessIdentity[];
}

export interface ProcessTreeTerminationResult {
  remainingPids: number[];
}

export interface ProcessTreeSnapshot {
  rootPid: number;
  descendantPids: readonly number[];
  identities: readonly ProcessIdentity[];
  /** Windows 进程表查询失败时，空 identities 不代表进程树已经退出。 */
  identityVerification?: "verified" | "unavailable";
}

export interface ProcessTreeTerminatorWaitOptions extends ProcessTreeTerminatorOptions {
  snapshot?: ProcessTreeSnapshot;
  waitAfterForceMs?: number;
}
