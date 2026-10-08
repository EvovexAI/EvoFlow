/* oxlint-disable eslint(max-lines) -- Provider/Model 的原子配置生命周期共享一次 Repository 更新边界，拆开会重复顺序与规范化逻辑。 */
import type {
  ModelConfigRules,
  ModelId,
  ProviderConfig,
  ProviderId,
  ProviderTemplateId,
  ProviderConfigRule,
  ProviderTemplateLocale,
} from "./config/index.js";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ProviderConfigMap,
  ProviderConfig as ProviderConfigValue,
  ProviderTemplateMap,
  resolveProviderTemplateName,
} from "./config/index.js";
import { resolveOwnedOrder } from "./owned-order.js";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type { ProviderConfigSnapshot, ProviderSource } from "./sources.js";

export interface ProviderConfigLayerSnapshot {
  readonly revision: string;
  readonly providers: ProviderConfigMap;
  readonly providerTemplates?: ProviderTemplateMap;
  readonly models: ModelConfigRules;
  readonly providerOrder?: readonly ProviderId[];
  readonly defaultModelSelection?: ModelSelection;
}

export interface ProviderConfigLayerUpdate {
  readonly providers: ProviderConfigMap;
  readonly providerTemplates?: ProviderTemplateMap;
  readonly models: ModelConfigRules;
  readonly providerOrder?: readonly ProviderId[];
  readonly defaultModelSelection?: ModelSelection;
}

export interface PersonalProviderConfigRepository extends ProviderSource<ProviderConfigLayerSnapshot> {
  update(
    transform: (current: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate,
  ): Promise<ProviderConfigLayerSnapshot>;
}

export interface ProviderConfigServiceDependencies {
  readonly zcodeBuiltinSource: ProviderSource<ProviderConfigLayerSnapshot>;
  readonly personalRepository: PersonalProviderConfigRepository;
}

export interface PersonalProviderCreation {
  readonly providerId: ProviderId;
}

export interface CreatePersonalProviderInput {
  readonly templateId?: ProviderTemplateId;
  readonly providerName?: string;
  readonly locale?: ProviderTemplateLocale;
  readonly initialConfig?: ProviderConfig;
}

/** Facade 提供的 Host 内部成员事实；不得接受 Renderer 自报的模型名单。 */
export interface ProviderModelMembership {
  readonly providerId: ProviderId;
  readonly inheritedModelIds: readonly ModelId[];
  readonly personalRevision: string;
  /** 在 Personal 事务内检查发布快照未过期，不触发网络请求。 */
  readonly assertCurrent: () => void;
}

function assertMembershipCurrent(
  membership: ProviderModelMembership | undefined,
  providerId: ProviderId,
  current: ProviderConfigLayerSnapshot,
): void {
  if (!membership) return;
  membership.assertCurrent();
  if (membership.providerId !== providerId || membership.personalRevision !== current.revision) {
    throw new Error("Provider Settings membership revision conflict");
  }
}

/** Personal 根记录只是覆盖层，不是 Provider 存在性的依据；仅继承 Provider 可按需创建覆盖。 */
function writableProviderOverlay(
  builtin: ProviderConfigLayerSnapshot,
  current: ProviderConfigLayerSnapshot,
  providerId: ProviderId,
): ProviderConfig {
  const provider = current.providers.get(providerId);
  if (provider) return provider;
  if (builtin.providers.has(providerId)) return new ProviderConfigValue({});
  // 已删除的自定义/模板实例没有继承 Provider 身份，迟到操作不能把它复活。
  throw new Error(`Provider 不存在: ${providerId}`);
}

export class ProviderConfigService implements ProviderSource<ProviderConfigSnapshot> {
  readonly #zcodeBuiltinSource: ProviderSource<ProviderConfigLayerSnapshot>;
  readonly #personalRepository: PersonalProviderConfigRepository;
  readonly #listeners = new Set<(reason: string) => void>();
  readonly #sourceDisposers: Array<() => void>;
  #disposed = false;

  constructor(dependencies: ProviderConfigServiceDependencies) {
    this.#zcodeBuiltinSource = dependencies.zcodeBuiltinSource;
    this.#personalRepository = dependencies.personalRepository;
    this.#sourceDisposers = [
      this.#zcodeBuiltinSource.onDidChange((reason) => this.#emit(`zcodeBuiltin:${reason}`)),
      this.#personalRepository.onDidChange((reason) => this.#emit(`personal:${reason}`)),
    ];
  }

