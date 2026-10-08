import { execFile } from "node:child_process";
import type {
  ProcessIdentity,
  ProcessTreeTerminatorOptions,
} from "#src/process/processTreeTypes.js";

const WINDOWS_PROCESS_LOOKUP_TIMEOUT_MS = 2_500;
const DOTNET_UNIX_EPOCH_TICKS = 621_355_968_000_000_000n;
const TICKS_PER_MICROSECOND = 10n;
const WINDOWS_START_TIME_PREFIX = "windows-utc-us:";

type WindowsCimCapability = "cim" | "identity-unavailable";

interface WindowsProcessListFlight {
  promise: Promise<readonly ProcessIdentity[]>;
  startedAtMs: number;
}

let windowsProcessListInFlight: WindowsProcessListFlight | undefined;
let windowsCimCapability: WindowsCimCapability | undefined;

function isHardCimUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}

function remainingWindowsCleanupMs(options: ProcessTreeTerminatorOptions): number | undefined {
  return options.windowsCleanupDeadlineAtMs === undefined
    ? undefined
    : Math.max(options.windowsCleanupDeadlineAtMs - Date.now(), 0);
}

function boundedWindowsLookupTimeoutMs(
  defaultTimeoutMs: number,
  options: ProcessTreeTerminatorOptions,
): number {
  const remainingMs = remainingWindowsCleanupMs(options);
  return remainingMs === undefined
    ? defaultTimeoutMs
    : Math.max(Math.min(defaultTimeoutMs, remainingMs), 0);
}

async function awaitWindowsProcessListWithinDeadline(
  request: Promise<readonly ProcessIdentity[]>,
  options: ProcessTreeTerminatorOptions,
): Promise<readonly ProcessIdentity[]> {
  const remainingMs = remainingWindowsCleanupMs(options);
  if (remainingMs === undefined) return await request;
  if (remainingMs <= 0) return [];

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<readonly ProcessIdentity[]>((resolve) => {
        deadlineTimer = setTimeout(() => resolve([]), remainingMs);
      }),
    ]);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

function warn(options: ProcessTreeTerminatorOptions, message: string, ...args: unknown[]): void {
  options.log?.warn(options.traceId, message, ...args);
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseWindowsProcessList(stdout: string): ProcessIdentity[] {
  const identities: ProcessIdentity[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [pidText, parentPidText, rawStartTime] = line.trim().split(/\s+/);
    const pid = parsePositiveInteger(pidText);
    const parentPid = parseNonNegativeInteger(parentPidText);
    const startTime = normalizePowerShellStartTime(rawStartTime);
    if (pid === undefined || parentPid === undefined || !startTime) continue;
    identities.push({ parentPid, pid, startTime });
  }
  return identities;
}

function normalizePowerShellStartTime(rawStartTime: string | undefined): string | undefined {
  if (!rawStartTime) return undefined;
  try {
    const unixMicroseconds =
      (BigInt(rawStartTime) - DOTNET_UNIX_EPOCH_TICKS) / TICKS_PER_MICROSECOND;
    return `${WINDOWS_START_TIME_PREFIX}${unixMicroseconds}`;
  } catch {
    return undefined;
  }
}

export async function verifyWindowsProcessIdentityAsync(
  identity: ProcessIdentity,
  timeoutMs: number,
  options: ProcessTreeTerminatorOptions = {},
): Promise<boolean> {
  if (process.platform !== "win32" || timeoutMs <= 0) return false;
  if (windowsCimCapability === "identity-unavailable") return false;
  // Windows 11 24H2 及部分 Win10 镜像不再提供 WMIC；Windows 10+ 统一使用
  // PowerShell/CIM，查询失败仍按 CreationDate 无法确认处理，禁止绕过身份校验强杀。
  return await new Promise<boolean>((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "ProcessId = ${identity.pid}" | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().Ticks }`,
      ],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error || !stdout) {
          if (isHardCimUnavailable(error)) windowsCimCapability = "identity-unavailable";
          warn(
            options,
            `Windows root 身份 PowerShell 复核失败 pid=${identity.pid}:`,
            error ?? stderr,
          );
          resolve(false);
          return;
        }
        const current = parseWindowsProcessList(stdout).find(
          (processIdentity) => processIdentity.pid === identity.pid,
        );
        windowsCimCapability = "cim";
        resolve(current?.startTime === identity.startTime);
      },
    );
  });
}

export async function readWindowsProcessListAsync(
  options: ProcessTreeTerminatorOptions,
): Promise<readonly ProcessIdentity[]> {
  if (windowsCimCapability === "identity-unavailable") return [];
  const ownedProcessStartedAtMs = options.ownedProcessStartedAtMs;
  if (
    windowsProcessListInFlight &&
    (ownedProcessStartedAtMs === undefined ||
      ownedProcessStartedAtMs < windowsProcessListInFlight.startedAtMs)
  ) {
    return await awaitWindowsProcessListWithinDeadline(windowsProcessListInFlight.promise, options);
  }

  // Get-CimInstance 在部分 Windows 机器上会超过 1 秒。同步等待会阻塞 Host
  // 的退出 deadline；共享同一个异步查询后，多个 workspace 可以复用一次系统进程表。
  // 旧共享 Promise 可能早于新 Agent 的 spawn 开始，复用这张进程表必然找不到
  // 新 root 并退化为 unverified。只有严格晚于 root 启动的查询才具备可复用资格。
  const startedAtMs = Date.now();
  const request = new Promise<readonly ProcessIdentity[]>((resolve) => {
    // 移除 WMIC 后直接走受支持的 CIM 后端，避免 ENOENT fallback 消耗 cleanup
    // deadline；查询失败返回空身份，调用方继续沿 fail-closed 路径观察退出。
    const timeoutMs = boundedWindowsLookupTimeoutMs(WINDOWS_PROCESS_LOOKUP_TIMEOUT_MS, options);
    if (timeoutMs <= 0) {
      resolve([]);
      return;
    }

    execFile(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().Ticks }",
      ],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error || !stdout) {
          if (isHardCimUnavailable(error)) windowsCimCapability = "identity-unavailable";
          warn(options, "查询 Windows runtime 进程表失败（异步）:", error ?? stderr);
          resolve([]);
          return;
        }
        const identities = parseWindowsProcessList(stdout);
        if (identities.length === 0)
          warn(options, "PowerShell 未返回可解析的 Windows runtime 进程表");
        if (identities.length > 0) windowsCimCapability = "cim";
        resolve(identities);
      },
    );
  }).finally(() => {
    if (windowsProcessListInFlight?.promise === request) windowsProcessListInFlight = undefined;
  });
  windowsProcessListInFlight = { promise: request, startedAtMs };
  return await awaitWindowsProcessListWithinDeadline(request, options);
}
