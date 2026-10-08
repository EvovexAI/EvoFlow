/* oxlint-disable eslint(max-lines) -- Settings/Selection Facade 共享同一套 Registry 投影与写入边界。 */
import type { ConfigValidationIssue } from "./config-overlay.js";
import type { ProviderModelMembership } from "./config-service.js";
import type {
  ModelConfig,
  ModelConfigObject,
  ModelId,
  ProviderConfig,
  ProviderConfigObject,
  ProviderId,
  ProviderTemplateId,
} from "./config/index.js";
import {
  ModelConfigRules,
  ProviderTemplateMap,
  type ProviderConfigRule,
  type ProviderTemplateNameMap,
  type ProviderTemplateLocale,
  parseModelConfig,
  parseProviderConfig,
} from "./config/index.js";
import type { ProviderRegistryView } from "./registry.js";
import {
  serializeRegistryModelConfig,
  serializeRegistryProviderConfig,
  type ProviderConfigResolution,
  type RegistryModelConfigObject,
} from "./resolver.js";
import { resolveInitialModelSelection } from "./model-selection-config.js";
import {
  resolveEffectiveModelSelection,
  type EffectiveModelSelectionResult,
  type ModelSelectionProviderClassifier,
} from "./effective-model-selection.js";
import type { ModelSelection } from "./registry.js";
import type {
  ProviderRegistryServiceChangedEvent,
  ProviderRegistryServiceSnapshot,
} from "./registry-service.js";

export interface ProviderRegistryFacadeSource {
  getSnapshot(): ProviderRegistryServiceSnapshot | null;
  getView(): ProviderRegistryView;
  refresh(reason: string): Promise<ProviderRegistryServiceSnapshot>;
  onDidChange(listener: (event: ProviderRegistryServiceChangedEvent) => void): () => void;
}

export interface ProviderSettingsMutationTarget {
  createPersonalProvider(input?: {
    readonly templateId?: ProviderTemplateId;
    readonly providerName?: string;
    readonly locale?: ProviderTemplateLocale;
    readonly initialConfig?: ProviderConfig;
  }): Promise<{ readonly providerId: ProviderId }>;
  savePersonalProviderOverlay(
    providerId: ProviderId,
    config: ProviderConfig,
    membership?: ProviderModelMembership,
    metadata?: Pick<ProviderConfigRule, "providerName" | "templateId" | "enabled">,
  ): Promise<unknown>;
  deletePersonalProvider(providerId: ProviderId): Promise<unknown>;
  reorderPersonalProviders(providerIds: readonly ProviderId[]): Promise<unknown>;
  reorderPersonalModels(
    providerId: ProviderId,
    modelIds: readonly ModelId[],
    membership?: ProviderModelMembership,
  ): Promise<unknown>;
  addPersonalModel(
    providerId: ProviderId,
    modelId: ModelId,
    config: ModelConfig,
    membership?: ProviderModelMembership,
    useRecommendedConfig?: boolean,
  ): Promise<unknown>;
  renamePersonalModel(
    providerId: ProviderId,
    currentModelId: ModelId,
    nextModelId: ModelId,
    membership?: ProviderModelMembership,
  ): Promise<unknown>;
  deletePersonalModel(
    providerId: ProviderId,
    modelId: ModelId,
    membership?: ProviderModelMembership,
  ): Promise<unknown>;
  savePersonalModelDraft(
    providerId: ProviderId,
    originalModelId: ModelId,
    nextModelId: ModelId,
    config: ModelConfig,
    expectedPersonalRevision: string,
    useRecommendedConfig?: boolean,
    membership?: ProviderModelMembership,
  ): Promise<unknown>;
  setPersonalModelEnabled(
    providerId: ProviderId,
    modelId: ModelId,
    enabled: boolean,
    membership?: ProviderModelMembership,
  ): Promise<unknown>;
  refresh(reason: string): Promise<ProviderRegistryServiceSnapshot>;
  /** 主动重读上游事实后再刷新 Registry。 */
  refreshSources?(reason: string): Promise<ProviderRegistryServiceSnapshot>;
}

