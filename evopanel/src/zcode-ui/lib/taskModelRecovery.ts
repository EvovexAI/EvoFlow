import type { ZCodeConfigOption, ZCodeTaskMeta } from "@zcode/shared";
import { getZCodeAgentModeSelectOptions } from "@zcode/shared";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";

function parseProviderQualifiedModel(
  model: string,
): { providerId: string; modelName: string } | null {
  const normalizedModel = model.trim();
  const separatorIndex = normalizedModel.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex >= normalizedModel.length - 1) {
    return null;
  }

  const providerId = normalizedModel.slice(0, separatorIndex).trim();
  const modelName = normalizedModel.slice(separatorIndex + 1).trim();
  if (!providerId || !modelName) {
    return null;
  }

  return { providerId, modelName };
}

function isSyntheticModelPlaceholder(model: string): boolean {
  return model.trim().toLocaleLowerCase() === "<synthetic>";
}

function resolveGlmRecoveredTaskModelValue(taskModel: string | undefined): string | null {
  const normalizedTaskModel = taskModel?.trim();
  if (!normalizedTaskModel || isSyntheticModelPlaceholder(normalizedTaskModel)) {
    return null;
  }

  const customModel = decodeCustomModelValue(normalizedTaskModel);
  if (customModel?.providerId && customModel.modelName) {
    return normalizedTaskModel;
  }

  const providerQualifiedModel = parseProviderQualifiedModel(normalizedTaskModel);
  if (providerQualifiedModel) {
    return encodeCustomModelValue(
      providerQualifiedModel.providerId,
      providerQualifiedModel.modelName,
    );
  }

  return normalizedTaskModel;
}

function resolveRecoveredTaskModelValue(
  taskMeta: Pick<ZCodeTaskMeta, "provider" | "model">,
): string | null {
  const normalizedTaskModel = taskMeta.model?.trim();
  if (!normalizedTaskModel || isSyntheticModelPlaceholder(normalizedTaskModel)) {
    return null;
  }

  if (taskMeta.provider === "glm") {
    return resolveGlmRecoveredTaskModelValue(normalizedTaskModel);
  }

  return normalizedTaskModel;
}

function resolveModelOptionName(modelValue: string): string {
  const customModel = decodeCustomModelValue(modelValue);
  const providerQualifiedModel = parseProviderQualifiedModel(modelValue);
  return customModel?.modelName?.trim() || providerQualifiedModel?.modelName || modelValue;
}

function ensureModelOptionValue(option: ZCodeConfigOption, modelValue: string): ZCodeConfigOption {
  const options = option.options ?? [];
  const hasOption = options.some((candidate) => candidate.value === modelValue);
  if (hasOption && option.currentValue === modelValue) {
    return option;
  }

  return {
    ...option,
    currentValue: modelValue,
    options: hasOption
      ? options
      : [
          ...options,
          {
            name: resolveModelOptionName(modelValue),
            value: modelValue,
          },
        ],
  };
}

function createRecoveredModelOption(modelValue: string): ZCodeConfigOption {
  return {
    category: "model",
    currentValue: modelValue,
    id: "model",
    name: "Model",
    options: [
      {
        name: resolveModelOptionName(modelValue),
        value: modelValue,
      },
    ],
    type: "select",
  };
}

function createRecoveredModeOption(modeValue: string): ZCodeConfigOption {
  return {
    category: "mode",
    currentValue: modeValue,
    id: "mode",
    name: "Mode",
    options: getZCodeAgentModeSelectOptions(),
    type: "select",
  };
}

function createRecoveredThoughtLevelOption(thoughtLevel: string): ZCodeConfigOption {
  return {
    category: "thought_level",
    currentValue: thoughtLevel,
    id: "thought_level",
    name: "Effort",
    options: [
      {
        name: thoughtLevel,
        value: thoughtLevel,
      },
    ],
    type: "select",
  };
}

function ensureSelectOptionCurrentValue(
  option: ZCodeConfigOption,
  value: string,
): ZCodeConfigOption {
  const options = option.options ?? [];
  const hasOption = options.some((candidate) => candidate.value === value);
  if (hasOption && option.currentValue === value) {
    return option;
  }

  return {
    ...option,
    currentValue: value,
    options: hasOption
      ? options
      : [
          ...options,
          {
            name: value,
            value,
          },
        ],
  };
}

