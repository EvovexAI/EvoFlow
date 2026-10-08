import {
  $getCharacterOffsets,
  $getRoot,
  $isElementNode,
  $isTextNode,
  type LexicalNode,
  type RangeSelection,
} from "lexical";
import { $isPromptMentionNode } from "@/mentions/nodes/PromptMentionNode.js";

/** 编辑器文本用于光标；业务输出显式读取 canonical，不能覆写 TextNode 文本语义。 */
export function $getPromptMarkdown(node: LexicalNode = $getRoot()): string {
  if ($isPromptMentionNode(node)) return node.getMarkdown();
  if (!$isElementNode(node)) return node.getTextContent();
  const children = node.getChildren();
  return children
    .map(
      (child, index) =>
        $getPromptMarkdown(child) +
        ($isElementNode(child) && !child.isInline() && index < children.length - 1 ? "\n\n" : ""),
    )
    .join("");
}

/** 与 Lexical RangeSelection 的段落/端点规则一致，仅将实际选中的 token 换为 canonical。 */
export function $getPromptSelectionMarkdown(selection: RangeSelection): string {
  if (selection.isCollapsed()) return "";
  const nodes = selection.getNodes();
  const [anchorOffset, focusOffset] = $getCharacterOffsets(selection);
  const forward = selection.anchor.isBefore(selection.focus);
  const start = forward ? anchorOffset : focusOffset;
  const end = forward ? focusOffset : anchorOffset;
  let result = "";
  let previousWasElement = true;
  for (const [index, node] of nodes.entries()) {
    if ($isElementNode(node) && !node.isInline()) {
      if (!previousWasElement) result += "\n";
      previousWasElement = !node.isEmpty();
      continue;
    }
    previousWasElement = false;
    let text = node.getTextContent();
    if ($isTextNode(node)) {
      let from = index === 0 ? start : 0;
      let to = index === nodes.length - 1 ? end : text.length;
      // 两个 element point 包住同一个文本节点时，offset 是子节点索引而不是字符。
      if (
        nodes.length === 1 &&
        selection.anchor.type === "element" &&
        selection.focus.type === "element" &&
        selection.anchor.offset !== selection.focus.offset
      ) {
        from = 0;
        to = text.length;
      }
      text = text.slice(from, to);
      if (text && $isPromptMentionNode(node)) text = node.getMarkdown();
    }
    result += text;
  }
  return result;
}

/** 剪切与复制都将相交 token 视为整体，但不能扩张仅触碰边界的选区。 */
export function $getAtomicPromptSelection(selection: RangeSelection): RangeSelection {
  const normalized = selection.clone();
  if (normalized.isCollapsed()) return normalized;
  const [start, end] = normalized.isBackward()
    ? [normalized.focus, normalized.anchor]
    : [normalized.anchor, normalized.focus];
  const startNode = start.getNode();
  const endNode = end.getNode();
  if (
    start.type === "text" &&
    $isPromptMentionNode(startNode) &&
    start.offset < startNode.getTextContentSize()
  ) {
    start.set(start.key, 0, "text");
  }
  if (end.type === "text" && $isPromptMentionNode(endNode) && end.offset > 0) {
    end.set(end.key, endNode.getTextContentSize(), "text");
  }
  return normalized;
}
