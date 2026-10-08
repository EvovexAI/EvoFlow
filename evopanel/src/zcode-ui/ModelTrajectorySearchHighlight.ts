import { findTrajectoryTextMatches, type TrajectorySearchMatch } from "@/ModelTrajectorySearch.js";

const HIGHLIGHT_NAME = "zcode-model-trajectory-find";
const ACTIVE_HIGHLIGHT_NAME = "zcode-model-trajectory-find-active";
const STYLE_ID = "zcode-model-trajectory-find-highlight-style";
const HIGHLIGHT_STYLE = `
::highlight(${HIGHLIGHT_NAME}) {
  background-color: var(--color-find-highlight, #fde68a);
  color: var(--color-foreground);
}
::highlight(${ACTIVE_HIGHLIGHT_NAME}) {
  background-color: var(--color-find-highlight-active, #facc15);
  color: var(--color-foreground);
}
`;

interface HighlightRegistry {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => void;
}

type HighlightConstructor = new (...ranges: Range[]) => unknown;

export function applyTrajectorySearchHighlights({
  root,
  query,
  matches,
  activeMatch,
}: {
  root: HTMLElement;
  query: string;
  matches: readonly TrajectorySearchMatch[];
  activeMatch: TrajectorySearchMatch | null;
}): Range | null {
  const support = getHighlightSupport();
  if (!support) return null;
  ensureStyle();
  const ranges = matches
    .map((match) => getMatchRange(root, query, match, false))
    .filter((range): range is Range => range !== null);
  const activeRange = activeMatch ? getMatchRange(root, query, activeMatch, true) : null;
  support.registry.set(HIGHLIGHT_NAME, new support.Highlight(...ranges));
  support.registry.set(
    ACTIVE_HIGHLIGHT_NAME,
    new support.Highlight(...(activeRange ? [activeRange] : [])),
  );
  return activeRange;
}

export function clearTrajectorySearchHighlights(): void {
  const support = getHighlightSupport();
  support?.registry.delete(HIGHLIGHT_NAME);
  support?.registry.delete(ACTIVE_HIGHLIGHT_NAME);
}

export function isTrajectorySearchTargetMounted(root: HTMLElement, expansionKey: string): boolean {
  return [...root.querySelectorAll<HTMLElement>("[data-trajectory-search-target-key]")].some(
    (element) => element.dataset.trajectorySearchTargetKey === expansionKey,
  );
}

export function scrollTrajectorySearchRangeIntoView(
  range: Range,
  scrollContainer: HTMLElement,
): boolean {
  const rangeRect = range.getBoundingClientRect();
  const containerRect = scrollContainer.getBoundingClientRect();
  if (rangeRect.top >= containerRect.top && rangeRect.bottom <= containerRect.bottom) return false;

  // 不能在 virtualizer 预定位后再用 scrollIntoView 滚动整个祖先链；直接修正轨迹容器
  // 的 scrollTop，确保一次“下一个”只有最终文本定位这一段可见滚动。
  const rangeCenter = rangeRect.top + rangeRect.height / 2;
  const containerCenter = containerRect.top + containerRect.height / 2;
  scrollContainer.scrollTop += rangeCenter - containerCenter;
  return true;
}

function getMatchRange(
  root: HTMLElement,
  query: string,
  match: TrajectorySearchMatch,
  preferExpanded: boolean,
): Range | null {
  const target = [
    ...root.querySelectorAll<HTMLElement>("[data-trajectory-search-target-key]"),
  ].find((element) => element.dataset.trajectorySearchTargetKey === match.expansionKey);
  if (!target) return null;
  let fields = [
    ...target.querySelectorAll<HTMLElement>(`[data-trajectory-search-field="${match.field}"]`),
  ];
  if (preferExpanded && target.dataset.state === "open") {
    const expandedFields = fields.filter((element) =>
      element.closest("[data-trajectory-message-expanded]"),
    );
    if (expandedFields.length > 0) fields = expandedFields;
  }
  const ranges = fields.flatMap((element) => collectRanges(element, query));
  return ranges[match.fieldMatchIndex] ?? ranges[0] ?? null;
}

function collectRanges(element: HTMLElement, normalizedQuery: string): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    for (const match of findTrajectoryTextMatches(textNode.data, normalizedQuery)) {
      const range = document.createRange();
      range.setStart(textNode, match.sourceStart);
      range.setEnd(textNode, match.sourceEnd);
      ranges.push(range);
    }
    node = walker.nextNode();
  }
  return ranges;
}

function ensureStyle(): void {
  const style = document.getElementById(STYLE_ID) ?? document.createElement("style");
  style.id = STYLE_ID;
  if (style.textContent !== HIGHLIGHT_STYLE) style.textContent = HIGHLIGHT_STYLE;
  if (!style.isConnected) document.head.append(style);
}

function getHighlightSupport(): {
  registry: HighlightRegistry;
  Highlight: HighlightConstructor;
} | null {
  if (typeof window === "undefined" || typeof CSS === "undefined") return null;
  const registry = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
  const Highlight = (window as unknown as { Highlight?: HighlightConstructor }).Highlight;
  return registry && Highlight ? { registry, Highlight } : null;
}
