/* eslint-disable max-lines -- Windows two-phase transport lifecycle must remain one linearized state machine. */
import { randomBytes } from "node:crypto";

import type { HelperHealth } from "@zcode/zcode-cua/broker";
import type {
  CuaHelperHandle,
  CuaHelperTransportRestartResult,
  CuaProductHelperHost,
} from "@zcode/zcode-cua/broker/server";

import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import {
  ADDON_ENV,
  WindowsCuaChildLifecycle,
  asError,
  defaultChildProcess,
  defaultHealthProbe,
  defaultSocketPathFactory,
  isExactHealthPid,
  parseReadyMessage,
  type Generation,
  type WindowsCuaChild,
  type WindowsCuaChildProcessAdapter,
  type WindowsCuaHelperHostOptions,
} from "#src/cua-permission-broker/windowsCuaHelperHostSupport.js";

export type {
  WindowsCuaChild,
  WindowsCuaChildProcessAdapter,
  WindowsCuaHelperHostOptions,
} from "#src/cua-permission-broker/windowsCuaHelperHostSupport.js";

/** authority 铸造兜底：config-provenance 随机数，与 node.ts 懒分支 spawn 同口径。 */
const mintRandomAuthority = (): string => randomBytes(16).toString("hex");

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000;

type CuaHelperTransportHandle = Pick<CuaHelperHandle, "socketPath" | "pluginAuthority">;

export type ManagedCuaProductHelperHost = CuaProductHelperHost & {
  stop(): Promise<void>;
  checkHealth(timeoutMs?: number): Promise<unknown>;
  waitForTransport?(timeoutMs?: number): Promise<CuaHelperTransportHandle>;
};

/**
 * Host 的 lifecycle tail 是唯一线性化边界：任何 fresh fork 都必须排在上一代 exact child
 * exit 之后。kill 仅是请求，不能把未观察到 exit 的进程误判为已经终止。
 */
export class WindowsCuaHelperHost implements ManagedCuaProductHelperHost {
  private readonly childProcess: WindowsCuaChildProcessAdapter;
  private readonly mintSocketPath: () => string;
  private readonly healthProbe: (socketPath: string, timeoutMs: number) => Promise<HelperHealth>;
  private readonly startupTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly logger: ServiceLogger;
  private readonly childLifecycle: WindowsCuaChildLifecycle;
  private readonly authority: string;
  private handle: CuaHelperHandle | null = null;
  // 只要 transport_ready 已经对外 resolve，Agent 就可能已经持有这组凭据；即使 full health
  // 尚未完成，后续可恢复启动也必须复用它。显式 stop 会清掉该状态，避免 dispose 后复活旧 pipe。
  private lastAgentVisibleTransport: Pick<CuaHelperHandle, "socketPath"> | null = null;
  private current: Generation | null = null;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private terminationBlocker: Error | null = null;
  private startInFlight: Promise<CuaHelperHandle> | null = null;
  private startInFlightEpoch: number | null = null;
  private restartInFlight: Promise<CuaHelperHandle> | null = null;
  private restartAfterStartInFlight: Promise<CuaHelperHandle> | null = null;
  private restartPreservingTransportInFlight: Promise<CuaHelperTransportRestartResult> | null =
    null;
  private transportReadyInFlight: Promise<CuaHelperTransportHandle> | null = null;
  private transportReadyResolve: ((handle: CuaHelperTransportHandle) => void) | null = null;
  private transportReadyReject: ((error: unknown) => void) | null = null;
  private nextGeneration = 0;
  // 外部 stop 是 disposal 边界；排队中的旧 start/restart 不得在其后重新 fork。
  private externalStopEpoch = 0;

