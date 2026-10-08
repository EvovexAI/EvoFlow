import { resolveWorkspaceKey, type ZCodeComputerUseOperationEvent } from "@zcode/shared";
import type { PipSessionEvent } from "@zcode/zcode-cua/pip-session";

export interface CuaOperationWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface CuaOperationState {
  active: boolean;
  sessionId: string;
  turnId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface CuaOperationStateReporter {
  onStateChanged(event: CuaOperationState): void;
}

interface CuaOperationTurnTracker {
  accept(workspace: CuaOperationWorkspaceTarget, event: ZCodeComputerUseOperationEvent): void;
  /** 当前是否存在仍在执行 Computer Use 工具的 turn。 */
  hasActiveTurn(): boolean;
  clearWorkspaceKey(workspaceKey: string): void;
  clearAll(): void;
}

interface TrackerLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

interface ActiveTurnRecord extends CuaOperationState {
  workspaceKey: string;
  sessionKey: string;
  turnKey: string;
}

const MAX_RETIRED_TURN_KEYS = 2_048;
const MAX_SEEN_OPERATION_EVENT_IDS = 8_192;

function toReportedState(record: ActiveTurnRecord, active: boolean): CuaOperationState {
  return {
    active,
    sessionId: record.sessionId,
    turnId: record.turnId,
    workspacePath: record.workspacePath,
    ...(record.workspaceIdentity ? { workspaceIdentity: record.workspaceIdentity } : {}),
  };
}

export function createCuaOperationTurnTracker(options: {
  /** Windows 顶部提示条的桌面投影；非 win32 不注入。 */
  reporter?: CuaOperationStateReporter;
  /** Windows operation indicator 的聚合边界；PiP 不再消费该聚合状态。 */
  onTurnsActive?: () => void;
  onTurnsIdle?: () => void;
  /** macOS desktop-local PiP 只消费这些产品事实；panel policy 留在 producer。 */
  onPipSessionLifecycle?: (
    workspace: CuaOperationWorkspaceTarget,
    event: Exclude<PipSessionEvent, { kind: "focus-changed" }>,
  ) => void;
  logger?: TrackerLogger;
}): CuaOperationTurnTracker {
  const currentTurnBySession = new Map<string, string>();
  const lastSeqBySession = new Map<string, number>();
  /**
   * 已排期、且经确认在用 Computer Use 的 tool call（键为 turnKey\0toolCallId）。
   *
   * 只有 tool-scheduled 携带模型源码（ToolCallStartedPayload 没有 input 字段），所以
   * "是否 CUA" 只能在排期时判定；但浮层要等真正开始执行才亮——排期与开始之间可能卡在
   * 权限审批上，那时还没有人在操作电脑。于是这里把排期时的事实存下来，交给 tool-started 兑现。
   */
  const computerUseScheduledCalls = new Set<string>();
  const activeTurns = new Map<string, ActiveTurnRecord>();
  const retiredTurnKeys = new Set<string>();
  const retiredTurnKeyOrder: string[] = [];
  const seenEventIds = new Set<string>();
  const seenEventIdOrder: string[] = [];

  const sessionKeyFor = (workspaceKey: string, sessionId: string) =>
    `${workspaceKey}\0${sessionId}`;
  const turnKeyFor = (sessionKey: string, turnId: string) => `${sessionKey}\0${turnId}`;
  const toolKeyFor = (turnKey: string, toolCallId: string) => `${turnKey}\0${toolCallId}`;

  function notifyBoundary(kind: "active" | "idle"): void {
    const callback = kind === "active" ? options.onTurnsActive : options.onTurnsIdle;
    if (!callback) return;
    options.logger?.info(
      `CUA operation turns ${kind === "active" ? "became active" : "went idle"} (activeTurns=${activeTurns.size})`,
    );
    try {
      callback();
    } catch (error) {
      // 边界回调是展示旁路（PiP 收口），不能截断主 session event 链路。
      options.logger?.warn(`CUA operation turn boundary callback failed error=${String(error)}`);
    }
  }

  function publishPipLifecycle(
    workspace: CuaOperationWorkspaceTarget,
    event: Exclude<PipSessionEvent, { kind: "focus-changed" }>,
  ): void {
    try {
      options.onPipSessionLifecycle?.(workspace, event);
    } catch (error) {
      options.logger?.warn(
        `CUA PiP lifecycle publisher failed session=${event.sessionId} event=${event.kind} error=${String(error)}`,
      );
    }
  }

  function report(record: ActiveTurnRecord, active: boolean, refresh = false): void {
    if (options.reporter) {
      try {
        options.reporter.onStateChanged(toReportedState(record, active));
      } catch (error) {
        // Reporter 是桌面投影旁路；MessagePort 关闭竞态不能截断主 session event 链路。
        options.logger?.warn(
          `CUA operation reporter failed workspace=${record.workspaceKey} session=${record.sessionId} turn=${record.turnId} error=${String(error)}`,
        );
      }
    }
    const message = `CUA operation turn ${active ? "activated" : "cleared"} workspace=${record.workspaceKey} session=${record.sessionId} turn=${record.turnId}`;
    if (refresh) {
      options.logger?.debug(message);
    } else {
      options.logger?.info(message);
    }
  }

  function retireTurn(turnKey: string): void {
    if (retiredTurnKeys.has(turnKey)) return;
    retiredTurnKeys.add(turnKey);
    retiredTurnKeyOrder.push(turnKey);
    while (retiredTurnKeyOrder.length > MAX_RETIRED_TURN_KEYS) {
      const removed = retiredTurnKeyOrder.shift();
      if (removed) retiredTurnKeys.delete(removed);
    }
  }

  function clearTurn(turnKey: string): void {
    const record = activeTurns.get(turnKey);
    if (record) {
      activeTurns.delete(turnKey);
      report(record, false);
    }
    const toolPrefix = `${turnKey}\0`;
    for (const key of computerUseScheduledCalls) {
      if (key.startsWith(toolPrefix)) computerUseScheduledCalls.delete(key);
    }
    // 只有真的清掉了一个操作 turn 才可能归零；从未 active 过的 turn 不会触发边界。
    if (record && activeTurns.size === 0) notifyBoundary("idle");
  }

  function clearSession(sessionKey: string): void {
    for (const record of activeTurns.values()) {
      if (record.sessionKey === sessionKey) clearTurn(record.turnKey);
    }
    const sessionPrefix = `${sessionKey}\0`;
    for (const key of computerUseScheduledCalls) {
      if (key.startsWith(sessionPrefix)) computerUseScheduledCalls.delete(key);
    }
  }

  function accept(
    workspace: CuaOperationWorkspaceTarget,
    event: ZCodeComputerUseOperationEvent,
  ): void {
    const workspaceKey = resolveWorkspaceKey(workspace);
    const sessionKey = sessionKeyFor(workspaceKey, event.sessionId);
    const eventKey = `${workspaceKey}\0${event.eventId}`;
    if (seenEventIds.has(eventKey)) return;
    seenEventIds.add(eventKey);
    seenEventIdOrder.push(eventKey);
    while (seenEventIdOrder.length > MAX_SEEN_OPERATION_EVENT_IDS) {
      const removed = seenEventIdOrder.shift();
      if (removed) seenEventIds.delete(removed);
    }

    const lastSeq = lastSeqBySession.get(sessionKey) ?? 0;
    if (event.sequenceNumber < lastSeq) {
      options.logger?.debug(
        `ignored stale CUA operation event sequenceNumber=${event.sequenceNumber} lastSeq=${lastSeq} session=${event.sessionId}`,
      );
      return;
    }
    // sideband 使用 runtime 原始 sequenceNumber；不能与旧 session/event 的投影 seq
    // 混用，否则较大的 raw 序号会让后续旧协议终态被误判为迟到并留下永久浮层。
    lastSeqBySession.set(sessionKey, Math.max(lastSeq, event.sequenceNumber));

    if (event.kind === "turn-started") {
      if (!event.turnId) return;
      const nextTurnKey = turnKeyFor(sessionKey, event.turnId);
      if (retiredTurnKeys.has(nextTurnKey)) return;
      publishPipLifecycle(workspace, {
        kind: "turn-started",
        sessionId: event.sessionId,
        turnId: event.turnId,
        sequenceNumber: event.sequenceNumber,
        eventId: event.eventId,
      });
      const previousTurnId = currentTurnBySession.get(sessionKey);
      if (previousTurnId && previousTurnId !== event.turnId) {
        retireTurn(turnKeyFor(sessionKey, previousTurnId));
        clearSession(sessionKey);
      }
      currentTurnBySession.set(sessionKey, event.turnId);
      return;
    }

    if (event.kind === "session-closed") {
      publishPipLifecycle(workspace, {
        kind: "session-closed",
        sessionId: event.sessionId,
        sequenceNumber: event.sequenceNumber,
        eventId: event.eventId,
      });
      const currentTurnId = currentTurnBySession.get(sessionKey);
      if (currentTurnId) retireTurn(turnKeyFor(sessionKey, currentTurnId));
      clearSession(sessionKey);
      currentTurnBySession.delete(sessionKey);
      return;
    }

    if (event.kind === "turn-completed" || event.kind === "turn-failed") {
      const turnId = event.turnId;
      if (!turnId) return;
      publishPipLifecycle(workspace, {
        kind: "turn-ended",
        sessionId: event.sessionId,
        turnId,
        sequenceNumber: event.sequenceNumber,
        eventId: event.eventId,
        outcome: event.kind === "turn-completed" ? "completed" : "failed",
      });
      const turnKey = turnKeyFor(sessionKey, turnId);
      retireTurn(turnKey);
      clearTurn(turnKey);
      if (currentTurnBySession.get(sessionKey) === turnId) {
        currentTurnBySession.delete(sessionKey);
      }
      return;
    }

    if (event.kind !== "tool-scheduled" && event.kind !== "tool-started") return;
    const toolCallId = event.toolCallId;
    const currentTurnId = currentTurnBySession.get(sessionKey);
    const turnId = event.turnId ?? currentTurnId;
    if (!toolCallId || !turnId) return;
    // 根因：新 turn 已替换旧 turn 后，迟到的旧 tool event 不能再次复活已终止的顶部提示。
    if (currentTurnId && turnId !== currentTurnId) return;
    if (!currentTurnId) currentTurnBySession.set(sessionKey, turnId);

    const turnKey = turnKeyFor(sessionKey, turnId);
    if (retiredTurnKeys.has(turnKey)) return;
    const toolKey = toolKeyFor(turnKey, toolCallId);
    if (event.kind === "tool-scheduled") {
      if (event.computerUse) computerUseScheduledCalls.add(toolKey);
      return;
    }

    // 只认"这次 tool call 在用 Computer Use"这一个布尔事实，不解析动作名：
    // 动作名要从模型源码里抽出来再拿动作词表比对，SDK 面一改就整条链失配。
    // 判定在 bootstrap 侧一次做完（usesComputerUse）。
    if (!computerUseScheduledCalls.delete(toolKey)) return;

    const existingRecord = activeTurns.get(turnKey);
    if (existingRecord) {
      // 同一 turn 内每个新 CUA cell 都要刷新桌面浮层的安全截止时间；Reporter 会在 Main 侧
      // 重置兜底计时器，但不会重复创建原生窗口。
      report(existingRecord, true, true);
      return;
    }

    const record: ActiveTurnRecord = {
      active: true,
      workspaceKey,
      sessionKey,
      turnKey,
      sessionId: event.sessionId,
      turnId,
      workspacePath: workspace.workspacePath,
      ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
    };
    activeTurns.set(turnKey, record);
    report(record, true);
    if (activeTurns.size === 1) notifyBoundary("active");
  }

  function clearWorkspaceKey(workspaceKey: string): void {
    for (const record of activeTurns.values()) {
      if (record.workspaceKey === workspaceKey) clearTurn(record.turnKey);
    }
    const workspacePrefix = `${workspaceKey}\0`;
    for (const key of currentTurnBySession.keys()) {
      if (key.startsWith(workspacePrefix)) currentTurnBySession.delete(key);
    }
    for (const key of lastSeqBySession.keys()) {
      if (key.startsWith(workspacePrefix)) lastSeqBySession.delete(key);
    }
    for (const key of computerUseScheduledCalls) {
      if (key.startsWith(workspacePrefix)) computerUseScheduledCalls.delete(key);
    }
    for (let index = retiredTurnKeyOrder.length - 1; index >= 0; index -= 1) {
      const key = retiredTurnKeyOrder[index];
      if (!key?.startsWith(workspacePrefix)) continue;
      retiredTurnKeyOrder.splice(index, 1);
      retiredTurnKeys.delete(key);
    }
    for (let index = seenEventIdOrder.length - 1; index >= 0; index -= 1) {
      const key = seenEventIdOrder[index];
      if (!key?.startsWith(workspacePrefix)) continue;
      seenEventIdOrder.splice(index, 1);
      seenEventIds.delete(key);
    }
  }

  function clearAll(): void {
    for (const record of activeTurns.values()) clearTurn(record.turnKey);
    currentTurnBySession.clear();
    lastSeqBySession.clear();
    computerUseScheduledCalls.clear();
    retiredTurnKeys.clear();
    retiredTurnKeyOrder.length = 0;
    seenEventIds.clear();
    seenEventIdOrder.length = 0;
  }

  return {
    accept,
    hasActiveTurn: () => activeTurns.size > 0,
    clearWorkspaceKey,
    clearAll,
  };
}
