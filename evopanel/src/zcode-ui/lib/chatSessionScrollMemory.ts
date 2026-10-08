export interface ChatSessionScrollMemoryState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  wasPinnedToBottom?: boolean;
  updatedAt: number;
}

const CHAT_SESSION_SCROLL_MEMORY_MAX_ENTRIES = 200;

const chatSessionScrollMemory = new Map<string, ChatSessionScrollMemoryState>();

function normalizeKeyPart(value?: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function touchChatSessionScrollMemoryEntry(
  key: string,
  state: ChatSessionScrollMemoryState,
): ChatSessionScrollMemoryState {
  chatSessionScrollMemory.delete(key);
  chatSessionScrollMemory.set(key, state);
  return state;
}

function pruneChatSessionScrollMemory(): void {
  while (chatSessionScrollMemory.size > CHAT_SESSION_SCROLL_MEMORY_MAX_ENTRIES) {
    const oldestKey = chatSessionScrollMemory.keys().next().value;
    if (!oldestKey) {
      return;
    }

    chatSessionScrollMemory.delete(oldestKey);
  }
}

export function buildChatSessionScrollMemoryKey({
  workspacePath,
  workspaceIdentity,
  paneId,
  sessionId,
  taskId,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  paneId?: string;
  sessionId?: string | null;
  taskId?: string | null;
}): string | null {
  const workspaceKey = normalizeKeyPart(workspaceIdentity) ?? normalizeKeyPart(workspacePath);
  const paneScope = normalizeKeyPart(paneId);
  const sessionScope = normalizeKeyPart(sessionId);
  const taskScope = normalizeKeyPart(taskId);
  if (!workspaceKey) {
    return null;
  }

  const rendererScope = paneScope ? `${workspaceKey}::pane:${paneScope}` : workspaceKey;

  if (sessionScope) {
    return `${rendererScope}::session:${sessionScope}`;
  }

  return taskScope ? `${rendererScope}::task:${taskScope}` : null;
}

export function readChatSessionScrollMemoryState(
  key: string | null,
): ChatSessionScrollMemoryState | null {
  if (!key) {
    return null;
  }

  const state = chatSessionScrollMemory.get(key);
  return state ? touchChatSessionScrollMemoryEntry(key, state) : null;
}

export function saveChatSessionScrollMemoryState(
  key: string | null,
  state: ChatSessionScrollMemoryState,
): void {
  if (!key) {
    return;
  }

  touchChatSessionScrollMemoryEntry(key, state);
  pruneChatSessionScrollMemory();
}

export function resolveChatSessionScrollRestoreTop(
  state: Pick<ChatSessionScrollMemoryState, "scrollTop">,
  metrics: Pick<HTMLElement, "clientHeight" | "scrollHeight">,
): number {
  const maxScrollTop = Math.max(metrics.scrollHeight - metrics.clientHeight, 0);
  return Math.min(Math.max(state.scrollTop, 0), maxScrollTop);
}
