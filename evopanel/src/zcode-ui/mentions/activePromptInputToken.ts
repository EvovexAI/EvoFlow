import {
  extractActivePromptInputTrigger,
  type ActivePromptInputTrigger,
} from "@/lib/promptInputTriggers.js";

interface PromptInputTextSelectionSnapshot {
  cursorOffset: number;
  nodeKey: string;
  text: string;
  textBeforeCursor: string;
}

export interface ActivePromptInputTokenSnapshot extends ActivePromptInputTrigger {
  nodeKey: string;
  tokenEnd: number;
  tokenStart: number;
  tokenText: string;
}

function isCaretInsideToken(
  snapshot: ActivePromptInputTokenSnapshot,
  cursorOffset: number,
): boolean {
  return cursorOffset >= snapshot.tokenStart + 1 && cursorOffset <= snapshot.tokenEnd;
}

function createActivePromptInputTokenSnapshot(
  selection: PromptInputTextSelectionSnapshot,
): ActivePromptInputTokenSnapshot | null {
  const activeTrigger = extractActivePromptInputTrigger(selection.textBeforeCursor);
  if (!activeTrigger) {
    return null;
  }

  const tokenStart = selection.cursorOffset - activeTrigger.query.length - 1;
  const tokenEnd = selection.cursorOffset;
  return {
    ...activeTrigger,
    nodeKey: selection.nodeKey,
    tokenEnd,
    tokenStart,
    tokenText: selection.text.slice(tokenStart, tokenEnd),
  };
}

export function reconcileActivePromptInputTokenSnapshot(
  previous: ActivePromptInputTokenSnapshot | null,
  selection: PromptInputTextSelectionSnapshot,
  selectionOnly: boolean,
): ActivePromptInputTokenSnapshot | null {
  if (!selectionOnly || !previous) {
    return createActivePromptInputTokenSnapshot(selection);
  }

  if (previous.nodeKey !== selection.nodeKey) {
    return null;
  }

  const currentTokenText = selection.text.slice(previous.tokenStart, previous.tokenEnd);
  if (currentTokenText !== previous.tokenText) {
    return createActivePromptInputTokenSnapshot(selection);
  }

  if (!isCaretInsideToken(previous, selection.cursorOffset)) {
    return null;
  }

  // ArrowLeft/ArrowRight 只改变 selection，token 文本并未改变。
  // 若仍按光标前缀重算 query，会反复过滤候选、重置 selectedIndex 并重建虚拟列表。
  return previous;
}

export function getActivePromptInputTokenReplacementRange(
  snapshot: ActivePromptInputTokenSnapshot | null,
  selection: PromptInputTextSelectionSnapshot,
): { end: number; start: number } | null {
  if (
    !snapshot ||
    snapshot.nodeKey !== selection.nodeKey ||
    !isCaretInsideToken(snapshot, selection.cursorOffset) ||
    selection.text.slice(snapshot.tokenStart, snapshot.tokenEnd) !== snapshot.tokenText
  ) {
    return null;
  }

  return { end: snapshot.tokenEnd, start: snapshot.tokenStart };
}
