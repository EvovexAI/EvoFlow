import {
  ALL_BOT_WORKSPACES,
  type BotConfig,
  type BotWorkspaceRef,
} from "@zcode/shared";

export function getWorkspaceKey(workspacePath: string, workspaceIdentity?: string): string {
  return workspaceIdentity?.trim() || workspacePath;
}

export function getWorkspaceLabel(workspacePath: string): string {
  return workspacePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? workspacePath;
}

export function createWorkspaceRef(workspacePath: string, workspaceIdentity?: string): BotWorkspaceRef {
  const id = getWorkspaceKey(workspacePath, workspaceIdentity);
  return {
    id,
    label: getWorkspaceLabel(workspacePath),
    workspacePath,
    workspaceIdentity,
  };
}

function isAllWorkspacesAllowed(allowedWorkspaces: readonly string[]): boolean {
  return allowedWorkspaces.length === 0 || allowedWorkspaces.includes(ALL_BOT_WORKSPACES);
}

export function normalizeAllowedWorkspaces(allowedWorkspaces: readonly string[]): string[] {
  const workspaceIds = allowedWorkspaces.map((item) => item.trim()).filter(Boolean);
  if (isAllWorkspacesAllowed(workspaceIds)) {
    return [ALL_BOT_WORKSPACES];
  }
  return [...new Set(workspaceIds)];
}

export function isWorkspaceAllowed(workspaceId: string, allowedWorkspaces: readonly string[]): boolean {
  return isAllWorkspacesAllowed(allowedWorkspaces) || allowedWorkspaces.includes(workspaceId);
}

export function filterAllowedWorkspaces(
  workspaces: BotWorkspaceRef[],
  allowedWorkspaces: readonly string[],
): BotWorkspaceRef[] {
  return isAllWorkspacesAllowed(allowedWorkspaces)
    ? workspaces
    : workspaces.filter((workspace) => allowedWorkspaces.includes(workspace.id));
}

function resolveCanonicalWorkspaceId(
  value: string | undefined,
  workspaces: readonly BotWorkspaceRef[],
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const samePathWorkspaces = workspaces.filter((workspace) => workspace.workspacePath === trimmed);
  const exactWorkspace = workspaces.find((workspace) => workspace.id === trimmed);
  if (exactWorkspace) {
    const identityCandidates = samePathWorkspaces.filter((workspace) => workspace.workspaceIdentity);
    if (!exactWorkspace.workspaceIdentity && identityCandidates.length === 1) {
      return identityCandidates[0]!.id;
    }
    return exactWorkspace.id;
  }
  return samePathWorkspaces.length === 1 ? samePathWorkspaces[0]!.id : trimmed;
}

export function normalizeConfiguredAllowedWorkspaces(
  allowedWorkspaces: readonly string[],
  workspaces: readonly BotWorkspaceRef[],
): string[] {
  const normalized = normalizeAllowedWorkspaces(allowedWorkspaces);
  if (isAllWorkspacesAllowed(normalized)) {
    return [ALL_BOT_WORKSPACES];
  }
  return [
    ...new Set(
      normalized.map((workspaceId) => resolveCanonicalWorkspaceId(workspaceId, workspaces) ?? workspaceId),
    ),
  ];
}

export function firstAllowedWorkspace(
  workspaceRefs: BotWorkspaceRef[],
  bot: BotConfig,
): BotWorkspaceRef | null {
  const allowedWorkspaces = filterAllowedWorkspaces(workspaceRefs, bot.allowedWorkspaces);
  return allowedWorkspaces[0] ?? null;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveWorkspaceByValue(
  workspaceRefs: BotWorkspaceRef[],
  value: string,
  allowedIds: string[],
): BotWorkspaceRef | null {
  const trimmed = value.trim();
  const index = Number.parseInt(trimmed, 10);
  const workspaces = filterAllowedWorkspaces(workspaceRefs, allowedIds);
  if (Number.isFinite(index) && index > 0) {
    return workspaces[index - 1] ?? null;
  }
  const normalized = normalizeText(trimmed);
  return (
    workspaces.find(
      (workspace) =>
        normalizeText(workspace.id) === normalized ||
        normalizeText(workspace.label) === normalized ||
        workspace.workspacePath === trimmed ||
        getWorkspaceKey(workspace.workspacePath, workspace.workspaceIdentity) === trimmed,
    ) ?? null
  );
}
