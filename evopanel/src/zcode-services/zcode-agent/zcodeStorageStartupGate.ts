import { randomUUID } from "node:crypto";
import { Emitter } from "@zcode/rpc";
import {
  zcodeStorageStartupStateSchema,
  type ZCodeStorageStartupState,
  type DatabaseStartupErrorCode,
} from "@zcode/shared";

const FIRST_STATUS_TIMEOUT_MS = 30_000;

/** 一个 protocol client 对应一个进程代次，状态只来自该连接的合法控制帧。 */
export class ZCodeStorageStartupGate {
  private current?: ZCodeStorageStartupState;
  private terminalError?: Error;
  private pending?: Promise<void>;
  private resolve?: () => void;
  private reject?: (error: Error) => void;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly changed = new Emitter<ZCodeStorageStartupState>();
  readonly onDidChange = this.changed.event;

  constructor(required: boolean, firstStatusTimeoutMs = FIRST_STATUS_TIMEOUT_MS) {
    if (required) {
      this.ensurePending();
      this.timer = setTimeout(() => this.fail("startup_status_timeout"), firstStatusTimeoutMs);
      this.timer.unref?.();
    }
  }

  get isWaiting(): boolean {
    return Boolean(this.terminalError || (this.pending && this.current?.phase !== "ready"));
  }

  get snapshot(): ZCodeStorageStartupState | undefined {
    return this.current;
  }

  accept(input: unknown): boolean {
    const parsed = zcodeStorageStartupStateSchema.safeParse(input);
    if (!parsed.success || this.terminalError) return false;
    const next = parsed.data;
    if (
      this.current &&
      (next.attemptId !== this.current.attemptId ||
        next.databaseId !== this.current.databaseId ||
        next.sequence <= this.current.sequence ||
        this.current.phase === "ready" ||
        this.current.phase === "failed")
    )
      return false;
    clearTimeout(this.timer);
    this.current = next;
    if (next.phase === "ready") this.resolve?.();
    else if (next.phase === "failed") this.fail(next.errorCode ?? "sql_failed");
    else this.ensurePending();
    this.changed.fire(next);
    return true;
  }

  async wait(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.terminalError) throw this.terminalError;
    if (!this.pending || this.current?.phase === "ready") return;
    if (!signal) return this.pending;
    let abort!: () => void;
    try {
      await Promise.race([
        this.pending,
        new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    if (this.pending && this.current?.phase !== "ready" && !this.terminalError)
      this.fail("transport_closed");
    this.changed.dispose();
  }

  private ensurePending(): void {
    if (this.pending) return;
    this.pending = new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    // 尚无业务调用时也可能先收到失败；仍保留 rejected promise 给之后的调用者。
    void this.pending.catch(() => undefined);
  }

  private fail(code: DatabaseStartupErrorCode): void {
    // 首帧之前失败也必须形成快照；未知数据库身份不能伪装成某个已解析路径。
    if (this.current?.phase !== "failed") {
      this.current = this.current
        ? { ...this.current, phase: "failed", errorCode: code, sequence: this.current.sequence + 1 }
        : {
            schemaVersion: 1,
            attemptId: randomUUID(),
            databaseId: `unresolved:${randomUUID()}`,
            databaseKind: "session",
            sequence: 1,
            phase: "failed",
            elapsedMs: 0,
            errorCode: code,
          };
      this.changed.fire(this.current);
    }
    this.terminalError = new Error(`SQLite startup failed: ${code}`);
    this.reject?.(this.terminalError);
  }
}
