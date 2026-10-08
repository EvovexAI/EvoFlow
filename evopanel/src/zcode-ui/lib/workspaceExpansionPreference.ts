interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const WORKSPACE_EXPANSION_STORAGE_KEY = "zcode-workspace-expansion";

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export type WorkspaceExpansionState = Record<string, boolean>;

function normalizeWorkspaceExpansionState(value: unknown): WorkspaceExpansionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, boolean] =>
        typeof entry[0] === "string" && typeof entry[1] === "boolean",
    ),
  );
}

export function readWorkspaceExpansionState(
  storage: StorageLike | null = getBrowserStorage(),
): WorkspaceExpansionState {
  const rawValue = storage?.getItem(WORKSPACE_EXPANSION_STORAGE_KEY);
  if (!rawValue) {
    return {};
  }

  try {
    return normalizeWorkspaceExpansionState(JSON.parse(rawValue));
  } catch {
    return {};
  }
}

function persistWorkspaceExpansionState(
  state: WorkspaceExpansionState,
  storage: StorageLike | null = getBrowserStorage(),
) {
  storage?.setItem(
    WORKSPACE_EXPANSION_STORAGE_KEY,
    JSON.stringify(normalizeWorkspaceExpansionState(state)),
  );
}

export function persistWorkspaceExpandedPreference(
  workspacePath: string,
  expanded: boolean,
  storage: StorageLike | null = getBrowserStorage(),
) {
  const currentState = readWorkspaceExpansionState(storage);
  if (currentState[workspacePath] === expanded) {
    return;
  }

  persistWorkspaceExpansionState(
    {
      ...currentState,
      [workspacePath]: expanded,
    },
    storage,
  );
}

export function resolveExpandedWorkspacePaths(
  workspacePaths: readonly string[],
  expansionState: WorkspaceExpansionState,
): Set<string> {
  return new Set(workspacePaths.filter((workspacePath) => expansionState[workspacePath] !== false));
}
