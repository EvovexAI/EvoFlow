import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export type PromptAttachmentTransferPhase = "uploading" | "committing" | "complete" | "canceled";

export interface PromptAttachmentTransferProgress {
  operationId: string;
  phase: PromptAttachmentTransferPhase;
  uploadedBytes: number;
  totalBytes: number;
}

export interface PromptAttachmentStageParams {
  operationId: string;
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  localPath: string;
  fileName: string;
  mime: string;
  sizeBytes?: number;
}

export interface PromptAttachmentStageResult {
  operationId: string;
  ref: string;
  bytes: number;
  staged: boolean;
}

/**
 * Renderer 只消费这个 host 服务，不直接依赖 SSH/WSL/Docker backend。
 * 本地 host 返回零拷贝路径，remote host wrapper 则先完成跨机暂存。
 */
export interface IPromptAttachmentTransferService {
  stage(params: PromptAttachmentStageParams): Promise<PromptAttachmentStageResult>;
  adopt(operationId: string): Promise<void>;
  cancel(operationId: string): Promise<void>;
  cleanup(operationId: string): Promise<void>;
  onDynamicProgress(operationId: string): Event<PromptAttachmentTransferProgress>;
}

export const IPromptAttachmentTransferService =
  createServiceDescriptor<IPromptAttachmentTransferService>(
    ServiceChannels.PromptAttachmentTransfer,
  );
