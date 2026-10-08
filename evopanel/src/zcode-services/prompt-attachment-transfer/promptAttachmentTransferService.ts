import { stat } from "node:fs/promises";
import { Emitter } from "@zcode/rpc";
import type {
  IPromptAttachmentTransferService,
  PromptAttachmentTransferProgress,
} from "./promptAttachmentTransfer.js";

/** 本地 workspace 保持 localPath 零拷贝，不伪造上传进度。 */
export function createLocalPromptAttachmentTransferService(): IPromptAttachmentTransferService {
  const emitters = new Map<string, Emitter<PromptAttachmentTransferProgress>>();
  const getEmitter = (operationId: string) => {
    const existing = emitters.get(operationId);
    if (existing) return existing;
    const emitter = new Emitter<PromptAttachmentTransferProgress>({
      onDidRemoveLastListener: () => {
        emitters.delete(operationId);
        emitter.dispose();
      },
    });
    emitters.set(operationId, emitter);
    return emitter;
  };

  return {
    async stage(params) {
      const bytes =
        typeof params.sizeBytes === "number" && params.sizeBytes > 0
          ? params.sizeBytes
          : await stat(params.localPath)
              .then((value) => value.size)
              .catch(() => 0);
      return {
        operationId: params.operationId,
        ref: params.localPath,
        bytes,
        staged: false,
      };
    },
    async adopt() {},
    async cancel() {},
    async cleanup() {},
    onDynamicProgress: (operationId) => getEmitter(operationId).event,
  };
}
