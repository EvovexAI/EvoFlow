// 推荐 Prompt 的延迟可信解析需要知道用户是否在等待期间编辑了 Composer。
// revision 只存在 renderer 内存中，不进入草稿持久化、协议或远程同步；workspace identity
// 使用与 Zustand 草稿相同的 workspaceKey，避免本地路径和远程身份串写。
const revisionByWorkspaceKey = new Map<string, number>();

function getWorkspaceKey(workspacePath: string, workspaceIdentity?: string): string {
  return workspaceIdentity?.trim() || workspacePath;
}

export function getComposerDraftRevision(
  workspacePath: string,
  workspaceIdentity?: string,
): number {
  return revisionByWorkspaceKey.get(getWorkspaceKey(workspacePath, workspaceIdentity)) ?? 0;
}

export function advanceComposerDraftRevision(
  workspacePath: string,
  workspaceIdentity?: string,
): number {
  const workspaceKey = getWorkspaceKey(workspacePath, workspaceIdentity);
  const nextRevision = (revisionByWorkspaceKey.get(workspaceKey) ?? 0) + 1;
  revisionByWorkspaceKey.set(workspaceKey, nextRevision);
  return nextRevision;
}
