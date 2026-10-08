// V4 已提交命令的 renderer 持久账本。
// 它只保存客户端恢复线索，不参与 conversation projection，也绝不能据此自动重放。
import type {
  CommandAck,
  CommandEnvelope,
  CommandsQueryParams,
  CommandsQueryResult,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import type { PendingCommandClientContext } from "@/v4/pendingCommandWorkspace.js";
import { pendingCommandReplayFor, type PendingCommandReplay } from "@/v4/pendingCommandReplay.js";
export type { PendingCommandReplay } from "@/v4/pendingCommandReplay.js";

const PENDING_COMMAND_TTL_MS = 24 * 60 * 60 * 1_000;
const STORAGE_KEY = "zcode-v4-pending-commands:v1";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type PendingCommandRecoveryReason = "discarded";

export interface PendingCommandEntry {
  commandId: string;
  clientId: string;
  sessionId: string | null;
  issuedAt: number;
  expiresAt: number;
  replay: PendingCommandReplay;
  clientContext?: PendingCommandClientContext;
  recovery?: PendingCommandRecoveryReason;
  recoveryDismissed?: boolean;
}

interface PendingCommandReplayRequest {
  type: "sendText" | "sendGoalCommand" | "compact" | "createSession";
  payload: Record<string, unknown>;
  sessionId: string | null;
  baseRevision?: number;
  clientContext?: PendingCommandClientContext;
}

interface PendingCommandRegistryOptions {
  storage?: StorageLike;
  now?: () => number;
}

type QueryCommands = (params: CommandsQueryParams) => Promise<CommandsQueryResult>;

function browserStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function keyOf(sessionId: string | null, commandId: string): string {
  return `${sessionId ?? "<global>"}\u0000${commandId}`;
}

function clonePayload(payload: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
}

function isEntry(value: unknown): value is PendingCommandEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<PendingCommandEntry>;
  return (
    typeof entry.commandId === "string" &&
    typeof entry.clientId === "string" &&
    (typeof entry.sessionId === "string" || entry.sessionId === null) &&
    typeof entry.issuedAt === "number" &&
    typeof entry.expiresAt === "number" &&
    Boolean(entry.replay) &&
    typeof entry.replay === "object"
  );
}

function isRuntimeLocalDiscard(ack: CommandAck): boolean {
  return (
    ack.reasonCode === "fault.command.inputDiscardedOnRestart" &&
    ack.result?.type === "inputDisposition" &&
    (ack.result.delivery === "queue" || ack.result.delivery === "guide")
  );
}

/**
 * ACK、queue 与 transcript 曾分别维护临时状态；renderer 刷新或 ACK 丢失后，
 * UI 已清空但无法证明 CLI 是否 admission。这里把“待对账线索”先于上行持久化，并用
 * queue/guided/transcript sourceCommandId 或显式终态收口；registry 本身永远不产生权威事实。
 */
class PendingCommandRegistry {
  private readonly storage: StorageLike | undefined;
  private readonly now: () => number;
  private readonly entries = new Map<string, PendingCommandEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly reconcileInFlight = new Map<string, Promise<void>>();

