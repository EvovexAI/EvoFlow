/**
 * tasks(action=…) 员工任务工具卡：中文 action 枚举 + 名称/状态摘要。
 */
import { ClipboardList } from "lucide-react";
import {
  readNamedToolAction,
  readTasksToolBrief,
  tasksActionLabelZh,
} from "../../../lib/builtin-action-labels.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { ActionNamedToolCallBlock } from "./action-named-tool.js";

const TASKS_TOOL_ICON = <ClipboardList className="size-4 shrink-0 text-foreground-subtle" />;

const TASKS_CONFIG = {
  kindLabel: "员工任务",
  icon: TASKS_TOOL_ICON,
  readAction: readNamedToolAction,
  labelForAction: (action: string) => tasksActionLabelZh(action, { max: 24 }),
  readBrief: readTasksToolBrief,
};

export function isTasksToolCall(toolCall: {
  toolName?: string | null;
  kind?: string | null;
}): boolean {
  const name = String(toolCall.toolName || "").trim().toLowerCase();
  const kind = String(toolCall.kind || "").trim().toLowerCase();
  return name === "tasks" || kind === "tasks";
}

export function TasksToolCallBlock(context: ToolCallBlockRenderContext) {
  return <ActionNamedToolCallBlock context={context} config={TASKS_CONFIG} />;
}
