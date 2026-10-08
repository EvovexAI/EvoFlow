// sessions-index 传输面（desktop/host 实现）：桥到 IZCodeAgentService 的 v4 sessions-index 转发面
// （与 agentConversationTransport 同构；web 直连 relay 时换实现即可）。
import type { IZCodeAgentService } from "@zcode/services";
import {
  sessionsIndexTopicFrameSchema,
  TopicWireFrameAssembler,
  type ConversationResyncParams,
  type SessionsIndexTopicFrame,
  type SessionsIndexTopicWireCandidate,
  type TopicFrameDeliveryKind,
  type V4ConversationResyncResult,
  type V4SessionsIndexSubscribeResult,
} from "@zcode/shared/zcode-protocol-v4";
import { sessionsIndexTopic } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { ensureAgentV4ConnectionHandshake } from "@/v4/agentV4ConnectionHandshake.js";
import { createAckActivationBarrier } from "@/v4/ackActivationBarrier.js";
import { createTopicWireDecoder } from "@/v4/topicWireDecoder.js";

export interface SessionsIndexTransport {
  subscribe(params: {
    base?: { logEpoch: string; seq: number };
    visibility?: "foreground" | "background";
  }): Promise<V4SessionsIndexSubscribeResult>;
  activate(subscriptionId: string): void;
  resync(params: ConversationResyncParams): Promise<V4ConversationResyncResult>;
  unsubscribe(subscriptionId: string): Promise<void>;
  onFrame(
    listener: (
      frame: SessionsIndexTopicFrame,
      context?: { deliveryKind: TopicFrameDeliveryKind },
    ) => void,
  ): () => void;
  onAssemblyFault(
    listener: (fault: {
      topic: string;
      subscriptionId: string;
      reasonCode?: string;
      deliveryKind?: TopicFrameDeliveryKind;
    }) => void,
  ): () => void;
  onRuntimeRestart(listener: () => void): () => void;
  onRuntimeLifecycle?: (listener: (state: "available" | "unavailable") => void) => () => void;
}

interface AgentSessionsIndexTransportTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

type SessionsIndexV4AgentService = Pick<
  IZCodeAgentService,
  | "subscribeSessionsIndexV4"
  | "resyncSessionsIndexV4"
  | "unsubscribeSessionsIndexV4"
  | "onDynamicSessionsIndexFrame"
  | "onAgentRuntimeRestarted"
> &
  Partial<
    Pick<
      IZCodeAgentService,
      "helloConversationV4" | "initializeConversationV4" | "onAgentRuntimeLifecycle"
    >
  >;

