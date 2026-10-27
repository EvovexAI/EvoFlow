/**
 * assets(action=…) 资产工具卡：中文 action 枚举 + 检索词/路径摘要。
 */
import { FolderOpen } from "lucide-react";
import {
  assetsActionLabelZh,
  readAssetsToolBrief,
  readNamedToolAction,
} from "../../../lib/builtin-action-labels.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { ActionNamedToolCallBlock } from "./action-named-tool.js";

const ASSETS_TOOL_ICON = <FolderOpen className="size-4 shrink-0 text-foreground-subtle" />;

const ASSETS_CONFIG = {
  kindLabel: "资产",
  icon: ASSETS_TOOL_ICON,
  readAction: readNamedToolAction,
  labelForAction: (action: string) => assetsActionLabelZh(action, { max: 24 }),
  readBrief: readAssetsToolBrief,
};

export function isAssetsToolCall(toolCall: {
  toolName?: string | null;
  kind?: string | null;
}): boolean {
  const name = String(toolCall.toolName || "").trim().toLowerCase();
  const kind = String(toolCall.kind || "").trim().toLowerCase();
  return name === "assets" || kind === "assets";
}

export function AssetsToolCallBlock(context: ToolCallBlockRenderContext) {
  return <ActionNamedToolCallBlock context={context} config={ASSETS_CONFIG} />;
}
