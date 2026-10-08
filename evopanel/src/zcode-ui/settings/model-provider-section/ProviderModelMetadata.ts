/* oxlint-disable eslint(max-lines) -- Model Config 弹窗的 Draft、校验与稀疏 Overlay 必须共享同一字段映射，避免 UI 产生第二套规则。 */
import type { ProviderSettingsFormModel } from "@/lib/providerSettingsFormTypes.js";
import type { ModelInputFormatData } from "@zcode/shared/model-config";
import {
  EnumOptionSpecConfig,
  extractManualModelConfig,
  clearManualModelConfig,
  type ModelConfigObject,
} from "@zcode/provider";

export type ProviderModelInputFormatDraft = ModelInputFormatData;

export interface ProviderModelDraftValues {
  idValue: string;
  contextWindowValue: string;
  maxOutputTokensValue: string;
  inputFormatValue: ProviderModelInputFormatDraft;
  enabledValue?: boolean;
  useRecommendedConfigValue?: boolean;
  /** 仅在本次 Draft 从固定模式切回推荐模式时清空已有 Overlay。 */
  clearPersonalConfigValue?: boolean;
  /** 字段来源是用户意图，不依赖整份表单是否有效或数值是否恰好等于推荐。 */
  overriddenFieldsValue?: readonly string[];
  supportsJsonSchemaOutputValue?: boolean;
  supportsNativeWebSearchValue?: boolean;
  supportsMidConversationSystemValue?: boolean;
  reasoningLevelValuesValue: readonly string[];
  reasoningLevelMapValue: string;
}

export type ProviderModelDraftCommitResult =
  | { status: "commit"; model: ProviderSettingsFormModel }
  | {
      status: "invalid";
      field:
        | "id"
        | "contextWindow"
        | "maxOutputTokens"
        | "inputFormat"
        | "reasoningLevelValues"
        | "reasoningLevelMap";
    };

export function createProviderModelDraftValues(
  model: ProviderSettingsFormModel,
): ProviderModelDraftValues {
  // 配置不完整时编辑器就是修复入口，不能在打开前抛错；数值保留空输入，能力控件用保守初值。
  const properties = model.config.properties ?? {};
  const inputFormat = properties?.inputFormat;
  return {
    idValue: model.modelId,
    // 编辑器只把 Personal Overlay 当作真实输入；继承值由 UI 作为 placeholder 展示。
    contextWindowValue:
      model.personalConfig.properties?.contextWindow == null
        ? ""
        : String(model.personalConfig.properties.contextWindow),
    maxOutputTokensValue:
      model.personalConfig.optionSpecs?.maxOutputTokens?.max == null
        ? ""
        : String(model.personalConfig.optionSpecs.maxOutputTokens.max),
    inputFormatValue: {
      supportsText: inputFormat?.supportsText ?? true,
      supportsImage: inputFormat?.supportsImage ?? false,
      supportsVideo: inputFormat?.supportsVideo ?? false,
      supportsAudio: inputFormat?.supportsAudio ?? false,
      supportsPdf: inputFormat?.supportsPdf ?? false,
    },
    enabledValue: model.config.enabled !== false,
    useRecommendedConfigValue: model.useRecommendedConfig !== false,
    clearPersonalConfigValue: false,
    overriddenFieldsValue: personalDraftFieldKeys(model.personalConfig),
    supportsJsonSchemaOutputValue: properties.supportsJsonSchemaOutput ?? false,
    supportsNativeWebSearchValue: properties.supportsNativeWebSearch ?? false,
    supportsMidConversationSystemValue: properties.supportsMidConversationSystem ?? false,
    reasoningLevelValuesValue: [...(model.config.optionSpecs?.reasoningLevel?.values ?? [])],
    reasoningLevelMapValue:
      typeof model.personalConfig.optionSpecs?.reasoningLevel?.map === "string"
        ? model.personalConfig.optionSpecs.reasoningLevel.map
        : "",
  };
}

function personalDraftFieldKeys(config: ModelConfigObject): string[] {
  const result: string[] = [];
  for (const key of [
    "supportsJsonSchemaOutput",
    "supportsNativeWebSearch",
    "supportsMidConversationSystem",
  ] as const) {
    if (config.properties?.[key] != null) result.push(`${key}Value`);
  }
  if (config.optionSpecs?.reasoningLevel?.values != null) result.push("reasoningLevelValuesValue");
  for (const [key, value] of Object.entries(config.properties?.inputFormat ?? {})) {
    if (value != null) result.push(`inputFormatValue.${key}`);
  }
  return result;
}

