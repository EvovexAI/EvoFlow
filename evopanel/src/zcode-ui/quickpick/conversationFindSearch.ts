interface ConversationFindState {
  currentIndex: number;
  total: number;
}

type ConversationFindDirection = "previous" | "next";

export function resolveConversationFindNavigationDirection(
  key: string,
  shiftKey: boolean,
): ConversationFindDirection | null {
  if (key === "ArrowUp") {
    return "previous";
  }
  if (key === "ArrowDown") {
    return "next";
  }
  if (key === "Enter") {
    return shiftKey ? "previous" : "next";
  }
  return null;
}

export function getConversationFindState(
  total: number,
  preferredIndex: number,
): ConversationFindState {
  if (total <= 0) {
    return { currentIndex: -1, total: 0 };
  }

  return {
    currentIndex: preferredIndex >= 0 && preferredIndex < total ? preferredIndex : 0,
    total,
  };
}

function moveConversationFindSelection(
  state: ConversationFindState,
  direction: ConversationFindDirection,
): number {
  if (state.total <= 0 || state.currentIndex < 0) {
    return -1;
  }

  const delta = direction === "next" ? 1 : -1;
  return (state.currentIndex + delta + state.total) % state.total;
}

export function resolveConversationFindNavigationSelection(
  query: string,
  state: ConversationFindState,
  direction: ConversationFindDirection,
): { activeIndex: number; query: string } {
  return {
    activeIndex: moveConversationFindSelection(state, direction),
    query,
  };
}