/** 一条 host 连接（= 一个 workspace）上的 sessions-index 传输面。 */
export function createAgentSessionsIndexTransport(
  agentService: SessionsIndexV4AgentService,
  target: AgentSessionsIndexTransportTarget,
): SessionsIndexTransport {
  const workspace = {
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
  };
  const ensureHandshake = () => {
    if (!agentService.helloConversationV4 || !agentService.initializeConversationV4) {
      return Promise.reject(new Error("fault.connection.handshakeUnavailable"));
    }
    return ensureAgentV4ConnectionHandshake(
      agentService as Pick<IZCodeAgentService, "helloConversationV4" | "initializeConversationV4">,
    );
  };
  const topic = sessionsIndexTopic(target.workspaceIdentity?.trim() || target.workspacePath);
  const listeners = new Set<
    (frame: SessionsIndexTopicFrame, context?: { deliveryKind: TopicFrameDeliveryKind }) => void
  >();
  const faultListeners = new Set<
    (fault: {
      topic: string;
      subscriptionId: string;
      reasonCode?: string;
      deliveryKind?: TopicFrameDeliveryKind;
    }) => void
  >();
  const restartListeners = new Set<() => void>();
  const runtimeLifecycleListeners = new Set<(state: "available" | "unavailable") => void>();
  const decoder = createTopicWireDecoder(
    new TopicWireFrameAssembler(sessionsIndexTopicFrameSchema),
    (frame: SessionsIndexTopicFrame, deliveryKind) => {
      for (const listener of listeners) listener(frame, { deliveryKind });
    },
    (fault) => {
      for (const listener of faultListeners) listener(fault);
    },
  );
  const barrier = createAckActivationBarrier<SessionsIndexTopicWireCandidate>((wire) => {
    decoder.accept(wire);
  });
  let upstream: { dispose(): void } | null = null;
  let restartUpstream: { dispose(): void } | null = null;
  let lifecycleUpstream: { dispose(): void } | null = null;
  let activeSubscriptionId: string | null = null;
  let runtimeGeneration = 0;
  const targetWorkspaceKey = target.workspaceIdentity?.trim() || target.workspacePath;
  return {
    async subscribe(params) {
      await ensureHandshake();
      const pending = barrier.begin(topic);
      const subscribeRuntimeGeneration = runtimeGeneration;
      try {
        const result = await agentService.subscribeSessionsIndexV4({
          ...workspace,
          runtimePolicy: "existing-only",
          ...(params.base ? { base: params.base } : {}),
          ...(params.visibility ? { visibility: params.visibility } : {}),
        });
        if (subscribeRuntimeGeneration !== runtimeGeneration) {
          barrier.cancel(pending);
          throw new Error("fault.subscription.runtimeRestarted");
        }
        try {
          barrier.bind(pending, result.ack.subscriptionId);
        } catch (error) {
          // ACK 前 physical batch 越界后不能用残缺初始态激活 store。
          try {
            await agentService.unsubscribeSessionsIndexV4({
              ...workspace,
              subscriptionId: result.ack.subscriptionId,
              runtimePolicy: "existing-only",
            });
          } catch (cleanupError) {
            logger.warn("[v4-sessions-index] failed to undo rejected subscription", cleanupError);
          }
          throw error;
        }
        return result;
      } catch (error) {
        barrier.cancel(pending);
        throw error;
      }
    },
    activate(subscriptionId) {
      const activation = barrier.activate(subscriptionId);
      if (activation) activeSubscriptionId = subscriptionId;
      if (activation?.previousSubscriptionId) {
        decoder.discard(activation.topic, activation.previousSubscriptionId);
      }
    },
    async resync(params) {
      await ensureHandshake();
      if (activeSubscriptionId !== params.subscriptionId) {
        throw new Error("fault.subscription.notOwned");
      }
      decoder.recover(topic, params.subscriptionId);
      return agentService.resyncSessionsIndexV4({
        ...workspace,
        subscriptionId: params.subscriptionId,
        base: params.base,
        runtimePolicy: "existing-only",
        ...(params.forceSnapshot !== undefined ? { forceSnapshot: params.forceSnapshot } : {}),
      });
    },
    async unsubscribe(subscriptionId) {
      // 本地 ownership 先释放；旧 service proxy 的 handshake/RPC 已失败时也不能继续投帧。
      barrier.forget(subscriptionId);
      if (activeSubscriptionId === subscriptionId) activeSubscriptionId = null;
      decoder.discard(topic, subscriptionId);
      await ensureHandshake();
      return agentService.unsubscribeSessionsIndexV4({
        ...workspace,
        subscriptionId,
        runtimePolicy: "existing-only",
      });
    },
    onFrame(listener) {
      listeners.add(listener);
      upstream ??= agentService.onDynamicSessionsIndexFrame(workspace)((frame) =>
        barrier.accept(frame),
      );
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          upstream?.dispose();
          upstream = null;
        }
      };
    },
    onAssemblyFault(listener) {
      faultListeners.add(listener);
      return () => faultListeners.delete(listener);
    },
    onRuntimeRestart(listener) {
      restartListeners.add(listener);
      restartUpstream ??= agentService.onAgentRuntimeRestarted((event) => {
        if (event.workspaceKey !== targetWorkspaceKey) return;
        runtimeGeneration += 1;
        barrier.clear();
        decoder.clear();
        activeSubscriptionId = null;
        for (const restartListener of restartListeners) restartListener();
      });
      return () => {
        restartListeners.delete(listener);
        if (restartListeners.size === 0) {
          restartUpstream?.dispose();
          restartUpstream = null;
        }
      };
    },
    ...(agentService.onAgentRuntimeLifecycle
      ? {
          onRuntimeLifecycle(listener: (state: "available" | "unavailable") => void) {
            const lifecycleListeners = runtimeLifecycleListeners;
            lifecycleListeners.add(listener);
            lifecycleUpstream ??=
              agentService.onAgentRuntimeLifecycle?.((event) => {
                if (event.workspaceKey !== targetWorkspaceKey) return;
                runtimeGeneration += 1;
                barrier.clear();
                decoder.clear();
                activeSubscriptionId = null;
                for (const lifecycleListener of lifecycleListeners) {
                  lifecycleListener(event.state);
                }
              }) ?? null;
            return () => {
              lifecycleListeners.delete(listener);
              if (lifecycleListeners.size === 0) {
                lifecycleUpstream?.dispose();
                lifecycleUpstream = null;
              }
            };
          },
        }
      : {}),
  };
}