export interface ProviderSettingsModelCandidateView {
  readonly kind: "candidate";
  readonly modelId: ModelId;
  readonly builtin: boolean;
  readonly effectiveBuiltinConfig: ModelConfigObject;
  readonly personalExactConfig?: ModelConfigObject;
  readonly useRecommendedConfig?: boolean;
  readonly effectiveConfig: RegistryModelConfigObject | ModelConfigObject;
  readonly enabled: boolean;
  readonly executable: boolean;
  readonly selectable: boolean;
  readonly issues: readonly ConfigValidationIssue[];
}

export type ProviderSettingsModelView = ProviderSettingsModelCandidateView;

export interface ModelConfigResolution {
  readonly inheritedConfig: ModelConfigObject;
  readonly effectiveConfig: ModelConfigObject;
  readonly issues: readonly ConfigValidationIssue[];
}

export type ResolveModelConfigInput =
  | {
      readonly providerId: ProviderId;
      readonly modelId: ModelId;
    }
  | {
      readonly providerId: ProviderId;
      readonly originalModelId: ModelId;
      readonly modelId: ModelId;
      readonly personalConfig: ModelConfigObject;
    };

export interface SavePersonalModelDraftInput {
  readonly providerId: ProviderId;
  readonly originalModelId: ModelId;
  readonly nextModelId: ModelId;
  readonly personalConfig: ModelConfigObject;
  readonly useRecommendedConfig?: boolean;
  readonly basedOnRevision: number;
}

export interface ProviderSettingsProviderView extends Pick<
  ProviderConfigRule,
  "providerName" | "templateId"
> {
  readonly enabled: boolean;
  readonly accountState?: import("./account-provider-state.js").AccountProviderState;
  readonly providerId: ProviderId;
  /** 当前 Effective Config 是否已经进入 Registry，可用于模型选择和创建。 */
  readonly executable: boolean;
  readonly effectiveBuiltinConfig?: ProviderConfigObject;
  readonly personalConfig?: ProviderConfigObject;
  readonly effectiveConfig: ProviderConfigObject;
  readonly issues: readonly ConfigValidationIssue[];
  readonly models: readonly ProviderSettingsModelView[];
}

export interface ProviderSettingsTemplateView {
  readonly templateId: ProviderTemplateId;
  readonly templateNameMap: ProviderTemplateNameMap;
  readonly config: ProviderConfigObject;
}

export interface ProviderSettingsView {
  readonly revision: number;
  readonly providerTemplates: readonly ProviderSettingsTemplateView[];
  readonly providerOrder: readonly ProviderId[];
  readonly providers: readonly ProviderSettingsProviderView[];
}

export interface ProviderSettingsCreationResult {
  readonly providerId: ProviderId;
  readonly view: ProviderSettingsView;
}

export interface ModelSelectionModelView {
  readonly modelId: ModelId;
  readonly config: RegistryModelConfigObject;
}

export interface ModelSelectionProviderView extends Pick<
  ProviderConfigRule,
  "providerName" | "templateId"
> {
  readonly providerId: ProviderId;
  readonly config: ProviderConfigObject;
  readonly models: readonly ModelSelectionModelView[];
}

export interface ModelSelectionViewInput {
  readonly selection: ModelSelection | null;
}

export interface ModelSelectionView extends Partial<EffectiveModelSelectionResult> {
  readonly revision: number;
  readonly providers: readonly ModelSelectionProviderView[];
  readonly preferredSelection?: ModelSelection;
}

export class ProviderSettingsFacade {
  readonly #source: ProviderRegistryFacadeSource;
  readonly #mutations?: ProviderSettingsMutationTarget;
  readonly #providerMutationTails = new Map<ProviderId, Promise<unknown>>();

  constructor(source: ProviderRegistryFacadeSource, mutations?: ProviderSettingsMutationTarget) {
    this.#source = source;
    this.#mutations = mutations;
  }

