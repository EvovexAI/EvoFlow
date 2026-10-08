import { $getSelection, $isRangeSelection, $isTextNode } from "lexical";
export function getCurrentTextNodeSelection() {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return null;
  }

  const anchor = selection.anchor;
  if (anchor.type !== "text") {
    return null;
  }

  const node = anchor.getNode();
  if (!$isTextNode(node)) {
    return null;
  }

  const text = node.getTextContent();
  return {
    selection,
    node,
    cursorOffset: anchor.offset,
    nodeKey: node.getKey(),
    text,
    textAfterCursor: text.slice(anchor.offset),
    textBeforeCursor: text.slice(0, anchor.offset),
  };
}
