import { formatLogPrefix } from "@zcode/shared";

export type LogLevel = "debug" | "info" | "warn" | "error";

type DesktopLogLevel = Exclude<LogLevel, "debug">;

type DesktopLogBridgeWindow = Window & {
  zcode?: {
    log?: (level: DesktopLogLevel, args: unknown[]) => void;
  };
};

function isRendererProductionBuild(): boolean {
  const viteProduction =
    ((import.meta as ImportMeta & { env?: { readonly PROD?: boolean } }).env ?? {}).PROD === true;
  // Vitest 的 import.meta.env.PROD 在 transform 阶段固化，NODE_ENV fallback 让生产分支
  // 可被单测验证；实际 renderer build 仍以 Vite 的 PROD 标记为准。
  return (
    viteProduction || (typeof process !== "undefined" && process.env.NODE_ENV === "production")
  );
}

function isRendererLoggingDisabled(): boolean {
  return (
    (
      globalThis as typeof globalThis & {
        __ZCODE_RENDERER_DISABLE_LOGGING__?: boolean;
      }
    ).__ZCODE_RENDERER_DISABLE_LOGGING__ === true
  );
}

const consoleFns: Record<LogLevel, (...args: unknown[]) => void> = {
  debug: console.debug,
  info: console.log,
  warn: console.warn,
  error: console.error,
};

function isLoggerLevelEnabled(_level: LogLevel): boolean {
  // 生产构建下 renderer 所有日志级别都禁用；暴露 guard 让调用方在构造重 payload 前退出。
  return !isRendererProductionBuild() && !isRendererLoggingDisabled();
}

function log(level: LogLevel, ...args: unknown[]) {
  // 生产构建下 renderer 日志直接 no-op，避免 console 格式化、IPC 转发和落盘拖慢渲染主线程。
  if (!isLoggerLevelEnabled(level)) {
    return;
  }
  consoleFns[level](formatLogPrefix("ui"), ...args);
  // ui 包单独 typecheck 时拿不到 desktop renderer 注入的 window.zcode 声明，
  // 而且 Electron bridge 只接收 info/warn/error；debug 原样透传会让类型和宿主协议都不一致。
  // 这里显式收窄 bridge 形状，并只把主进程真正支持的级别转发过去。
  if (level !== "debug" && typeof window !== "undefined") {
    // tabStore 等纯前端状态模块现在也会在 Vitest 的 Node 环境里打 info 日志。
    // 如果这里无条件访问 window，测试一触发日志就会直接抛 ReferenceError，
    // 结果变成“为了排查问题而引入新的测试噪音”。先确认运行在浏览器环境，再走桌面端 bridge。
    (window as DesktopLogBridgeWindow).zcode?.log?.(level, args);
  }
}

function lifecycleLog(level: DesktopLogLevel, ...args: unknown[]) {
  // 生产包默认只保留经过筛选的生命周期诊断，避免把消息流日志重新打开。
  // 测试和故障注入仍可通过显式全局开关关闭全部 renderer 日志。
  if (isRendererLoggingDisabled()) {
    return;
  }
  if (isRendererProductionBuild()) {
    if (typeof window !== "undefined") {
      (window as DesktopLogBridgeWindow).zcode?.log?.(level, args);
    }
    return;
  }
  log(level, ...args);
}

export const logger = {
  debug: (...args: unknown[]) => log("debug", ...args),
  info: (...args: unknown[]) => log("info", ...args),
  warn: (...args: unknown[]) => log("warn", ...args),
  error: (...args: unknown[]) => log("error", ...args),
  lifecycle: {
    info: (...args: unknown[]) => lifecycleLog("info", ...args),
    warn: (...args: unknown[]) => lifecycleLog("warn", ...args),
    error: (...args: unknown[]) => lifecycleLog("error", ...args),
  },
  /** 带 traceId 前缀的日志，用于全链路追踪 */
  trace: (traceId: string, level: LogLevel, ...args: unknown[]) => {
    log(level, `[trace:${traceId}]`, ...args);
  },
};

/**
 * 进程内存本地诊断日志的唯一 renderer 出口。
 * 它是 renderer 生产日志策略里的“正式监控链路”例外：生产构建仍经桌面桥落盘（最多每 60s 一行、
 * 有变化才写），Web 端无桥时 no-op。业务模块不得借用它绕过生产门控。
 */
export function logMemoryDiagnostics(line: string): void {
  if (isRendererLoggingDisabled()) {
    return;
  }
  if (typeof window !== "undefined") {
    const bridge = (window as DesktopLogBridgeWindow).zcode?.log;
    if (bridge) {
      bridge("info", [line]);
      return;
    }
  }
  if (!isRendererProductionBuild()) {
    consoleFns.info(formatLogPrefix("ui"), line);
  }
}
