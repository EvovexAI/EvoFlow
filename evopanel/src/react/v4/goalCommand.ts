// goalCommand — 主聊天 composer 的 ZCode 式目标命令发送（/goal → v4 命令面）。
//
// - 命令：sendGoalCommand / pauseGoal / resumeGoal（schema 见
//   zcode-shared/zcode-protocol-v4/command.ts，sendGoalCommand 非 CAS、
//   pauseGoal/resumeGoal 为 CAS 命令需 snapshot.revision）。
// - sessionId = LangGraph thread_id（v4 会话 1:1）；由 wsClient.resolveSessionThreadId
//   解析，与 chatSend 的 thread 解析共用同一缓存。
// - revision：从共享 SessionDataLayer 的投影 store 读最新 snapshot.revision
//   （必须复用 V4StreamRowsBridge 的共享层——自建 SessionDataLayer 会开出
//   第二条 frames SSE 连接）；store 未建立/无快照时 CAS 命令无法构造信封，
//   返回失败由调用方 toast 提示稍后重试。
// - 全链路日志（[v4-goal]）落 frontend log；transport 异常兜底成失败结果，
//   不再静默抛出。rejected 的用户可见反馈由调用方（handle-send）负责 toast。
import { createCommandEnvelope } from "@zcode/ui/v4/commandFactory.js";
import { logger } from "@zcode/ui/logger.js";
import type { CommandAck, CommandPayloadMap, CommandType } from "@zcode/shared/zcode-protocol-v4";
import { getEvoflowV4Transport } from "./evoflowV4Transport.js";
import { getSharedV4SessionDataLayer } from "./V4StreamRowsBridge.js";
import { wsClient } from "../../lib/ws-client.js";

/** 读取该会话 v4 投影的最新 revision（store 未建立/无快照返回 undefined）。 */
function peekRevision(sessionId: string): number | undefined {
  const layer = getSharedV4SessionDataLayer();
  if (!layer.has(sessionId)) return undefined;
  const lease = layer.acquire(sessionId);
  try {
    return lease.store.getState().snapshot?.revision;
  } finally {
    lease.release();
  }
}

/** 同步窥视该 thread 的 v4 目标状态（无快照/无目标返回 null）。
 *  goalProposal 面板抑制等判定用：v4 目标活跃时不再自动弹 hosted 目标面板。 */
export function peekV4GoalState(sessionId: string): { status: string } | null {
  try {
    const layer = getSharedV4SessionDataLayer();
    if (!layer.has(sessionId)) return null;
    const lease = layer.acquire(sessionId);
    try {
      const goal = lease.store.getState().snapshot?.goal ?? null;
      return goal ? { status: String(goal.status || '') } : null;
    } finally {
      lease.release();
    }
  } catch {
    return null;
  }
}

/** v4 目标是否处于活跃推进态（active/verifying）。 */
export function isV4GoalActive(sessionId: string): boolean {
  const status = peekV4GoalState(sessionId)?.status || '';
  return status === 'active' || status === 'verifying';
}

async function resolveThreadId(sessionKey: string): Promise<string> {
  const resolved = await wsClient.resolveSessionThreadId?.(sessionKey);
  return String(resolved || '').trim();
}

export type V4GoalCommandResult =
  | { ok: true; ack: CommandAck }
  | { ok: false; status: string; reasonCode?: string; message: string };

export async function sendV4GoalCommand<T extends CommandType>(
  sessionKey: string,
  type: T,
  payload: CommandPayloadMap[T],
): Promise<V4GoalCommandResult> {
  const sessionId = await resolveThreadId(sessionKey);
  logger.info('[v4-goal] command dispatch', {
    type,
    sessionKey,
    sessionId: sessionId || '(unresolved)',
    payloadText: String((payload as { text?: string } | undefined)?.text || '').slice(0, 60),
  });
  if (!sessionId) {
    return { ok: false, status: 'no-session', message: '会话尚未初始化（无 thread）' };
  }
  let baseRevision: number | undefined;
  try {
    baseRevision = peekRevision(sessionId);
  } catch {
    baseRevision = undefined;
  }
  let envelope: ReturnType<typeof createCommandEnvelope>;
  try {
    envelope = createCommandEnvelope({
      type,
      payload,
      sessionId,
      baseRevision,
    } as Parameters<typeof createCommandEnvelope>[0]);
  } catch (error) {
    // CAS 命令（pauseGoal/resumeGoal）缺 baseRevision：v4 投影尚未建立快照。
    logger.warn('[v4-goal] envelope build failed', { type, sessionId, error: String(error) });
    return {
      ok: false,
      status: 'no-revision',
      message: '会话状态尚未同步，请稍后重试',
    };
  }
  try {
    const ack = await getEvoflowV4Transport().sendCommand(envelope);
    logger.info('[v4-goal] ack', { type, status: ack.status, reasonCode: ack.reasonCode });
    if (ack.status === 'accepted' || ack.status === 'duplicate' || ack.status === 'noop') {
      return { ok: true, ack };
    }
    return {
      ok: false,
      status: ack.status,
      reasonCode: ack.reasonCode,
      message: typeof ack.result === 'string' ? ack.result : ack.status,
    };
  } catch (error) {
    logger.error('[v4-goal] transport error', { type, sessionId, error: String(error) });
    return {
      ok: false,
      status: 'transport-error',
      message: `命令发送失败：${String(error).slice(0, 120)}`,
    };
  }
}