  constructor(private readonly options: WindowsCuaHelperHostOptions) {
    this.childProcess = options.childProcess ?? defaultChildProcess;
    this.mintSocketPath = options.mintSocketPath ?? defaultSocketPathFactory;
    this.healthProbe = options.healthProbe ?? defaultHealthProbe;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.logger = options.logger ?? createServiceLogger("windows-cua-helper-host");
    this.childLifecycle = new WindowsCuaChildLifecycle(this.logger);
    this.authority = (options.mintPluginAuthority ?? mintRandomAuthority)();
  }

  get running(): boolean {
    return this.handle !== null;
  }
  get socketPath(): string | null {
    return this.handle?.socketPath ?? null;
  }
  get pluginAuthority(): string | null {
    return this.handle ? this.authority : null;
  }

  waitForTransport(timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS): Promise<CuaHelperTransportHandle> {
    if (this.handle) {
      return Promise.resolve({
        socketPath: this.handle.socketPath,
        pluginAuthority: this.handle.pluginAuthority,
      });
    }
    const pending = this.transportReadyInFlight;
    if (!pending) return Promise.reject(new Error("Windows Computer Use Helper is not starting"));
    // 调用方通常会再套同一份有界 startup 预算；这里的本地 timer 保护直接调用者，
    // 避免 transport promise 因 Helper 永久不回消息而悬挂。
    return new Promise<CuaHelperTransportHandle>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Windows Computer Use Helper transport timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      pending.then(
        (handle) => {
          clearTimeout(timer);
          resolve(handle);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  start(): Promise<CuaHelperHandle> {
    const stopEpoch = this.externalStopEpoch;
    if (this.startInFlight && this.startInFlightEpoch === stopEpoch) return this.startInFlight;
    this.createTransportReadyPromise();
    const transportReady = this.transportReadyInFlight;
    // start() 既是 cold-start 入口，也是异常退出后的按需恢复入口。Host 已经暴露过的
    // Agent-facing tuple 必须优先复用；只有从未暴露过 tuple（或显式 stop 后已清理）才 fresh。
    const preservedTransport = this.lastAgentVisibleTransport ?? undefined;
    const tracked = this.enqueue(() => this.startNow(stopEpoch, preservedTransport))
      .catch((error) => {
        // 旧 start 可能在 stop 竞态中晚于新 generation 失败，只有仍持有同一 promise 时才能收口。
        if (this.transportReadyInFlight === transportReady) {
          this.rejectTransportReady(error);
        }
        throw error;
      })
      .finally(() => {
        if (this.startInFlight === tracked) {
          this.startInFlight = null;
          this.startInFlightEpoch = null;
        }
      });
    this.startInFlight = tracked;
    this.startInFlightEpoch = stopEpoch;
    // 外部 stop 会在调用方等待 start 之前同步中止它；保留原 Promise 语义，同时避免形成未处理 rejection。
    void tracked.catch(() => undefined);
    return tracked;
  }

  stop(): Promise<void> {
    const generation = this.current;
    const termination = this.invalidateForExternalStop(generation);
    return this.enqueue(async () => {
      try {
        await termination;
      } finally {
        if (generation && this.current?.id === generation.id) this.current = null;
      }
    });
  }

  restart(): Promise<CuaHelperHandle> {
    if (this.restartInFlight) return this.restartInFlight;
    const stopEpoch = this.externalStopEpoch;
    const tracked = this.enqueue(async () => {
      await this.stopNow("restart");
      return this.startNow(stopEpoch);
    }).finally(() => {
      if (this.restartInFlight === tracked) this.restartInFlight = null;
    });
    this.restartInFlight = tracked;
    return tracked;
  }

  restartAfterCurrentStart(): Promise<CuaHelperHandle> {
    if (this.restartAfterStartInFlight) return this.restartAfterStartInFlight;
    const stopEpoch = this.externalStopEpoch;
    const tracked = this.enqueue(async () => {
      await this.stopNow("permission-restart");
      return this.startNow(stopEpoch);
    }).finally(() => {
      if (this.restartAfterStartInFlight === tracked) this.restartAfterStartInFlight = null;
    });
    this.restartAfterStartInFlight = tracked;
    return tracked;
  }

  restartAfterCurrentStartPreservingTransport(
    options: { beforeFreshStart?: () => void } = {},
  ): Promise<CuaHelperTransportRestartResult> {
    if (this.restartPreservingTransportInFlight) return this.restartPreservingTransportInFlight;
    const stopEpoch = this.externalStopEpoch;
    const tracked = this.enqueue(async () => {
      // enqueue 会等待在途 start；在这里读取 handle 才能覆盖“授权回调早于首个 ready”竞态。
      const previous = this.handle ?? this.lastAgentVisibleTransport;
      await this.stopNow("preserving-transport-restart");
      if (stopEpoch !== this.externalStopEpoch)
        throw new Error("Windows Computer Use Helper startup stopped");
      if (previous) {
        // Helper 进程是可替换的 downstream；已有 Agent 绑定的是 host-facing named pipe，
        // 恢复时复用它们，避免 Windows Helper 重启把 Agent 留在旧 pipe 上。
        return {
          handle: await this.startNow(stopEpoch, previous),
          reused: true,
        };
      }
      options.beforeFreshStart?.();
      this.lastAgentVisibleTransport = null;
      return { handle: await this.startNow(stopEpoch), reused: false };
    }).finally(() => {
      if (this.restartPreservingTransportInFlight === tracked)
        this.restartPreservingTransportInFlight = null;
    });
    this.restartPreservingTransportInFlight = tracked;
    return tracked;
  }

  async checkHealth(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<HelperHealth> {
    const handle = this.handle;
    if (!handle) throw new Error("Windows Computer Use Helper is not running");
    return this.healthProbe(handle.socketPath, timeoutMs);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.lifecycleTail.then(async () => {
      if (this.terminationBlocker) throw this.terminationBlocker;
      return operation();
    });
    this.lifecycleTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private startNow(
    stopEpoch: number,
    preservedTransport?: Pick<CuaHelperHandle, "socketPath">,
  ): Promise<CuaHelperHandle> {
    if (stopEpoch !== this.externalStopEpoch)
      return Promise.reject(new Error("Windows Computer Use Helper startup stopped"));
    if (this.handle) return Promise.resolve(this.handle);
    if (this.terminationBlocker) return Promise.reject(this.terminationBlocker);
    return this.startGeneration(stopEpoch, preservedTransport);
  }

  private createTransportReadyPromise(): void {
    if (this.transportReadyInFlight) return;
    this.transportReadyInFlight = new Promise<CuaHelperTransportHandle>((resolve, reject) => {
      this.transportReadyResolve = resolve;
      this.transportReadyReject = reject;
    });
    // start() 负责最终失败收口；直接等待 transport 的调用方也不能留下未处理 rejection。
    void this.transportReadyInFlight.catch(() => undefined);
  }

  private resolveTransportReady(handle: CuaHelperTransportHandle): void {
    // transport_ready 已经可能被 spawn env 消费；从此刻起 tuple 就是 Agent-facing identity，
    // 不能因为后续 full health 失败或子进程异常退出而在下一次 start 时改发新 pipe。
    this.lastAgentVisibleTransport = {
      socketPath: handle.socketPath,
    };
    this.transportReadyResolve?.(handle);
    this.transportReadyResolve = null;
    this.transportReadyReject = null;
  }

  private rejectTransportReady(error: unknown): void {
    this.transportReadyReject?.(error);
    this.invalidateTransportReady();
  }

  private invalidateTransportReady(): void {
    // transport_ready 是 generation 级承诺；Helper 退出后，已 resolve 的 promise
    // 无法再 reject，但必须从 Host 上摘除，避免下一代 start 复用死 generation 的 tuple。
    this.transportReadyResolve = null;
    this.transportReadyReject = null;
    this.transportReadyInFlight = null;
  }

  private async stopNow(context: string): Promise<void> {
    const generation = this.current;
    if (!generation) return;
    this.handle = null;
    if (context !== "preserving-transport-restart") {
      this.lastAgentVisibleTransport = null;
    }
    generation.stopped = true;
    await this.terminateGeneration(generation, context);
    if (this.current?.id === generation.id) this.current = null;
    this.invalidateTransportReady();
  }

  private startGeneration(
    stopEpoch: number,
    preservedTransport?: Pick<CuaHelperHandle, "socketPath">,
  ): Promise<CuaHelperHandle> {
    const id = ++this.nextGeneration;
    const socketPath = preservedTransport?.socketPath ?? this.mintSocketPath();
    const argv = [
      this.options.runtime.entryPath,
      "--socket",
      socketPath,
      "--parent-pid",
      String(process.pid),
    ];
    let child: WindowsCuaChild;
    try {
      child = this.childProcess.fork(this.options.runtime.command, argv, {
        cwd: this.options.runtime.root,
        env: {
          ...process.env,
          ...this.options.runtime.commandEnv,
          [ADDON_ENV]: this.options.runtime.addonPath,
          ELECTRON_RUN_AS_NODE: "1",
        },
      });
    } catch (error) {
      const startupError = asError(error);
      // fork 同步失败时没有 child/exit 事件可触发 fail()，必须主动终止本代 transport 等待。
      this.rejectTransportReady(startupError);
      this.childLifecycle.logFailure(id, undefined, "fork", startupError);
      return Promise.reject(startupError);
    }

    return new Promise<CuaHelperHandle>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let generation: Generation;
      const fail = (error: unknown, errorClass: string) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const original = asError(error);
        this.handle = null;
        this.rejectTransportReady(original);
        generation.stopped = true;
        this.childLifecycle.logFailure(id, child.pid, errorClass, original);
        void this.terminateGeneration(generation, errorClass).then(
          () => reject(original),
          (cleanupError) => {
            this.childLifecycle.logFailure(id, child.pid, `${errorClass}-cleanup`, cleanupError);
            reject(original);
          },
        );
      };
      const abort = (error: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.handle = null;
        this.rejectTransportReady(error);
        reject(error);
      };
      const onError = (error: unknown) => fail(error, "child-error");
      const onExit = (code: unknown) => {
        generation.exitObserved = true;
        if (!settled)
          fail(
            new Error(`Windows Computer Use Helper exited before ready (${String(code)})`),
            "early-exit",
          );
        else if (!generation.stopped && this.current?.id === id) {
          this.handle = null;
          this.current = null;
          this.invalidateTransportReady();
          this.logger.warn(undefined, "Windows Computer Use Helper exited unexpectedly", {
            generation: id,
            pid: child.pid,
            errorClass: "unexpected-exit",
          });
          // 这里只通知 Helper 状态失效；下次 CUA demand 复用已发布 tuple 恢复，不回收 Agent。
          this.options.onUnexpectedExit?.({ generation: id, pid: child.pid });
        }
      };
      const onMessage = (message: unknown) => {
        // stop 后、旧进程退出前仍可能收到 ready；先检查代际，避免把已清除的 tuple 重新写回。
        if (generation.stopped || stopEpoch !== this.externalStopEpoch || this.current?.id !== id)
          return;
        const ready = parseReadyMessage(message);
        if (ready === "ignore") return;
        if (!ready)
          return fail(
            new Error("Invalid Windows Computer Use Helper control message"),
            "malformed-message",
          );
        if (ready.type === "error") {
          // The helper reported its own startup failure — surface the
          // diagnostic instead of discarding it as a malformed message.
          return fail(new Error(ready.message), "helper-reported-error");
        }
        if (ready.socketPath !== socketPath) return;
        if (ready.pid !== child.pid)
          return fail(new Error("ready-pid-mismatch"), "ready-pid-mismatch");
        this.resolveTransportReady({
          socketPath,
          pluginAuthority: this.authority,
        });
        if (ready.type === "transport_ready") return;
        void this.healthProbe(socketPath, this.startupTimeoutMs).then(
          (health) => {
            if (
              settled ||
              generation.stopped ||
              stopEpoch !== this.externalStopEpoch ||
              this.current?.id !== id
            )
              return;
            if (!isExactHealthPid(health, child.pid))
              return fail(new Error("health-pid-mismatch"), "health-pid-mismatch");
            settled = true;
            if (timer) clearTimeout(timer);
            const handle: CuaHelperHandle = {
              socketPath,
              // Windows 走 named pipe，不参与 macOS 的冷启动 rendezvous（pipe 不是 fs 节点，
              // 没有 rename 让渡语义）。Helper 直接 bind 这个 pipe 名，两者恒等。
              launchSocketPath: socketPath,
              pluginAuthority: this.authority,
              helperAppPath: this.options.runtime.entryPath,
              bundleId: health.bundleId,
              pid: health.pid,
            };
            // 合并时保留 ready handle；transport_ready 已保存可恢复 tuple，不能只存 tuple 而丢掉运行状态。
            this.handle = handle;
            this.logger.info(undefined, "Windows Computer Use Helper ready", {
              generation: id,
              pid: health.pid,
            });
            resolve(handle);
          },
          (error) => fail(error, "health-failed"),
        );
      };
      generation = {
        id,
        child,
        socketPath,
        stopped: false,
        exitObserved: false,
        abort,
        removeMainListeners: () => {
          this.childLifecycle.off(child, "message", onMessage, id, "cleanup-off-message");
          this.childLifecycle.off(child, "error", onError, id, "cleanup-off-error");
          this.childLifecycle.off(child, "exit", onExit, id, "cleanup-off-exit");
        },
      };
      this.current = generation;
      if (
        !this.childLifecycle.on(child, "message", onMessage, id, "setup-on-message") ||
        !this.childLifecycle.on(child, "error", onError, id, "setup-on-error") ||
        !this.childLifecycle.on(child, "exit", onExit, id, "setup-on-exit")
      ) {
        fail(new Error("Windows Computer Use Helper listener setup failed"), "listener-setup");
        return;
      }
      timer = setTimeout(
        () => fail(new Error("Windows Computer Use Helper startup timed out"), "startup-timeout"),
        this.startupTimeoutMs,
      );
      timer.unref?.();
    });
  }

  private terminateGeneration(generation: Generation, context: string): Promise<void> {
    if (generation.terminationPromise) return generation.terminationPromise;
    const termination = this.terminateGenerationOnce(generation, context);
    generation.terminationPromise = termination;
    return termination;
  }

  private async terminateGenerationOnce(generation: Generation, context: string): Promise<void> {
    try {
      await this.childLifecycle.terminate(generation, context, this.shutdownTimeoutMs);
    } catch (error) {
      this.terminationBlocker = asError(error);
      throw error;
    }
  }

  private invalidateForExternalStop(generation: Generation | null): Promise<void> {
    this.externalStopEpoch += 1;
    this.lastAgentVisibleTransport = null;
    if (!generation) {
      this.rejectTransportReady(new Error("Windows Computer Use Helper startup stopped"));
      return Promise.resolve();
    }
    this.handle = null;
    generation.stopped = true;
    generation.abort?.(new Error("Windows Computer Use Helper startup stopped"));
    // settled generation 没有 abort rejecter，仍必须摘除旧 transport tuple，避免后续 start 复用死凭据。
    this.invalidateTransportReady();
    const termination = this.terminateGeneration(generation, "stop");
    // 外部 stop 在 tail 之前发起终止；预先消费拒绝，避免 deadline 先于 tail 接管时出现未处理 rejection。
    void termination.catch(() => undefined);
    return termination;
  }
}
