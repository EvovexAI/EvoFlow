interface AppWorkspaceRpcTarget {
  workspaceIdentity?: string;
  remoteSessionId?: string;
  remoteTarget?: unknown;
}

function normalizeOptionalString(value?: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function resolveAppWorkspaceRpcTarget({
  activeTarget,
  explicitWorkspaceIdentity,
  explicitRemoteSessionId,
}: {
  activeTarget: AppWorkspaceRpcTarget;
  explicitWorkspaceIdentity?: string;
  explicitRemoteSessionId?: string;
}): AppWorkspaceRpcTarget {
  return {
    workspaceIdentity:
      normalizeOptionalString(activeTarget.workspaceIdentity) ??
      normalizeOptionalString(explicitWorkspaceIdentity),
    remoteSessionId:
      normalizeOptionalString(activeTarget.remoteSessionId) ??
      normalizeOptionalString(explicitRemoteSessionId),
    remoteTarget: activeTarget.remoteTarget,
  };
}