  async read(): Promise<ProviderConfigSnapshot> {
    this.#assertNotDisposed();
    const [zcodeBuiltin, personal] = await Promise.all([
      this.#zcodeBuiltinSource.read(),
      this.#personalRepository.read(),
    ]);
    return Object.freeze({
      revision: JSON.stringify([zcodeBuiltin.revision, personal.revision]),
      zcodeBuiltinRevision: zcodeBuiltin.revision,
      personalRevision: personal.revision,
      zcodeBuiltinProviders: zcodeBuiltin.providers,
      zcodeBuiltinProviderTemplates: zcodeBuiltin.providerTemplates ?? ProviderTemplateMap.empty(),
      personalProviders: personal.providers,
      zcodeBuiltinModelRules: zcodeBuiltin.models,
      personalModels: personal.models,
      personalProviderOrder: personal.providerOrder ?? [],
    });
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#assertNotDisposed();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 仅供版本迁移或事实源 cutover 原子替换完整 Personal Overlay。 */
  replacePersonalConfig(config: ProviderConfigLayerUpdate): Promise<ProviderConfigLayerSnapshot> {
    this.#assertNotDisposed();
    // 全量导入/分发与字段编辑不同；新信封未带默认选择时必须清除，不能继承接收端旧值。
    return this.#personalRepository.update(() => config);
  }

  async savePersonalProviderOverlay(
    providerId: ProviderId,
    config: ProviderConfig,
    membership?: ProviderModelMembership,
    metadata?: Pick<ProviderConfigRule, "providerName" | "templateId" | "enabled">,
  ): Promise<ProviderConfigLayerSnapshot> {
    assertNonEmptyId("providerId", providerId);
    const zcodeBuiltin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => {
      assertMembershipCurrent(membership, providerId, current);
      const builtin = zcodeBuiltin.providers.get(providerId);
      const currentPersonal = current.providers.get(providerId);
      const currentEffectiveProviders = zcodeBuiltin.providers.overlay(current.providers);
      // 账号总禁用已撤销；在公共写入边界拒绝新操作，避免隐藏 UI 后仍能写出无效状态。
      if (builtin?.access?.type === "zhipu-account" && metadata?.enabled === false) {
        throw new Error(`Account Provider 不允许禁用: ${providerId}`);
      }
      if (builtin?.access?.type === "zhipu-account" && config.access !== undefined) {
        // 通用保存入口只解析 ProviderConfig，曾绕过 Personal Source Schema，
        // 允许固定 Account Provider 的 access 被写盘，直到下次读取才整份拒绝。
        throw new Error(
          `固定 Account Provider 的 Access 只能由 ZCode Built-in Config 声明: ${providerId}`,
        );
      }
      // 普通保存曾同时承担创建语义，删除后的迟到保存可以凭空复活 Overlay。
      // 创建已经是明确的领域操作，普通保存只更新现有配置，不存在即拒绝。
      if (!currentPersonal && !builtin) {
        throw new Error(`Personal Provider 尚未创建: ${providerId}`);
      }
      let normalized = config;
      if (builtin) {
        if (normalized.group != null && normalized.group !== builtin.group) {
          throw new Error(`Personal Overlay 不能改写 Built-in Provider group: ${providerId}`);
        }
        normalized = normalized.withoutGroup();
      } else {
        const group = normalized.group ?? currentPersonal?.group;
        if (group !== "standard-personal") {
          throw new Error(`Personal-only Provider 必须使用 standard-personal group: ${providerId}`);
        }
        normalized = normalized.overlay(new ProviderConfigValue({ group }));
      }
      const membershipBaseline =
        builtin ?? resolveTemplateBaseline(zcodeBuiltin, current.providers, providerId);
      const next = normalized.withModelMembershipFrom(
        // 普通 Provider 保存也保留动态成员顺序；不能改名称时又按静态名单删掉已保存的调序。
        normalizePersonalProviderMembership(
          currentPersonal,
          membershipBaseline,
          membership?.inheritedModelIds,
        ),
      );
      const currentRule = current.providers.getRule(providerId);
      const providers = current.providers.setRule({
        ...currentRule,
        providerId,
        ...(metadata?.templateId === undefined ? {} : { templateId: metadata.templateId }),
        ...(metadata?.enabled === undefined ? {} : { enabled: metadata.enabled }),
        ...(metadata?.providerName === undefined
          ? {}
          : { providerName: metadata.providerName?.trim() || null }),
        config: next,
      });
      const nextEffectiveProviders = zcodeBuiltin.providers.overlay(providers);
      // 旧版本可能已经留下重名 Provider。全量校验会让这些历史问题阻断
      // 任意无关 Provider 的保存；这里仅禁止本次名称变更新引入重名。
      assertProviderLabelMutationIsUnique(
        providerId,
        currentEffectiveProviders,
        nextEffectiveProviders,
      );
      return {
        providers,
        models: current.models,
        providerOrder: current.providerOrder,
      };
    });
  }

