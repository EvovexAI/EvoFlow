import {
  CODE_COMMENT_REMOVE_BROADCAST_CHANNEL,
  markCodeCommentRemoved,
  type CodeCommentComposerAttachment,
  type CodeCommentRemovePayload,
} from "@/lib/codeCommentContext.js";
import { logger } from "@/logger.js";
import { useCodeCommentPreviewStore } from "@/store/codeCommentPreviewStore.js";

interface BroadcastMessage {
  channel: string;
  payload: unknown;
}

export function removeCodeCommentPreview(
  attachment: CodeCommentComposerAttachment,
  port?: { send: (message: BroadcastMessage) => Promise<void> | void },
) {
  const payload: CodeCommentRemovePayload = {
    id: attachment.id,
    workspacePath: attachment.workspacePath,
    ...(attachment.workspaceIdentity ? { workspaceIdentity: attachment.workspaceIdentity } : {}),
  };
  markCodeCommentRemoved(payload);
  useCodeCommentPreviewStore.getState().removeCommentBySource(payload);
  if (!port) return;
  try {
    void Promise.resolve(
      port.send({
        channel: CODE_COMMENT_REMOVE_BROADCAST_CHANNEL,
        payload,
      }),
    ).catch((error: unknown) => {
      logger.warn(`[v4-composer] code comment preview 广播失败: ${String(error)}`);
    });
  } catch (error) {
    logger.warn(`[v4-composer] code comment preview 广播失败: ${String(error)}`);
  }
}
