import type { ZCodeConfigOption } from "@zcode/shared";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";

function resolveModelDisplayValue(
  options: readonly ZCodeConfigOption[],
  config: Pick<SessionConfigState, "provider" | "model">,
): string {
  const provider = config.provider.trim();
  const rawModel = config.model.trim();
  const model =
    provider && rawModel.startsWith(`${provider}/`)
      ? rawModel.slice(provider.length + 1)
      : rawModel;
  if (!provider || !model) {
    return "";
  }

  const modelOption = options.find(
    (option) => option.category === "model" && option.type === "select",
  );
  const catalogValue = modelOption?.options?.find((candidate) => {
    const ref = parseModelPickerValue(candidate.value);
    return ref.providerId === provider && ref.modelId === model;
  })?.value;
  return catalogValue ?? `${provider}/${model}`;
}

/**
 * 把 v4 session 权威配置叠到 workspace 完整目录，供 task → draft 继承使用。
 * 目录项和候选列表保持原引用语义，仅替换 model/mode/thought 的 currentValue。
 */
export function projectSessionConfigToTaskConfigOptions(
  options: readonly ZCodeConfigOption[],
  config: Pick<SessionConfigState, "provider" | "model" | "mode" | "thought">,
): ZCodeConfigOption[] {
  const modelValue = resolveModelDisplayValue(options, config);
  return options.map((option) => {
    if (option.type !== "select") {
      return option;
    }
    if (option.category === "model" && modelValue) {
      return { ...option, currentValue: modelValue };
    }
    if (option.category === "mode" && config.mode.trim()) {
      return { ...option, currentValue: config.mode.trim() };
    }
    if (option.category === "thought_level") {
      return { ...option, currentValue: config.thought.trim() };
    }
    return option;
  });
}
