import type { PipSessionEvent } from "@zcode/zcode-cua/pip-session";
import {
  createPipSessionClient,
  type PipSessionClient,
  type PipSessionClientOptions,
} from "@zcode/zcode-cua/pip-session/node";
import { createServiceLogger, type ServiceLogger } from "../logger/serviceLogger.js";
import type { CuaPipSessionService } from "./cuaPipSession.js";

export interface CuaPipPresentationCredentials {
  socketPath: string;
}

type PipSessionClientResolution =
  | { client: PipSessionClient; skipReason?: never }
  | {
      client: null;
      skipReason:
        | "service-disabled"
        | "service-disposed"
        | "credentials-unavailable"
        | "transport-disabled";
    };

function eventLogContext(event: PipSessionEvent): Record<string, unknown> {
  if (event.kind === "focus-changed") {
    return {
      kind: event.kind,
      revision: event.revision,
      sessionId: event.sessionId,
      sourceWindowId: event.sourceWindowId,
    };
  }
  return {
    eventId: event.eventId,
    kind: event.kind,
    sequenceNumber: event.sequenceNumber,
    sessionId: event.sessionId,
    ...(event.kind === "session-closed" ? {} : { turnId: event.turnId }),
    ...(event.kind === "turn-ended" ? { outcome: event.outcome } : {}),
  };
}

