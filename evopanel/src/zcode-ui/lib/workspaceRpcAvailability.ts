interface WorkspaceRpcAvailabilityTarget {
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  remoteTarget?: unknown;
}

function isRemoteWorkspaceRpcTarget(target: WorkspaceRpcAvailabilityTarget): boolean {
  return Boolean(
    target.workspaceIdentity?.trim() || target.remoteSessionId?.trim() || target.remoteTarget,
  );
}

export function shouldEnableWorkspaceRpc(target: WorkspaceRpcAvailabilityTarget): boolean {
  return !isRemoteWorkspaceRpcTarget(target) || Boolean(target.remoteSessionId?.trim());
}
