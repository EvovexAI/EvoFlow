import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { Emitter } from "@zcode/rpc";
import type { ZCodeProtocolMessage } from "@zcode/shared";
import { zcodeProtocolMessageSchema } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  ZCodeProtocolTransport,
  ZCodeProtocolTransportClosedEvent,
} from "./zcodeProtocolTransport.js";
import {
  captureProcessGroupSnapshot,
  captureExitedRootDescendantsSnapshotAsync,
  captureProcessTreeSnapshotAsync,
  terminateProcessTree,
  terminateProcessTreeAndWait,
} from "#src/process/processTreeTerminator.js";
import type { ProcessTreeSnapshot } from "#src/process/processTreeTerminator.js";
import { AgentStderrCollector, EXIT_STDERR_DRAIN_MS } from "./agentStderrCollector.js";

interface ZCodeStdioTransportOptions {
  onStderrLine?: (line: string) => void;
  ownedProcessGroupId?: number;
  ownedProcessStartedAtMs?: number;
}

const STDIO_EOF_EXIT_WAIT_MS = 1_800;
const DISPOSE_STDERR_DRAIN_MS = 3_250;
const E2E_COVERAGE_STDIO_EOF_EXIT_WAIT_MS = 5_000;
const PROCESS_TREE_FORCE_AFTER_MS = 2_000;
const PROCESS_TREE_WINDOWS_TASKKILL_TIMEOUT_MS = 1_000;
const PROCESS_TREE_WINDOWS_EXIT_OBSERVATION_GRACE_MS = 250;
const processTreeLogger = createServiceLogger("zcode-agent-process-tree");

export class ZCodeStdioTransport implements ZCodeProtocolTransport {
  readonly kind = "stdio" as const;

  private readonly messageEmitter = new Emitter<ZCodeProtocolMessage>();
  private readonly closeEmitter = new Emitter<ZCodeProtocolTransportClosedEvent>();
  private readonly stderrCollector: AgentStderrCollector;
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private stdoutBuffer = "";
  private stdoutFlushed = false;
  private readersDisposed = false;
  private disposed = false;
  private closed = false;
  private disposeAndWaitPromise: Promise<void> | undefined;
  private cleanupProcessTreeSnapshot: ProcessTreeSnapshot | undefined;
  private cleanupAttemptCount = 0;
  private childExitedAtMs: number | undefined;