  getView(): ProviderSettingsView {
    const snapshot = requireSnapshot(this.#source);
    return createProviderSettingsView({
      revision: snapshot.registry.revision,
      zcodeBuiltinProviders: snapshot.config.zcodeBuiltinProviders,
      zcodeBuiltinProviderTemplates: snapshot.config.zcodeBuiltinProviderTemplates,
      personalProviders: snapshot.config.personalProviders,
      personalModels: snapshot.config.personalModels,
      resolution: snapshot.resolution,
      accountStates: snapshot.account.states,
    });
  }

  async refresh(reason: string): Promise<ProviderSettingsView> {
    if (this.#mutations?.refreshSources) {
      await this.#mutations.refreshSources(`settings:${reason}`);
    } else {
      await this.#source.refresh(reason);
    }
    return this.getView();
  }

  resolveModelConfig(input: ResolveModelConfigInput): ModelConfigResolution {
    const snapshot = requireSnapshot(this.#source);
    const provider = requireEffectiveProvider(snapshot, input.providerId);
    if (!("personalConfig" in input)) {
      const modelRules = ModelConfigRules.composeEffective(
        snapshot.config.zcodeBuiltinModelRules,
        snapshot.config.personalModels,
      );
      const config = modelRules.resolve({
        providerId: input.providerId,
        templateId: provider.templateId,
        modelId: input.modelId,
        apiType: provider.config.api?.type,
        baseUrl: provider.config.api?.baseUrl,
      });
      return Object.freeze({
        inheritedConfig: config.toJSON(),
        effectiveConfig: config.toJSON(),
        issues: Object.freeze([
          ...config.validateComplete(["providers", input.providerId, "models", input.modelId]),
        ]),
      });
    }

    const personalConfig = parseModelConfig(input.personalConfig);
    const inheritedConfig = snapshot.config.zcodeBuiltinModelRules.resolve({
      providerId: input.providerId,
      templateId: provider.templateId,
      modelId: input.modelId,
      apiType: provider.config.api?.type,
      baseUrl: provider.config.api?.baseUrl,
    });
    let personalRules = snapshot.config.personalModels;
    if (input.originalModelId !== input.modelId) {
      personalRules = personalRules.renameExactModel(
        input.providerId,
        input.originalModelId,
        input.modelId,
      );
    }
    // 此入口预览智能配置草稿；固定模式不请求推荐，重新开启时不能沿用旧固定标记。
    personalRules = personalRules.setExact(input.providerId, input.modelId, personalConfig, true);
    const config = ModelConfigRules.composeEffective(
      snapshot.config.zcodeBuiltinModelRules,
      personalRules,
    ).resolve({
      providerId: input.providerId,
      templateId: provider.templateId,
      modelId: input.modelId,
      apiType: provider.config.api?.type,
      baseUrl: provider.config.api?.baseUrl,
    });
    return Object.freeze({
      inheritedConfig: inheritedConfig.toJSON(),
      effectiveConfig: config.toJSON(),
      issues: Object.freeze([
        ...config.validateComplete(["providers", input.providerId, "models", input.modelId]),
      ]),
    });
  }

  onDidChange(listener: (view: ProviderSettingsView) => void): () => void {
    return this.#source.onDidChange(() => listener(this.getView()));
  }

  createPersonalProvider(input?: {
    readonly templateId?: ProviderTemplateId;
    readonly providerName?: string;
    readonly locale?: ProviderTemplateLocale;
    readonly initialConfig?: ProviderConfigObject;
  }): Promise<ProviderSettingsCreationResult> {
    return this.#mutateWithResult("create-provider", (target) =>
      target.createPersonalProvider({
        ...(input?.templateId ? { templateId: input.templateId } : {}),
        ...(input?.providerName ? { providerName: input.providerName } : {}),
        ...(input?.locale ? { locale: input.locale } : {}),
        ...(input?.initialConfig
          ? { initialConfig: parseProviderConfig(input.initialConfig) }
          : {}),
      }),
    ).then(({ result, view }) => ({ providerId: result.providerId, view }));
  }

  savePersonalProviderOverlay(
    providerId: ProviderId,
    config: ProviderConfigObject,
    metadata?: Pick<ProviderConfigRule, "providerName" | "templateId" | "enabled">,
  ): Promise<ProviderSettingsView> {
    return this.#mutateProvider(providerId, "save-provider", (target) =>
      target.savePersonalProviderOverlay(
        providerId,
        parseProviderConfig(config),
        this.#modelMembership(providerId),
        metadata,
      ),
    );
  }

