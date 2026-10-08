import type { ZCodeConfigOption, ZCodeProvider } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import type { ModelSelectGroup, ModelSelectGroupItem } from "@/ModelConfigSelect.js";
import {
  buildRegistryModelSelectGroups,
  type ModelProviderGroupLabelOptions,
} from "@/lib/modelSelectionGroups.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { resolveV4ModelTriggerLabel } from "@/v4/composer/modelTriggerDisplay.js";

// 定时任务表单必须是纯本地草稿，不能借用 workspace 默认配置写接口来获取选项；
// 否则仅打开或取消编辑也会改掉当前项目和 draft session 的运行配置。

/** 权限模式默认值：Ask before changes。 */
export const AUTOMATION_DEFAULT_MODE = "build";

/** 新建任务必须把目标 Host 的 preferredSelection 固化为具体模型，而不是保存虚拟“默认模型”。 */
export function resolveAutomationPreferredModelValue(
  view: Pick<ModelSelectionView, "preferredSelection">,
): string | null {
  const preferred = view.preferredSelection;
  return preferred ? encodeCustomModelValue(preferred.providerId, preferred.modelId) : null;
}

const AUTOMATION_MODE_VALUES = ["build", "edit", "plan", "yolo"] as const;

export function buildAutomationModelSelectGroups(params: {
  selectedProvider: ZCodeProvider;
  labels: ModelProviderGroupLabelOptions;
  registrySelectionView: ModelSelectionView;
}): ModelSelectGroup[] {
  return buildRegistryModelSelectGroups(
    params.selectedProvider,
    params.registrySelectionView,
    params.labels,
  );
}

export function buildAutomationModeOption(currentValue: string): ZCodeConfigOption {
  return {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue,
    options: AUTOMATION_MODE_VALUES.map((value) => ({ value, name: value })),
  };
}

function findDirectModelItem(
  modelGroups: readonly ModelSelectGroup[],
  modelValue: string,
): ModelSelectGroupItem | null {
  for (const group of modelGroups) {
    const item = group.items.find((candidate) => candidate.value === modelValue);
    if (item) return item;
  }
  return null;
}

export function resolveAutomationModelItem(
  modelGroups: readonly ModelSelectGroup[],
  modelValue: string,
): ModelSelectGroupItem | null {
  const direct = findDirectModelItem(modelGroups, modelValue);
  if (direct) return direct;

  const separator = modelValue.indexOf("/");
  const qualifiedProviderId = separator > 0 ? modelValue.slice(0, separator) : null;
  const qualifiedModelId = separator > 0 ? modelValue.slice(separator + 1) : modelValue;
  const modelMatches = modelGroups.flatMap((group) =>
    group.items.filter((item) => {
      const decoded = decodeCustomModelValue(item.value);
      return decoded?.modelName === qualifiedModelId;
    }),
  );
  if (qualifiedProviderId) {
    const providerMatches = modelMatches.filter(
      (item) => decodeCustomModelValue(item.value)?.providerId === qualifiedProviderId,
    );
    if (providerMatches.length === 1) return providerMatches[0] ?? null;
  }
  // 历史 automation 可能只保存纯模型名；同名模型跨 provider 时不能猜测来源。
  // workspace runtime 也可能返回 zcode-openai-compatible/model 这类包装值，provider 对不上时
  // 只有模型名全局唯一才允许回填菜单项，避免默认模型丢失对应的 think 元数据。
  return modelMatches.length === 1 ? (modelMatches[0] ?? null) : null;
}

export function resolveAutomationModelTriggerLabel(params: {
  modelGroups: readonly ModelSelectGroup[];
  modelSelectionView?: ModelSelectionView | null;
  modelValue: string;
  fallbackLabel: string;
}): string {
  const selectedItem = resolveAutomationModelItem(params.modelGroups, params.modelValue);
  if (!selectedItem) {
    const decodedModel = decodeCustomModelValue(params.modelValue);
    if (decodedModel?.modelName) {
      // 仅展示层保留历史模型名；模型不回填到当前候选列表，也不改变保存或派发逻辑。
      return decodedModel.modelName;
    }

    const separator = params.modelValue.indexOf("/");
    return separator > 0
      ? params.modelValue.slice(separator + 1)
      : params.modelValue.trim() || params.fallbackLabel;
  }

  const selectedModel = decodeCustomModelValue(selectedItem.value);
  const providerId = selectedModel?.providerId;
  const providerName =
    params.modelSelectionView?.providers.find((provider) => provider.providerId === providerId)
      ?.providerName ?? undefined;

  // Automations 曾自行截断 provider/model 协议值，只显示最后一级模型名，
  // 导致同一模型在会话侧和定时任务侧身份文案不一致。这里直接复用会话侧规则，
  // 同时保留内置 family 与失效值的统一裁剪语义。
  return resolveV4ModelTriggerLabel({
    modelGroups: params.modelGroups,
    normalizedValue: selectedItem.value,
    fallbackLabel: params.fallbackLabel,
    providerId,
    providerName,
  });
}

export function buildAutomationThoughtLevelOption(
  runtimeOption: ZCodeConfigOption | undefined,
  currentValue: string,
): ZCodeConfigOption | null {
  const options = runtimeOption?.options ?? [];
  if (options.length === 0) return null;
  const validCurrentValue = options.some((option) => option.value === currentValue);
  // 原因：候选刷新不是用户选择，不能把失效档位改成默认/最高档并保存。
  const resolvedValue = validCurrentValue ? currentValue : "";

  return {
    id: "thought_level",
    name: runtimeOption?.name ?? "Effort",
    category: "thought_level",
    type: "select",
    currentValue: resolvedValue,
    options: options.map((option) => ({ ...option })),
  };
}
