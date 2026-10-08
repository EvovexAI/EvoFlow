import type { ZCodeConfigOption } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";

/** 从 Registry 的 ModelConfig Option Specs 读取思考档位。 */
export function resolveModelThoughtOption(params: {
  modelSelectionView: ModelSelectionView;
  providerId: string;
  modelId: string;
  currentValue?: string;
  formatLevelName?: (level: string) => string;
}): ZCodeConfigOption | null {
  const provider = params.modelSelectionView.providers.find(
    (candidate) => candidate.providerId === params.providerId,
  );
  const model = provider?.models.find((candidate) => candidate.modelId === params.modelId);
  const reasoning = model?.config.optionSpecs.reasoningLevel;
  if (!reasoning || reasoning.values.length === 0) return null;

  return {
    id: "thought_level",
    name: "Thought Level",
    category: "thought_level",
    type: "select",
    // Reasoning 没有默认档位；空字符串表示模型已选但用户尚未选择 reasoning。
    currentValue:
      params.currentValue && reasoning.values.includes(params.currentValue)
        ? params.currentValue
        : "",
    options: reasoning.values.map((level) => ({
      value: level,
      name: params.formatLevelName?.(level) ?? level,
    })),
  };
}
