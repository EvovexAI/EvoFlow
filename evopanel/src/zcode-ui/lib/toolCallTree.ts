import type { TaskChatToolCall } from "@/lib/taskChatMessageTypes.js";

export interface TaskChatToolCallTreeNode {
  toolCall: TaskChatToolCall;
  childToolCalls: TaskChatToolCallTreeNode[];
}
