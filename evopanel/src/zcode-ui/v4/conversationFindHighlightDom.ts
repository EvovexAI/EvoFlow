import type { ConversationFindMatch } from "@/v4/conversationFindIndex.js";

const FIND_HIGHLIGHT_NAME = "zcode-v4-conversation-find";
const ACTIVE_FIND_HIGHLIGHT_NAME = "zcode-v4-conversation-find-active";
const SEARCH_RESULT_HIGHLIGHT_NAME = "zcode-v4-conversation-search-result";

const FIND_STYLE_ID = "zcode-v4-conversation-find-highlight-style";
const FIND_HIGHLIGHT_STYLE = `
::highlight(${FIND_HIGHLIGHT_NAME}) {
  background-color: var(--color-find-highlight, #fde68a);
  color: var(--color-foreground);
}
::highlight(${ACTIVE_FIND_HIGHLIGHT_NAME}) {
  background-color: var(--color-find-highlight-active, #facc15);
  color: var(--color-foreground);
}
::highlight(${SEARCH_RESULT_HIGHLIGHT_NAME}) {
  background-color: var(--color-find-highlight-active, #facc15);
  color: var(--color-foreground);
}
`;

interface CssHighlightRegistryLike {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => void;
}

type CssHighlightLike = { priority?: number };
type HighlightConstructor = new (...ranges: Range[]) => unknown;

function ensureConversationFindHighlightStyle() {
  if (typeof document === "undefined") {
    return;
  }

  const style = document.getElementById(FIND_STYLE_ID) ?? document.createElement("style");
  style.id = FIND_STYLE_ID;
  if (style.textContent !== FIND_HIGHLIGHT_STYLE) {
    // 开发态 HMR 会复用旧 style 节点；内容变化时必须同步更新。
    style.textContent = FIND_HIGHLIGHT_STYLE;
  }
  if (!style.isConnected) {
    document.head.append(style);
  }
}

function getCssHighlightSupport(): {
  highlights: CssHighlightRegistryLike;
  Highlight: HighlightConstructor;
} | null {
  if (typeof window === "undefined" || typeof CSS === "undefined") {
    return null;
  }

  const highlights = (CSS as unknown as { highlights?: CssHighlightRegistryLike }).highlights;
  const Highlight = (window as unknown as { Highlight?: HighlightConstructor }).Highlight;
  if (!highlights || !Highlight) {
    return null;
  }
  return { highlights, Highlight };
}

function createHighlight(
  Highlight: HighlightConstructor,
  ranges: Range[],
  priority: number,
): unknown {
  const highlight = new Highlight(...ranges) as CssHighlightLike;
  highlight.priority = priority;
  return highlight;
}

function shouldSkipTextNode(textNode: Text): boolean {
  const parent = textNode.parentElement;
  if (!parent) {
    return true;
  }
  return Boolean(
    parent.closest(
      'button,input,textarea,select,[contenteditable="true"],[data-conversation-find-ignore="true"]',
    ),
  );
}

function collectTextRangesInElement(element: HTMLElement, normalizedQuery: string): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!(node instanceof Text) || shouldSkipTextNode(node)) {
        return NodeFilter.FILTER_REJECT;
      }
      return node.data.toLocaleLowerCase().includes(normalizedQuery)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    },
  });

  let currentNode = walker.nextNode();
  while (currentNode) {
    const textNode = currentNode as Text;
    const normalizedText = textNode.data.toLocaleLowerCase();
    let searchStart = 0;
    while (searchStart < normalizedText.length) {
      const matchIndex = normalizedText.indexOf(normalizedQuery, searchStart);
      if (matchIndex === -1) {
        break;
      }
      const range = document.createRange();
      range.setStart(textNode, matchIndex);
      range.setEnd(textNode, matchIndex + normalizedQuery.length);
      ranges.push(range);
      searchStart = matchIndex + normalizedQuery.length;
    }
    currentNode = walker.nextNode();
  }

  return ranges;
}

function getMountedRowElement(root: HTMLElement, rowId: number): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-row-id="${rowId}"]`);
}

function getMountedConversationFindRange(
  root: HTMLElement,
  query: string,
  match: ConversationFindMatch,
): Range | null {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return null;
  }
  const rowElement = getMountedRowElement(root, match.rowId);
  if (!rowElement) {
    return null;
  }
  const rowRanges = collectTextRangesInElement(rowElement, normalizedQuery);
  return rowRanges[match.rowMatchIndex] ?? null;
}

export function applyConversationFindHighlights({
  root,
  query,
  matches,
  activeMatch,
}: {
  root: HTMLElement;
  query: string;
  matches: readonly ConversationFindMatch[];
  activeMatch: ConversationFindMatch | null;
}): Range | null {
  ensureConversationFindHighlightStyle();
  const support = getCssHighlightSupport();
  if (!support) {
    return null;
  }

  const ranges = matches
    .map((match) => getMountedConversationFindRange(root, query, match))
    .filter((range): range is Range => range !== null);
  const activeRange = activeMatch
    ? getMountedConversationFindRange(root, query, activeMatch)
    : null;

  support.highlights.set(FIND_HIGHLIGHT_NAME, createHighlight(support.Highlight, ranges, 0));
  support.highlights.set(
    ACTIVE_FIND_HIGHLIGHT_NAME,
    createHighlight(support.Highlight, activeRange ? [activeRange] : [], 1),
  );
  return activeRange;
}

export function applySearchResultHighlight({
  root,
  query,
  match,
}: {
  root: HTMLElement;
  query: string;
  match: ConversationFindMatch;
}): Range | null {
  ensureConversationFindHighlightStyle();
  const support = getCssHighlightSupport();
  if (!support) {
    return null;
  }
  const range = getMountedConversationFindRange(root, query, match);
  support.highlights.set(
    SEARCH_RESULT_HIGHLIGHT_NAME,
    createHighlight(support.Highlight, range ? [range] : [], 2),
  );
  return range;
}

export function scrollConversationFindRangeIntoView(range: Range) {
  const container = range.commonAncestorContainer;
  const element = container instanceof Element ? container : container.parentElement;
  element?.scrollIntoView({ block: "center", behavior: "smooth" });
}

export function clearConversationFindHighlights() {
  const support = getCssHighlightSupport();
  support?.highlights.delete(FIND_HIGHLIGHT_NAME);
  support?.highlights.delete(ACTIVE_FIND_HIGHLIGHT_NAME);
}

export function clearSearchResultHighlight() {
  getCssHighlightSupport()?.highlights.delete(SEARCH_RESULT_HIGHLIGHT_NAME);
}
