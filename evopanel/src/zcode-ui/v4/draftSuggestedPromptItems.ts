import type { ClientSceneConfig, ClientSceneItem } from "@zcode/services";

export interface DraftSuggestedPromptLocalizedText {
  cn?: string;
  en?: string;
}

export const DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS = "NAVIGATE:AUTOMATIONS" as const;
export const DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS_OFFPEAK =
  "NAVIGATE:AUTOMATIONS:OFFPEAK" as const;

export type DraftSuggestedPromptAction =
  | typeof DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS
  | typeof DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS_OFFPEAK;

export interface DraftSuggestedPromptItem {
  id: string;
  /** Lucide canonical 名称，只来自 ClientSceneItem.img；不使用 imgs。 */
  iconName?: string;
  /** 官方推荐项的市场图标。 */
  iconUrl?: string;
  /** 复用插件市场图标的展示样式，不代表绑定插件。 */
  iconStyle?: "plugin";
  label: DraftSuggestedPromptLocalizedText;
  prompt: DraftSuggestedPromptLocalizedText;
  actions?: DraftSuggestedPromptAction[];
  plugin?: {
    stableId: string;
    label: DraftSuggestedPromptLocalizedText;
  };
}

function parseDraftSuggestedPromptActions(
  onFinish: string | null | undefined,
): DraftSuggestedPromptAction[] {
  if (!onFinish) return [];

  const actions: DraftSuggestedPromptAction[] = [];
  for (const token of onFinish.split(",")) {
    switch (token.trim()) {
      case DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS:
        if (!actions.includes(DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS)) {
          actions.push(DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS);
        }
        break;
      case DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS_OFFPEAK:
        if (!actions.includes(DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS_OFFPEAK)) {
          actions.push(DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS_OFFPEAK);
        }
        break;
      default:
        break;
    }
  }
  return actions;
}

function findDefaultItem(
  scene: ClientSceneConfig,
  promptItem: ClientSceneItem,
): ClientSceneItem | undefined {
  for (const [optionKey, itemIds] of Object.entries(promptItem.defaults ?? {})) {
    const optionItems = scene.options[optionKey]?.items;
    if (!optionItems) continue;
    for (const itemId of itemIds) {
      const item = optionItems.find((candidate) => candidate.id === itemId);
      if (item) return item;
    }
  }
  return undefined;
}

export function mapClientScenesToDraftSuggestedPromptItems(
  scenes: readonly ClientSceneConfig[],
): DraftSuggestedPromptItem[] {
  const scene = scenes.find((candidate) => candidate.scene === "draft-suggestion");
  const promptItems = scene?.options.prompts?.items;
  if (!scene || !promptItems) return [];

  return promptItems.map((item) => {
    const defaultItem = findDefaultItem(scene, item);
    const actions = parseDraftSuggestedPromptActions(item.on_finish);
    const stableId = defaultItem?.contents.en?.trim() || defaultItem?.contents.cn?.trim();
    return {
      id: item.id,
      ...(item.img?.trim() ? { iconName: item.img.trim() } : {}),
      label: item.labels,
      prompt: item.contents,
      ...(actions.length > 0 ? { actions } : {}),
      ...(defaultItem && stableId
        ? {
            plugin: {
              stableId,
              label: defaultItem.labels,
            },
          }
        : {}),
    };
  });
}

export function resolveDraftSuggestedPromptText(
  text: DraftSuggestedPromptLocalizedText,
  locale: string,
): string {
  const primary = locale.startsWith("zh") ? text.cn : text.en;
  const fallback = locale.startsWith("zh") ? text.en : text.cn;
  return primary?.trim() || fallback?.trim() || "";
}
