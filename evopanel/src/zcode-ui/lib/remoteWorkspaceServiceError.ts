export const REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE = "ZCODE_REMOTE_WORKSPACE_DISCONNECTED";

export function createRemoteWorkspaceDisconnectedError(): Error & {
  code: typeof REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE;
} {
  const error = new Error(REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE) as Error & {
    code: typeof REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE;
  };
  error.code = REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE;
  return error;
}

export function isRemoteWorkspaceDisconnectedError(error: unknown): boolean {
  // RPC/Proxy 边界可能保留 Error，也可能只保留 code/message 字段。
  // 只接受精确错误码，避免用 includes 把真实业务错误误判成初始化等待态。
  if (error === REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE) {
    return true;
  }

  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE ||
    candidate.message === REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE
  );
}
