/* oxlint-disable eslint(max-lines) -- Provider 与 Access Config 的 Overlay/序列化必须集中维护同一联合类型；待契约稳定后再按配置族拆文件。 */
import { ConfigOverlay, type ConfigValidationIssue } from "../config-overlay.js";
import type { z } from "zod";
import {
  completeApiKeyAccessDataSchema,
  completeZhipuAccountAccessDataSchema,
  completeProviderApiDataSchema,
  completeProviderConfigDataSchema,
  type providerApiTypeDataSchema,
  type providerGroupDataSchema,
  type zhipuAccountModeDataSchema,
  type providerVisibilityDataSchema,
  type providerLogoDataSchema,
  type apiKeyAccessDataSchema,
  type zhipuAccountAccessDataSchema,
  type providerAccessDataSchema,
  type providerApiDataSchema,
  type providerConfigDataSchema,
  type providerTemplateNameMapDataSchema,
  type providerTemplateDataSchema,
} from "./provider-data-schema.js";
import { validateConfigSchema } from "./schema-validation.js";
import type { ModelId, ProviderId, ProviderTemplateId } from "./ids.js";
import type { ProviderConfigRuleData } from "./rule-data-schema.js";

export type ProviderApiType = z.infer<typeof providerApiTypeDataSchema>;
export type ProviderGroup = z.infer<typeof providerGroupDataSchema>;
export type ZhipuAccountMode = z.infer<typeof zhipuAccountModeDataSchema>;

export type ApiKeyAccessConfigInput = Omit<ApiKeyAccessConfigObject, "type"> & {
  readonly type?: ApiKeyAccessConfigObject["type"];
};

export type ApiKeyAccessConfigObject = Readonly<z.infer<typeof apiKeyAccessDataSchema>>;

export class ApiKeyAccessConfig extends ConfigOverlay<ApiKeyAccessConfig> {
  readonly type: ApiKeyAccessConfigObject["type"];
  readonly apiKey?: ApiKeyAccessConfigInput["apiKey"];
  readonly apiKeyManagementUrl?: ApiKeyAccessConfigInput["apiKeyManagementUrl"];

  constructor(input: ApiKeyAccessConfigInput = {}) {
    super();
    this.type = input.type ?? "api-key";
    this.apiKey = input.apiKey;
    this.apiKeyManagementUrl = input.apiKeyManagementUrl;
    Object.freeze(this);
  }