export function createCuaPipSessionService(options: {
  enabled: boolean;
  resolveCredentials: () => Promise<CuaPipPresentationCredentials | undefined>;
  createClient?: (options: PipSessionClientOptions) => PipSessionClient;
  logger?: ServiceLogger;
}): CuaPipSessionService {
  const logger = options.logger ?? createServiceLogger("cua-pip-session");
  const clientFactory = options.createClient ?? createPipSessionClient;
  let current: {
    key: string;
    client: PipSessionClient;
  } | null = null;
  let disabledTransportKey: string | null = null;
  let tail: Promise<void> = Promise.resolve();
  let disposed = false;
  /**
   * 被 `credentials-unavailable` 丢掉的那条 `turn-started`，等凭据可用时补发。
   *
   * PiP 以 turn 为作用域，没有
   * `turn-started` 就没有 PiP 窗口。而它**必然**早于 Helper —— Helper 由首次 CUA 工具
   * 调用懒启动，`turn-started` 在 turn 一开始就发；此时 `resolveCredentials()` 既没有
   * 托管 host、又探不到稳定 socket（那条路径是 probe-only、不拉起），于是返回 undefined。
   * 日志实证：turn-started(seq 3) → credentials-unavailable；随后 Helper 起来，
   * focus-changed(rev 11/12/13) 全部 applied:true；turn-ended(seq 3862) →
   * applied:false / turn-mismatch。通道是通的，只是开场那一条掉了。
   *
   * 本文件早先的注释已经写明"过去会静默丢掉 turn-started，PiP 永久停在上一轮完成态"，
   * 但当时只补了 warn 日志、没有补发。单条 prompt 的任务没有第二个 turn，所以实际效果
   * 是 PiP 永远不出现。
   *
   * 只缓存一条：新的 turn-started 直接顶掉旧的（旧 turn 已经过去，补发它只会开一个
   * 早该关闭的 turn）。协调器按 `sequenceNumber` 判重，补发因此是幂等的。
   */
  let pendingTurnStarted: { event: PipSessionEvent; turnId: string } | null = null;
  /**
   * 补发重试定时器。
   *
   * 为什么不能只等"下一个恰好发生的事件"来触发补发
   *   20:18:15.628  turn-started → credentials-unavailable（Helper 未起）
   *   20:18:23      Helper 起来 → 首次 capture_app → bindCapture → pending-turn
   *                 （协调器侧 PIP_SESSION_CAPTURE_PENDING_TTL_MS = 2s，约 20:18:25 过期）
   *   20:18:30.420  下一个事件才来，补发成功 applied:true —— 但已晚了 5 秒
   * 结果 turn 开起来时暂存的 capture 已过期，captureAccepted 不再触发，窗口仍然不起。
   *
   * 所以凭据一可用就要立刻补发：暂存的同时起一个有界轮询，命中即停。间隔取 250ms，
   * 远小于协调器那 2s 的 TTL；上限 30s 覆盖 Helper 冷启动（含首次 TCC 授权对话框）。
   */
  let replayTimer: ReturnType<typeof setTimeout> | null = null;
  const REPLAY_RETRY_MS = 250;
  const REPLAY_DEADLINE_MS = 30_000;
  let replayDeadline = 0;

  const cancelReplayRetry = () => {
    if (replayTimer !== null) {
      clearTimeout(replayTimer);
      replayTimer = null;
    }
  };

  const getClient = async (): Promise<PipSessionClientResolution> => {
    if (!options.enabled) return { client: null, skipReason: "service-disabled" };
    if (disposed) return { client: null, skipReason: "service-disposed" };
    const credentials = await options.resolveCredentials();
    if (!credentials) return { client: null, skipReason: "credentials-unavailable" };
    const key = credentials.socketPath;
    if (disabledTransportKey === key) {
      return { client: null, skipReason: "transport-disabled" };
    }
    if (current?.key === key) return { client: current.client };
    current?.client.close();
    const client = clientFactory({
      socketPath: credentials.socketPath,
      onDiagnostic: (diagnostic) => {
        const message = `[cua-pip-session] ${diagnostic.code}: ${diagnostic.message}`;
        if (diagnostic.code === "version_mismatch") logger.warn(undefined, message);
        else logger.debug(undefined, message);
      },
    });
    current = { key, client };
    try {
      await client.connect();
      return { client };
    } catch (error) {
      if (current?.client === client) current = null;
      client.close();
      if ((error as { code?: unknown }).code === "version_mismatch") {
        disabledTransportKey = key;
      }
      throw error;
    }
  };

  /**
   * 有界轮询：凭据一可用就把暂存的 turn-started 发出去，不等下一个事件。
   * 经同一条 `tail` 串行，避免与 publish 竞态导致补发排到当前事件之后。
   */
  const scheduleReplayRetry = (): void => {
    cancelReplayRetry();
    if (disposed || pendingTurnStarted === null) return;
    if (Date.now() >= replayDeadline) {
      logger.warn(undefined, "[cua-pip-session] deferred turn-started expired before transport", {
        ...eventLogContext(pendingTurnStarted.event),
      });
      pendingTurnStarted = null;
      return;
    }
    replayTimer = setTimeout(() => {
      replayTimer = null;
      if (disposed || pendingTurnStarted === null) return;
      const operation = tail.then(async () => {
        if (disposed || pendingTurnStarted === null) return;
        let resolution;
        try {
          resolution = await getClient();
        } catch {
          // 连接失败（Helper 刚起、还没 listen）：继续等下一轮。
          scheduleReplayRetry();
          return;
        }
        if (!resolution.client) {
          scheduleReplayRetry();
          return;
        }
        const replay = pendingTurnStarted;
        pendingTurnStarted = null;
        try {
          const result = await resolution.client.send(replay.event);
          logger.info(undefined, "[cua-pip-session] replayed deferred turn-started", {
            ...eventLogContext(replay.event),
            applied: result.applied,
            reason: result.reason,
          });
        } catch (error) {
          logger.warn(undefined, "[cua-pip-session] replay of deferred turn-started failed", {
            ...eventLogContext(replay.event),
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      });
      tail = operation;
    }, REPLAY_RETRY_MS);
    // 轮询定时器不应该让进程活着：它只是在等一个可能永远不出现的 Helper。
    replayTimer.unref?.();
  };

  const publish = (event: PipSessionEvent): Promise<void> => {
    if (disposed) return Promise.resolve();
    const operation = tail.then(async () => {
      try {
        const resolution = await getClient();
        if (!resolution.client) {
          if (
            resolution.skipReason === "credentials-unavailable" ||
            resolution.skipReason === "transport-disabled"
          ) {
            // 记账（见 pendingTurnStarted 的根因说明）：turn-started 丢了就等凭据可用时
            // 补发；同一 turn 的 turn-ended 也丢了则连缓存一起作废 —— 那个 turn 已经在
            // 没有传输的窗口里走完，补发只会开一个早该关闭的 turn。
            if (event.kind === "turn-started") {
              pendingTurnStarted = { event, turnId: event.turnId };
              replayDeadline = Date.now() + REPLAY_DEADLINE_MS;
              scheduleReplayRetry();
            } else if (
              (event.kind === "turn-ended" || event.kind === "session-closed") &&
              pendingTurnStarted !== null &&
              ("turnId" in event
                ? pendingTurnStarted.turnId === event.turnId
                : pendingTurnStarted.event.sessionId === event.sessionId)
            ) {
              pendingTurnStarted = null;
              cancelReplayRetry();
            }
            // Bug 诊断：Helper 常驻但凭据交接失败时，过去会静默丢掉 turn-started，PiP
            // 永久停在上一轮完成态。生命周期事件每轮只有常数条，生产 warn 不会随帧刷盘。
            logger.warn(undefined, "[cua-pip-session] event delivery skipped", {
              ...eventLogContext(event),
              skipReason: resolution.skipReason,
            });
          } else {
            // service-disabled / service-disposed 过去完全静默 return，
            // 于是「一条 PiP 事件都没发」与「发了但被拒」在日志上不可区分——排查时只能反推
            // 投递链上四处静默早退。生命周期事件每轮常数条，warn 不会随帧刷盘。
            logger.warn(undefined, "[cua-pip-session] event delivery dropped", {
              ...eventLogContext(event),
              skipReason: resolution.skipReason,
            });
          }
          return;
        }
        // 凭据到位了：先把开场那条补上，协调器才有一个开着的 turn 可以承接后面的事件。
        // 当前事件本身就是 turn-started 时不补发（它已经顶掉了缓存）。
        cancelReplayRetry();
        const replay = event.kind === "turn-started" ? null : pendingTurnStarted;
        pendingTurnStarted = null;
        if (replay !== null) {
          try {
            const replayed = await resolution.client.send(replay.event);
            logger.info(undefined, "[cua-pip-session] replayed deferred turn-started", {
              ...eventLogContext(replay.event),
              applied: replayed.applied,
              reason: replayed.reason,
            });
          } catch (error) {
            // 补发失败不能拖垮当前事件：当前事件仍要发出去，最坏退回 turn-mismatch。
            logger.warn(undefined, "[cua-pip-session] replay of deferred turn-started failed", {
              ...eventLogContext(replay.event),
              errorMessage: error instanceof Error ? error.message : String(error),
            });
          }
        }
        const result = await resolution.client.send(event);
        // Bug 诊断：PiP 切组跨 Main、Host、broker 三个进程；成功与幂等拒绝 ACK 若只写
        // debug，生产包无法区分 turn-started 未发送和 stale-sequence/turn-mismatch。
        // 这是低频生命周期日志，不记录截图、token 或 prompt，可安全保留在生产环境。
        logger.info(undefined, "[cua-pip-session] event delivery acknowledged", {
          ...eventLogContext(event),
          applied: result.applied,
          reason: result.reason,
        });
      } catch (error) {
        logger.warn(undefined, "[cua-pip-session] event delivery failed", {
          ...eventLogContext(event),
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    });
    tail = operation;
    return operation;
  };

  return {
    publishFocus: publish,
    publishLifecycle: publish,
    dispose() {
      disposed = true;
      cancelReplayRetry();
      pendingTurnStarted = null;
      current?.client.close();
      current = null;
    },
  };
}
