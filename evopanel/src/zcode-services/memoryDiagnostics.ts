import type { IDisposable } from "@zcode/rpc";
import {
  createMemoryDiagnosticsRegistry,
  type MemoryDiagnosticsProvider,
  type MemoryDiagnosticsRegistry,
} from "@zcode/shared";

/**
 * services 进程级内存诊断计数器注册表。
 *
 * 各 service 工厂在创建时注册纯读取 provider，disposeAll 时注销；Host 每 60 秒 collect 一次
 * 写本地日志。不放在 service 接口上是为了不把诊断方法暴露到 RPC channel。
 */
export const memoryDiagnosticsRegistry: MemoryDiagnosticsRegistry =
  createMemoryDiagnosticsRegistry();

export function registerMemoryDiagnosticsProvider(
  name: string,
  provider: MemoryDiagnosticsProvider,
): IDisposable {
  return memoryDiagnosticsRegistry.register(name, provider);
}

export function collectServiceMemoryDiagnostics(): Record<string, number> {
  return memoryDiagnosticsRegistry.collect();
}
