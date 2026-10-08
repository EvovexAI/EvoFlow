import { decodeCustomModelValue } from "@zcode/shared";
import type { ZCodeConfigOption } from "@zcode/shared";

const FEEDBACK_MODEL_OPTIONS_PREVIEW_LIMIT = 12;

export interface FeedbackAgentModelContext {
  model?: string;
  display?: string;
  optionCount?: number;
  optionsPreview?: string[];
}

export function readCurrentAgentModelContext(
  configOptions?: readonly ZCodeConfigOption[] | null,
): FeedbackAgentModelContext {
  const modelOption = configOptions?.find(
    (option) => option.category === "model" && option.type === "select",
  );
  if (!modelOption) {
    return {};
  }

  const options = (modelOption.options ?? [])
    .map((option) => ({
      value: option.value.trim(),
      name: option.name.trim(),
    }))
    .filter((option) => option.value.length > 0 || option.name.length > 0);
  const rawModel =
    typeof modelOption.currentValue === "string"
      ? modelOption.currentValue.trim()
      : String(modelOption.currentValue ?? "").trim();
  const matchedOption = rawModel ? options.find((option) => option.value === rawModel) : undefined;
  const customModel = rawModel ? decodeCustomModelValue(rawModel) : null;
  const display = matchedOption?.name || customModel?.modelName?.trim() || rawModel;

  return {
    ...(rawModel ? { model: rawModel } : {}),
    ...(display ? { display } : {}),
    optionCount: options.length,
    optionsPreview: options
      .slice(0, FEEDBACK_MODEL_OPTIONS_PREVIEW_LIMIT)
      .map((option) => option.name || option.value),
  };
}
