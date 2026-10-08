/**
 * EvoFlow v4 shell — ``IZCodeAgentService`` 会话面的 EvoFlow 实现。
 *
 * 只实现 v4 conversation 链路真正消费的方法（见 ``zcode-ui/v4/agentConversationTransport.ts``
 * 与 ``agentV4ConnectionHandshake.ts`` 的调用集）；其余方法经 Proxy 返回显式 rejected
 * promise，UI 触碰到未实现功能时得到可诊断的错误而不是静默挂起。
 *
 * 后端契约：``backend/app/gateway/v4/conversation.py`` + ``routes.py``。
 */

import type {
  ClientHello,
  CommandAck,
  CommandsQueryParams,
  CommandsQueryResult,
  ConversationTopicWireCandidate,
  HelloMessage,
  SubscribeParams,
  V4ConversationSubscribeResult,
} from "@zcode/shared/zcode-protocol-v4";
import { Event } from "@zcode/rpc";
import type { IZCodeAgentService } from "@zcode/services";
import { getV4ConnectionId, v4FrameConnection, v4Post } from "./evoflowV4Connection.js";

type WorkspaceTarget = {
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceKey?: string;
  remoteSessionId?: string | null;
};

type SubscribeConversationParams = WorkspaceTarget & {
  sessionId: string;
  base?: SubscribeParams["base"];
  visibility?: SubscribeParams["visibility"];
};

function notImplemented(method: string): Promise<never> {
  return Promise.reject(
    new Error(`[v4shell] agentService.${method} 尚未接入 EvoFlow 后端（H3-C+）`),
  );
}

/** 空事件订阅桩：`(params?) => (listener?) => disposable` 任意调用深度都自带 dispose。 */
const emptyEventSubscription: unknown = (() => {
  const fn = (() => emptyEventSubscription) as unknown as { dispose(): void };
  fn.dispose = () => {};
  return fn;
})();

class EvoflowAgentService {
  // ── wire 握手（transport 首订阅前必经）──────────────────────────────────

  async helloConversationV4(): Promise<HelloMessage> {
    return v4Post<HelloMessage>("/api/v4/conversation/hello", {
      connectionId: getV4ConnectionId(),
    });
  }

  async initializeConversationV4(clientHello: ClientHello): Promise<void> {
    await v4Post("/api/v4/conversation/initialize", clientHello);
  }

  // ── 订阅生命周期 ────────────────────────────────────────────────────────

  async subscribeConversationV4(
    params: SubscribeConversationParams,
  ): Promise<V4ConversationSubscribeResult> {
    const topic = `conversation/${params.sessionId}`;
    return v4Post<V4ConversationSubscribeResult>("/api/v4/conversation/subscribe", {
      connectionId: getV4ConnectionId(),
      clientMode: "desktop-continuous",
      topic,
      ...(params.base ? { base: params.base } : {}),
      ...(params.visibility ? { visibility: params.visibility } : {}),
    });
  }

  async unsubscribeConversationV4(params: {
    subscriptionId: string;
  } & WorkspaceTarget): Promise<void> {
    await v4Post("/api/v4/conversation/unsubscribe", {
      subscriptionId: params.subscriptionId,
    });
  }

  async resyncConversationV4(params: {
    subscriptionId: string;
    base?: { logEpoch: string; seq: number } | null;
    forceSnapshot?: boolean;
  } & WorkspaceTarget): Promise<{ ack: { subscriptionId: string; mode: "snapshot" | "resume"; logEpoch: string } }> {
    return v4Post("/api/v4/conversation/resync", {
      subscriptionId: params.subscriptionId,
      ...(params.base ? { base: params.base } : {}),
      ...(params.forceSnapshot !== undefined ? { forceSnapshot: params.forceSnapshot } : {}),
    });
  }

  async conversationRowsRangeV4(params: {
    sessionId: string;
    beforeRowId?: number;
    limit: number;
  } & WorkspaceTarget): Promise<{
    rows: unknown[];
    atSeq: number;
    atRevision: number;
    atLogEpoch: string;
    hasMore: boolean;
  }> {
    return v4Post("/api/v4/conversation/rows_range", {
      sessionId: params.sessionId,
      ...(params.beforeRowId !== undefined ? { beforeRowId: params.beforeRowId } : {}),
      limit: params.limit,
    });
  }

  // ── 命令 ────────────────────────────────────────────────────────────────

  async sendConversationCommandV4(params: {
    envelope: Record<string, unknown>;
  } & WorkspaceTarget): Promise<CommandAck> {
    return v4Post<CommandAck>("/api/v4/conversation/command", {
      envelope: params.envelope,
    });
  }

  async queryConversationCommandsV4(
    params: CommandsQueryParams,
  ): Promise<CommandsQueryResult> {
    // ttft 时钟探测 / 命令状态查询：EvoFlow 后端尚无命令台账，统一回 unknown。
    return {
      results: params.commands.map((key) => ({ key, result: "unknown" as const })),
    };
  }

  // ── 下行帧流 ────────────────────────────────────────────────────────────

  /** workspace 级下行帧流；EvoFlow 单机后端不区分 workspace，一律广播给本连接监听者。 */
  onDynamicConversationFrame(_params: WorkspaceTarget): Event<ConversationTopicWireCandidate> {
    return (listener) => ({ dispose: v4FrameConnection.onWire(listener) });
  }

  /** 直接订阅模式：`(listener) => IDisposable`（transport 以
   * ``agentService.onAgentRuntimeRestarted(listener)`` 调用，不走事件工厂二次调用）。 */
  onAgentRuntimeRestarted(_listener: (event: void) => void): { dispose(): void } {
    return { dispose() {} };
  }

  // 其余大面（rows range / plans / attachments / sessions-index / cua / ...）经 Proxy 拒绝。
}

const implemented = new EvoflowAgentService() as unknown as Record<string, unknown>;

/** 未实现方法的稳定桩缓存：ZCode hook 依赖数组需要稳定身份（见 evoflowServices 注释）。 */
const stubMethodCache = new Map<string, unknown>();

export const evoflowAgentService: IZCodeAgentService = new Proxy(implemented, {
  get(target, prop: string) {
    if (prop in target) return target[prop];
    const cached = stubMethodCache.get(prop);
    if (cached !== undefined) return cached;
    let stub: unknown;
    // `on*` 是事件订阅工厂：未接入的事件面返回空订阅，语义是「永远不触发」而不是
    // 失败——transport 构造期就会订阅这些事件。
    if (prop.startsWith("on")) {
      stub = emptyEventSubscription;
    } else {
      stub = (...args: unknown[]) => notImplemented(prop);
    }
    stubMethodCache.set(prop, stub);
    return stub;
  },
}) as unknown as IZCodeAgentService;
