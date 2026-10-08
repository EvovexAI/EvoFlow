import type { AgentSummary } from "@zcode/shared";
import { buildSubagentMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import type { MentionItem } from "@/mentions/mentionTypes.js";

type SubagentMentionInput = Pick<
  AgentSummary,
  "id" | "name" | "description" | "path" | "scope" | "source" | "enabled" | "modelSelection"
>;

function getSubagentSourcePriority(agent: SubagentMentionInput): number {
  if (agent.scope === "workspace") {
    return 0;
  }
  if (agent.source === "user") {
    return 1;
  }
  return 2;
}

function getSubagentSourceLabel(agent: SubagentMentionInput): string {
  if (agent.scope === "workspace") {
    return "Workspace";
  }
  if (agent.source === "plugin") {
    return "Plugin";
  }
  if (agent.source === "built-in") {
    return "Built-in";
  }
  return "User";
}

export function mapSubagentsToMentionItemsForTest(agents: SubagentMentionInput[]): MentionItem[] {
  const uniqueAgentsByName = new Map<string, SubagentMentionInput>();
  for (const agent of agents) {
    if (!agent.enabled) {
      continue;
    }
    const key = agent.name.trim().toLowerCase();
    if (!key) {
      continue;
    }
    const current = uniqueAgentsByName.get(key);
    if (!current || getSubagentSourcePriority(agent) < getSubagentSourcePriority(current)) {
      uniqueAgentsByName.set(key, agent);
    }
  }

  return [...uniqueAgentsByName.values()].map((agent) => {
    const sourceLabel = getSubagentSourceLabel(agent);
    const model = agent.modelSelection
      ? `${agent.modelSelection.providerId}/${agent.modelSelection.modelId}`
      : undefined;
    return {
      id: `subagent:${agent.id}`,
      category: "subagents",
      label: agent.name,
      description: agent.description ? `${sourceLabel} · ${agent.description}` : sourceLabel,
      value: agent.name,
      markdown: buildSubagentMentionMarkdown(agent.name),
      keywords: [
        agent.name,
        agent.description,
        agent.scope,
        agent.source,
        sourceLabel,
        model ?? "",
        agent.path,
      ],
      data: {
        path: agent.path,
        scope: agent.scope,
        source: agent.source,
        model,
      },
    } satisfies MentionItem;
  });
}
