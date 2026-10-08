import { mergeLocalTtftFacts } from "@/v4/telemetry/localTtftFacts.js";
import {
  buildLocalTtftRecord,
  type LocalTtftPending as Pending,
} from "@/v4/telemetry/localTtftRecord.js";
import { logger } from "@/logger.js";
import {
  LOCAL_TTFT_MAX_PENDING,
  LOCAL_TTFT_TTL_MS,
  LOCAL_TTFT_CLOCK_TTL_MS,
  localTtftNow,
  type LocalTtftContext,
  type LocalTtftCalibration,
  type LocalTtftFacts,
  type LocalTtftRecord,
  type LocalTtftOutputKind,
} from "@zcode/shared";
import type {
  ConversationTopicFrame,
  TopicFrameDeliveryKind,
} from "@zcode/shared/zcode-protocol-v4";

/** Renderer 独占点击总时钟；不使用 ACK 或旁路 telemetry 判定首输出。 */
export class LocalTtftObserver {
  enabled = false;
  private readonly pending = new Map<string, Pending>();
  private isForeground = true;
  private lastClockSample?: number;
  private readonly clocks = new Map<string, LocalTtftCalibration>();
  constructor(
    private readonly onRecord: (record: LocalTtftRecord) => void,
    private readonly now = localTtftNow,
    private readonly wallNow = Date.now,
    private readonly readForeground?: () => boolean,
  ) {}
  private emit(record: LocalTtftRecord): void {
    try {
      this.onRecord(record);
    } catch {
      /* 观测失败不能阻断提交、内容投影或清理。 */
    }
  }
  start(workspace: string, busy: boolean, unsupported = false): LocalTtftContext | undefined {
    if (!this.enabled) return undefined;
    this.expire();
    if (this.readForeground) this.visibility(this.readForeground());
    const context: LocalTtftContext = { version: 1, observationId: crypto.randomUUID() };
    const pending: Pending = {
      context,
      workspace,
      start: this.now(),
      wallStart: this.wallNow(),
      checkpointRevision: 0,
      lastSeq: -1,
      rows: new Map(),
      sendMode: busy ? "queued" : "idle",
      visibility: this.isForeground ? "foreground" : "background",
      visibilityChanges: [{ at: this.now(), foreground: this.isForeground }],
      confirmations: [],
    };
    this.emit(this.record(pending, "start", "success"));
    if (this.pending.size >= LOCAL_TTFT_MAX_PENDING) {
      const completed = [...this.pending].find(([, value]) => value.closed);
      if (completed) this.pending.delete(completed[0]);
    }
    if (this.pending.size >= LOCAL_TTFT_MAX_PENDING) {
      this.emit(this.record(pending, "excluded", "capacity"));
      return undefined;
    }
    if (unsupported) {
      this.emit(this.record(pending, "excluded", "unsupported"));
      return;
    }
    this.pending.set(context.observationId, pending);
    return context;
  }
  dispatch(
    context: LocalTtftContext,
    workspace: string,
    commandId: string,
    sessionId?: string | null,
  ): LocalTtftContext | undefined {
    const pending = this.pending.get(context.observationId);
    if (!pending || pending.workspace !== workspace) return undefined;
    pending.dispatch ??= this.now();
    pending.commandId ??= commandId;
    pending.sessionId ??= sessionId ?? undefined;
    this.emit(this.record(pending, "checkpoint", "success"));
    return context;
  }
  ack(context: LocalTtftContext, status: string, excluded?: "capacity"): void {
    if (excluded) {
      this.exclude(context, excluded);
      return;
    }
    if (status !== "accepted" && status !== "duplicate")
      this.exclude(context, status === "rejected" ? "rejected" : "failed");
  }
  calibrate(workspace: string, clock: LocalTtftCalibration): void {
    if (this.clocks.size >= LOCAL_TTFT_MAX_PENDING)
      this.clocks.delete(this.clocks.keys().next().value!);
    this.clocks.set(workspace, clock);
  }
  needsCalibration(workspace: string): boolean {
    const sample = this.clocks.get(workspace);
    return this.enabled && (!sample || this.now() - sample.measuredAt > LOCAL_TTFT_CLOCK_TTL_MS);
  }
  checkpoint(workspace: string, incoming: LocalTtftFacts): void {
    const pending = this.merge(workspace, incoming);
    if (!pending) return;
    const signature = JSON.stringify(pending.facts);
    if (signature === pending.checkpointSignature) return;
    pending.checkpointSignature = signature;
    this.emit(this.record(pending, "checkpoint", pending.outcome ?? "unclosed"));
    if (pending.facts?.sendMode === "guided" && !pending.closed)
      this.exclude(pending.context, "guided");
    if (pending.facts?.terminal && pending.facts.outputAt === undefined && !pending.closed)
      this.exclude(
        pending.context,
        pending.facts.terminal === "completed" ? "unsupported" : pending.facts.terminal,
      );
  }
  private merge(workspace: string, incoming: LocalTtftFacts): Pending | undefined {
    const pending = this.pending.get(incoming.observationId);
    if (
      !pending ||
      pending.workspace !== workspace ||
      pending.commandId !== incoming.commandId ||
      (pending.sessionId && incoming.sessionId && pending.sessionId !== incoming.sessionId)
    )
      return;
    const facts = mergeLocalTtftFacts(pending.facts, incoming);
    if (!facts) return;
    pending.facts = facts;
    return pending;
  }
  receive(
    workspace: string,
    frame: ConversationTopicFrame,
    delivery: TopicFrameDeliveryKind,
  ): void {
    // 首次订阅快照可能晚于准备检查点；它不是 gap recovery，也绝不是首输出。
    if (delivery === "initial") return;
    for (const facts of frame.ttftRelated ?? [])
      this.receive(workspace, { ...frame, ttft: facts, ttftRelated: undefined }, delivery);
    if (delivery === "recovery" || frame.payload.kind === "snapshot") {
      // Bug 原因：桌面 continuous 在订阅缓冲溢出或投影重建后会用 online snapshot 代替 deltas，
      // 之前一律记为 recovery，把手机恢复语义贴到桌面样本上。snapshot 内无法唯一归因首输出，
      // 仍需排除，但按 resync 单独标记；recovery 只保留给真正的 recovery 投递。
      const outcome = delivery === "recovery" ? "recovery" : "resync";
      for (const pending of this.pending.values()) {
        if (
          pending.workspace === workspace &&
          frame.topic === `conversation/${pending.sessionId ?? pending.facts?.sessionId}`
        )
          this.exclude(pending.context, outcome);
      }
      return;
    }
    let facts = frame.ttft;
    if (!facts) return;
    if (
      delivery !== "online" ||
      frame.payload.kind !== "deltas" ||
      frame.topic !== `conversation/${facts.sessionId}`
    )
      return;
    const pending = this.merge(workspace, facts);
    if (!pending) return;
    if (!pending.facts?.outputAt && facts.outputAt)
      logger.debug("[local-ttft] actual content frame", {
        commandId: facts.commandId,
        turnId: facts.turnId,
        productTurnId: facts.productTurnId,
        outputKind: facts.outputKind,
        rows: frame.payload.deltas.flatMap((delta) =>
          delta.op === "row.appended" || delta.op === "row.upserted"
            ? [{ kind: delta.row.kind, turnId: delta.row.turnId }]
            : [],
        ),
      });
    this.checkpoint(workspace, facts);
    facts = pending.facts!;
    if (pending.textClosed) return;
    if (facts.excluded) {
      this.exclude(pending.context, facts.excluded);
      return;
    }
    if (frame.toSeq <= pending.lastSeq) return;
    pending.lastSeq = frame.toSeq;
    for (const delta of frame.payload.deltas) {
      let kind: LocalTtftOutputKind | undefined;
      if (delta.op === "row.appended" || delta.op === "row.upserted") {
        const row = delta.row;
        if (row.turnId !== facts.productTurnId) continue;
        if (pending.rows.size < 128)
          pending.rows.set(row.rowId, { turnId: row.turnId, kind: row.kind });
        if ((row.kind === "assistantText" || row.kind === "reasoning") && row.text.trim())
          kind = row.kind === "assistantText" ? "text" : "reasoning";
        if (
          row.kind === "toolCall" &&
          row.toolName.trim() &&
          (row.inputText.trim() || row.status !== "inputStreaming")
        )
          kind = "tool";
      } else if (delta.op === "row.delta" && delta.append.trim()) {
        const row = pending.rows.get(delta.rowId);
        if (!row || row.turnId !== facts.productTurnId) continue;
        if (row.kind === "assistantText" && delta.path === "text") kind = "text";
        if (row.kind === "reasoning" && delta.path === "text") kind = "reasoning";
        if (row.kind === "toolCall" && delta.path === "inputText") kind = "tool";
      }
      if (!kind || facts.outputAt === undefined) continue;
      if (!pending.first && !pending.closed) {
        pending.first = kind;
        pending.firstAt = this.now();
        pending.closed = true;
        pending.outcome = "success";
        const completed = this.record(pending, "first_output", "success");
        this.emit(completed);
      }
      if (kind === "text") {
        this.emit(this.record(pending, "first_text", "success"));
        pending.textClosed = true;
        return;
      }
    }
    if (facts.terminal && !pending.textClosed) {
      this.emit(
        this.record(
          pending,
          pending.first ? "no_text" : "excluded",
          pending.first
            ? "success"
            : facts.terminal === "completed"
              ? "unsupported"
              : facts.terminal,
        ),
      );
      pending.closed = true;
      pending.textClosed = true;
    }
  }
  exclude(context: LocalTtftContext, outcome: LocalTtftRecord["outcome"]): void {
    const pending = this.pending.get(context.observationId);
    if (!pending) return;
    if (pending.closed) {
      if (pending.first && !pending.textClosed) {
        this.emit(this.record(pending, "no_text", outcome));
        pending.textClosed = true;
      }
      return;
    }
    if (pending.confirmationStart !== undefined) this.confirmation(context, false);
    this.emit(this.record(pending, pending.first ? "no_text" : "excluded", outcome));
    pending.closed = true;
    pending.outcome = outcome;
    pending.textClosed = true;
  }
  confirmationRetry(context: LocalTtftContext): void {
    const pending = this.pending.get(context.observationId);
    if (!pending || pending.closed) return;
    // stale 确认拒绝没有 accepted input；下一次命令仍沿首次点击，但不能绑定已拒绝命令。
    pending.commandId = undefined;
    pending.facts = undefined;
  }
  confirmation(context: LocalTtftContext, waiting: boolean): void {
    const pending = this.pending.get(context.observationId);
    if (!pending) return;
    if (waiting) pending.confirmationStart ??= this.now();
    else if (pending.confirmationStart !== undefined) {
      if (pending.confirmations.length < 32)
        pending.confirmations.push({
          id: `confirmation:${pending.confirmations.length}`,
          stage: "user_confirmation",
          start: pending.confirmationStart,
          end: this.now(),
          source: "renderer",
          outcome: "completed",
        });
      pending.confirmationStart = undefined;
    }
  }
  background(): void {
    this.visibility(false);
  }
  foreground(): void {
    this.visibility(true);
  }
  private visibility(foreground: boolean): void {
    this.isForeground = foreground;
    for (const pending of this.pending.values()) {
      if (pending.closed) continue;
      if ((pending.visibility !== "background") === foreground) continue;
      pending.visibility = foreground ? "background_returned" : "background";
      if (pending.visibilityChanges.length < 32)
        pending.visibilityChanges.push({ at: this.now(), foreground });
      this.emit(this.record(pending, "checkpoint", "unclosed"));
    }
  }
  sampleClock(): void {
    const now = this.now();
    if (this.lastClockSample !== undefined && now - this.lastClockSample > 5000)
      for (const pending of this.pending.values()) if (!pending.closed) pending.clockInvalid = true;
    this.lastClockSample = now;
  }
  interrupt(workspace?: string): void {
    for (const pending of this.pending.values())
      if (workspace === undefined || pending.workspace === workspace)
        this.exclude(pending.context, "interrupted");
    if (workspace === undefined) this.clocks.clear();
    else this.clocks.delete(workspace);
  }
  expire(): void {
    for (const pending of this.pending.values())
      if (this.now() - pending.start > LOCAL_TTFT_TTL_MS) {
        if (!pending.closed) this.exclude(pending.context, "unclosed");
        this.pending.delete(pending.context.observationId);
      }
  }
  private record(
    pending: Pending,
    kind: LocalTtftRecord["kind"],
    outcome: LocalTtftRecord["outcome"],
  ): LocalTtftRecord {
    return buildLocalTtftRecord(
      pending,
      kind,
      outcome,
      this.now(),
      this.wallNow(),
      this.clocks.get(pending.workspace),
    );
  }
}
let observer: LocalTtftObserver | undefined;
export function setLocalTtftObserver(value: LocalTtftObserver | undefined): void {
  observer = value;
}
export function getLocalTtftObserver(): LocalTtftObserver | undefined {
  return observer;
}
