import { create } from "zustand";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import type { ChatComposerAttachment } from "@/lib/chatAttachments.js";

export type ComposerAttachmentUploadStatus =
  | "waitingSession"
  | "queued"
  | "uploading"
  | "committing"
  | "ready"
  | "failed";

export interface ComposerAttachmentUploadItem extends ChatComposerAttachment {
  /**
   * composer-owned 仍处于上传/暂存生命周期；session-owned 是从权威 queue 撤回的既有 ref。
   * 后者已经由 session 接管，runtime restart、cleanup 和 resend 都不能再次处理引用所有权。
   */
  referenceOwnership: "composer" | "session";
  uploadStatus: ComposerAttachmentUploadStatus;
  uploadProgress: number;
  uploadError?: string;
  uploadErrorKind?: "transient" | "permanent" | "runtimeRestarted";
  attachmentRef?: AttachmentRef;
  operationId: string;
  autoRetryCount: number;
  /**
   * 因 runtime 换代触发的重传次数，与上传失败重试分开计。
   * 换代不是「上传失败」，共用计数器会让一次换代就烧掉用户可见的重试配额。
   */
  runtimeRebuildRetryCount: number;
  staged: boolean;
  adopted: boolean;
  showComplete: boolean;
  localZeroCopy: boolean;
}

interface ComposerAttachmentUploadStoreState {
  scopes: Record<string, ComposerAttachmentUploadItem[]>;
}

/**
 * renderer 内存态：File/object URL 不落盘，但 task/composer 切换或局部卸载不会丢失。
 * 上传控制器仍由发起该 operation 的 hook 闭包持有，relay/main 不保存业务状态。
 */
export const useComposerAttachmentUploadStore = create<ComposerAttachmentUploadStoreState>()(
  () => ({ scopes: {} }),
);

declare global {
  interface Window {
    __zcodeComposerAttachmentUploadStoreE2E?: typeof useComposerAttachmentUploadStore;
    __zcodeCurrentComposerAttachmentScopeKeyE2E?: string;
  }
}

if (shouldExposeE2EStoreBridge()) {
  // E2E 只暴露当前唯一附件 owner，供 scope 切换用例准备状态；不再把附件塞回旧 Session Store。
  window.__zcodeComposerAttachmentUploadStoreE2E = useComposerAttachmentUploadStore;
}

export function exposeComposerAttachmentScopeKeyForE2E(scopeKey: string): void {
  if (window.__zcodeComposerAttachmentUploadStoreE2E) {
    window.__zcodeCurrentComposerAttachmentScopeKeyE2E = scopeKey;
  }
}

export function readComposerAttachmentScope(scopeKey: string): ComposerAttachmentUploadItem[] {
  return useComposerAttachmentUploadStore.getState().scopes[scopeKey] ?? [];
}

export function updateComposerAttachmentScope(
  scopeKey: string,
  update: (current: ComposerAttachmentUploadItem[]) => ComposerAttachmentUploadItem[],
): void {
  useComposerAttachmentUploadStore.setState((state) => {
    const next = update(state.scopes[scopeKey] ?? []);
    if (next.length === 0) {
      const { [scopeKey]: _removed, ...remainingScopes } = state.scopes;
      return { scopes: remainingScopes };
    }
    return {
      scopes: {
        ...state.scopes,
        [scopeKey]: next,
      },
    };
  });
}