function mergeRecoveredTaskModelConfigOptions({
  taskMeta,
  configOptions,
}: {
  taskMeta: Pick<ZCodeTaskMeta, "provider" | "model">;
  configOptions: readonly ZCodeConfigOption[];
}): ZCodeConfigOption[] | null {
  const recoveredModelValue = resolveRecoveredTaskModelValue(taskMeta);
  if (!recoveredModelValue) {
    return null;
  }

  let hasModelOption = false;
  let changed = false;
  const nextConfigOptions = configOptions.map((option) => {
    if (option.category !== "model" || option.type !== "select") {
      return option;
    }

    hasModelOption = true;
    const nextOption = ensureModelOptionValue(option, recoveredModelValue);
    changed = changed || nextOption !== option;
    return nextOption;
  });

  if (!hasModelOption) {
    // 历史 task 恢复时，resume/config_option_update 可能晚于首帧渲染。
    // 只清空上一条 task 的配置会让工具栏短暂退回“选择模型”；这里用 task.meta.model
    // 合成最小模型项，先稳定展示持久化模型，真实 configOptions 回来后再覆盖。
    return [createRecoveredModelOption(recoveredModelValue), ...nextConfigOptions];
  }

  // 旧会话恢复时 task.meta.model 可能已经被写回 task 配置。
  // 如果这里在无变化时仍返回新数组，调用方会反复 setTaskConfigOptions，和工具栏恢复 effect 互相触发。
  return changed ? nextConfigOptions : null;
}

export function resolveTaskRestorePreloadConfigOptions({
  taskMeta,
  cachedTaskConfigOptions,
}: {
  taskMeta: Pick<ZCodeTaskMeta, "provider" | "model"> &
    Partial<Pick<ZCodeTaskMeta, "mode" | "thoughtLevel">>;
  cachedTaskConfigOptions?: readonly ZCodeConfigOption[];
}): ZCodeConfigOption[] {
  let cachedOptions = [...(cachedTaskConfigOptions ?? [])];
  const recoveredOptions = mergeRecoveredTaskModelConfigOptions({
    taskMeta,
    configOptions: cachedOptions,
  });

  if (recoveredOptions) {
    cachedOptions = recoveredOptions;
  }

  const mode = taskMeta.mode?.trim();
  if (taskMeta.provider === "glm" && mode) {
    let hasModeOption = false;
    cachedOptions = cachedOptions.map((option) => {
      if (option.category !== "mode" || option.type !== "select") {
        return option;
      }
      hasModeOption = true;
      return ensureSelectOptionCurrentValue(option, mode);
    });
    if (!hasModeOption) {
      // 定时任务触发出的 task 在真实 settings 回来前，composer 只能拿到 task meta。
      // 这里从 meta 合成最小 mode option，避免权限入口短暂显示 workspace 默认值。
      cachedOptions = [createRecoveredModeOption(mode), ...cachedOptions];
    }
  }

  const thoughtLevel = taskMeta.thoughtLevel?.trim();
  if (taskMeta.provider === "glm" && thoughtLevel) {
    let hasThoughtOption = false;
    cachedOptions = cachedOptions.map((option) => {
      if (option.category !== "thought_level" || option.type !== "select") {
        return option;
      }
      hasThoughtOption = true;
      return ensureSelectOptionCurrentValue(option, thoughtLevel);
    });
    if (!hasThoughtOption) {
      // 和 mode 一样，automation task-local thoughtLevel 需要先从 task meta 回显；
      // 后续 session settings 会补齐该模型支持的完整 thought options。
      cachedOptions = [...cachedOptions, createRecoveredThoughtLevelOption(thoughtLevel)];
    }
  }

  // 历史 task 已经打开过时，taskConfigOptionsByTaskId 里有完整的
  // model/mode/thought_level。恢复期如果只因为 task.meta.model 缺失就清空，
  // 工具栏会先隐藏 mode/thought，等新快照回来后再出现；这里保留 task 级缓存，
  // 真正的新 settings 缺项时再由 setTaskConfigOptions 覆盖并隐藏。
  return cachedOptions;
}
