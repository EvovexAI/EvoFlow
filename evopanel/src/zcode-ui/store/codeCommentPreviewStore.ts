import { create } from "zustand";
import {
  getCodeCommentWorkspaceKey,
  unmarkCodeCommentRemoved,
  type CodeCommentComposerAttachment,
  type CodeCommentPreview,
  type CodeCommentRemovePayload,
} from "@/lib/codeCommentContext.js";

type CodeCommentPreviewBucketKey = string;

const EMPTY_CODE_COMMENT_PREVIEWS: CodeCommentPreview[] = [];

interface CodeCommentPreviewStoreState {
  commentsByBucketKey: Record<CodeCommentPreviewBucketKey, CodeCommentPreview[]>;
  getComments: (params: CodeCommentPreviewBucketParams) => CodeCommentPreview[];
  addComment: (params: CodeCommentPreviewBucketParams & { comment: CodeCommentPreview }) => void;
  removeComment: (params: CodeCommentPreviewBucketParams & { id: string }) => void;
  removeCommentBySource: (payload: CodeCommentRemovePayload) => void;
  restoreCommentFromAttachment: (attachment: CodeCommentComposerAttachment) => void;
  clearSource: (params: CodeCommentPreviewBucketParams) => void;
}

interface CodeCommentPreviewBucketParams {
  workspacePath: string;
  workspaceIdentity?: string;
  sourcePath: string;
}

function buildCodeCommentPreviewBucketKey({
  workspacePath,
  workspaceIdentity,
  sourcePath,
}: CodeCommentPreviewBucketParams): CodeCommentPreviewBucketKey {
  return `${getCodeCommentWorkspaceKey(workspacePath, workspaceIdentity)}\0${sourcePath}`;
}

export const useCodeCommentPreviewStore = create<CodeCommentPreviewStoreState>((set, get) => ({
  commentsByBucketKey: {},
  getComments: (params) =>
    get().commentsByBucketKey[buildCodeCommentPreviewBucketKey(params)] ??
    EMPTY_CODE_COMMENT_PREVIEWS,
  addComment: (params) => {
    const bucketKey = buildCodeCommentPreviewBucketKey(params);
    set((state) => {
      const current = state.commentsByBucketKey[bucketKey] ?? [];
      return {
        commentsByBucketKey: {
          ...state.commentsByBucketKey,
          [bucketKey]: [
            ...current.filter((comment) => comment.id !== params.comment.id),
            params.comment,
          ],
        },
      };
    });
  },
  removeComment: (params) => {
    const bucketKey = buildCodeCommentPreviewBucketKey(params);
    set((state) => {
      const current = state.commentsByBucketKey[bucketKey] ?? [];
      const next = current.filter((comment) => comment.id !== params.id);
      if (next.length === current.length) {
        return state;
      }
      return {
        commentsByBucketKey: {
          ...state.commentsByBucketKey,
          [bucketKey]: next,
        },
      };
    });
  },
  removeCommentBySource: (payload) => {
    const workspaceKey = getCodeCommentWorkspaceKey(
      payload.workspacePath,
      payload.workspaceIdentity,
    );
    set((state) => {
      let changed = false;
      const commentsByBucketKey = Object.fromEntries(
        Object.entries(state.commentsByBucketKey).map(([bucketKey, comments]) => {
          if (!bucketKey.startsWith(`${workspaceKey}\0`)) {
            return [bucketKey, comments];
          }
          const next = comments.filter((comment) => comment.id !== payload.id);
          changed ||= next.length !== comments.length;
          return [bucketKey, next];
        }),
      );
      return changed ? { commentsByBucketKey } : state;
    });
  },
  restoreCommentFromAttachment: (attachment) => {
    if (!attachment.sourcePath) {
      return;
    }
    unmarkCodeCommentRemoved({
      id: attachment.id,
      workspacePath: attachment.workspacePath,
      workspaceIdentity: attachment.workspaceIdentity,
    });
    get().addComment({
      workspacePath: attachment.workspacePath,
      workspaceIdentity: attachment.workspaceIdentity,
      sourcePath: attachment.sourcePath,
      comment: {
        id: attachment.id,
        sourcePath: attachment.sourcePath,
        sourceTitle: attachment.sourceTitle,
        startLine: attachment.startLine,
        endLine: attachment.endLine,
        selectedText: attachment.selectedText,
        comment: attachment.comment,
      },
    });
  },
  clearSource: (params) => {
    const bucketKey = buildCodeCommentPreviewBucketKey(params);
    set((state) => {
      if (!state.commentsByBucketKey[bucketKey]) {
        return state;
      }
      const { [bucketKey]: _removed, ...commentsByBucketKey } = state.commentsByBucketKey;
      return { commentsByBucketKey };
    });
  },
}));
