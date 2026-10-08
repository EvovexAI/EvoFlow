import type { ClientSceneConfig, ClientSceneItem } from "@zcode/services";
import type { AutomationScheduledTemplateIconName } from "@/settings/AutomationScheduledTemplateIcon.js";
import type { OffPeakTemplateIconName } from "@/settings/OffPeakTemplateIcon.js";
import { canVisualizeCronInAutomationEditor } from "@/settings/automationFormat.js";

export interface AutomationTemplateLocalizedText {
  cn?: string;
  en?: string;
}

interface AutomationTemplateBase {
  id: string;
  iconName?: string;
  title: AutomationTemplateLocalizedText;
  description: AutomationTemplateLocalizedText;
  prompt: AutomationTemplateLocalizedText;
}

export interface ScheduledAutomationTemplate extends AutomationTemplateBase {
  cronExpr: string;
  icon: AutomationScheduledTemplateIconName;
}

export interface OffPeakAutomationTemplate extends AutomationTemplateBase {
  homepageDescription?: AutomationTemplateLocalizedText;
  customize: boolean;
  icon: OffPeakTemplateIconName;
}

type FormatAutomationMessage = (descriptor: { id: string }) => string;

const CUSTOMIZE_TEMPLATE_MESSAGE_IDS = {
  title: "offPeak.newTask.template.customize.title",
  description: "offPeak.newTask.template.customize.description",
} as const;

export interface AutomationTemplateCatalog {
  scheduled: ScheduledAutomationTemplate[];
  offPeak: OffPeakAutomationTemplate[];
  rejectedScheduledTemplateIds: string[];
}

const CUSTOMIZE_TEMPLATE: OffPeakAutomationTemplate = {
  id: "customize",
  // Customize 是本地保底入口，稳定文案由 locale 真源在渲染时解析，避免 catalog 再保存一份双语副本。
  title: {},
  description: {},
  prompt: { cn: "", en: "" },
  customize: true,
  icon: "customize",
};

function normalizeTemplateId(id: string): string {
  return id.replace(/^item[-_]?/i, "");
}

function resolveTemplateIconName(item: ClientSceneItem): string | undefined {
  return item.img?.trim() || undefined;
}

function resolveOffPeakHomepageDescription(item: ClientSceneItem): AutomationTemplateLocalizedText {
  return {
    cn: item.descs?.cn?.trim() || item.contents.cn,
    en: item.descs?.en?.trim() || item.contents.en,
  };
}

function scheduledIcon(id: string): AutomationScheduledTemplateIconName {
  const normalized = normalizeTemplateId(id).toLowerCase();
  if (normalized.includes("morning") || normalized.includes("standup")) return "target";
  if (normalized.includes("risk") || normalized.includes("ci")) return "activity";
  if (normalized.includes("release") || normalized.includes("file")) return "file";
  return "list";
}

function offPeakIcon(id: string, customize: boolean): OffPeakTemplateIconName {
  if (customize) return "customize";
  const normalized = normalizeTemplateId(id).toLowerCase();
  if (normalized.includes("standup") || normalized.includes("git")) {
    return "standupGitSummary";
  }
  if (normalized.includes("ci") || normalized.includes("flaky")) return "ciFlakyReport";
  if (normalized.includes("documentation") || normalized.includes("doc")) {
    return "documentationSyncCheck";
  }
  return "followUpMonitor";
}

function isCustomizeItem(item: ClientSceneItem): boolean {
  return normalizeTemplateId(item.id).toLowerCase() === "customize";
}

function hasLocalizedTitle(item: ClientSceneItem): boolean {
  return Boolean(item.labels.cn?.trim() || item.labels.en?.trim());
}

function resolveReferencedCronExpr(
  scene: ClientSceneConfig,
  promptItem: ClientSceneItem,
  isValidCronExpr: (cronExpr: string) => boolean,
): string | null {
  const cronItemIds = promptItem.defaults?.cronExpr;
  const cronItems = scene.options.cronExpr?.items;
  if (!cronItemIds?.length || !cronItems) return null;

  for (const cronItemId of cronItemIds) {
    const cronItem = cronItems.find((item) => item.id === cronItemId);
    if (!cronItem) continue;
    const localizedValues = [cronItem.contents.en, cronItem.contents.cn]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    const cronExpr = localizedValues[0];
    if (!cronExpr) continue;
    // cron 不是自然语言；不同 locale 配置成不同表达式会让点击结果不可预测，按非法配置拒绝。
    if (localizedValues.some((value) => value !== cronExpr)) return null;
    // Croner 支持六/七段等表达式，但 Automation builder 只能无损编辑其中的
    // 五段子集。只做 Service 校验会让模板在打开表单后、用户尚未编辑时就被静默改写。
    if (isValidCronExpr(cronExpr) && canVisualizeCronInAutomationEditor(cronExpr)) {
      return cronExpr;
    }
  }
  return null;
}

