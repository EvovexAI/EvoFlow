import type {
  RendererActionTraceAttributes,
  RendererActionTraceBatchV1,
  RendererActionTraceConfigV1,
  RendererActionTraceResourceV1,
  RendererActionTraceSpanV1,
} from "@zcode/shared";
import {
  RENDERER_ACTION_TRACE_MAX_BATCH_BYTES,
  RENDERER_ACTION_TRACE_MAX_BATCH_SPANS,
} from "@zcode/shared";
import {
  resolveUserActionCatalogEntry,
  type UserActionFeatureId,
} from "@/lib/userActionTraceCatalog.js";

const RENDERER_ACTION_TRACE_MAX_QUEUE_SPANS = 256;
const RENDERER_ACTION_TRACE_FLUSH_DELAY_MS = 2_000;

interface UserActionTelemetryClock {
  now(): number;
  setNow?(value: number): void;
}

export type UserActionTrigger = RendererActionTraceAttributes["trigger"];
export type UserActionResultSource = NonNullable<RendererActionTraceAttributes["result_source"]>;

interface StartUserActionInput {
  featureId: UserActionFeatureId;
  action: string;
  trigger: UserActionTrigger;
  surface?: string;
  timeoutMs?: number;
  workspaceKind?: RendererActionTraceAttributes["workspace_kind"];
  remoteKind?: RendererActionTraceAttributes["remote_kind"];
  automationKind?: RendererActionTraceAttributes["automation_kind"];
}

export interface UserActionResult {
  resultSource?: UserActionResultSource;
  failureStage?: string;
  stateAfter?: RendererActionTraceAttributes["state_after"];
  configured?: boolean;
  requiresRestart?: boolean;
  sectionId?: string;
  valueAfter?: string;
  admissionResult?: RendererActionTraceAttributes["admission_result"];
}

interface UserActionFailure extends UserActionResult {
  failureStage: string;
}

interface UserActionHandle {
  complete(result?: UserActionResult): void;
  fail(failure: UserActionFailure): void;
  reject(result?: UserActionResult): void;
  cancel(): void;
  noop(): void;
}

interface UserActionTelemetry {
  start(input: StartUserActionInput): UserActionHandle;
}

interface RendererUserActionTelemetryOptions {
  config: RendererActionTraceConfigV1;
  resource: RendererActionTraceResourceV1;
  sendBatch: (batch: RendererActionTraceBatchV1) => Promise<unknown> | unknown;
  clock?: UserActionTelemetryClock;
  random?: () => number;
  randomHex?: (bytes: 8 | 16) => string;
}

interface ActiveAction {
  actionId: string;
  entry: NonNullable<ReturnType<typeof resolveUserActionCatalogEntry>>;
  input: StartUserActionInput;
  spanId: string;
  startedAt: number;
  timeout: ReturnType<typeof setTimeout>;
  traceId: string;
}

const NOOP_ACTION_HANDLE: UserActionHandle = {
  complete() {},
  fail() {},
  reject() {},
  cancel() {},
  noop() {},
};

export class RendererUserActionTelemetry implements UserActionTelemetry {
  private config: RendererActionTraceConfigV1;
  private readonly resource: RendererActionTraceResourceV1;
  private readonly sendBatch: RendererUserActionTelemetryOptions["sendBatch"];
  private readonly clock: UserActionTelemetryClock;
  private readonly random: () => number;
  private readonly randomHex: (bytes: 8 | 16) => string;
  private readonly completedQueue: RendererActionTraceSpanV1[] = [];
  private readonly activeActions = new Set<ActiveAction>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushPromise: Promise<void> | undefined;
  private droppedSinceLastFlush = 0;
  private sequence = 0;

  constructor(options: RendererUserActionTelemetryOptions) {
    this.config = options.config;
    this.resource = options.resource;
    this.sendBatch = options.sendBatch;
    this.clock = options.clock ?? { now: defaultNow };
    this.random = options.random ?? Math.random;
    this.randomHex = options.randomHex ?? randomHex;
  }

  updateConfig(config: RendererActionTraceConfigV1): void {
    this.config = config;
  }

  start(input: StartUserActionInput): UserActionHandle {
    const entry = resolveUserActionCatalogEntry(input.featureId, input.action);
    if (
      !entry ||
      !this.config.enabled ||
      !this.config.enabledGroups.includes(entry.group) ||
      this.random() >= this.config.sampleRatio
    ) {
      return NOOP_ACTION_HANDLE;
    }

    const active: ActiveAction = {
      actionId: crypto.randomUUID(),
      entry,
      input,
      spanId: this.randomHex(8),
      startedAt: this.clock.now(),
      timeout: setTimeout(() => {
        this.finish(active, "abandoned", {});
      }, input.timeoutMs ?? entry.timeoutMs),
      traceId: this.randomHex(16),
    };
    this.activeActions.add(active);

    return {
      complete: (result) => this.finish(active, "completed", result ?? {}),
      fail: (failure) => this.finish(active, "failed", failure),
      reject: (result) => this.finish(active, "rejected", result ?? {}),
      cancel: () => this.finish(active, "cancelled", {}),
      noop: () => this.finish(active, "noop", {}),
    };
  }

  flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = Promise.resolve()
      .then(() => this.flushImpl())
      .finally(() => {
        this.flushPromise = undefined;
        if (this.completedQueue.length > 0 && this.flushTimer === undefined) {
          this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            void this.flush();
          }, RENDERER_ACTION_TRACE_FLUSH_DELAY_MS);
        }
      });
    return this.flushPromise;
  }

  private async flushImpl(): Promise<void> {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    while (this.completedQueue.length > 0) {
      const spans = this.takeNextBatch();
      if (spans.length === 0) break;
      const batch: RendererActionTraceBatchV1 = {
        version: 1,
        rendererInstanceId: this.resource.rendererInstanceId,
        sequence: this.sequence++,
        droppedSinceLastFlush: this.droppedSinceLastFlush,
        resource: this.resource,
        spans,
      };
      this.droppedSinceLastFlush = 0;
      try {
        await this.sendBatch(batch);
      } catch {
        // Telemetry 是严格旁路；传输失败不能回压或改变用户操作结果。
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const active of this.activeActions) {
      this.finish(active, "abandoned", {});
    }
    await this.flush();
  }

  private finish(
    active: ActiveAction,
    outcome: RendererActionTraceAttributes["outcome"],
    result: UserActionResult,
  ): void {
    if (!this.activeActions.delete(active)) return;
    clearTimeout(active.timeout);
    const endedAt = this.clock.now();
    const attributes: RendererActionTraceAttributes = {
      feature_id: active.entry.featureId,
      action: active.entry.action,
      catalog_group: active.entry.group,
      operation_kind: active.entry.operationKind,
      surface: active.input.surface ?? active.entry.surface,
      trigger: active.input.trigger,
      outcome,
      action_id: active.actionId,
      ...(result.resultSource ? { result_source: result.resultSource } : {}),
      ...(result.failureStage ? { failure_stage: result.failureStage } : {}),
      ...(result.stateAfter ? { state_after: result.stateAfter } : {}),
      ...(result.configured !== undefined ? { configured: result.configured } : {}),
      ...(result.requiresRestart !== undefined ? { requires_restart: result.requiresRestart } : {}),
      ...(result.sectionId ? { section_id: result.sectionId } : {}),
      ...(result.valueAfter ? { value_after: result.valueAfter } : {}),
      ...(active.input.workspaceKind ? { workspace_kind: active.input.workspaceKind } : {}),
      ...(active.input.remoteKind ? { remote_kind: active.input.remoteKind } : {}),
      ...(result.admissionResult ? { admission_result: result.admissionResult } : {}),
      ...(active.input.automationKind ? { automation_kind: active.input.automationKind } : {}),
    };
    const span: RendererActionTraceSpanV1 = {
      traceId: active.traceId,
      spanId: active.spanId,
      name: "ui_action",
      startTimeUnixMs: active.startedAt,
      endTimeUnixMs: Math.max(endedAt, active.startedAt),
      status: outcome === "failed" || outcome === "rejected" ? "error" : "ok",
      attributes,
    };
    if (this.completedQueue.length >= RENDERER_ACTION_TRACE_MAX_QUEUE_SPANS) {
      this.droppedSinceLastFlush += 1;
      return;
    }
    this.completedQueue.push(span);
    if (this.completedQueue.length >= RENDERER_ACTION_TRACE_MAX_BATCH_SPANS) {
      void this.flush();
    } else if (this.flushTimer === undefined) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        void this.flush();
      }, RENDERER_ACTION_TRACE_FLUSH_DELAY_MS);
    }
  }

  private takeNextBatch(): RendererActionTraceSpanV1[] {
    const spans: RendererActionTraceSpanV1[] = [];
    while (spans.length < RENDERER_ACTION_TRACE_MAX_BATCH_SPANS && this.completedQueue.length > 0) {
      const candidate = this.completedQueue[0];
      if (!candidate) break;
      const next = [...spans, candidate];
      const estimatedBytes = JSON.stringify(next).length * 2;
      if (estimatedBytes > RENDERER_ACTION_TRACE_MAX_BATCH_BYTES) {
        if (spans.length === 0) {
          this.completedQueue.shift();
          this.droppedSinceLastFlush += 1;
          continue;
        }
        break;
      }
      spans.push(candidate);
      this.completedQueue.shift();
    }
    return spans;
  }
}

let activeUserActionTelemetry: UserActionTelemetry = {
  start: () => NOOP_ACTION_HANDLE,
};

export function setUserActionTelemetry(telemetry: UserActionTelemetry | null): void {
  activeUserActionTelemetry = telemetry ?? { start: () => NOOP_ACTION_HANDLE };
}

export function startUserAction(input: StartUserActionInput): UserActionHandle {
  return activeUserActionTelemetry.start(input);
}

export async function runUserActionAsync<T>(options: {
  input: StartUserActionInput;
  operation: () => Promise<T>;
  completed?: UserActionResult | ((value: T) => UserActionResult);
  failureStage: string;
}): Promise<T> {
  const handle = startUserAction(options.input);
  try {
    const value = await options.operation();
    handle.complete(
      typeof options.completed === "function" ? options.completed(value) : options.completed,
    );
    return value;
  } catch (error) {
    handle.fail({ failureStage: options.failureStage });
    throw error;
  }
}

export function runUserAction<T>(options: {
  input: StartUserActionInput;
  operation: () => T;
  completed?: UserActionResult | ((value: T) => UserActionResult);
  failureStage: string;
}): T {
  const handle = startUserAction(options.input);
  try {
    const value = options.operation();
    handle.complete(
      typeof options.completed === "function" ? options.completed(value) : options.completed,
    );
    return value;
  } catch (error) {
    handle.fail({ failureStage: options.failureStage });
    throw error;
  }
}

function defaultNow(): number {
  return typeof performance !== "undefined"
    ? performance.timeOrigin + performance.now()
    : Date.now();
}

function randomHex(bytes: 8 | 16): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}