  async createPersonalProvider(
    input: CreatePersonalProviderInput = {},
  ): Promise<PersonalProviderCreation> {
    const zcodeBuiltin = await this.#zcodeBuiltinSource.read();
    const templateId = input.templateId?.trim();
    const template = templateId ? zcodeBuiltin.providerTemplates?.get(templateId) : undefined;
    if (templateId && !template) throw new Error(`Provider Template 不存在: ${templateId}`);
    if (input.initialConfig?.group !== undefined) {
      throw new Error("initialConfig 不能包含 group");
    }
    if (input.initialConfig?.builtinModelIds !== undefined) {
      throw new Error("initialConfig 不能包含 builtinModelIds");
    }
    let createdProviderId: ProviderId | undefined;
    await this.#updatePersonal((current) => {
      const occupied = new Set([...zcodeBuiltin.providers.keys(), ...current.providers.keys()]);
      const providerId = nextPersonalProviderId(occupied, templateId);
      createdProviderId = providerId;
      const effectiveProviders = resolvePersonalProviderBaselines(zcodeBuiltin, current.providers);
      const label = nextPersonalProviderLabel(
        input.providerName ??
          (template && templateId
            ? resolveProviderTemplateName(templateId, template, input.locale ?? "en-US")
            : "new-provider"),
        effectiveProviders,
      );
      const initial = input.initialConfig ?? new ProviderConfigValue();
      const providers = current.providers.setRule({
        providerId,
        ...(templateId ? { templateId } : {}),
        providerName: label,
        config: new ProviderConfigValue({
          group: "standard-personal",
          access: templateId ? undefined : new ApiKeyAccessConfig(),
          personalModelIds: [],
          modelOrder: [],
        }).overlay(initial),
      });
      return {
        providers,
        models: current.models,
        providerOrder: appendCurrentProviderOrder(
          zcodeBuiltin.providers,
          providers,
          current.providerOrder,
          providerId,
        ),
      };
    });
    if (!createdProviderId) throw new Error("Personal Provider 创建失败");
    return Object.freeze({ providerId: createdProviderId });
  }

  deletePersonalProvider(providerId: ProviderId): Promise<ProviderConfigLayerSnapshot> {
    assertNonEmptyId("providerId", providerId);
    return this.#updatePersonal((current) => ({
      providers: current.providers.delete(providerId),
      models: current.models.deleteExactForProvider(providerId),
      providerOrder: current.providerOrder?.filter((candidate) => candidate !== providerId),
    }));
  }

  async reorderPersonalProviders(
    providerIds: readonly ProviderId[],
  ): Promise<ProviderConfigLayerSnapshot> {
    const zcodeBuiltin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => ({
      providers: current.providers,
      models: current.models,
      providerOrder: normalizeProviderOrder(zcodeBuiltin.providers, current.providers, providerIds),
    }));
  }

  async reorderPersonalModels(
    providerId: ProviderId,
    modelIds: readonly ModelId[],
    membership?: ProviderModelMembership,
  ): Promise<ProviderConfigLayerSnapshot> {
    assertNonEmptyId("providerId", providerId);
    const zcodeBuiltin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => {
      assertMembershipCurrent(membership, providerId, current);
      const builtinProvider =
        zcodeBuiltin.providers.get(providerId) ??
        resolveTemplateBaseline(zcodeBuiltin, current.providers, providerId);
      const provider = writableProviderOverlay(zcodeBuiltin, current, providerId);
      const modelOrder = normalizeModelOrder(
        membership?.inheritedModelIds ?? builtinProvider?.builtinModelIds ?? [],
        provider.personalModelIds ?? [],
        modelIds,
      );
      return {
        providers: current.providers.set(providerId, provider.withModelOrder(modelOrder)),
        models: current.models,
        providerOrder: current.providerOrder,
      };
    });
  }

  async addPersonalModel(
    providerId: ProviderId,
    modelId: ModelId,
    config: ModelConfig,
    membership?: ProviderModelMembership,
    useRecommendedConfig?: boolean,
  ): Promise<ProviderConfigLayerSnapshot> {
    const normalizedProviderId = normalizeId("providerId", providerId);
    const normalizedModelId = normalizeId("modelId", modelId);
    const zcodeBuiltin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => {
      assertMembershipCurrent(membership, normalizedProviderId, current);
      const provider = writableProviderOverlay(zcodeBuiltin, current, normalizedProviderId);
      const builtinModelIds =
        membership?.inheritedModelIds ??
        resolveProviderBuiltinModelIds(zcodeBuiltin, current.providers, normalizedProviderId);
      if (builtinModelIds.includes(normalizedModelId)) {
        throw new Error(`Model 已存在: ${normalizedProviderId}/${normalizedModelId}`);
      }
      const currentModelIds = provider.personalModelIds ?? [];
      if (currentModelIds.includes(normalizedModelId)) {
        throw new Error(`Model 已存在: ${normalizedProviderId}/${normalizedModelId}`);
      }
      return {
        providers: current.providers.set(
          normalizedProviderId,
          provider.withPersonalModelIds([...currentModelIds, normalizedModelId]).withModelOrder(
            // 添加不能重新按成员名单排序，否则会丢掉用户已经保存的顺序。
            normalizeModelOrder(
              builtinModelIds,
              [...currentModelIds, normalizedModelId],
              provider.modelOrder ?? [],
            ),
          ),
        ),
        models: current.models.setExact(
          normalizedProviderId,
          normalizedModelId,
          config.overlay(new ModelConfig({ enabled: true })),
          useRecommendedConfig,
        ),
        providerOrder: current.providerOrder,
      };
    });
  }

  async renamePersonalModel(
    providerId: ProviderId,
    currentModelId: ModelId,
    nextModelId: ModelId,
    membership?: ProviderModelMembership,
  ): Promise<ProviderConfigLayerSnapshot> {
    const normalizedProviderId = normalizeId("providerId", providerId);
    const currentId = normalizeId("modelId", currentModelId);
    const nextId = normalizeId("modelId", nextModelId);
    if (currentId === nextId) return this.#personalRepository.read();
    const zcodeBuiltin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => {
      assertMembershipCurrent(membership, normalizedProviderId, current);
      const provider = current.providers.get(normalizedProviderId);
      const builtinModelIds =
        membership?.inheritedModelIds ??
        resolveProviderBuiltinModelIds(zcodeBuiltin, current.providers, normalizedProviderId);
      // 继承归属保护适用于 Facade 和底层直接调用，不能只在有动态上下文时检查。
      if (builtinModelIds.includes(currentId))
        throw new Error(`Built-in Model 不能重命名: ${normalizedProviderId}/${currentId}`);
      if (!provider?.personalModelIds?.includes(currentId)) {
        throw new Error(`Personal Model 不存在: ${normalizedProviderId}/${currentId}`);
      }
      if (provider.personalModelIds.includes(nextId)) {
        throw new Error(`Model 已存在: ${normalizedProviderId}/${nextId}`);
      }
      if (builtinModelIds.includes(nextId)) {
        throw new Error(`Model 已存在: ${normalizedProviderId}/${nextId}`);
      }
      const modelIds = provider.personalModelIds.map((modelId) =>
        modelId === currentId ? nextId : modelId,
      );
      const requestedOrder = (provider.modelOrder ?? []).map((modelId) =>
        modelId === currentId ? nextId : modelId,
      );
      return {
        providers: current.providers.set(
          normalizedProviderId,
          provider
            .withPersonalModelIds(modelIds)
            .withModelOrder(normalizeModelOrder(builtinModelIds, modelIds, requestedOrder)),
        ),
        models: current.models.renameExactModel(normalizedProviderId, currentId, nextId),
        providerOrder: current.providerOrder,
      };
    });
  }

  async setPersonalModelEnabled(
    providerId: ProviderId,
    modelId: ModelId,
    enabled: boolean,
    membership?: ProviderModelMembership,
  ): Promise<ProviderConfigLayerSnapshot> {
    const id = normalizeId("providerId", providerId);
    const model = normalizeId("modelId", modelId);
    if (typeof enabled !== "boolean") throw new Error("Model enabled 必须是 boolean");
    const builtin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => {
      assertMembershipCurrent(membership, id, current);
      const provider = current.providers.get(id);
      const inherited =
        membership?.inheritedModelIds ??
        resolveProviderBuiltinModelIds(builtin, current.providers, id);
      if (!inherited.includes(model) && !provider?.personalModelIds?.includes(model)) {
        throw new Error(`Model 不存在: ${id}/${model}`);
      }
      // 启停曾复用完整草稿保存，可能覆盖其他编辑或被固定配置完整性阻挡。
      // 在事务内只修改最新 enabled；不改变模式、成员和其他模型字段。
      const config = (current.models.getExact(id, model) ?? new ModelConfig({})).overlay(
        new ModelConfig({ enabled }),
      );
      return {
        providers: current.providers,
        models: current.models.setExact(id, model, config),
        providerOrder: current.providerOrder,
      };
    });
  }

  /** Model 编辑弹窗的唯一写入边界：成员、顺序、精确 Rule 在同一次 Repository update 中提交。 */
  async savePersonalModelDraft(
    providerId: ProviderId,
    originalModelId: ModelId,
    nextModelId: ModelId,
    config: ModelConfig,
    expectedPersonalRevision: string,
    useRecommendedConfig?: boolean,
    membership?: ProviderModelMembership,
  ): Promise<ProviderConfigLayerSnapshot> {
    const normalizedProviderId = normalizeId("providerId", providerId);
    const originalId = normalizeId("modelId", originalModelId);
    const nextId = normalizeId("modelId", nextModelId);
    const zcodeBuiltin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => {
      assertMembershipCurrent(membership, normalizedProviderId, current);
      if (current.revision !== expectedPersonalRevision) {
        throw new Error(
          `Personal Provider Config revision conflict: expected ${expectedPersonalRevision}, current ${current.revision}`,
        );
      }
      const recommended =
        useRecommendedConfig ??
        current.models.getExactRule(normalizedProviderId, originalId)?.type !==
          "manual-provider-model";
      const provider = current.providers.get(normalizedProviderId);
      const builtinModelIds =
        membership?.inheritedModelIds ??
        resolveProviderBuiltinModelIds(zcodeBuiltin, current.providers, normalizedProviderId);
      const builtinSet = new Set(builtinModelIds);
      if (originalId !== nextId && builtinSet.has(originalId)) {
        throw new Error(`Built-in Model 不能重命名: ${normalizedProviderId}/${originalId}`);
      }
      if (originalId !== nextId && builtinSet.has(nextId)) {
        throw new Error(`Model 已存在: ${normalizedProviderId}/${nextId}`);
      }
      const personalModelIds = provider?.personalModelIds ?? [];
      const originalExists = builtinSet.has(originalId) || personalModelIds.includes(originalId);
      if (!originalExists) {
        throw new Error(`Model 不存在: ${normalizedProviderId}/${originalId}`);
      }
      if (originalId !== nextId && (personalModelIds.includes(nextId) || builtinSet.has(nextId))) {
        throw new Error(`Model 已存在: ${normalizedProviderId}/${nextId}`);
      }

      let providers = current.providers;
      let models = current.models;
      if (originalId !== nextId) {
        if (!provider?.personalModelIds?.includes(originalId)) {
          throw new Error(`Personal Model 不存在: ${normalizedProviderId}/${originalId}`);
        }
        const modelIds = provider.personalModelIds.map((modelId) =>
          modelId === originalId ? nextId : modelId,
        );
        const requestedOrder = (provider.modelOrder ?? []).map((modelId) =>
          modelId === originalId ? nextId : modelId,
        );
        providers = providers.set(
          normalizedProviderId,
          provider
            .withPersonalModelIds(modelIds)
            .withModelOrder(normalizeModelOrder(builtinModelIds, modelIds, requestedOrder)),
        );
        models = models.renameExactModel(normalizedProviderId, originalId, nextId);
      }
      models =
        recommended && isStructurallyEmpty(config.toJSON())
          ? models.deleteExact(normalizedProviderId, nextId)
          : models.setExact(normalizedProviderId, nextId, config, recommended);
      return { providers, models, providerOrder: current.providerOrder };
    });
  }

  async deletePersonalModel(
    providerId: ProviderId,
    modelId: ModelId,
    membership?: ProviderModelMembership,
  ): Promise<ProviderConfigLayerSnapshot> {
    const normalizedProviderId = normalizeId("providerId", providerId);
    const normalizedModelId = normalizeId("modelId", modelId);
    const builtin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => {
      assertMembershipCurrent(membership, normalizedProviderId, current);
      const provider = current.providers.get(normalizedProviderId);
      const inherited =
        membership?.inheritedModelIds ??
        resolveProviderBuiltinModelIds(builtin, current.providers, normalizedProviderId);
      if (inherited.includes(normalizedModelId))
        throw new Error(`Built-in Model 不能删除: ${normalizedProviderId}/${normalizedModelId}`);
      if (!provider?.personalModelIds?.includes(normalizedModelId)) {
        throw new Error(`Personal Model 不存在: ${normalizedProviderId}/${normalizedModelId}`);
      }
      return {
        providers: current.providers.set(
          normalizedProviderId,
          provider
            .withPersonalModelIds(
              provider.personalModelIds.filter((candidate) => candidate !== normalizedModelId),
            )
            .withModelOrder(
              normalizeModelOrder(
                inherited,
                provider.personalModelIds.filter((candidate) => candidate !== normalizedModelId),
                provider.modelOrder ?? [],
              ),
            ),
        ),
        models: current.models.deleteExact(normalizedProviderId, normalizedModelId),
        providerOrder: current.providerOrder,
      };
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const dispose of this.#sourceDisposers.splice(0)) dispose();
    this.#listeners.clear();
  }

  #updatePersonal(
    transform: (current: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate,
  ): Promise<ProviderConfigLayerSnapshot> {
    this.#assertNotDisposed();
    return this.#personalRepository.update((current) => ({
      // Provider/Model/排序只修改自己的成员，不能因共用文件清掉默认选择。
      defaultModelSelection: current.defaultModelSelection,
      ...transform(current),
    }));
  }

  #emit(reason: string): void {
    if (this.#disposed) return;
    for (const listener of this.#listeners) listener(reason || "changed");
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("ProviderConfigService 已 dispose");
  }
}

