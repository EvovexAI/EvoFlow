import { BUILTIN_PROVIDER_TEMPLATE_IDS } from "@zcode/shared";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelConfigRules,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  type ProviderConfigLayerUpdate,
} from "@zcode/provider";
import {
  isModelProviderModelConfig,
  normalizeModelProviderConfiguredBaseUrl,
  resolveModelProviderApiFormat,
  resolveModelProviderRuntimeBaseUrl,
  type ModelProviderConfig,
  type ModelProviderModelEntry,
} from "./legacyModelProviderSerialized.js";

interface LegacyPersonalProviderConfigImportInput {
  readonly legacyProviders: readonly ModelProviderConfig[];
}

interface LegacyPersonalModelMember {
  readonly modelId: string;
  readonly contextWindow?: number;
}

/**
 * 从旧 Effective Store 中只提取仍能确认的 Personal 用户意图。
 *
 * 旧 Store 把 Built-in、Catalog enrichment、设置页默认值和用户输入写在同一
 * 个模型对象里。迁移整份对象或与当前 Built-in 求差异，都会把系统生成事实冻结成
 * Personal Overlay；因此这里只保留自定义 Provider 调用配置、成员顺序和 context。
 */
export function importLegacyPersonalProviderConfig(
  input: LegacyPersonalProviderConfigImportInput,
): ProviderConfigLayerUpdate {
  let providers = ProviderConfigMap.empty();
  let models = ModelConfigRules.empty();

  for (const legacy of input.legacyProviders) {
    const providerId = legacy.id.trim();
    if (!providerId) continue;
    // 已发布 config.json 也把 builtin:* 标成 custom；保留身份必须先于 source。
    // 只有按量 API 的 Key 是用户输入，模板关联使用当前身份；旧文件仅为回滚保留，不持续双写。
    const apiTemplateId =
      providerId === "builtin:bigmodel"
        ? BUILTIN_PROVIDER_TEMPLATE_IDS.bigmodel
        : providerId === "builtin:zai"
          ? BUILTIN_PROVIDER_TEMPLATE_IDS.zai
          : undefined;
    if (apiTemplateId) {
      const apiKey = legacy.apiKey.trim();
      if (apiKey)
        providers = providers.setRule({
          providerId: apiTemplateId,
          templateId: apiTemplateId,
          config: new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey }),
          }),
        });
      continue;
    }
    if (providerId.startsWith("builtin:") || providerId.startsWith("account:")) continue;
    // Built-in 整体由当前 ZCode Built-in Config 与 Account Overlay 重建；models-dev 已
    // 退役，workspace 也不是全局 Personal 输入。只允许旧自定义 Provider 进入新文件。
    if (legacy.source !== undefined && legacy.source !== "custom") continue;

    const members = collectLegacyPersonalModelMembers(legacy.models);
    const modelIds = members.map((member) => member.modelId);
    const providerName = legacy.name.trim();
    providers = providers.setRule({
      providerId,
      // 旧启停是用户意图；遗漏 false 会被统一默认值重新启用，必须保留在规则外层。
      ...(legacy.enabled !== undefined ? { enabled: legacy.enabled } : {}),
      ...(providerName && providerName !== providerId ? { providerName } : {}),
      config: createPersonalProviderConfig(legacy, modelIds),
    });

    for (const member of members) {
      if (member.contextWindow === undefined) continue;
      models = models.setExact(
        providerId,
        member.modelId,
        new ModelConfig({
          properties: new ModelPropertiesConfig({
            contextWindow: member.contextWindow,
          }),
        }),
      );
    }
  }

  return Object.freeze({ providers, models });
}

function createPersonalProviderConfig(
  legacy: ModelProviderConfig,
  modelIds: readonly string[],
): ProviderConfig {
  return new ProviderConfig({
    group: "standard-personal",
    access: new ApiKeyAccessConfig({
      apiKey: legacy.apiKey.trim() || undefined,
      apiKeyManagementUrl: legacy.apiKeyUrl,
    }),
    api: new ProviderApiConfig({
      type: resolveModelProviderApiFormat(legacy),
      baseUrl:
        resolveModelProviderRuntimeBaseUrl(legacy) ||
        normalizeModelProviderConfiguredBaseUrl(legacy.endpoints.baseURL ?? ""),
      headers: legacy.headers,
    }),
    ...(modelIds.length > 0 ? { personalModelIds: modelIds, modelOrder: modelIds } : {}),
  });
}

function collectLegacyPersonalModelMembers(
  entries: readonly ModelProviderModelEntry[],
): readonly LegacyPersonalModelMember[] {
  const seen = new Set<string>();
  const members: LegacyPersonalModelMember[] = [];

  for (const entry of entries) {
    const modelId = (typeof entry === "string" ? entry : entry.id).trim();
    if (!modelId || seen.has(modelId)) continue;
    if (isModelProviderModelConfig(entry) && entry.deleted === true) continue;
    seen.add(modelId);
    members.push({
      modelId,
      ...(isModelProviderModelConfig(entry) && isPositiveInteger(entry.contextWindow)
        ? { contextWindow: entry.contextWindow }
        : {}),
    });
  }

  return members;
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
  );
}