  constructor(options: PendingCommandRegistryOptions = {}) {
    this.storage = options.storage ?? browserStorage();
    this.now = options.now ?? Date.now;
    this.load();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  record(
    envelope: CommandEnvelope,
    clientContext?: PendingCommandClientContext,
  ): PendingCommandEntry | null {
    this.pruneExpired();
    const replay = pendingCommandReplayFor(envelope);
    if (!replay) return null;
    const key = keyOf(envelope.sessionId, envelope.commandId);
    const existing = this.entries.get(key);
    if (existing) return existing;
    const entry: PendingCommandEntry = {
      commandId: envelope.commandId,
      clientId: envelope.clientId,
      sessionId: envelope.sessionId,
      issuedAt: envelope.issuedAt,
      // TTL 锚定首次登记时间；reload/reconcile 不得续期。
      expiresAt: this.now() + PENDING_COMMAND_TTL_MS,
      replay,
      ...(clientContext ? { clientContext } : {}),
    };
    this.entries.set(key, entry);
    this.commit();
    return entry;
  }

  list(sessionId: string | null): readonly PendingCommandEntry[] {
    this.pruneExpired();
    return [...this.entries.values()]
      .filter((entry) => entry.sessionId === sessionId)
      .sort((left, right) => left.issuedAt - right.issuedAt);
  }

  listRecoverable(sessionId: string | null): readonly PendingCommandEntry[] {
    return this.list(sessionId).filter(
      // 兼容 V4 初版已经写入 localStorage 的 unknown：它不是可操作错误，不能再进入 UI。
      (entry) => entry.recovery === "discarded" && !entry.recoveryDismissed,
    );
  }

  settle(sessionId: string | null, commandId: string): void {
    if (!this.entries.delete(keyOf(sessionId, commandId))) return;
    this.commit();
  }

  dismissRecovery(sessionId: string | null, commandId: string): void {
    const key = keyOf(sessionId, commandId);
    const entry = this.entries.get(key);
    if (!entry?.recovery || entry.recoveryDismissed) return;
    this.entries.set(key, { ...entry, recoveryDismissed: true });
    this.commit();
  }

  applyAck(envelope: CommandEnvelope, ack: CommandAck): void {
    let entry = this.entries.get(keyOf(envelope.sessionId, envelope.commandId));
    if (!entry) return;
    if (entry.replay.kind === "sensitiveDigest") {
      // 交互答案不可重放；拿到确定 ACK 后其对账职责已结束。
      this.settle(entry.sessionId, entry.commandId);
      return;
    }
    entry = this.remapCreatedSession(entry, ack);
    if (ack.status === "accepted" || ack.status === "duplicate") {
      this.clearRecovery(entry);
      return;
    }
    if (ack.status === "failed" && ack.reasonCode === "fault.command.inputDiscardedOnRestart") {
      if (isRuntimeLocalDiscard(ack)) {
        this.settle(entry.sessionId, entry.commandId);
        return;
      }
      this.markRecovery(entry, "discarded");
      return;
    }
    this.settle(entry.sessionId, entry.commandId);
  }

  applyQuery(result: CommandsQueryResult): void {
    for (const item of result.results) {
      let entry = this.entries.get(keyOf(item.key.sessionId, item.key.commandId));
      if (!entry) continue;
      if (item.result === "unknown") {
        // V4 初版把“权威事实未命中”提升成需要用户处理的错误横幅，导致正常的
        // App/CLI 生命周期切换也频繁打扰用户。unknown 没有可操作结论，renderer 静默清账。
        this.settle(entry.sessionId, entry.commandId);
        continue;
      }
      if (
        item.result.status === "failed" &&
        item.result.reasonCode === "fault.command.queryUnavailable"
      ) {
        continue;
      }
      if (
        item.result.status === "failed" &&
        item.result.reasonCode === "fault.command.inputDiscardedOnRestart"
      ) {
        if (isRuntimeLocalDiscard(item.result)) {
          this.settle(entry.sessionId, entry.commandId);
          continue;
        }
        this.markRecovery(entry, "discarded");
        continue;
      }
      entry = this.remapCreatedSession(entry, item.result);
      if (entry.replay.kind === "sensitiveDigest") {
        this.settle(entry.sessionId, entry.commandId);
        continue;
      }
      if (item.result.status === "accepted" || item.result.status === "duplicate") {
        this.clearRecovery(entry);
      } else {
        this.settle(entry.sessionId, entry.commandId);
      }
    }
  }

  reconcileSnapshot(snapshot: ConversationSnapshot): void {
    const settled = new Set<string>();
    for (const item of snapshot.queue.items) {
      if (item.sourceCommandId) {
        // 把“进入 queue”当成仍未投递的话，直到 transcript 才清理
        // localStorage；App/CLI 重启后旧 runtime queue 被正常丢弃，却又触发重发提示。
        // queue projection 已是 CLI 权威接收证据，renderer ingress 账本应在此结算。
        settled.add(item.sourceCommandId);
      }
    }
    for (const row of snapshot.rows.window) {
      if (row.kind === "userInput" && row.sourceCommandId) {
        settled.add(row.sourceCommandId);
      }
      if (row.kind === "timelineMarker" && row.marker.type === "compact" && row.sourceCommandId) {
        // compact 不产生 user row；timeline marker 是该维护命令已开始执行的权威证据。
        settled.add(row.sourceCommandId);
      }
    }
    if (settled.size === 0) return;
    let changed = false;
    for (const commandId of settled) {
      changed = this.entries.delete(keyOf(snapshot.sessionId, commandId)) || changed;
    }
    if (changed) this.commit();
  }

  reconcileSession(sessionId: string | null, query: QueryCommands): Promise<void> {
    const inFlightKey = sessionId ?? "<global>";
    const existing = this.reconcileInFlight.get(inFlightKey);
    if (existing) return existing;
    const pending = this.runReconcile(sessionId, query).finally(() => {
      if (this.reconcileInFlight.get(inFlightKey) === pending) {
        this.reconcileInFlight.delete(inFlightKey);
      }
    });
    this.reconcileInFlight.set(inFlightKey, pending);
    return pending;
  }

  consumeReplay(key: {
    sessionId: string | null;
    commandId: string;
  }): PendingCommandReplayRequest | null {
    const entry = this.entries.get(keyOf(key.sessionId, key.commandId));
    if (!entry || entry.replay.kind !== "input") return null;
    const request: PendingCommandReplayRequest = {
      type: entry.replay.type,
      payload: clonePayload(entry.replay.payload),
      sessionId: entry.sessionId,
      ...(entry.replay.baseRevision !== undefined
        ? { baseRevision: entry.replay.baseRevision }
        : {}),
      ...(entry.clientContext ? { clientContext: entry.clientContext } : {}),
    };
    // 用户已确认以新 commandId 重发，旧 discarded 线索在本地完成收口。
    this.settle(entry.sessionId, entry.commandId);
    return request;
  }

  private async runReconcile(sessionId: string | null, query: QueryCommands): Promise<void> {
    const entries = this.list(sessionId);
    for (let offset = 0; offset < entries.length; offset += 64) {
      const batch = entries.slice(offset, offset + 64);
      const result = await query({
        commands: batch.map((entry) => ({
          sessionId: entry.sessionId,
          commandId: entry.commandId,
        })),
      });
      this.applyQuery(result);
    }
  }

  private markRecovery(entry: PendingCommandEntry, recovery: PendingCommandRecoveryReason): void {
    if (entry.recovery === recovery) return;
    this.entries.set(keyOf(entry.sessionId, entry.commandId), {
      ...entry,
      recovery,
      recoveryDismissed: false,
    });
    this.commit();
  }

  private clearRecovery(entry: PendingCommandEntry): void {
    if (!entry.recovery && !entry.recoveryDismissed) return;
    const { recovery: _recovery, recoveryDismissed: _dismissed, ...settled } = entry;
    this.entries.set(keyOf(entry.sessionId, entry.commandId), settled);
    this.commit();
  }

  private remapCreatedSession(entry: PendingCommandEntry, ack: CommandAck): PendingCommandEntry {
    if (
      entry.replay.kind !== "input" ||
      entry.replay.type !== "createSession" ||
      (ack.status !== "accepted" && ack.status !== "duplicate") ||
      ack.result?.type !== "createSession" ||
      entry.sessionId === ack.result.sessionId
    ) {
      return entry;
    }
    this.entries.delete(keyOf(entry.sessionId, entry.commandId));
    const remapped = { ...entry, sessionId: ack.result.sessionId };
    this.entries.set(keyOf(remapped.sessionId, remapped.commandId), remapped);
    this.commit();
    return remapped;
  }

  private load(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      for (const value of parsed) {
        if (isEntry(value)) {
          this.entries.set(keyOf(value.sessionId, value.commandId), value);
        }
      }
      this.pruneExpired();
    } catch {
      // storage 损坏不能阻断聊天；丢弃的是客户端恢复线索，不影响 CLI 权威事实。
      this.entries.clear();
    }
  }

  private pruneExpired(): void {
    const now = this.now();
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) this.commit();
  }

  private commit(): void {
    if (this.storage) {
      try {
        if (this.entries.size === 0) {
          this.storage.removeItem(STORAGE_KEY);
        } else {
          this.storage.setItem(STORAGE_KEY, JSON.stringify([...this.entries.values()]));
        }
      } catch {
        // quota/incognito：退化为当前 renderer 内存账本。
      }
    }
    for (const listener of this.listeners) listener();
  }
}

export const pendingCommandRegistry = new PendingCommandRegistry();
