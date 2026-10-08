export type CommandCenterSearchScope = "all" | "commands" | "conversations" | "files";

export interface CommandCenterSearchHistoryEntry {
  query: string;
  scope: CommandCenterSearchScope;
  updatedAt: number;
}

const COMMAND_CENTER_HISTORY_LIMIT = 20;
const COMMAND_CENTER_HISTORY_KEY_PREFIX = "zcode-command-center-search-history:";

function getStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function getHistoryKey(workspaceKey: string): string {
  return `${COMMAND_CENTER_HISTORY_KEY_PREFIX}${workspaceKey}`;
}

function isCommandCenterSearchHistoryEntry(
  value: unknown,
): value is CommandCenterSearchHistoryEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as Partial<CommandCenterSearchHistoryEntry>;
  return (
    typeof entry.query === "string" &&
    typeof entry.updatedAt === "number" &&
    (entry.scope === "all" ||
      entry.scope === "commands" ||
      entry.scope === "conversations" ||
      entry.scope === "files")
  );
}

export function readCommandCenterSearchHistory(
  workspaceKey: string,
): CommandCenterSearchHistoryEntry[] {
  const storage = getStorage();
  if (!storage) {
    return [];
  }

  try {
    const parsed = JSON.parse(storage.getItem(getHistoryKey(workspaceKey)) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter(isCommandCenterSearchHistoryEntry).slice(0, COMMAND_CENTER_HISTORY_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function writeCommandCenterSearchHistory(
  workspaceKey: string,
  entries: CommandCenterSearchHistoryEntry[],
) {
  const storage = getStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(
      getHistoryKey(workspaceKey),
      JSON.stringify(entries.slice(0, COMMAND_CENTER_HISTORY_LIMIT)),
    );
  } catch {
    // 搜索历史只是快捷入口，localStorage 不可用时不应阻断命令中心主流程。
  }
}

export function pushCommandCenterSearchHistory(params: {
  workspaceKey: string;
  query: string;
  scope: CommandCenterSearchScope;
}): CommandCenterSearchHistoryEntry[] {
  const query = params.query.trim();
  if (!query || query === ">" || query === "#" || query === "@") {
    return readCommandCenterSearchHistory(params.workspaceKey);
  }

  const nextEntry: CommandCenterSearchHistoryEntry = {
    query,
    scope: params.scope,
    updatedAt: Date.now(),
  };
  const dedupeKey = query.toLocaleLowerCase();
  const entries = [
    nextEntry,
    ...readCommandCenterSearchHistory(params.workspaceKey).filter(
      (entry) => entry.query.toLocaleLowerCase() !== dedupeKey,
    ),
  ].slice(0, COMMAND_CENTER_HISTORY_LIMIT);
  writeCommandCenterSearchHistory(params.workspaceKey, entries);
  return entries;
}

export function clearCommandCenterSearchHistory(workspaceKey: string) {
  writeCommandCenterSearchHistory(workspaceKey, []);
}
