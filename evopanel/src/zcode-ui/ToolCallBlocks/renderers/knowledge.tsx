/**
 * knowledge(action=…) 知识库工具卡：中文 action 枚举 + 检索词/文档名摘要。
 */
import { BookOpen } from "lucide-react";
import {
  knowledgeActionLabelZh,
  readKnowledgeToolBrief,
  readNamedToolAction,
} from "../../../lib/builtin-action-labels.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { ActionNamedToolCallBlock } from "./action-named-tool.js";

const KNOWLEDGE_TOOL_ICON = <BookOpen className="size-4 shrink-0 text-foreground-subtle" />;

function readKnowledgeAction(input: unknown): string {
  const action = readNamedToolAction(input);
  if (action) return action;
  // knowledge_tool 默认 action=search；模型省略或流式半截时仍按检索展示。
  return readKnowledgeToolBrief(input) ? "search" : "";
}

const KNOWLEDGE_CONFIG = {
  kindLabel: "知识库",
  icon: KNOWLEDGE_TOOL_ICON,
  readAction: readKnowledgeAction,
  labelForAction: (action: string) => knowledgeActionLabelZh(action, { max: 24 }),
  readBrief: readKnowledgeToolBrief,
};

export function isKnowledgeToolCall(toolCall: {
  toolName?: string | null;
  kind?: string | null;
}): boolean {
  const name = String(toolCall.toolName || "").trim().toLowerCase();
  const kind = String(toolCall.kind || "").trim().toLowerCase();
  return name === "knowledge" || kind === "knowledge";
}

export function KnowledgeToolCallBlock(context: ToolCallBlockRenderContext) {
  return <ActionNamedToolCallBlock context={context} config={KNOWLEDGE_CONFIG} />;
}
