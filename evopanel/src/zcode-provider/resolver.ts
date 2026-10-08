/* oxlint-disable eslint(max-lines) -- Resolver 同时产出 Settings 分层结果与唯一 Registry 完整类型证明。 */
import type { z } from "zod";
import type { completeModelConfigDataSchema } from "@zcode/shared/model-config";
import type {
  completeApiKeyAccessDataSchema,
  completeZhipuAccountAccessDataSchema,
  completeProviderConfigDataSchema,
} from "./config/provider-data-schema.js";
import type { ConfigValidationIssue } from "./config-overlay.js";
import {
  type ApiKeyAccessConfig,
  ModelConfig,
  ModelConfigRules,
  type ZhipuAccountAccessConfig,
  type ModelId,
  type ProviderConfig,
  type ProviderConfigRule,
  ProviderConfigMap,
  type ProviderTemplateMap,
  type ProviderId,
} from "./config/index.js";
import { resolveOwnedOrder } from "./owned-order.js";
import type { AccountProviderStates } from "./account-provider-state.js";

export type RegistryZhipuAccountAccessConfig = ZhipuAccountAccessConfig &
  z.infer<typeof completeZhipuAccountAccessDataSchema>;

export type RegistryProviderAccessConfig =
  | (ApiKeyAccessConfig & z.infer<typeof completeApiKeyAccessDataSchema>)
  | RegistryZhipuAccountAccessConfig;

export type RegistryProviderConfig = ProviderConfig &
  z.infer<typeof completeProviderConfigDataSchema> & {
    readonly access: RegistryProviderAccessConfig;
  };

export type RegistryProviderConfigObject = z.infer<typeof completeProviderConfigDataSchema>;

export function serializeRegistryProviderConfig(
  config: RegistryProviderConfig,
): RegistryProviderConfigObject {
  return {
    group: config.group,
    ...(config.logo === undefined ? {} : { logo: config.logo }),
    access:
      config.access.type !== "zhipu-account"
        ? {
            type: config.access.type,
            apiKey: config.access.apiKey,
            ...(config.access.apiKeyManagementUrl === undefined
              ? {}
              : { apiKeyManagementUrl: config.access.apiKeyManagementUrl }),
          }
        : {
            type: config.access.type,
            accountType: config.access.accountType,
            mode: config.access.mode,
            entitled: config.access.entitled,
          },
    api: {
      type: config.api.type,
      baseUrl: config.api.baseUrl,
      ...(config.api.headers == null ? {} : { headers: config.api.headers }),
    },
    ...(config.builtinModelIds == null ? {} : { builtinModelIds: [...config.builtinModelIds] }),
    ...(config.personalModelIds == null ? {} : { personalModelIds: [...config.personalModelIds] }),
    ...(config.modelOrder == null ? {} : { modelOrder: [...config.modelOrder] }),
    ...(config.visibility === undefined ? {} : { visibility: config.visibility }),
  };
}

export type RegistryModelConfig = ModelConfig & z.infer<typeof completeModelConfigDataSchema>;

export type RegistryModelConfigObject = z.infer<typeof completeModelConfigDataSchema>;

export function serializeRegistryModelConfig(
  config: RegistryModelConfig,
): RegistryModelConfigObject {
  return {
    enabled: config.enabled,
    properties: {
      requiresMfjsToolSchema: config.properties.requiresMfjsToolSchema,
      contextWindow: config.properties.contextWindow,
      inputFormat: {
        supportsText: config.properties.inputFormat.supportsText,
        supportsImage: config.properties.inputFormat.supportsImage,
        supportsVideo: config.properties.inputFormat.supportsVideo,
        supportsAudio: config.properties.inputFormat.supportsAudio,
        supportsPdf: config.properties.inputFormat.supportsPdf,
      },
      outputFormat: { supportsText: config.properties.outputFormat.supportsText },
      supportsToolCall: config.properties.supportsToolCall,
      supportsJsonSchemaOutput: config.properties.supportsJsonSchemaOutput,
      supportsNativeWebSearch: config.properties.supportsNativeWebSearch,
      supportsMidConversationSystem: config.properties.supportsMidConversationSystem,
    },
    optionSpecs: {
      reasoningLevel: config.optionSpecs.reasoningLevel,
      maxOutputTokens: config.optionSpecs.maxOutputTokens,
    },
  };
}

export type RegistryConfigResult<T> =
  | { readonly ok: true; readonly config: T }
  | { readonly ok: false; readonly issues: readonly ConfigValidationIssue[] };

export function createRegistryProviderConfig(
  config: ProviderConfig,
  path: readonly string[] = ["provider"],
): RegistryConfigResult<RegistryProviderConfig> {
  const issues = config.validateComplete(path);
  return issues.length > 0
    ? { ok: false, issues: Object.freeze([...issues]) }
    : { ok: true, config: config as RegistryProviderConfig };
}

