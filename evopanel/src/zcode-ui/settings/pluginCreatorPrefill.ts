import type { SkillSummary } from "@zcode/shared";
import type { CreateTaskOptions } from "@/app-shell/types.js";
import { buildSkillMentionMarkdown } from "@/mentions/mentionMarkdown.js";

const PLUGIN_CREATOR_SKILL = "plugin-creator";
const PLUGIN_CREATOR_ID = "plugin-creator@zcode-plugins-official";

function buildPluginCreatorPrefill(skills: readonly SkillSummary[]): CreateTaskOptions {
  // 创建入口只信任官方来源，不让用户目录或同名市场技能截获这项产品动作。
  const skill = skills.find(
    (entry) =>
      entry.name === PLUGIN_CREATOR_SKILL &&
      entry.pluginId === PLUGIN_CREATOR_ID &&
      entry.scope === "plugin" &&
      entry.enabled &&
      entry.path.trim(),
  );
  if (!skill) throw new Error("plugin_creator_unavailable");
  const markdown = buildSkillMentionMarkdown(skill.name, skill.path);
  return {
    initialPrompt: `${markdown} `,
    initialPromptMention: {
      id: `skill:${skill.id}`,
      category: "skills",
      label: skill.name,
      value: skill.name,
      markdown,
      description: skill.description,
      data: { path: skill.path, scope: skill.scope },
    },
  };
}

export async function loadPluginCreatorPrefill(
  loadSkills: () => Promise<{ skills: SkillSummary[] }>,
  isCurrent: () => boolean,
): Promise<CreateTaskOptions | null> {
  const result = await loadSkills();
  return isCurrent() ? buildPluginCreatorPrefill(result.skills) : null;
}
