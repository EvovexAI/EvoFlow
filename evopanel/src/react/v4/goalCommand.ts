// goalCommand — 主聊天 composer 的 ZCode 式目标命令发送（/goal → v4 命令面）。
//
// - 命令：sendGoalCommand / pauseGoal / resumeGoal（schema 见
//   zcode-shared/zcode-protocol-v4/command.ts，sendGoalCommand 非 CAS、
//   pauseGoal/resumeGoal 为 CAS 命令需 snapshot.revision）。
// - sessionId = LangGraph thread_id（v4 会话 1:1）；由 wsClient.resolveSessionThreadId
//   解析，与 chatSend 的 thread 解析共用同一缓存。
// - revision：从共享 SessionDataLayer 的投影 store 读最新 snapshot.revision
//   （复用 warmEvoflowV4Session 的 acquire/release 模式）；store 未建立/无快照时
//   CAS 命令无法构造信封，返回失败由调用方 toast 提示稍后重试。
// - rejected 的用户可见反馈由调用方（handle-send）负责 toast。
import { createCommandEnvelope } from "@zcode/ui/v4/commandFactory.js";
import { SessionDataLayer } from "@zcode/ui/v4/sessionDataLayer.js";
import type { CommandAck, CommandPayloadMap, CommandType } from "@zcode/shared/zcode-protocol-v4";
import { getEvoflowV4Transport } from "./evoflowV4Transport.js";
import { wsClient } from "../../lib/ws-client.js";

let sharedLayer: SessionDataLayer | null = null;
function getSharedLayer(): SessionDataLayer {
  if (!sharedLayer) {
    sharedLayer = new SessionDataLayer({ transport: getEvoflowV4Transport() });
  }
  return sharedLayer;
}

/** 读取该会话 v4 投影的最新 revision（store 未建立/无快照返回 undefined）。 */
function peekRevision(sessionId: string): number | undefined {
  const layer = getSharedLayer();
  if (!layer.has(sessionId)) return undefined;
  const lease = layer.acquire(sessionId);
  try {
    return lease.store.getState().snapshot?.revision;
  } finally {
    lease.release();
  }
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
    return {
      ok: false,
      status: 'no-revision',
      message: '会话状态尚未同步，请稍后重试',
    };
  }
  const ack = await getEvoflowV4Transport().sendCommand(envelope);
  if (ack.status === 'accepted' || ack.status === 'duplicate' || ack.status === 'noop') {
    return { ok: true, ack };
  }
  return {
    ok: false,
    status: ack.status,
    reasonCode: ack.reasonCode,
    message: typeof ack.result === 'string' ? ack.result : ack.status,
  };
}