export function createRegistryModelConfig(
  config: ModelConfig,
  path: readonly string[] = ["model"],
): RegistryConfigResult<RegistryModelConfig> {
  const issues = config.validateComplete(path);
  return issues.length > 0
    ? { ok: false, issues: Object.freeze([...issues]) }
    : { ok: true, config: config as RegistryModelConfig };
}

export interface ProviderConfigResolverInput {
  readonly zcodeBuiltinProviders: ProviderConfigMap;
  readonly zcodeBuiltinProviderTemplates?: ProviderTemplateMap;
  readonly personalProviders: ProviderConfigMap;
  readonly zcodeBuiltinModelRules: ModelConfigRules;
  readonly personalModels: ModelConfigRules;
  readonly accountProviders: ProviderConfigMap;
  readonly accountStates?: AccountProviderStates;
  readonly personalProviderOrder?: readonly ProviderId[];
}

export interface ResolvedProviderModelCandidate {
  readonly kind: "candidate";
  readonly modelId: ModelId;
  readonly source: "builtin" | "personal";
  readonly config: ModelConfig;
  readonly effectiveBuiltinConfig: ModelConfig;
  readonly issues: readonly ConfigValidationIssue[];
  readonly enabled: boolean;
  readonly executable: boolean;
  readonly selectable: boolean;
}

export type ResolvedProviderModel = ResolvedProviderModelCandidate;

export interface ResolvedProvider extends Pick<ProviderConfigRule, "templateId" | "providerName"> {
  readonly enabled: boolean;
  readonly providerId: ProviderId;
  readonly config: ProviderConfig;
  readonly templateConfig?: ProviderConfig;
  readonly effectiveBuiltinConfig?: ProviderConfig;
  readonly providerIssues: readonly ConfigValidationIssue[];
  readonly models: readonly ResolvedProviderModel[];
}

export interface ProviderModel {
  readonly modelId: ModelId;
  readonly config: RegistryModelConfig;
}

export interface Provider extends Pick<ProviderConfigRule, "templateId" | "providerName"> {
  readonly providerId: ProviderId;
  readonly config: RegistryProviderConfig;
  readonly models: readonly ProviderModel[];
}

export interface ProviderConfigResolution {
  readonly effectiveBuiltinProviders: ProviderConfigMap;
  readonly effectiveProviders: ProviderConfigMap;
  readonly resolvedProviders: readonly ResolvedProvider[];
  readonly registryProviders: readonly Provider[];
  readonly issues: readonly ConfigValidationIssue[];
}