  overlay(next: ApiKeyAccessConfig): ApiKeyAccessConfig {
    return new ApiKeyAccessConfig({
      type: next.type,
      apiKey: this.overlayValue(this.apiKey, next.apiKey),
      apiKeyManagementUrl: this.overlayValue(this.apiKeyManagementUrl, next.apiKeyManagementUrl),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return validateConfigSchema(completeApiKeyAccessDataSchema, this.toJSON(), path);
  }

  toJSON(): ApiKeyAccessConfigObject {
    return {
      type: this.type,
      ...objectWithoutUndefined({
        apiKey: this.apiKey,
        apiKeyManagementUrl: this.apiKeyManagementUrl,
      }),
    };
  }
}

export type ZhipuAccountAccessConfigInput = Omit<ZhipuAccountAccessConfigObject, "type">;

export type ZhipuAccountAccessConfigObject = Readonly<z.infer<typeof zhipuAccountAccessDataSchema>>;

export class ZhipuAccountAccessConfig extends ConfigOverlay<ZhipuAccountAccessConfig> {
  readonly type = "zhipu-account" as const;
  readonly accountType?: ZhipuAccountAccessConfigInput["accountType"];
  readonly mode?: ZhipuAccountAccessConfigInput["mode"];
  readonly entitled?: ZhipuAccountAccessConfigInput["entitled"];

  constructor(input: ZhipuAccountAccessConfigInput = {}) {
    super();
    this.accountType = input.accountType;
    this.mode = input.mode;
    this.entitled = input.entitled;
    Object.freeze(this);
  }

  overlay(next: ZhipuAccountAccessConfig): ZhipuAccountAccessConfig {
    return new ZhipuAccountAccessConfig({
      accountType: this.overlayValue(this.accountType, next.accountType),
      mode: this.overlayValue(this.mode, next.mode),
      entitled: this.overlayValue(this.entitled, next.entitled),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return validateConfigSchema(completeZhipuAccountAccessDataSchema, this.toJSON(), path);
  }

  toJSON(): ZhipuAccountAccessConfigObject {
    return {
      type: this.type,
      ...objectWithoutUndefined({
        accountType: this.accountType,
        mode: this.mode,
        entitled: this.entitled,
      }),
    };
  }
}

export type ProviderAccessConfig = ApiKeyAccessConfig | ZhipuAccountAccessConfig;

export type ProviderAccessConfigObject = Readonly<z.infer<typeof providerAccessDataSchema>>;

/** 手动 Key 的编辑/保存共用能力判断，不把套餐 Key 误写成普通 API Key。 */
export function isApiKeyAccess<T extends { readonly type: string }>(
  access: T | null | undefined,
): access is Extract<T, { readonly type: ApiKeyAccessConfigObject["type"] }> {
  return access?.type === "api-key" || access?.type === "zhipu-coding-plan-api-key";
}

export type ProviderVisibility = z.infer<typeof providerVisibilityDataSchema>;

export type ProviderLogoRef = Readonly<z.infer<typeof providerLogoDataSchema>>;

export type ProviderApiConfigInput = Readonly<z.infer<typeof providerApiDataSchema>>;

export class ProviderApiConfig extends ConfigOverlay<ProviderApiConfig> {
  readonly type?: ProviderApiConfigInput["type"];
  readonly baseUrl?: ProviderApiConfigInput["baseUrl"];
  readonly headers?: ProviderApiConfigInput["headers"];

  constructor(input: ProviderApiConfigInput = {}) {
    super();
    this.type = input.type;
    this.baseUrl = input.baseUrl;
    this.headers = input.headers ? Object.freeze({ ...input.headers }) : input.headers;
    Object.freeze(this);
  }

  overlay(next: ProviderApiConfig): ProviderApiConfig {
    return new ProviderApiConfig({
      type: this.overlayValue(this.type, next.type),
      baseUrl: this.overlayValue(this.baseUrl, next.baseUrl),
      headers: this.overlayValue(this.headers, next.headers),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    // 旧检查只判断 type 非空，不可信 JS 值可绕过枚举；准入与保存共用 schema。
    return validateConfigSchema(completeProviderApiDataSchema, this.toJSON(), path);
  }

  toJSON(): ProviderApiConfigInput {
    return objectWithoutUndefined({
      type: this.type,
      baseUrl: this.baseUrl,
      headers: this.headers,
    });
  }
}

export type ProviderConfigInput = Omit<ProviderConfigObject, "access" | "api"> & {
  readonly access?: ProviderAccessConfig | null;
  readonly api?: ProviderApiConfig | null;
};

export type ProviderConfigObject = Readonly<z.infer<typeof providerConfigDataSchema>>;

export class ProviderConfig extends ConfigOverlay<ProviderConfig> {
  readonly group?: ProviderConfigObject["group"];
  readonly logo?: ProviderConfigObject["logo"];
  readonly access?: ProviderAccessConfig | null;
  readonly api?: ProviderApiConfig | null;
  readonly builtinModelIds?: ProviderConfigObject["builtinModelIds"];
  readonly personalModelIds?: ProviderConfigObject["personalModelIds"];
  readonly modelOrder?: ProviderConfigObject["modelOrder"];
  readonly visibility?: ProviderConfigObject["visibility"];

  constructor(input: ProviderConfigInput = {}) {
    super();
    this.group = input.group;
    this.logo = freezeProviderLogo(input.logo);
    this.access = input.access;
    this.api = input.api;
    this.builtinModelIds = freezeModelIds(input.builtinModelIds);
    this.personalModelIds = freezeModelIds(input.personalModelIds);
    this.modelOrder = freezeModelIds(input.modelOrder);
    this.visibility = input.visibility;
    Object.freeze(this);
  }

  overlay(next: ProviderConfig): ProviderConfig {
    return new ProviderConfig({
      group: this.overlayValue(this.group, next.group),
      logo: this.overlayValue(this.logo, next.logo),
      access: overlayProviderAccess(this.access, next.access),
      api: this.overlayConfig(this.api, next.api),
      builtinModelIds: this.overlayValue(this.builtinModelIds, next.builtinModelIds),
      personalModelIds: this.overlayValue(this.personalModelIds, next.personalModelIds),
      modelOrder: this.overlayValue(this.modelOrder, next.modelOrder),
      visibility: this.overlayValue(this.visibility, next.visibility),
    });
  }

  withBuiltinModelIds(builtinModelIds: readonly ModelId[]): ProviderConfig {
    return this.overlay(new ProviderConfig({ builtinModelIds }));
  }

  withPersonalModelIds(modelIds: readonly ModelId[]): ProviderConfig {
    return this.overlay(new ProviderConfig({ personalModelIds: modelIds }));
  }

  withModelOrder(modelOrder: readonly ModelId[]): ProviderConfig {
    return this.overlay(new ProviderConfig({ modelOrder }));
  }

  withoutGroup(): ProviderConfig {
    return new ProviderConfig({
      logo: this.logo,
      access: this.access,
      api: this.api,
      builtinModelIds: this.builtinModelIds,
      personalModelIds: this.personalModelIds,
      modelOrder: this.modelOrder,
      visibility: this.visibility,
    });
  }

  /** 普通 Provider 字段保存不拥有成员变更；成员只能由明确的领域操作更新。 */
  withModelMembershipFrom(source: ProviderConfig | undefined): ProviderConfig {
    return new ProviderConfig({
      group: this.group,
      logo: this.logo,
      access: this.access,
      api: this.api,
      builtinModelIds: source?.builtinModelIds,
      personalModelIds: source?.personalModelIds,
      modelOrder: source?.modelOrder,
      visibility: this.visibility,
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    // 不再用字段存在性代替值域验证，也不把展示/成员等可选字段变成执行必填项。
    return validateConfigSchema(completeProviderConfigDataSchema, this.toJSON(), path);
  }

  toJSON(): ProviderConfigObject {
    return objectWithoutUndefined({
      group: this.group,
      logo: this.logo,
      access: this.access?.toJSON() ?? this.access,
      api: this.api?.toJSON() ?? this.api,
      builtinModelIds: this.builtinModelIds,
      personalModelIds: this.personalModelIds,
      modelOrder: this.modelOrder,
      visibility: this.visibility,
    });
  }
}

export type ProviderTemplateNameMap = Readonly<z.infer<typeof providerTemplateNameMapDataSchema>>;
export type ProviderTemplateLocale = keyof ProviderTemplateNameMap;

export type ProviderTemplateInput = Omit<ProviderTemplateObject, "config"> & {
  readonly config: ProviderConfig;
};

export type ProviderTemplateObject = Readonly<z.infer<typeof providerTemplateDataSchema>>;

/** Template 是元数据与 Provider Overlay 的领域壳，本身不是 Provider。 */
export class ProviderTemplate {
  readonly templateId: ProviderTemplateId;
  readonly templateNameMap: ProviderTemplateNameMap;
  readonly config: ProviderConfig;

  constructor(input: ProviderTemplateInput) {
    this.templateId = input.templateId;
    this.templateNameMap = Object.freeze({ ...input.templateNameMap });
    this.config = input.config;
    Object.freeze(this);
  }

  toJSON(): ProviderTemplateObject {
    return {
      templateId: this.templateId,
      templateNameMap: this.templateNameMap,
      config: this.config.toJSON(),
    };
  }
}

export function resolveProviderTemplateName(
  templateId: ProviderTemplateId,
  template: Pick<ProviderTemplate, "templateNameMap">,
  locale: ProviderTemplateLocale,
): string {
  return (
    template.templateNameMap[locale]?.trim() ||
    template.templateNameMap["en-US"]?.trim() ||
    templateId
  );
}

/** Built-in Template 与真实 Provider 使用不同身份空间；Template 永不进入 Registry。 */
export class ProviderTemplateMap extends ConfigOverlay<ProviderTemplateMap> {
  readonly #values: ReadonlyMap<ProviderTemplateId, ProviderTemplate>;

  constructor(entries: Iterable<readonly [ProviderTemplateId, ProviderTemplate]> = []) {
    super();
    const values = new Map<ProviderTemplateId, ProviderTemplate>();
    for (const [templateId, template] of entries) {
      if (values.has(templateId)) throw new Error(`重复 Provider Template key: ${templateId}`);
      values.set(templateId, template);
    }
    this.#values = values;
    Object.freeze(this);
  }

  static empty(): ProviderTemplateMap {
    return new ProviderTemplateMap();
  }

  overlay(next: ProviderTemplateMap): ProviderTemplateMap {
    const result = new Map(this.#values);
    for (const [templateId, template] of next.#values) result.set(templateId, template);
    return new ProviderTemplateMap(result);
  }

  validateComplete(): readonly ConfigValidationIssue[] {
    return [];
  }

  get(templateId: ProviderTemplateId): ProviderTemplate | undefined {
    return this.#values.get(templateId);
  }

  has(templateId: ProviderTemplateId): boolean {
    return this.#values.has(templateId);
  }

  keys(): ProviderTemplateId[] {
    return [...this.#values.keys()];
  }

  entries(): Array<readonly [ProviderTemplateId, ProviderTemplate]> {
    return [...this.#values.entries()];
  }

  toJSON(): ProviderTemplateObject[] {
    return this.entries().map(([, template]) => template.toJSON());
  }
}

function freezeProviderLogo(
  logo: ProviderLogoRef | null | undefined,
): ProviderLogoRef | null | undefined {
  return logo ? Object.freeze({ ...logo }) : logo;
}

function freezeModelIds(
  modelIds: readonly ModelId[] | null | undefined,
): readonly ModelId[] | null | undefined {
  if (!modelIds) return modelIds;
  return Object.freeze(
    modelIds.map((modelId) => {
      const normalized = modelId.trim();
      if (!normalized) throw new Error("Model ID 不能为空");
      return normalized;
    }),
  );
}

export type ProviderConfigRule = Readonly<
  Omit<ProviderConfigRuleData, "config"> & { config: ProviderConfig }
>;

/** 索引只保存完整规则；get/entries 是内容投影，改成员时不能丢掉外层身份和名称。 */
export class ProviderConfigMap extends ConfigOverlay<ProviderConfigMap> {
  readonly #values: ReadonlyMap<ProviderId, ProviderConfigRule>;

  constructor(entries: Iterable<ProviderConfigRule | readonly [ProviderId, ProviderConfig]> = []) {
    super();
    const values = new Map<ProviderId, ProviderConfigRule>();
    for (const entry of entries) {
      const rule = "providerId" in entry ? entry : { providerId: entry[0], config: entry[1] };
      if (values.has(rule.providerId)) throw new Error(`重复 Provider key: ${rule.providerId}`);
      values.set(rule.providerId, Object.freeze({ ...rule }));
    }
    this.#values = values;
    Object.freeze(this);
  }

  static empty(): ProviderConfigMap {
    return new ProviderConfigMap();
  }

  overlay(next: ProviderConfigMap): ProviderConfigMap {
    const result = new Map(this.#values);
    for (const [providerId, rule] of next.#values) {
      const current = result.get(providerId);
      result.set(
        providerId,
        current
          ? {
              providerId,
              templateId: this.overlayValue(current.templateId, rule.templateId),
              providerName: this.overlayValue(current.providerName, rule.providerName),
              enabled: this.overlayValue(current.enabled, rule.enabled),
              config: current.config.overlay(rule.config),
            }
          : rule,
      );
    }
    return new ProviderConfigMap(result.values());
  }

  mapConfigs(
    transform: (
      config: ProviderConfig,
      providerId: ProviderId,
      rule: ProviderConfigRule,
    ) => ProviderConfig,
  ): ProviderConfigMap {
    return new ProviderConfigMap(
      this.rules().map((rule) => ({
        ...rule,
        config: transform(rule.config, rule.providerId, rule),
      })),
    );
  }

  reorder(providerIds: readonly ProviderId[]): ProviderConfigMap {
    const result = new Map<ProviderId, ProviderConfigRule>();
    for (const providerId of providerIds) {
      const rule = this.#values.get(providerId);
      if (rule && !result.has(providerId)) result.set(providerId, rule);
    }
    for (const [providerId, rule] of this.#values) {
      if (!result.has(providerId)) result.set(providerId, rule);
    }
    return new ProviderConfigMap(result.values());
  }

  set(providerId: ProviderId, config: ProviderConfig): ProviderConfigMap {
    return this.setRule({ ...this.#values.get(providerId), providerId, config });
  }

  setRule(rule: ProviderConfigRule): ProviderConfigMap {
    const result = new Map(this.#values);
    result.set(rule.providerId, rule);
    return new ProviderConfigMap(result.values());
  }

  delete(providerId: ProviderId): ProviderConfigMap {
    return new ProviderConfigMap(this.rules().filter((rule) => rule.providerId !== providerId));
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return this.entries().flatMap(([providerId, config]) =>
      config.validateComplete([...path, providerId]),
    );
  }

  get(providerId: ProviderId): ProviderConfig | undefined {
    return this.#values.get(providerId)?.config;
  }
  getRule(providerId: ProviderId): ProviderConfigRule | undefined {
    return this.#values.get(providerId);
  }
  has(providerId: ProviderId): boolean {
    return this.#values.has(providerId);
  }
  keys(): ProviderId[] {
    return [...this.#values.keys()];
  }
  rules(): ProviderConfigRule[] {
    return [...this.#values.values()];
  }
  entries(): Array<readonly [ProviderId, ProviderConfig]> {
    return this.rules().map((rule) => [rule.providerId, rule.config]);
  }

  toJSON(): ProviderConfigRuleData[] {
    return this.rules().map(({ config, ...rule }) =>
      objectWithoutUndefined({ ...rule, config: config.toJSON() }),
    );
  }
}

function overlayProviderAccess(
  current: ProviderAccessConfig | null | undefined,
  next: ProviderAccessConfig | null | undefined,
): ProviderAccessConfig | null | undefined {
  if (next === undefined) return current;
  if (next === null || current === undefined || current === null) return next;
  if (current.type !== next.type) return next;
  switch (current.type) {
    case "api-key":
    case "zhipu-coding-plan-api-key":
      return current.overlay(next as ApiKeyAccessConfig);
    case "zhipu-account":
      return current.overlay(next as ZhipuAccountAccessConfig);
  }
}

function objectWithoutUndefined<T extends object>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}