function parsePositiveIntegerDraft(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function resolveProviderModelDraftCommit({
  currentModel,
  draft,
}: {
  currentModel: ProviderSettingsFormModel;
  draft: ProviderModelDraftValues;
}): ProviderModelDraftCommitResult {
  if (draft.clearPersonalConfigValue && currentModel.inheritedConfig) {
    // 切回推荐只重置比较基线，不能在最终提交时无条件清空，否则会吞掉重置后的新编辑。
    currentModel = {
      ...currentModel,
      personalConfig: clearManualModelConfig(currentModel.personalConfig),
      config: { ...currentModel.inheritedConfig, enabled: currentModel.config.enabled },
    };
  }
  const modelId = draft.idValue.trim();
  if (!modelId) {
    return { status: "invalid", field: "id" };
  }

  const useRecommendedConfig = draft.useRecommendedConfigValue !== false;
  const inherited = useRecommendedConfig ? currentModel.inheritedConfig : undefined;
  const contextWindow = draft.contextWindowValue.trim()
    ? parsePositiveIntegerDraft(draft.contextWindowValue)
    : (inherited?.properties?.contextWindow ?? null);
  if (contextWindow === null) {
    return { status: "invalid", field: "contextWindow" };
  }

  const maxOutputTokens = draft.maxOutputTokensValue.trim()
    ? parsePositiveIntegerDraft(draft.maxOutputTokensValue)
    : undefined;
  if (maxOutputTokens === null || (!useRecommendedConfig && maxOutputTokens === undefined)) {
    return { status: "invalid", field: "maxOutputTokens" };
  }

  if (!draft.inputFormatValue.supportsText) {
    return { status: "invalid", field: "inputFormat" };
  }

  const reasoningLevelValues = draft.reasoningLevelValuesValue.map((value) => value.trim());
  if (
    reasoningLevelValues.length === 0 ||
    reasoningLevelValues.some((value) => !value) ||
    new Set(reasoningLevelValues).size !== reasoningLevelValues.length
  ) {
    return { status: "invalid", field: "reasoningLevelValues" };
  }
  const inheritedReasoning = inherited?.optionSpecs?.reasoningLevel;
  const reasoningLevelMap = draft.reasoningLevelMapValue.trim();
  const effectiveReasoningMap = reasoningLevelMap || inheritedReasoning?.map;
  if (
    !effectiveReasoningMap ||
    new EnumOptionSpecConfig({
      values: reasoningLevelValues,
      map: effectiveReasoningMap,
    }).validateComplete(["optionSpecs", "reasoningLevel"]).length > 0
  ) {
    return { status: "invalid", field: "reasoningLevelMap" };
  }
  const effectiveEnabled = draft.enabledValue ?? currentModel.config.enabled ?? true;
  const currentEffectiveEnabled = currentModel.config.enabled ?? true;
  const effectiveProperties = {
    // 系统字段不由编辑草稿产生；手动保存统一按可编辑 schema 提取。
    requiresMfjsToolSchema: currentModel.config.properties?.requiresMfjsToolSchema,
    contextWindow,
    inputFormat: {
      ...currentModel.config.properties?.inputFormat,
      supportsImage: draft.inputFormatValue.supportsImage,
      supportsVideo: draft.inputFormatValue.supportsVideo,
      supportsPdf: draft.inputFormatValue.supportsPdf,
    },
    outputFormat: currentModel.config.properties?.outputFormat,
    supportsToolCall: currentModel.config.properties?.supportsToolCall,
    supportsJsonSchemaOutput:
      draft.supportsJsonSchemaOutputValue ??
      currentModel.config.properties?.supportsJsonSchemaOutput ??
      false,
    supportsNativeWebSearch:
      draft.supportsNativeWebSearchValue ??
      currentModel.config.properties?.supportsNativeWebSearch ??
      false,
    supportsMidConversationSystem:
      draft.supportsMidConversationSystemValue ??
      currentModel.config.properties?.supportsMidConversationSystem ??
      false,
  };
  const personalProperties = buildPersonalProperties({
    current: currentModel.personalConfig.properties,
    inherited: inherited?.properties,
    currentEffective: currentModel.config.properties,
    effective: effectiveProperties,
  });
  // 数值显式填写即是覆盖；即使与推荐相等也保留，清空输入才表示撤销覆盖。
  if (draft.contextWindowValue.trim())
    assignMutable(personalProperties, "contextWindow", contextWindow);
  else deleteMutable(personalProperties, "contextWindow");
  for (const key of [
    "supportsJsonSchemaOutput",
    "supportsNativeWebSearch",
    "supportsMidConversationSystem",
  ] as const) {
    if (draft.overriddenFieldsValue?.includes(`${key}Value`))
      assignMutable(personalProperties, key, effectiveProperties[key]);
  }
  for (const key of ["supportsImage", "supportsVideo", "supportsPdf"] as const) {
    if (
      draft.overriddenFieldsValue?.includes(`inputFormatValue.${key}`) ||
      draft.inputFormatValue[key] !== currentModel.config.properties?.inputFormat?.[key]
    ) {
      assignMutable(personalProperties, "inputFormat", {
        ...personalProperties.inputFormat,
        [key]: draft.inputFormatValue[key],
      });
    }
  }
  const sparsePersonalConfig: ModelConfigObject = {
    ...currentModel.personalConfig,
    ...resolvePersonalBoolean(
      "enabled",
      effectiveEnabled,
      currentEffectiveEnabled,
      inherited?.enabled,
      currentModel.personalConfig.enabled,
    ),
    ...(Object.keys(personalProperties).length > 0 ? { properties: personalProperties } : {}),
  };
  if (Object.keys(personalProperties).length === 0)
    deleteMutable(sparsePersonalConfig, "properties");

  const inheritedMaxOption = inherited?.optionSpecs?.maxOutputTokens;
  // Option Spec 不再拥有 default；该输入框唯一表达模型硬上限 max。
  const currentEffectiveMaxOption = {
    ...currentModel.config.optionSpecs?.maxOutputTokens,
  };
  const resolvedMaxOutputSpec =
    maxOutputTokens === undefined
      ? undefined
      : {
          ...currentEffectiveMaxOption,
          max: maxOutputTokens,
        };
  const personalOptionSpecs = { ...currentModel.personalConfig.optionSpecs };
  applyPersonalReasoning({
    target: personalOptionSpecs,
    values: reasoningLevelValues,
    map: reasoningLevelMap,
    currentEffective: currentModel.config.optionSpecs?.reasoningLevel?.values ?? undefined,
    inherited: inheritedReasoning,
    currentPersonal: currentModel.personalConfig.optionSpecs?.reasoningLevel,
  });
  if (draft.overriddenFieldsValue?.includes("reasoningLevelValuesValue")) {
    personalOptionSpecs.reasoningLevel = {
      ...personalOptionSpecs.reasoningLevel,
      values: [...reasoningLevelValues],
    };
  }
  if (reasoningLevelMap)
    personalOptionSpecs.reasoningLevel = {
      ...personalOptionSpecs.reasoningLevel,
      map: reasoningLevelMap,
    };
  if (resolvedMaxOutputSpec !== undefined) {
    const currentPersonalMax = currentModel.personalConfig.optionSpecs?.maxOutputTokens;
    personalOptionSpecs.maxOutputTokens = {
      ...(currentPersonalMax?.map === undefined ? {} : { map: currentPersonalMax.map }),
      max: resolvedMaxOutputSpec.max,
    };
  } else {
    const currentPersonalMap = currentModel.personalConfig.optionSpecs?.maxOutputTokens?.map;
    if (currentPersonalMap === undefined) deleteMutable(personalOptionSpecs, "maxOutputTokens");
    else personalOptionSpecs.maxOutputTokens = { map: currentPersonalMap };
  }
  if (Object.keys(personalOptionSpecs).length > 0) {
    assignMutable(sparsePersonalConfig, "optionSpecs", personalOptionSpecs);
  } else {
    deleteMutable(sparsePersonalConfig, "optionSpecs");
  }
  const effectiveOptionSpecs = { ...currentModel.config.optionSpecs };
  effectiveOptionSpecs.reasoningLevel = {
    values: [...reasoningLevelValues],
    map: effectiveReasoningMap,
  };
  if (resolvedMaxOutputSpec !== undefined) {
    effectiveOptionSpecs.maxOutputTokens = resolvedMaxOutputSpec;
  } else if (inheritedMaxOption !== undefined) {
    effectiveOptionSpecs.maxOutputTokens = inheritedMaxOption;
  } else {
    deleteMutable(effectiveOptionSpecs, "maxOutputTokens");
  }
  const personalConfig = useRecommendedConfig
    ? sparsePersonalConfig
    : materializeEditorManagedPersonalConfig({
        current: sparsePersonalConfig,
        effective: {
          ...currentModel.config,
          enabled: effectiveEnabled,
          properties: effectiveProperties,
          optionSpecs: effectiveOptionSpecs,
        },
      });
  return {
    status: "commit",
    model: {
      ...currentModel,
      modelId,
      useRecommendedConfig,
      hasPersonalConfig: Object.keys(personalConfig).length > 0,
      personalConfig,
      config: {
        ...currentModel.config,
        enabled: effectiveEnabled,
        properties: effectiveProperties,
        optionSpecs: effectiveOptionSpecs,
      },
    },
  };
}

function preserveEnabledPersonalConfig(config: ModelConfigObject): ModelConfigObject {
  return config.enabled === undefined ? {} : { enabled: config.enabled };
}

function materializeEditorManagedPersonalConfig({
  current,
  effective,
}: {
  current: ModelConfigObject;
  effective: ModelConfigObject;
}): ModelConfigObject {
  // enabled 由模型列表行单独管理，不随“跟随推荐配置”模式物化或清除。
  // 只提取可编辑叶子；隐藏请求映射必须来自当前身份规则，不能由旧模型草稿冻结。
  return extractManualModelConfig({
    ...preserveEnabledPersonalConfig(current),
    properties: effective.properties,
    optionSpecs: effective.optionSpecs,
  });
}

function resolvePersonalBoolean<K extends string>(
  key: K,
  value: boolean,
  currentEffective: boolean,
  inherited: unknown,
  currentPersonal: boolean | null | undefined,
) {
  // 未触碰的控件必须保留现有的稀疏 Overlay，不能因为 Effective 默认值而凭空写入 false。
  if (value === currentEffective) {
    return currentPersonal === undefined || currentPersonal === null
      ? {}
      : ({ [key]: currentPersonal } as Record<K, boolean>);
  }
  return inherited === value ? {} : ({ [key]: value } as Record<K, boolean>);
}

function buildPersonalProperties({
  current,
  inherited,
  currentEffective,
  effective,
}: {
  current: ModelConfigObject["properties"];
  inherited: ModelConfigObject["properties"];
  currentEffective: ModelConfigObject["properties"];
  effective: NonNullable<ModelConfigObject["properties"]>;
}): NonNullable<ModelConfigObject["properties"]> {
  const result: Record<string, unknown> = { ...current };
  applySparseLeaf(result, "contextWindow", effective.contextWindow, inherited?.contextWindow);
  for (const key of [
    "supportsJsonSchemaOutput",
    "supportsNativeWebSearch",
    "supportsMidConversationSystem",
  ] as const) {
    applyInteractiveSparseLeaf(
      result,
      key,
      effective[key],
      currentEffective?.[key],
      inherited?.[key],
    );
  }
  const input = { ...current?.inputFormat } as Record<string, unknown>;
  applyInteractiveSparseLeaf(
    input,
    "supportsImage",
    effective.inputFormat?.supportsImage,
    currentEffective?.inputFormat?.supportsImage,
    inherited?.inputFormat?.supportsImage,
  );
  applyInteractiveSparseLeaf(
    input,
    "supportsVideo",
    effective.inputFormat?.supportsVideo,
    currentEffective?.inputFormat?.supportsVideo,
    inherited?.inputFormat?.supportsVideo,
  );
  if (Object.keys(input).length > 0) result.inputFormat = input;
  else delete result.inputFormat;
  return result as NonNullable<ModelConfigObject["properties"]>;
}

function applyInteractiveSparseLeaf(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  currentEffective: unknown,
  inherited: unknown,
) {
  if (value === currentEffective) return;
  applySparseLeaf(target, key, value, inherited);
}

function applySparseLeaf(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  inherited: unknown,
) {
  if (value === inherited) delete target[key];
  else target[key] = value;
}

function applyPersonalReasoning({
  target,
  values,
  map,
  currentEffective,
  inherited,
  currentPersonal,
}: {
  target: Record<string, unknown>;
  values: readonly string[];
  map: string;
  currentEffective: readonly string[] | undefined;
  inherited: NonNullable<ModelConfigObject["optionSpecs"]>["reasoningLevel"] | undefined;
  currentPersonal: NonNullable<ModelConfigObject["optionSpecs"]>["reasoningLevel"] | undefined;
}) {
  const next = { ...currentPersonal };
  if (!arraysEqual(values, currentEffective)) {
    if (arraysEqual(values, inherited?.values)) deleteMutable(next, "values");
    else assignMutable(next, "values", [...values]);
  }
  if (!map || map === inherited?.map) deleteMutable(next, "map");
  else assignMutable(next, "map", map);
  if (Object.keys(next).length === 0) delete target.reasoningLevel;
  else target.reasoningLevel = next;
}

function arraysEqual(
  left: readonly string[] | null | undefined,
  right: readonly string[] | null | undefined,
) {
  if (left === right) return true;
  if ((left?.length ?? 0) === 0 && (right?.length ?? 0) === 0) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function assignMutable(target: object, key: PropertyKey, value: unknown) {
  (target as Record<PropertyKey, unknown>)[key] = value;
}

function deleteMutable(target: object, key: PropertyKey) {
  delete (target as Record<PropertyKey, unknown>)[key];
}