export class ProviderConfigResolver {
  resolve(input: ProviderConfigResolverInput): ProviderConfigResolution {
    const accountProviders = new ProviderConfigMap(
      input.accountProviders
        .entries()
        .filter(([providerId]) => input.zcodeBuiltinProviders.has(providerId))
        .map(([providerId, config]) => [providerId, config.withoutGroup()] as const),
    );
    const concreteBuiltinProviders = input.zcodeBuiltinProviders.overlay(accountProviders);
    const providerTemplates = input.zcodeBuiltinProviderTemplates;
    const effectiveBuiltinProviders = concreteBuiltinProviders.mapConfigs((concrete, _id, rule) => {
      const template = rule.templateId
        ? providerTemplates?.get(rule.templateId)?.config
        : undefined;
      return template ? template.overlay(concrete) : concrete;
    });
    const personalProviders = input.personalProviders.mapConfigs((config, providerId) =>
      effectiveBuiltinProviders.has(providerId) ? config.withoutGroup() : config,
    );
    const templatePersonalProviders = personalProviders.mapConfigs((personal, providerId, rule) => {
      if (effectiveBuiltinProviders.has(providerId)) return personal;
      const template = rule.templateId
        ? providerTemplates?.get(rule.templateId)?.config
        : undefined;
      return template ? template.overlay(personal) : personal;
    });
    const effectiveProviders = effectiveBuiltinProviders.overlay(templatePersonalProviders);
    const effectiveModelRules = ModelConfigRules.composeEffective(
      input.zcodeBuiltinModelRules,
      input.personalModels,
    );
    const issues: ConfigValidationIssue[] = [];
    const resolvedProviders: ResolvedProvider[] = [];
    const registryProviders: Provider[] = [];

    for (const providerId of resolveProviderOrder(input, effectiveProviders)) {
      const rule = effectiveProviders.getRule(providerId)!;
      const { config, providerName } = rule;
      // 账号不再支持总禁用；旧覆盖值不能让无开关的账号永久失效，其他资格仍正常校验。
      const enabled = config.access?.type === "zhipu-account" || (rule.enabled ?? true);
      const providerPath = ["providers", providerId];
      const registryProviderResult = createRegistryProviderConfig(config, providerPath);
      const providerIssues: ConfigValidationIssue[] = registryProviderResult.ok
        ? []
        : [...registryProviderResult.issues];
      const templateId = rule.templateId ?? undefined;
      const templateConfig = templateId ? providerTemplates?.get(templateId)?.config : undefined;
      if (templateId && !templateConfig) {
        providerIssues.push({
          code: "missing-template",
          path: [...providerPath, "templateId"],
          message: `Provider Template 不存在: ${templateId}`,
        });
      }
      issues.push(...providerIssues);
      const builtinModelIds = config.builtinModelIds ?? [];
      const personalModelIds = config.personalModelIds ?? [];
      const builtinIdsInOrder = uniqueInOrder(builtinModelIds);
      const builtinIds = new Set(builtinIdsInOrder);
      const personalIdsInOrder = uniqueInOrder(personalModelIds).filter(
        (modelId) => !builtinIds.has(modelId),
      );
      const orderedModelIds = resolveOwnedOrder(
        builtinIdsInOrder,
        personalIdsInOrder,
        config.modelOrder ?? [],
      );
      const accessEntitled =
        config.access?.type !== "zhipu-account" || config.access.entitled === true;
      // 账号权益与当前连接是两件事。非当前账号仍保留设置展示，不向普通 Registry 发布模型。
      // Off-Peak 不定义 current，沿用其独立调度、隐藏和鉴权规则。
      const accountCurrent = input.accountStates?.[providerId]?.current !== false;
      const providerExecutable =
        enabled && accessEntitled && accountCurrent && providerIssues.length === 0;
      const models = orderedModelIds.map((modelId): ResolvedProviderModel => {
        const modelConfig = effectiveModelRules.resolve({
          providerId,
          templateId,
          modelId,
          apiType: config.api?.type,
          baseUrl: config.api?.baseUrl,
        });
        const effectiveBuiltinConfig = input.zcodeBuiltinModelRules.resolve({
          providerId,
          templateId,
          modelId,
          apiType: config.api?.type,
          baseUrl: config.api?.baseUrl,
        });
        const registryModelResult = createRegistryModelConfig(modelConfig, [
          ...providerPath,
          "models",
          modelId,
        ]);
        const modelIssues = registryModelResult.ok ? [] : registryModelResult.issues;
        issues.push(...modelIssues);
        const modelEnabled = modelConfig.enabled === true;
        const executable = providerExecutable && modelEnabled && modelIssues.length === 0;
        const selectable = executable && config.visibility !== "hidden";
        return Object.freeze({
          kind: "candidate",
          modelId,
          source: builtinIds.has(modelId) ? "builtin" : "personal",
          config: modelConfig,
          effectiveBuiltinConfig,
          issues: Object.freeze(modelIssues),
          enabled: modelEnabled,
          executable,
          selectable,
        });
      });

      const resolvedProvider = Object.freeze({
        providerId,
        enabled,
        providerName,
        templateId,
        config,
        ...(templateConfig ? { templateConfig } : {}),
        ...(effectiveBuiltinProviders.get(providerId)
          ? { effectiveBuiltinConfig: effectiveBuiltinProviders.get(providerId) }
          : {}),
        providerIssues: Object.freeze([...providerIssues]),
        models: Object.freeze(models),
      });
      resolvedProviders.push(resolvedProvider);

      if (!registryProviderResult.ok || providerIssues.length > 0) {
        continue;
      }
      const validModels = models
        .filter((model) => model.executable)
        .map(({ modelId, config: modelConfig }) => {
          const result = createRegistryModelConfig(modelConfig, [
            ...providerPath,
            "models",
            modelId,
          ]);
          if (!result.ok)
            throw new Error(`Registry Model 完整性结果不一致: ${providerId}/${modelId}`);
          return Object.freeze({ modelId, config: result.config });
        });
      if (validModels.length === 0) continue;
      registryProviders.push(
        Object.freeze({
          providerId,
          providerName,
          templateId,
          config: registryProviderResult.config,
          models: Object.freeze(validModels),
        }),
      );
    }

    return Object.freeze({
      effectiveBuiltinProviders,
      effectiveProviders,
      resolvedProviders: Object.freeze(resolvedProviders),
      registryProviders: Object.freeze(registryProviders),
      issues: Object.freeze(issues),
    });
  }
}

function uniqueInOrder(modelIds: readonly ModelId[]): readonly ModelId[] {
  const seen = new Set<ModelId>();
  return modelIds.filter((modelId) => {
    if (seen.has(modelId)) return false;
    seen.add(modelId);
    return true;
  });
}

function resolveProviderOrder(
  input: ProviderConfigResolverInput,
  effectiveProviders: ProviderConfigMap,
): readonly ProviderId[] {
  const sourceIds = effectiveProviders.keys();
  const familyIds = sourceIds.filter((providerId) => {
    const group = effectiveProviders.get(providerId)?.group;
    return group === "zai-family" || group === "bigmodel-family";
  });
  const familySet = new Set(familyIds);
  const builtinIds = input.zcodeBuiltinProviders
    .keys()
    .filter((providerId) => !familySet.has(providerId));
  const builtinSet = new Set(builtinIds);
  const personalIds = input.personalProviders
    .keys()
    .filter((providerId) => !builtinSet.has(providerId) && !familySet.has(providerId));
  return [
    ...familyIds,
    ...resolveOwnedOrder(builtinIds, personalIds, input.personalProviderOrder ?? []),
  ];
}
