import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { decodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";

export function shouldShowManageModelsAction(onManageModels?: () => void): boolean {
  return typeof onManageModels === "function";
}

function resolveModelValueDisplayLabel(value: string): string {
  const customSelection = decodeCustomModelValue(value);
  if (customSelection?.modelName?.trim()) {
    return customSelection.modelName.trim();
  }

  const normalizedValue = value.trim();
  const separatorIndex = normalizedValue.indexOf("/");
  if (separatorIndex > 0 && separatorIndex < normalizedValue.length - 1) {
    const modelName = normalizedValue.slice(separatorIndex + 1).trim();
    if (modelName) return modelName;
  }
  return normalizedValue;
}

export function resolveModelSelectTriggerDisplay(
  normalizedValue: string,
  modelGroups: readonly ModelSelectGroup[],
  showManageModelsAction: boolean,
  manageModelsLabel?: string,
  options?: {
    allowUnavailableCustomModelPlaceholder?: boolean;
    allowUnavailableModelPlaceholder?: boolean;
  },
): { value: string | undefined; placeholder: string | undefined } {
  if (normalizedValue.trim().toLocaleLowerCase() === "<synthetic>") {
    return { value: undefined, placeholder: undefined };
  }
  if (modelGroups.some((group) => group.items.some((item) => item.value === normalizedValue))) {
    return { value: normalizedValue, placeholder: undefined };
  }

  const customSelection = decodeCustomModelValue(normalizedValue);
  if (options?.allowUnavailableCustomModelPlaceholder && customSelection?.modelName?.trim()) {
    return { value: undefined, placeholder: customSelection.modelName.trim() };
  }
  if (options?.allowUnavailableModelPlaceholder && normalizedValue.trim()) {
    return {
      value: undefined,
      placeholder: resolveModelValueDisplayLabel(normalizedValue),
    };
  }
  if (modelGroups.length === 0 && showManageModelsAction) {
    return { value: undefined, placeholder: manageModelsLabel };
  }
  return { value: undefined, placeholder: undefined };
}
