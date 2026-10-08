import { thoughtLevelLabelId } from "@/chat-input-toolbar/thoughtLevelOptions.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { formatProviderModelLabel } from "@/v4/composer/modelTriggerDisplay.js";

/**
 * 子代理模型的**词**：run 上存的是规范串
 * `providerId/modelId[$reasoningLevel]`——那是给机器回填用的，不是给人读的。团队套餐的
 * providerId 是一个 UUID，原样贴到屏幕上，用户第一眼看到的就是一串十六进制。
 *
 * 所以三个面（确认窗、运行卡、详情侧板）共用这一个纯函数：拼名规则直接复用模型菜单那一条
 * （`formatProviderModelLabel`：内置家族只显示模型名，自定义 provider 才显示「名字/模型」），
 * 思考强度复用思考控件的词表。规范串本身只住在 tooltip 里。
 *
 * 纯函数 + 注入的 formatMessage / providerName：与 timeline-summary 同一条纪律，本文件不碰 store。
 */
type FormatMessage = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

export interface WorkflowSubagentModelLabel {
  /** 屏幕上的模型名；**永远不含 providerId**。 */
  name: string;
  /** 本地化的思考强度词；规范串没有 `$level` 时缺席。 */
  level?: string;
  /** 规范串原文（trim 过），只进 tooltip。 */
  canonical: string;
}

export interface WorkflowSubagentModelDeps {
  formatMessage: FormatMessage;
  /**
   * providerId → 会话模型清单里的 provider 名。缺席（或查不到）时退回裸 modelId——
   * 这是**刻意**的兜底：解析不到名字也绝不把 providerId 摆出来。
   */
  providerName?: (providerId: string) => string | undefined;
}

/** 解析不出结构时的兜底取名：砍掉 `providerId/` 前缀与 `$level` 后缀，剩下的就是人能读的那截。 */
function fallbackName(canonical: string): string {
  const separatorIndex = canonical.indexOf("/");
  const rest = separatorIndex > 0 ? canonical.slice(separatorIndex + 1) : canonical;
  const levelIndex = rest.indexOf("$");
  const name = levelIndex > 0 ? rest.slice(0, levelIndex) : rest;
  return name.length > 0 ? name : canonical;
}

/**
 * 规范串 → 屏幕上的词。解析失败（串缺 provider 段、或形状不合 schema）不抛：UI 不是第二个
 * 解析器，拿不准就退回裸 modelId。
 */
export function describeWorkflowSubagentModel(
  canonical: string,
  deps: WorkflowSubagentModelDeps,
): WorkflowSubagentModelLabel {
  const trimmed = canonical.trim();
  let parsed: ReturnType<typeof parseModelPickerValue> | undefined;
  try {
    parsed = parseModelPickerValue(trimmed);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) {
    return { canonical: trimmed, name: fallbackName(trimmed) };
  }

  // 会话清单里 providerName 查不到时会退回 providerId 本身（见 zcodeSessionSettingsToConfigOptions）；
  // 那种「名字」正是我们要挡的东西，当作没查到。
  const resolvedName = deps.providerName?.(parsed.providerId)?.trim();
  const providerName =
    resolvedName === undefined || resolvedName === parsed.providerId ? undefined : resolvedName;
  const name = formatProviderModelLabel(parsed.providerId, providerName, parsed.modelId);

  const rawLevel = parsed.options?.reasoningLevel;
  if (rawLevel === undefined) {
    return { canonical: trimmed, name };
  }
  // 档位词与思考控件同一张表；表里没有的值原样显示（provider 自定义的档位名）。
  const labelId = thoughtLevelLabelId(rawLevel);
  return {
    canonical: trimmed,
    level: labelId === undefined ? rawLevel : deps.formatMessage({ id: labelId }),
    name,
  };
}

/** 一句话说清模型与强度：没有档位时就是模型名本身（确认窗与 tooltip 共用）。 */
export function workflowSubagentModelText(
  formatMessage: FormatMessage,
  label: WorkflowSubagentModelLabel,
): string {
  return label.level === undefined
    ? label.name
    : formatMessage(
        { id: "chat.toolCall.workflow.subagentModel.withLevel" },
        { level: label.level, model: label.name },
      );
}

/**
 * 三个面共用的 tooltip：一句解释（子代理跑在哪儿、主代理没变）+ 换行 + 规范串。
 * 规范串是给机器回填用的，它只该在这里出现。
 */
export function workflowSubagentModelTooltip(
  formatMessage: FormatMessage,
  label: WorkflowSubagentModelLabel,
): string {
  const explained = formatMessage(
    { id: "chat.toolCall.workflow.subagentModel.tooltip" },
    { model: workflowSubagentModelText(formatMessage, label) },
  );
  return `${explained}\n${label.canonical}`;
}

/**
 * 卡与侧板要的两样东西：屏幕上的名字（只有名字，档位留给 tooltip）与 tooltip。
 * run 没指定过模型时缺席——跟随会话模型是常态，没有可说的。
 */
export function workflowSubagentModelCardLabel(
  canonical: string | undefined,
  deps: WorkflowSubagentModelDeps,
): { name: string; title: string } | undefined {
  if (canonical === undefined) {
    return undefined;
  }
  const label = describeWorkflowSubagentModel(canonical, deps);
  return { name: label.name, title: workflowSubagentModelTooltip(deps.formatMessage, label) };
}
