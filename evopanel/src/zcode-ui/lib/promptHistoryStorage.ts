import { MAX_PROMPT_HISTORY } from "@/lib/promptHistory.js";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PROMPT_HISTORY_STORAGE_KEY_PREFIX = "zcode-chat-prompt-history:";

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

function getPromptHistoryStorageKey(workspacePath: string) {
  return `${PROMPT_HISTORY_STORAGE_KEY_PREFIX}${workspacePath}`;
}

function normalizePromptHistoryEntries(entries: readonly unknown[]): string[] {
  return entries
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(-MAX_PROMPT_HISTORY);
}

export function readPromptHistoryEntries(
  workspacePath: string,
  storage: StorageLike | null = getBrowserStorage(),
): string[] {
  const rawValue = storage?.getItem(getPromptHistoryStorageKey(workspacePath));
  if (!rawValue) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return normalizePromptHistoryEntries(parsed);
  } catch {
    return [];
  }
}

export function persistPromptHistoryEntries(
  workspacePath: string,
  entries: readonly string[],
  storage: StorageLike | null = getBrowserStorage(),
) {
  const normalizedEntries = normalizePromptHistoryEntries(entries);

  // 之前聊天输入历史只挂在 ChatView 内存里，刷新页面或重启窗口后就会整段丢失，
  // 用户按上键也拿不到刚发过的消息。这里改成按 workspace 写入 localStorage，
  // 既保留重开后的历史，又避免不同项目之间把提示词历史串在一起。
  storage?.setItem(getPromptHistoryStorageKey(workspacePath), JSON.stringify(normalizedEntries));
}
