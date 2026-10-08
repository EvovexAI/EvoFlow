/**
 * 身份/隔离语义统一使用 workspaceIdentity，旧本地调用没有 identity 时回退路径。
 * 不包含 remoteSessionId：它描述连接实例，不改变 workspace 身份。
 */
export function getWorkspaceKey(workspacePath: string, workspaceIdentity?: string | null): string {
  return workspaceIdentity?.trim() || workspacePath;
}