  deletePersonalProvider(providerId: ProviderId): Promise<ProviderSettingsView> {
    return this.#mutateProvider(providerId, "delete-provider", (target) =>
      target.deletePersonalProvider(providerId),
    );
  }

  reorderPersonalProviders(providerIds: readonly ProviderId[]): Promise<ProviderSettingsView> {
    return this.#mutate("reorder-providers", (target) =>
      target.reorderPersonalProviders(providerIds),
    );
  }

  reorderPersonalModels(
    providerId: ProviderId,
    modelIds: readonly ModelId[],
  ): Promise<ProviderSettingsView> {
    return this.#mutateProvider(providerId, "reorder-models", (target) =>
      target.reorderPersonalModels(providerId, modelIds, this.#modelMembership(providerId)),
    );
  }

  addPersonalModel(
    providerId: ProviderId,
    modelId: ModelId,
    config: ModelConfigObject,
    useRecommendedConfig?: boolean,
  ): Promise<ProviderSettingsView> {
    return this.#mutateProvider(providerId, "add-model", (target) =>
      target.addPersonalModel(
        providerId,
        modelId,
        parseModelConfig(config),
        this.#modelMembership(providerId),
        useRecommendedConfig,
      ),
    );
  }

  renamePersonalModel(
    providerId: ProviderId,
    currentModelId: ModelId,
    nextModelId: ModelId,
  ): Promise<ProviderSettingsView> {
    return this.#mutateProvider(providerId, "rename-model", (target) =>
      target.renamePersonalModel(
        providerId,
        currentModelId,
        nextModelId,
        this.#modelMembership(providerId),
      ),
    );
  }

  deletePersonalModel(providerId: ProviderId, modelId: ModelId): Promise<ProviderSettingsView> {
    return this.#mutateProvider(providerId, "delete-personal-model", (target) =>
      target.deletePersonalModel(providerId, modelId, this.#modelMembership(providerId)),
    );
  }

  savePersonalModelDraft(input: SavePersonalModelDraftInput): Promise<ProviderSettingsView> {
    return this.#mutateProvider(input.providerId, "save-model-draft", async (target) => {
      const snapshot = requireSnapshot(this.#source);
      if (snapshot.registry.revision !== input.basedOnRevision) {
        throw new Error(
          `Provider Settings revision conflict: expected ${input.basedOnRevision}, current ${snapshot.registry.revision}`,
        );
      }
      const parsedConfig = parseModelConfig(input.personalConfig);
      await target.savePersonalModelDraft(
        input.providerId,
        input.originalModelId,
        input.nextModelId,
        parsedConfig,
        snapshot.config.personalRevision,
        input.useRecommendedConfig,
        this.#modelMembership(input.providerId, snapshot),
      );
    });
  }

  setPersonalModelEnabled(
    providerId: ProviderId,
    modelId: ModelId,
    enabled: boolean,
  ): Promise<ProviderSettingsView> {
    return this.#mutateProvider(providerId, "set-model-enabled", (target) =>
      target.setPersonalModelEnabled(
        providerId,
        modelId,
        enabled,
        this.#modelMembership(providerId),
      ),
    );
  }

  #modelMembership(
    providerId: ProviderId,
    snapshot = requireSnapshot(this.#source),
  ): ProviderModelMembership {
    const provider = snapshot.resolution.resolvedProviders.find(
      (item) => item.providerId === providerId,
    );
    if (!provider) throw new Error(`Provider 不存在: ${providerId}`);
    // 配置成员与可执行模型不是同一名单：禁用、无权益和不完整模型仍可编辑。
    // Account 的空/替换名单也必须原样使用，不能再与静态 Built-in 取并集。
    return Object.freeze({
      providerId,
      inheritedModelIds: Object.freeze(
        provider.models.filter((model) => model.source === "builtin").map((model) => model.modelId),
      ),
      personalRevision: snapshot.config.personalRevision,
      assertCurrent: () => {
        if (this.#source.getSnapshot() !== snapshot)
          throw new Error("Provider Settings snapshot revision conflict");
      },
    });
  }

  async #mutate(
    reason: string,
    operation: (target: ProviderSettingsMutationTarget) => Promise<unknown>,
  ): Promise<ProviderSettingsView> {
    if (!this.#mutations) throw new Error("ProviderSettingsFacade 未配置写入目标");
    await operation(this.#mutations);
    await this.#mutations.refresh(`settings:${reason}`);
    return this.getView();
  }

  #mutateProvider(
    providerId: ProviderId,
    reason: string,
    operation: (target: ProviderSettingsMutationTarget) => Promise<unknown>,
  ): Promise<ProviderSettingsView> {
    const previous = this.#providerMutationTails.get(providerId) ?? Promise.resolve();
    const waitForPrevious = previous.catch(() => undefined);
    const result = waitForPrevious.then(() => this.#mutate(reason, operation));
    this.#providerMutationTails.set(providerId, result);
    const cleanup = () => {
      if (this.#providerMutationTails.get(providerId) === result) {
        this.#providerMutationTails.delete(providerId);
      }
    };
    void result.then(cleanup, cleanup);
    return result;
  }

  async waitForProviderOperations(providerId: ProviderId): Promise<void> {
    await this.#providerMutationTails.get(providerId);
  }

  async #mutateWithResult<TResult>(
    reason: string,
    operation: (target: ProviderSettingsMutationTarget) => Promise<TResult>,
  ): Promise<{ readonly result: TResult; readonly view: ProviderSettingsView }> {
    if (!this.#mutations) throw new Error("ProviderSettingsFacade 未配置写入目标");
    const result = await operation(this.#mutations);
    await this.#mutations.refresh(`settings:${reason}`);
    return { result, view: this.getView() };
  }
}

export class ModelSelectionFacade {
  readonly #source: ProviderRegistryFacadeSource;
  readonly #classifyProvider: ModelSelectionProviderClassifier;
  readonly #resolveLegacyReasoningLevel?: (
    snapshot: ProviderRegistryServiceSnapshot,
    selection: ModelSelection,
  ) => string | undefined;

  constructor(
    source: ProviderRegistryFacadeSource,
    classifyProvider: ModelSelectionProviderClassifier = () => "ordinary",
    resolveLegacyReasoningLevel?: (
      snapshot: ProviderRegistryServiceSnapshot,
      selection: ModelSelection,
    ) => string | undefined,
  ) {
    this.#source = source;
    this.#classifyProvider = classifyProvider;
    this.#resolveLegacyReasoningLevel = resolveLegacyReasoningLevel;
  }

  getView(
    configuredDefault?: ModelSelection,
    revision?: number,
    input?: ModelSelectionViewInput,
  ): ModelSelectionView {
    // 账号事实与候选从同一已应用快照读取；不把最新 Settings 配给旧 Registry。
    const snapshot = input ? requireSnapshot(this.#source) : this.#source.getSnapshot();
    const registry = snapshot?.registry ?? this.#source.getView();
    const resolveLegacyReasoningLevel =
      snapshot && this.#resolveLegacyReasoningLevel
        ? (selection: ModelSelection) => this.#resolveLegacyReasoningLevel!(snapshot, selection)
        : undefined;
    // 默认偏好只归一化档位，不借此改写账号身份或保存配置。
    const normalizedDefault =
      configuredDefault && resolveLegacyReasoningLevel
        ? (resolveEffectiveModelSelection({
            selection: configuredDefault,
            registry,
            classifyProvider: () => "ordinary",
            resolveLegacyReasoningLevel,
          }).effectiveSelection ?? undefined)
        : configuredDefault;
    const initial = resolveInitialModelSelection({
      registry,
      configuredDefault: normalizedDefault,
    });
    return Object.freeze({
      revision: revision ?? registry.revision,
      providers: Object.freeze(
        registry.providers
          .filter((provider) => provider.config.visibility !== "hidden")
          .map(projectModelSelectionProviderView),
      ),
      ...(initial.source === "none" ? {} : { preferredSelection: initial.selection }),
      ...(input
        ? resolveEffectiveModelSelection({
            selection: input.selection,
            registry,
            accountStates: snapshot?.account.states,
            classifyProvider: this.#classifyProvider,
            resolveLegacyReasoningLevel,
          })
        : {}),
    });
  }

  onDidChange(listener: (view: ModelSelectionView) => void): () => void {
    return this.#source.onDidChange(() => listener(this.getView()));
  }
}

/** 把一个已进入 Registry 的 Provider 投影为标准模型选择候选。调用方负责产品作用域。 */
export function projectModelSelectionProviderView(
  provider: ProviderRegistryView["providers"][number],
): ModelSelectionProviderView {
  return Object.freeze({
    providerId: provider.providerId,
    providerName: provider.providerName,
    templateId: provider.templateId,
    config: serializeRegistryProviderConfig(provider.config),
    models: Object.freeze(
      provider.models.map((model) =>
        Object.freeze({
          modelId: model.modelId,
          config: serializeRegistryModelConfig(model.config),
        }),
      ),
    ),
  });
}

function requireSnapshot(source: ProviderRegistryFacadeSource): ProviderRegistryServiceSnapshot {
  const snapshot = source.getSnapshot();
  if (!snapshot) throw new Error("ProviderRegistryService 尚未 start()");
  return snapshot;
}

function requireEffectiveProvider(
  snapshot: ProviderRegistryServiceSnapshot,
  providerId: ProviderId,
): ProviderConfigRule {
  const provider = snapshot.resolution.effectiveProviders.getRule(providerId);
  if (!provider) throw new Error(`Provider 不存在: ${providerId}`);
  return provider;
}

function createProviderSettingsView(input: {
  revision: number;
  zcodeBuiltinProviders: ProviderRegistryServiceSnapshot["config"]["zcodeBuiltinProviders"];
  zcodeBuiltinProviderTemplates: ProviderRegistryServiceSnapshot["config"]["zcodeBuiltinProviderTemplates"];
  personalProviders: ProviderRegistryServiceSnapshot["config"]["personalProviders"];
  personalModels: ProviderRegistryServiceSnapshot["config"]["personalModels"];
  resolution: ProviderConfigResolution;
  accountStates?: import("./account-provider-state.js").AccountProviderStates;
}): ProviderSettingsView {
  const executableProviderIds = new Set(
    input.resolution.registryProviders.map((provider) => provider.providerId),
  );
  const projectProvider = (provider: (typeof input.resolution.resolvedProviders)[number]) => {
    const personalConfig = input.personalProviders.get(provider.providerId);
    return Object.freeze({
      providerId: provider.providerId,
      providerName: provider.providerName,
      templateId: provider.templateId,
      enabled: provider.enabled,
      ...(input.accountStates?.[provider.providerId]
        ? { accountState: input.accountStates[provider.providerId] }
        : {}),
      executable: executableProviderIds.has(provider.providerId),
      ...(provider.templateConfig ? { templateConfig: provider.templateConfig.toJSON() } : {}),
      ...(provider.effectiveBuiltinConfig
        ? { effectiveBuiltinConfig: provider.effectiveBuiltinConfig.toJSON() }
        : {}),
      ...(personalConfig ? { personalConfig: personalConfig.toJSON() } : {}),
      effectiveConfig: provider.config.toJSON(),
      issues: provider.providerIssues,
      models: Object.freeze(
        provider.models.map((model) => {
          const personalModelConfig = input.personalModels.getExact(
            provider.providerId,
            model.modelId,
          );
          const personalModelRule = input.personalModels.getExactRule(
            provider.providerId,
            model.modelId,
          );
          return Object.freeze({
            kind: model.kind,
            modelId: model.modelId,
            builtin: model.source === "builtin",
            effectiveBuiltinConfig: model.effectiveBuiltinConfig.toJSON(),
            ...(personalModelConfig ? { personalExactConfig: personalModelConfig.toJSON() } : {}),
            ...(personalModelRule
              ? { useRecommendedConfig: personalModelRule.type !== "manual-provider-model" }
              : {}),
            effectiveConfig: model.config.toJSON(),
            enabled: model.enabled,
            executable: model.executable,
            selectable: model.selectable,
            issues: model.issues,
          });
        }),
      ),
    });
  };
  const visibleProviders = input.resolution.resolvedProviders.filter(
    (provider) => provider.config.visibility !== "hidden",
  );
  const configuredProviders = visibleProviders;
  return Object.freeze({
    revision: input.revision,
    providerTemplates: Object.freeze(
      (input.zcodeBuiltinProviderTemplates ?? ProviderTemplateMap.empty())
        .entries()
        .map(([templateId, template]) =>
          Object.freeze({
            templateId,
            templateNameMap: template.templateNameMap,
            config: template.config.toJSON(),
          }),
        ),
    ),
    providerOrder: Object.freeze(
      configuredProviders
        .filter((provider) => provider.config.group === "standard-personal")
        .map((provider) => provider.providerId),
    ),
    providers: Object.freeze(configuredProviders.map(projectProvider)),
  });
}