  readonly onMessage = this.messageEmitter.event;
  readonly onClose = this.closeEmitter.event;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options?: ZCodeStdioTransportOptions,
  ) {
    this.stderrCollector = new AgentStderrCollector(child.stderr, options?.onStderrLine);

    // ZCode Protocol stdio 帧边界只认 LF。Node readline 会把 U+2028/U+2029
    // 当作换行，模型文本包含这类字符时会把合法 JSON 字符串切成半帧。
    child.stdout.on("data", this.handleStdoutData);
    child.stdout.once("end", this.handleStdoutEnd);
    child.stdout.once("close", this.handleStdoutEnd);
    child.stdin.on("error", (error) => this.handleStreamError("stdin", error));
    child.stdout.on("error", (error) => this.handleStreamError("stdout", error));
    child.once("exit", (code, signal) => {
      this.childExitedAtMs = Date.now();
      this.fireClose({ code, signal });
      this.disposeReaders();
      void this.waitForStderrDrain();
    });
    child.once("error", (error) => {
      this.fireClose({ reason: error.message });
      this.disposeReaders();
      void this.waitForStderrDrain();
    });
  }

  async send(message: ZCodeProtocolMessage): Promise<void> {
    if (this.disposed || this.closed || this.child.killed || !this.child.stdin.writable) {
      throw new Error("ZCode agent stdio transport is closed");
    }
    const frame = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(frame, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposeLocalResources();
    void this.stderrCollector.waitForDrain(DISPOSE_STDERR_DRAIN_MS);
    if (!this.hasChildExited()) {
      // Windows 和 POSIX 下 agent wrapper 可能继续拉起 runtime/MCP 子进程，
      // 只 kill 父进程会留下后代进程或短时间锁住 workspace cwd。
      const ownedProcessGroupId = this.options?.ownedProcessGroupId;
      terminateProcessTree(this.child, ownedProcessGroupId ? { ownedProcessGroupId } : {});
    }
  }

  disposeAndWait(): Promise<void> {
    if (!this.disposeAndWaitPromise) {
      const inFlight = this.disposeAndWaitOnce().finally(() => {
        if (this.disposeAndWaitPromise === inFlight) {
          this.disposeAndWaitPromise = undefined;
        }
      });
      this.disposeAndWaitPromise = inFlight;
    }
    return this.disposeAndWaitPromise;
  }

  waitForStderrDrain(): Promise<void> {
    return this.stderrCollector.waitForDrain();
  }

  private async disposeAndWaitOnce(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.disposeLocalResources();
    }
    // stdin EOF 可能让 CLI 根进程先退出，而 detached MCP 仍继续运行。
    // 必须在发 EOF 前保存树成员，否则根退出、后代被系统接管后无法再按 PPID 找回。
    this.cleanupAttemptCount += 1;
    const cleanupStartedAtMs = Date.now();
    const forceBudgetMs = this.cleanupAttemptCount > 1 ? 0 : PROCESS_TREE_FORCE_AFTER_MS;
    // 只扣减 forceAfterMs 无法约束慢 CIM；force 触底为 0 后 waiter 还会重新
    // 获得 taskkill + exit 宽限。Windows 必须从 cleanup 起点固定同一个绝对 deadline，
    // 并贯穿快照、EOF 和 waiter，才能稳定落在 Host 3.5s service phase 内。
    const windowsCleanupDeadlineAtMs =
      process.platform === "win32"
        ? cleanupStartedAtMs +
          forceBudgetMs +
          PROCESS_TREE_WINDOWS_TASKKILL_TIMEOUT_MS +
          PROCESS_TREE_WINDOWS_EXIT_OBSERVATION_GRACE_MS
        : undefined;
    this.cleanupProcessTreeSnapshot ??= await this.captureCleanupSnapshot(
      windowsCleanupDeadlineAtMs,
    );
    const processTreeSnapshot = this.cleanupProcessTreeSnapshot;
    if (!this.hasChildExited()) {
      // app-server --stdio 的正常退出边界是 stdin EOF。直接 taskkill
      // 进程树，既跳过 agent 自身 shutdown，也会让 host 固定等强杀兜底窗口。
      // 这里先请求协议入口自然收尾；短时间无响应再进入进程树兜底，仍保证不残留子进程。
      this.requestStdioClose();
      // coverage CLI bundle 未压缩且带完整 source map，启动/收尾明显慢于发布包。
      // coverage 下继续保留额外写盘宽限；普通窗口覆盖 CLI 的 1500ms 退出 deadline。
      const configuredEofWaitMs =
        process.env.ZCODE_E2E_COVERAGE === "1"
          ? E2E_COVERAGE_STDIO_EOF_EXIT_WAIT_MS
          : STDIO_EOF_EXIT_WAIT_MS;
      const remainingCleanupMs =
        windowsCleanupDeadlineAtMs === undefined
          ? configuredEofWaitMs
          : Math.max(windowsCleanupDeadlineAtMs - Date.now(), 0);
      await this.waitForChildExit(Math.min(configuredEofWaitMs, remainingCleanupMs));
    }
    // app 关闭时 host 必须等进程树的 SIGTERM/SIGKILL 兜底跑完；
    // 即使根 child 已在 EOF 窗口内退出，也要用预先保存的快照回收后代。
    const terminationResult = await terminateProcessTreeAndWait(this.child, {
      ...(this.options?.ownedProcessGroupId
        ? { ownedProcessGroupId: this.options.ownedProcessGroupId }
        : {}),
      ...(this.options?.ownedProcessStartedAtMs
        ? {
            ownedProcessStartedAtMs: this.options.ownedProcessStartedAtMs,
            ownedProcessExitedAtMs: this.childExitedAtMs ?? Date.now(),
          }
        : {}),
      ...(processTreeSnapshot ? { snapshot: processTreeSnapshot } : {}),
      log: processTreeLogger,
      // Windows 等待式清理的绝对 deadline 是 force 余量 + taskkill 上限 + exit 宽限。
      // 将命令上限控制在 1s，使完整 cleanup 仍落在 Host service phase 的 3.5s 内。
      windowsTaskkillTimeoutMs: PROCESS_TREE_WINDOWS_TASKKILL_TIMEOUT_MS,
      ...(windowsCleanupDeadlineAtMs === undefined ? {} : { windowsCleanupDeadlineAtMs }),
      // 前一次 cleanup 若报告残留，app quit 的最终重试不能再等待完整
      // graceful 窗口；直接进入 force，确保仍落在 main 给 Host 的退出预算内。
      forceAfterMs: Math.max(forceBudgetMs - (Date.now() - cleanupStartedAtMs), 0),
    });
    // Windows taskkill 已确认 OS 进程退出后，Node 的 ChildProcess exit 事件
    // 仍可能晚一轮投递。waiter 已同时检查 PID 存活与身份门禁，这里若再用滞后的
    // exitCode/signalCode 追加 root PID，会把成功回收误报为残留并触发无效重试。
    const remainingPids = terminationResult.remainingPids;
    await this.stderrCollector.waitForDrain(
      windowsCleanupDeadlineAtMs === undefined
        ? undefined
        : Math.max(0, Math.min(EXIT_STDERR_DRAIN_MS, windowsCleanupDeadlineAtMs - Date.now())),
    );
    if (remainingPids.length > 0) {
      // 只写 warning 后把 cleanup 当成功会让 manager 随即释放 ownership，
      // app quit 无法再次处理残留。这里把残留提升为失败并保留快照供最终重试。
      throw new Error(
        `runtime process tree cleanup incomplete; remaining pid=${[...new Set(remainingPids)].join(",")}`,
      );
    }
  }

  private readonly handleStdoutData = (chunk: Buffer | string): void => {
    if (this.closed) {
      return;
    }
    this.stdoutBuffer += typeof chunk === "string" ? chunk : this.stdoutDecoder.write(chunk);
    this.drainStdoutFrames();
  };

  private readonly handleStdoutEnd = (): void => {
    if (this.stdoutFlushed) {
      return;
    }
    this.stdoutFlushed = true;
    this.stdoutBuffer += this.stdoutDecoder.end();
    const trailing = this.stdoutBuffer;
    this.stdoutBuffer = "";
    if (trailing.length > 0 && !this.closed) {
      this.handleStdoutFrame(trailing);
    }
    this.fireClose({ reason: "stdout_closed" });
  };

  private drainStdoutFrames(): void {
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const frame = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.handleStdoutFrame(frame);
      if (this.closed) {
        return;
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleStdoutFrame(frame: string): void {
    const line = frame.endsWith("\r") ? frame.slice(0, -1) : frame;
    if (line.trim().length === 0) {
      return;
    }
    try {
      const parsed = zcodeProtocolMessageSchema.parse(JSON.parse(line));
      // 协议帧分发曾同步查询系统进程表，telemetry/streaming 高峰会阻塞
      // Host event loop 并让 subagent 面板无输出。运行期 data plane 只做解析和转发；
      // 完整进程树查询严格留在 dispose cleanup 边界。
      this.messageEmitter.fire(parsed);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.fireClose({ reason: `protocol_parse_error: ${reason}` });
    }
  }

  private handleStreamError(stream: "stdin" | "stdout", error: Error): void {
    // 远端 WSL/SSH agent 秒退后，host 仍可能正在写入尚未完成的协议请求。
    // Node 的 stdin write 回调会 reject，但底层 Socket 还会额外触发 error 事件；若没有长期监听，
    // zcode-server 会因未处理的 EPIPE 直接崩溃，UI 只能看到远端连接断开而不是协议请求失败。
    // 这里把 stream error 视为 transport 已关闭，阻止后续继续向失效 agent 写入。
    this.fireClose({ reason: `${stream}_error: ${error.message}` });
  }

  private fireClose(event: ZCodeProtocolTransportClosedEvent): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeEmitter.fire(event);
  }

  private disposeReaders(): void {
    if (this.readersDisposed) {
      return;
    }
    this.readersDisposed = true;
    this.child.stdout.off("data", this.handleStdoutData);
    this.child.stdout.off("end", this.handleStdoutEnd);
    this.child.stdout.off("close", this.handleStdoutEnd);
    this.child.stdout.resume();
  }

  private disposeLocalResources(): void {
    this.disposeReaders();
    this.messageEmitter.dispose();
    this.closeEmitter.dispose();
  }

  private requestStdioClose(): void {
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      return;
    }
    try {
      this.child.stdin.once("error", () => undefined);
      this.child.stdin.end();
    } catch {
      // agent 可能正好在 disposeAndWait 期间退出，stdin 已半关闭时 EOF 请求失败；
      // 失败不应打断后续进程树兜底，否则关闭路径又可能留下 runtime 残留。
    }
  }

  private waitForChildExit(timeoutMs: number): Promise<void> {
    if (this.hasChildExited()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        this.child.off?.("exit", settle);
        resolve();
      };
      this.child.once("exit", settle);
      timer = setTimeout(settle, timeoutMs);
      timer.unref?.();
    });
  }

  private hasChildExited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  private async captureCleanupSnapshot(
    windowsCleanupDeadlineAtMs?: number,
  ): Promise<ProcessTreeSnapshot | undefined> {
    const childHadExited = this.hasChildExited();
    const liveTree = childHadExited
      ? undefined
      : await captureProcessTreeSnapshotAsync(this.child, {
          log: processTreeLogger,
          ...(windowsCleanupDeadlineAtMs === undefined ? {} : { windowsCleanupDeadlineAtMs }),
          ownedProcessStartedAtMs: this.options?.ownedProcessStartedAtMs,
          // root 可能在 WMIC/CIM 查询期间退出。查询开始时还没有退出时间，
          // 必须在同轮查询完成后读取 exit 事件记录，才能安全恢复旧后代且排除 PID 复用。
          resolveOwnedProcessExitedAtMs: () => this.childExitedAtMs,
        });
    if (liveTree) {
      return liveTree;
    }
    if (process.platform === "win32" && !childHadExited && this.child.pid) {
      // 查询失败时不再串行追加第二次查询；查询期间 root 正常退出的后代已经由
      // captureProcessTreeSnapshotAsync 使用同轮进程表和 root 生命周期恢复。这里必须
      // 显式保留“身份不可验证”，否则空 identities 会被误判为进程树已经退出。
      return {
        rootPid: this.child.pid,
        descendantPids: [],
        identities: [],
        identityVerification: "unavailable",
      };
    }
    const processGroupId = this.options?.ownedProcessGroupId;
    if (processGroupId) {
      return captureProcessGroupSnapshot(processGroupId);
    }
    const exitedTree = await captureExitedRootDescendantsSnapshotAsync(this.child.pid ?? 0, {
      log: processTreeLogger,
      ...(windowsCleanupDeadlineAtMs === undefined ? {} : { windowsCleanupDeadlineAtMs }),
      ownedProcessStartedAtMs: this.options?.ownedProcessStartedAtMs,
      ownedProcessExitedAtMs: this.childExitedAtMs ?? Date.now(),
    });
    if (exitedTree) {
      return exitedTree;
    }
    // Windows 异步 CIM 查询失败后不能在 terminateAndWait 内立刻再查一次，
    // 否则两个查询超时会串行叠加并吃满 Main 的退出预算。不可验证快照会继续观察
    // 原 ChildProcess，并在超时后明确报告残留，但绝不向未经验证的复用 PID 发信号。
    return process.platform === "win32" && this.child.pid
      ? {
          rootPid: this.child.pid,
          descendantPids: [],
          identities: [],
          identityVerification: "unavailable",
        }
      : undefined;
  }
}