function isStructurallyEmpty(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.length === 0;
  return Object.values(value).every(isStructurallyEmpty);
}

function assertProviderLabelMutationIsUnique(
  providerId: ProviderId,
  currentProviders: ProviderConfigMap,
  nextProviders: ProviderConfigMap,
): void {
  const currentLabel = currentProviders.getRule(providerId)?.providerName?.trim();
  const nextLabel = nextProviders.getRule(providerId)?.providerName?.trim();
  const currentKey = currentLabel?.toLocaleLowerCase();
  const nextKey = nextLabel?.toLocaleLowerCase();
  if (!nextKey || nextKey === currentKey) return;
  for (const candidate of nextProviders.rules()) {
    const candidateId = candidate.providerId;
    if (candidateId === providerId) continue;
    if (candidate.providerName?.trim().toLocaleLowerCase() === nextKey) {
      throw new Error(`Provider 名称已存在: ${nextLabel}`);
    }
  }
}

function normalizePersonalProviderMembership(
  personal: ProviderConfig | undefined,
  builtin: ProviderConfig | undefined,
  inheritedModelIds?: readonly ModelId[],
): ProviderConfig | undefined {
  if (!personal) return undefined;
  const builtinModelIds = uniqueInOrder(inheritedModelIds ?? builtin?.builtinModelIds ?? []);
  const builtinSet = new Set(builtinModelIds);
  const personalModelIds = uniqueInOrder(personal.personalModelIds ?? []).filter(
    (modelId) => !builtinSet.has(modelId),
  );
  let normalized = personal.withPersonalModelIds(personalModelIds);
  if (personal.modelOrder !== undefined && personal.modelOrder !== null) {
    normalized = normalized.withModelOrder(
      normalizeModelOrder(builtinModelIds, personalModelIds, personal.modelOrder),
    );
  }
  return normalized;
}

