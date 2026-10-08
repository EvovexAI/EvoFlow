import type { ModelId, ProviderId } from "./config/index.js";
import type { Provider, ProviderModel } from "./resolver.js";
import type { ModelSelection } from "@zcode/shared/model-selection";

export type { ModelSelection } from "@zcode/shared/model-selection";

export type ModelSelectionOptions = NonNullable<ModelSelection["options"]>;

export type ModelSelectionValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "provider-not-found";
      readonly providerId: ProviderId;
    }
  | {
      readonly ok: false;
      readonly code: "model-not-found";
      readonly providerId: ProviderId;
      readonly modelId: ModelId;
    }
  | {
      readonly ok: false;
      readonly code: "reasoning-level-missing";
      readonly providerId: ProviderId;
      readonly modelId: ModelId;
    }
  | {
      readonly ok: false;
      readonly code: "reasoning-level-not-supported";
      readonly providerId: ProviderId;
      readonly modelId: ModelId;
      readonly reasoningLevel: string;
      readonly supportedLevels: readonly string[];
    };

export interface ProviderRegistryView {
  readonly revision: number;
  readonly providers: readonly Provider[];
}

export interface ProviderRegistryChangedEvent {
  readonly revision: number;
  readonly reason: string;
}

export class ProviderRegistry {
  #view: ProviderRegistryView;
  #providerById = new Map<ProviderId, Provider>();
  #modelByProviderId = new Map<ProviderId, Map<ModelId, ProviderModel>>();
  readonly #listeners = new Set<(event: ProviderRegistryChangedEvent) => void>();

  constructor(providers: readonly Provider[] = []) {
    this.#view = freezeView(0, providers);
    this.#rebuildIndexes();
  }

  getView(): ProviderRegistryView {
    return this.#view;
  }

  listProviders(): readonly Provider[] {
    return this.#view.providers;
  }

  getProvider(providerId: ProviderId): Provider | undefined {
    return this.#providerById.get(providerId);
  }

  getModel(providerId: ProviderId, modelId: ModelId): ProviderModel | undefined {
    return this.#modelByProviderId.get(providerId)?.get(modelId);
  }

  validateSelection(selection: ModelSelection): ModelSelectionValidation {
    if (!this.#providerById.has(selection.providerId)) {
      return {
        ok: false,
        code: "provider-not-found",
        providerId: selection.providerId,
      };
    }
    const model = this.getModel(selection.providerId, selection.modelId);
    if (!model) {
      return {
        ok: false,
        code: "model-not-found",
        providerId: selection.providerId,
        modelId: selection.modelId,
      };
    }
    return validateModelSelectionOptions(model, selection);
  }

  replace(providers: readonly Provider[], reason: string): void {
    this.#view = freezeView(this.#view.revision + 1, providers);
    this.#rebuildIndexes();
    const event = Object.freeze({ revision: this.#view.revision, reason });
    for (const listener of this.#listeners) listener(event);
  }

  onDidChange(listener: (event: ProviderRegistryChangedEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #rebuildIndexes(): void {
    const providerById = new Map<ProviderId, Provider>();
    const modelByProviderId = new Map<ProviderId, Map<ModelId, ProviderModel>>();
    for (const provider of this.#view.providers) {
      if (providerById.has(provider.providerId)) {
        throw new Error(`Registry 中存在重复 Provider: ${provider.providerId}`);
      }
      providerById.set(provider.providerId, provider);
      const models = new Map<ModelId, ProviderModel>();
      for (const model of provider.models) {
        if (models.has(model.modelId)) {
          throw new Error(`Registry 中存在重复 Model: ${provider.providerId}/${model.modelId}`);
        }
        models.set(model.modelId, model);
      }
      modelByProviderId.set(provider.providerId, models);
    }
    this.#providerById = providerById;
    this.#modelByProviderId = modelByProviderId;
  }
}

/** Registry 与默认选择初始化共用同一套通用 Model Option 校验。 */
export function validateModelSelectionOptions(
  // 只依赖发布给 Renderer 的 Option 事实，避免 UI 另写一份档位校验或构造领域类。
  model: {
    readonly config: {
      readonly optionSpecs: { readonly reasoningLevel: { readonly values: readonly string[] } };
    };
  },
  selection: ModelSelection,
): ModelSelectionValidation {
  const reasoningLevel = selection.options?.reasoningLevel;
  const reasoningSpec = model.config.optionSpecs.reasoningLevel;
  if (reasoningLevel === undefined) {
    return {
      ok: false,
      code: "reasoning-level-missing",
      providerId: selection.providerId,
      modelId: selection.modelId,
    };
  }
  if (!reasoningSpec.values.includes(reasoningLevel)) {
    return {
      ok: false,
      code: "reasoning-level-not-supported",
      providerId: selection.providerId,
      modelId: selection.modelId,
      reasoningLevel,
      supportedLevels: Object.freeze([...reasoningSpec.values]),
    };
  }
  return { ok: true };
}

function freezeView(revision: number, providers: readonly Provider[]): ProviderRegistryView {
  const frozenProviders = providers.map((provider) =>
    Object.freeze({
      providerId: provider.providerId,
      // 名称与模板已从 config 外移；冻结时漏拷贝会让所有 Selection View 丢失元数据。
      providerName: provider.providerName,
      templateId: provider.templateId,
      config: provider.config,
      models: Object.freeze(
        provider.models.map((model) =>
          Object.freeze({ modelId: model.modelId, config: model.config }),
        ),
      ),
    }),
  );
  return Object.freeze({ revision, providers: Object.freeze(frozenProviders) });
}
