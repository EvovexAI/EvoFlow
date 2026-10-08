export type ShareImportIntentStatus =
  | "received"
  | "waiting_for_auth"
  | "importing"
  | "complete"
  | "failed"
  | "cancelled";

export interface ShareImportIntent {
  shareCode: string;
  clientRequestId: string;
  status: ShareImportIntentStatus;
  targetWorkspacePath?: string;
  targetWorkspaceIdentity?: string;
  targetWorkspaceKind?: "local" | "remote";
}

export function createShareImportIntent(
  shareCode: string,
  requestIdFactory: () => string = () =>
    `share-import-request-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`,
  target?: Pick<
    ShareImportIntent,
    "targetWorkspacePath" | "targetWorkspaceIdentity" | "targetWorkspaceKind"
  >,
): ShareImportIntent {
  return {
    shareCode,
    clientRequestId: requestIdFactory(),
    status: "received",
    ...(target?.targetWorkspacePath ? { targetWorkspacePath: target.targetWorkspacePath } : {}),
    ...(target?.targetWorkspaceIdentity
      ? { targetWorkspaceIdentity: target.targetWorkspaceIdentity }
      : {}),
    ...(target?.targetWorkspaceKind ? { targetWorkspaceKind: target.targetWorkspaceKind } : {}),
  };
}

export function isShareImportIntentSame(
  intent: ShareImportIntent,
  payload: { shareCode: string },
): boolean {
  return intent.shareCode === payload.shareCode;
}

export function resolveShareImportFailurePresentation(kind: string): {
  messageId:
    | "conversationShare.import.loginRequired"
    | "conversationShare.import.notFound"
    | "conversationShare.import.expired"
    | "conversationShare.import.integrityFailed"
    | "conversationShare.import.failed";
  retryable: boolean;
} {
  if (kind === "authentication_required") {
    return {
      messageId: "conversationShare.import.loginRequired",
      retryable: false,
    };
  }
  return {
    messageId:
      kind === "not_found"
        ? "conversationShare.import.notFound"
        : kind === "expired"
          ? "conversationShare.import.expired"
          : kind === "invalid_contract"
            ? "conversationShare.import.integrityFailed"
            : "conversationShare.import.failed",
    retryable: true,
  };
}
