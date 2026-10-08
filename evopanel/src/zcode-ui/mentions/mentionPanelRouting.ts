import type { PromptInputTrigger } from "@/lib/promptInputTriggers.js";

export type MentionPanelGroupId = "plugins" | "files" | "sessions" | "whiteboards" | "skills";
export type SessionMentionWorkspaceScope = "current-workspace" | "same-authority-workspaces";

const CONTEXT_GROUP_ORDER: readonly MentionPanelGroupId[] = [
  "plugins",
  "files",
  "sessions",
  "whiteboards",
];
const SESSION_GROUP_ORDER: readonly MentionPanelGroupId[] = ["sessions"];
const SKILL_GROUP_ORDER: readonly MentionPanelGroupId[] = ["skills"];

/**
 * 输入触发器只负责发现入口，不改变候选选中后的 canonical mention。
 * `#` 与 `$`（含输入层归一后的 `¥` / `￥`）继续保留旧单分组面板。
 */
export function getMentionPanelGroupOrder(
  trigger: PromptInputTrigger | null | undefined,
): readonly MentionPanelGroupId[] {
  if (trigger === "@") {
    return CONTEXT_GROUP_ORDER;
  }
  if (trigger === "#") {
    return SESSION_GROUP_ORDER;
  }
  if (trigger === "$") {
    return SKILL_GROUP_ORDER;
  }
  return [];
}

/**
 * `@` 与 `#` 虽然复用会话 provider，但产品范围不同。
 * 若在共享 provider 内无条件扩展 workspace，`@` 会被连带扩容；范围必须由触发器路由显式决定。
 */
export function getSessionMentionWorkspaceScope(
  trigger: PromptInputTrigger | null | undefined,
): SessionMentionWorkspaceScope {
  return trigger === "#" ? "same-authority-workspaces" : "current-workspace";
}