function assertNonEmptyId(label: string, value: string): void {
  if (!value.trim()) throw new Error(`${label} 不能为空`);
}

function normalizeId(label: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} 不能为空`);
  return normalized;
}

function uniqueInOrder<T extends string>(values: readonly T[]): T[] {
  const result: T[] = [];
  for (const value of values) if (!result.includes(value)) result.push(value);
  return result;
}

function normalizeProviderOrder(
  _zcodeBuiltinProviders: ProviderConfigMap,
  personalProviders: ProviderConfigMap,
  requested: readonly ProviderId[],
): ProviderId[] {
  const personalIds = personalProviders
    .entries()
    .filter(([, config]) => config.group === "standard-personal")
    .map(([providerId]) => providerId);
  return [...resolveOwnedOrder([], personalIds, requested)];
}

function appendCurrentProviderOrder(
  zcodeBuiltinProviders: ProviderConfigMap,
  personalProviders: ProviderConfigMap,
  currentOrder: readonly ProviderId[] | undefined,
  addedProviderId: ProviderId,
): ProviderId[] {
  const current = normalizeProviderOrder(
    zcodeBuiltinProviders,
    personalProviders,
    currentOrder ?? [],
  );
  return normalizeProviderOrder(zcodeBuiltinProviders, personalProviders, [
    ...current.filter((providerId) => providerId !== addedProviderId),
    addedProviderId,
  ]);
}

function normalizeModelOrder(
  builtinModelIds: readonly ModelId[],
  personalModelIds: readonly ModelId[],
  requested: readonly ModelId[],
): ModelId[] {
  return [...resolveOwnedOrder(builtinModelIds, personalModelIds, requested)];
}

function nextPersonalProviderId(
  occupied: ReadonlySet<ProviderId>,
  templateId?: ProviderTemplateId,
): ProviderId {
  const base = templateId ? normalizeProviderIdSeed(templateId) : "new-provider";
  if (!occupied.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!occupied.has(candidate)) return candidate;
  }
}

function normalizeProviderIdSeed(value: string): string {
  return (
    value
      .trim()
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "new-provider"
  );
}

function resolvePersonalProviderBaselines(
  zcodeBuiltin: ProviderConfigLayerSnapshot,
  personalProviders: ProviderConfigMap,
): ProviderConfigMap {
  const personal = personalProviders.mapConfigs((config, _id, rule) => {
    const template = rule.templateId
      ? zcodeBuiltin.providerTemplates?.get(rule.templateId)
      : undefined;
    return template ? template.config.overlay(config) : config;
  });
  return zcodeBuiltin.providers.overlay(personal);
}

function resolveTemplateBaseline(
  builtin: ProviderConfigLayerSnapshot,
  providers: ProviderConfigMap,
  providerId: ProviderId,
): ProviderConfig | undefined {
  const templateId = providers.getRule(providerId)?.templateId;
  return templateId ? builtin.providerTemplates?.get(templateId)?.config : undefined;
}

function resolveProviderBuiltinModelIds(
  builtin: ProviderConfigLayerSnapshot,
  personalProviders: ProviderConfigMap,
  providerId: ProviderId,
): readonly ModelId[] {
  return (
    builtin.providers.get(providerId)?.builtinModelIds ??
    resolveTemplateBaseline(builtin, personalProviders, providerId)?.builtinModelIds ??
    []
  );
}

function nextPersonalProviderLabel(seed: string, providers: ProviderConfigMap): string {
  const base = seed.trim() || "new-provider";
  const labels = new Set(
    providers
      .rules()
      .map((provider) => provider.providerName?.trim().toLocaleLowerCase())
      .filter((label): label is string => Boolean(label)),
  );
  if (!labels.has(base.toLocaleLowerCase())) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!labels.has(candidate.toLocaleLowerCase())) return candidate;
  }
}
