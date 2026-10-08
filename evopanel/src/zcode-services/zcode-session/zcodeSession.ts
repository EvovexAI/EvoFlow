import { ServiceChannels } from "@zcode/shared";
import type {
  TraceId,
  ZCodeAgentMcpServer,
  ZCodeDeliveryKind,
  ZCodeMessageWithParts,
  ModelSelection,
  ZCodePermissionRequestParams,
  ZCodeUserInputRequestParams,
  ZCodeUserInputResponse,
  ZCodeSessionInfo,
  ZCodeSessionImportHistory,
  ZCodeSessionEvent,
  ZCodeSessionMode,
  ZCodeSessionPersistence,
  ZCodeSessionStateSnapshot,
  ZCodeStateUpdatedNotification,
  ZCodeWorkspacePresentation,
} from "@zcode/shared";
import { createServiceDescriptor } from "#src/descriptors.js";

export interface ZCodeSessionWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export type ZCodeSessionReadWorkspacePresentationParams = ZCodeSessionWorkspaceTarget;

export interface ZCodeTaskTarget extends ZCodeSessionWorkspaceTarget {
  sessionId: string;
}

export interface ZCodeSessionCreateParams extends ZCodeSessionWorkspaceTarget {
  /** 仅导入事务使用的预分配 ID；普通新会话继续由 Agent 分配。 */
  sessionId?: string;
  sessionTraceId?: TraceId;
  parentSessionId?: string;
  mode?: ZCodeSessionMode;
  model?: ModelSelection;
  persistence?: ZCodeSessionPersistence;
  thoughtLevel?: string;
  mcpServers?: ZCodeAgentMcpServer[];
  importedHistory?: ZCodeSessionImportHistory;
}

export interface ZCodeSessionResumeParams extends ZCodeTaskTarget {
  model?: ModelSelection;
  thoughtLevel?: string;
  mcpServers?: ZCodeAgentMcpServer[];
  /**
   * 默认广播 resume 得到的历史快照，并让 shadow 订阅请求初始 snapshot。
   * 续聊发送前的 runtime 预恢复会关闭它，避免旧终态快照覆盖本地已开始的新输入运行态。
   */
  broadcastSnapshot?: boolean;
}

export interface ZCodeSessionListParams extends ZCodeSessionWorkspaceTarget {
  includeArchived?: boolean;
  limit?: number;
}

export interface ZCodeSessionReadParams extends ZCodeTaskTarget {
  deliveryKind?: ZCodeDeliveryKind;
  messageLimit?: number;
  afterSeq?: number;
}

export interface ZCodeSessionMessagesParams extends ZCodeTaskTarget {
  afterMessageId?: string;
  limit?: number;
}

export interface ZCodeSessionEventsParams extends ZCodeTaskTarget {
  afterSeq?: number;
  limit?: number;
}

export interface ZCodeSessionSetModelParams extends ZCodeTaskTarget {
  model: ModelSelection;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface ZCodeSessionSetThoughtLevelParams extends ZCodeTaskTarget {
  thoughtLevel?: string;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface ZCodeSessionSetModeParams extends ZCodeTaskTarget {
  mode: ZCodeSessionMode;
  expectedRevision?: number;
}

export interface ZCodeSessionSubscribeParams extends ZCodeTaskTarget {
  deliveryKind: ZCodeDeliveryKind;
  afterSeq?: number;
  includeSnapshot?: boolean;
  eventCoalescing?: {
    mode: "background-summary";
    intervalMs?: number;
  };
}

export type ZCodeSessionServiceEvent =
  | { type: "session.event"; event: ZCodeSessionEvent }
  | { type: "state.updated"; notification: ZCodeStateUpdatedNotification }
  | { type: "permission.request"; request: ZCodePermissionRequestParams }
  | { type: "userInput.request"; request: ZCodeUserInputRequestParams }
  | {
      type: "userInput.response";
      requestId: string;
      response: ZCodeUserInputResponse;
    }
  | { type: "snapshot"; snapshot: ZCodeSessionStateSnapshot };

export interface ZCodeSessionInitializeResult {
  available: boolean;
  workspaceKey: string;
  protocolName?: string;
  protocolVersion?: number;
  transportKind?: "stdio" | "websocket";
  reason?: string;
  reasonCode?: "provider_not_ready";
}

export interface ZCodeSessionWorkspaceRuntimeIdentity {
  generation: number;
  identity: string;
  processId?: number;
  workspaceKey: string;
}

export interface IZCodeSessionService {
  initializeWorkspace(params: ZCodeSessionWorkspaceTarget): Promise<ZCodeSessionInitializeResult>;
  getWorkspaceRuntimeIdentity(
    params: ZCodeSessionWorkspaceTarget,
  ): Promise<ZCodeSessionWorkspaceRuntimeIdentity>;
  readWorkspacePresentation(
    params: ZCodeSessionReadWorkspacePresentationParams,
  ): Promise<ZCodeWorkspacePresentation>;
  createSession(params: ZCodeSessionCreateParams): Promise<ZCodeSessionStateSnapshot>;
  resumeSession(params: ZCodeSessionResumeParams): Promise<ZCodeSessionStateSnapshot>;
  listSessions(params: ZCodeSessionListParams): Promise<ZCodeSessionInfo[]>;
  readSession(params: ZCodeSessionReadParams): Promise<ZCodeSessionStateSnapshot>;
  readSessionMessages(params: ZCodeSessionMessagesParams): Promise<ZCodeMessageWithParts[]>;
  readSessionEvents(params: ZCodeSessionEventsParams): Promise<ZCodeSessionEvent[]>;
  promoteDeferredDraftSession(params: ZCodeTaskTarget): Promise<void>;
  closeSession(params: ZCodeTaskTarget): Promise<void>;
  closeDeferredDraftSession(params: ZCodeTaskTarget): Promise<boolean>;
  setModel(params: ZCodeSessionSetModelParams): Promise<ZCodeSessionStateSnapshot>;
  setThoughtLevel(params: ZCodeSessionSetThoughtLevelParams): Promise<ZCodeSessionStateSnapshot>;
  setMode(params: ZCodeSessionSetModeParams): Promise<ZCodeSessionStateSnapshot>;
  // renderer 订阅面走 agentService 的 conversation/sessions-index 帧通道。
}

export const IZCodeSessionService = createServiceDescriptor<IZCodeSessionService>(
  ServiceChannels.ZCodeSession,
);