function mapScheduledTemplates(
  scenes: readonly ClientSceneConfig[],
  isValidCronExpr: (cronExpr: string) => boolean,
): Pick<AutomationTemplateCatalog, "scheduled" | "rejectedScheduledTemplateIds"> {
  const scene = scenes.find((candidate) => candidate.scene === "scheduled-task");
  const items = scene?.options.prompts?.items ?? [];
  if (!scene) return { scheduled: [], rejectedScheduledTemplateIds: [] };

  const scheduled: ScheduledAutomationTemplate[] = [];
  const rejectedScheduledTemplateIds: string[] = [];
  for (const item of items) {
    if (!hasLocalizedTitle(item)) {
      rejectedScheduledTemplateIds.push(item.id);
      continue;
    }
    const cronExpr = resolveReferencedCronExpr(scene, item, isValidCronExpr);
    if (!cronExpr) {
      rejectedScheduledTemplateIds.push(item.id);
      continue;
    }
    const iconName = resolveTemplateIconName(item);
    scheduled.push({
      id: item.id,
      ...(iconName ? { iconName } : {}),
      title: item.labels,
      description: item.contents,
      prompt: item.contents,
      cronExpr,
      icon: scheduledIcon(item.id),
    });
  }
  return { scheduled, rejectedScheduledTemplateIds };
}

function mapOffPeakTemplates(scenes: readonly ClientSceneConfig[]): OffPeakAutomationTemplate[] {
  const scene = scenes.find((candidate) => candidate.scene === "off-peak-task");
  const items = scene?.options.prompts?.items ?? [];
  return items.filter(hasLocalizedTitle).map((item): OffPeakAutomationTemplate => {
    const customize = isCustomizeItem(item);
    const iconName = resolveTemplateIconName(item);
    return {
      id: item.id,
      ...(iconName ? { iconName } : {}),
      title: customize ? CUSTOMIZE_TEMPLATE.title : item.labels,
      description: customize ? CUSTOMIZE_TEMPLATE.description : item.contents,
      homepageDescription: customize
        ? CUSTOMIZE_TEMPLATE.description
        : resolveOffPeakHomepageDescription(item),
      prompt: item.contents,
      customize,
      icon: offPeakIcon(item.id, customize),
    };
  });
}

export function mapClientScenesToAutomationTemplates(
  scenes: readonly ClientSceneConfig[],
  isValidCronExpr: (cronExpr: string) => boolean,
): AutomationTemplateCatalog {
  return {
    ...mapScheduledTemplates(scenes, isValidCronExpr),
    offPeak: mapOffPeakTemplates(scenes),
  };
}

export function resolveAutomationTemplateText(
  text: AutomationTemplateLocalizedText,
  locale?: string,
): string {
  const isChinese = locale?.startsWith("zh") ?? false;
  const primary = isChinese ? text.cn : text.en;
  const fallback = isChinese ? text.en : text.cn;
  return primary?.trim() || fallback?.trim() || "";
}

export function resolveOffPeakTemplateText(
  template: OffPeakAutomationTemplate,
  field: "title" | "description" | "homepageDescription",
  locale: string,
  formatMessage: FormatAutomationMessage,
): string {
  if (template.customize) {
    const messageField = field === "homepageDescription" ? "description" : field;
    return formatMessage({ id: CUSTOMIZE_TEMPLATE_MESSAGE_IDS[messageField] });
  }
  const text =
    field === "homepageDescription"
      ? (template.homepageDescription ?? template.description)
      : template[field];
  return resolveAutomationTemplateText(text, locale);
}

export function materializeScheduledTemplateDraft(
  template: ScheduledAutomationTemplate,
  locale: string,
): { templateId: string; title: string; cronExpr: string; prompt: string } {
  return {
    templateId: template.id,
    title: resolveAutomationTemplateText(template.title, locale),
    cronExpr: template.cronExpr,
    prompt: resolveAutomationTemplateText(template.prompt, locale),
  };
}

export function materializeOffPeakTemplateDraft(
  template: OffPeakAutomationTemplate,
  locale: string,
): { templateId: string; title: string; prompt: string } {
  return {
    templateId: template.id,
    title: resolveAutomationTemplateText(template.title, locale),
    prompt: resolveAutomationTemplateText(template.prompt, locale),
  };
}
