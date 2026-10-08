/* eslint-disable max-lines -- 已发布旧 Provider store 只在单向 importer 边界建模。 */
import { z } from "zod";

export interface ClaudeModelMapping {
  haiku: string;
  sonnet: string;
  opus: string;
  reasoning: string;
}

/**
 * 各 ZCode Agent Provider 的模型槽位映射（按 provider 区分）。
 * 目前只实现 claude，后续扩展其他 provider 时在此加字段。
 */
export interface ProviderModelMappings {
  [provider: string]: unknown;
  /** @deprecated Claude 槽位不再写入 v2 provider store，仅用于读取旧配置后迁移清理。 */
  claude?: ClaudeModelMapping;
}

export interface ModelProviderEndpoints {
  /** @deprecated 仅用于读取旧 provider 配置；新 store 使用 baseURL + paths。 */
  anthropic?: string;
  /** @deprecated 仅用于读取旧 provider 配置；新 store 使用 baseURL + paths。 */
  openai?: string;
  /** @deprecated Gemini custom provider 已统一走 endpoints.openai + compat，仅保留旧数据兼容读取。 */
  gemini?: string;
  /** v2 catalog endpoint base URL；旧字段保留给迁移期 UI/连通性代码读取。 */
  baseURL?: string;
  /** v2 catalog endpoint paths，key 使用公开 runtime kind。 */
  paths?: Partial<Record<ModelProviderKind, string>>;
}

export type ModelProviderSupportedFormat = "anthropic" | "openai" | "responses" | "gemini";

export type ModelProviderApiFormat =
  | "anthropic-messages"
  | "openai-chat-completions"
  | "openai-responses";

export type ModelProviderCatalogSourceId = "china-llm-zcode-dev";

export type ModelProviderKind = "anthropic" | "openai" | "openai-compatible";

export type ModelProviderModality = "text" | "image" | "video" | "audio" | "pdf";

export interface ProviderOptionsPatch {
  set?: Array<{ path: string[]; value: unknown }>;
  unset?: Array<{ path: string[] }>;
}

export interface ModelProviderReasoningSpec {
  defaultLevel?: string;
  levels: Record<string, Partial<Record<ModelProviderKind, ProviderOptionsPatch>>>;
}

export function stripModelProviderReasoningPatches(
  reasoning: ModelProviderReasoningSpec,
): ModelProviderReasoningSpec {
  return {
    ...(reasoning.defaultLevel ? { defaultLevel: reasoning.defaultLevel } : {}),
    levels: Object.fromEntries(Object.keys(reasoning.levels).map((level) => [level, {}])),
  };
}

export interface ModelProviderCatalogModel {
  id: string;
  name?: string;
  kinds: ModelProviderKind[];
  defaultKind?: ModelProviderKind;
  modelIdByKind?: Partial<Record<ModelProviderKind, string>>;
  modalities: {
    input: ModelProviderModality[];
    output: ModelProviderModality[];
  };
  contextWindow: number;
  maxOutputTokens?: number;
  reasoning?: ModelProviderReasoningSpec;
  priority?: number;
}

export interface ModelProviderModelConfig extends ModelProviderCatalogModel {
  disabledReason?: string;
  supportsTools?: boolean;
  supportsStructuredOutput?: boolean;
  modified?: boolean;
  deleted?: boolean;
}

export type ModelProviderModelEntry = string | ModelProviderModelConfig;

export type ModelProviderSource = "builtin" | "models-dev" | "custom" | "workspace";

export type ModelProviderSystemDisabledReason =
  | "coding_plan_not_authenticated"
  | "coding_plan_not_connected"
  | "coding_plan_auth_failed"
  | "coding_plan_not_entitled"
  | "oauth_provider_inactive";

export interface ModelProviderConfig {
  id: string;
  name: string;
  /** 缺省等同启用；false 时仅从聊天框模型列表隐藏，不删除供应商配置。 */
  enabled?: boolean;
  /**
   * 系统自动关闭 provider 的原因。enabled=false 且该字段为空时表示用户手动关闭，
   * 后续权益校验成功也不能自动打开。
   */
  systemDisabledReason?: ModelProviderSystemDisabledReason;
  endpoints: ModelProviderEndpoints;
  apiFormat?: ModelProviderApiFormat;
  source?: ModelProviderSource;
  catalogSourceId?: ModelProviderCatalogSourceId;
  catalogProviderId?: string;
  modelsDevProviderId?: string;
  apiKeyRequired?: boolean;
  headers?: Record<string, string>;
  logoUrl?: string;
  apiKey: string;
  apiKeyUrl?: string;
  models: ModelProviderModelEntry[];
  defaultKind?: ModelProviderKind;
  /** @deprecated 旧模型显示名 map 只用于 v1 自动迁移。 */
  modelDisplayNames?: Record<string, string>;
  /** @deprecated 旧模型格式 map 只用于 v1 自动迁移。 */
  modelSupportedFormats?: Record<string, ModelProviderSupportedFormat[]>;
  providerMappings?: ProviderModelMappings;
  createdAt: number;
  updatedAt: number;
}

const claudeModelMappingSchema = z.object({
  haiku: z.string(),
  sonnet: z.string(),
  opus: z.string(),
  reasoning: z.string(),
});

const providerModelMappingsSchema = z
  .object({
    claude: claudeModelMappingSchema.optional(),
  })
  .catchall(z.unknown());

const modelSupportedFormatSchema = z.enum(["anthropic", "openai", "responses", "gemini"]);

export const modelProviderApiFormatSchema = z.enum([
  "anthropic-messages",
  "openai-chat-completions",
  "openai-responses",
]);

export const modelProviderKindSchema = z.enum(["anthropic", "openai", "openai-compatible"]);

export const modelProviderCatalogSourceIdSchema = z.enum(["china-llm-zcode-dev"]);

const modelProviderModalitySchema = z.enum(["text", "image", "video", "audio", "pdf"]);

const providerOptionsPatchOperationSchema = z.object({
  path: z.array(z.string().min(1)).min(1),
});

const providerOptionsPatchSchema = z.object({
  set: z.array(providerOptionsPatchOperationSchema.extend({ value: z.unknown() })).optional(),
  unset: z.array(providerOptionsPatchOperationSchema).optional(),
});

export const modelProviderReasoningSpecSchema = z.object({
  defaultLevel: z.string().min(1).optional(),
  levels: z.record(
    z.string().min(1),
    z.partialRecord(modelProviderKindSchema, providerOptionsPatchSchema),
  ),
});

const modelProviderEndpointPathsSchema = z.partialRecord(modelProviderKindSchema, z.string());

const modelProviderCatalogEndpointSchema = z.object({
  baseURL: z.string(),
  paths: modelProviderEndpointPathsSchema,
});

const modelProviderCatalogModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  kinds: z.array(modelProviderKindSchema),
  defaultKind: modelProviderKindSchema.optional(),
  modelIdByKind: z.partialRecord(modelProviderKindSchema, z.string().min(1)).optional(),
  modalities: z.object({
    input: z.array(modelProviderModalitySchema),
    output: z.array(modelProviderModalitySchema),
  }),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().optional(),
  reasoning: modelProviderReasoningSpecSchema.optional(),
  priority: z.number().finite().optional(),
});

const modelProviderCatalogProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  endpoints: modelProviderCatalogEndpointSchema,
  defaultKind: modelProviderKindSchema.optional(),
  models: z.array(modelProviderCatalogModelSchema),
});

export const modelProviderCatalogFileSchema = z.object({
  schemaVersion: z.literal("zcode.model-providers.v1"),
  providers: z.array(modelProviderCatalogProviderSchema),
});

const modelProviderModelConfigSchema = modelProviderCatalogModelSchema.extend({
  disabledReason: z.string().optional(),
  supportsTools: z.boolean().optional(),
  supportsStructuredOutput: z.boolean().optional(),
  modified: z.boolean().optional(),
  deleted: z.boolean().optional(),
});

export const modelProviderSourceSchema = z.enum(["builtin", "models-dev", "custom", "workspace"]);

export const modelProviderSystemDisabledReasonSchema = z.enum([
  "coding_plan_not_authenticated",
  "coding_plan_not_connected",
  "coding_plan_auth_failed",
  "coding_plan_not_entitled",
  "oauth_provider_inactive",
]);

const legacyModelProviderEndpointsSchema = z.object({
  anthropic: z.string().default(""),
  openai: z.string().default(""),
  gemini: z.string().default(""),
});

export const modelProviderEndpointsSchema = legacyModelProviderEndpointsSchema.extend({
  anthropic: z.string().optional(),
  openai: z.string().optional(),
  gemini: z.string().optional(),
  baseURL: z.string().optional(),
  paths: modelProviderEndpointPathsSchema.optional(),
});

const legacyModelProviderConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean().optional(),
  systemDisabledReason: modelProviderSystemDisabledReasonSchema.optional(),
  endpoints: legacyModelProviderEndpointsSchema,
  apiFormat: modelProviderApiFormatSchema.optional(),
  source: modelProviderSourceSchema.optional(),
  modelsDevProviderId: z.string().optional(),
  apiKeyRequired: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  logoUrl: z.string().optional(),
  apiKey: z.string(),
  apiKeyUrl: z.string().optional(),
  models: z.array(z.string()).default([]),
  modelDisplayNames: z.record(z.string(), z.string()).optional(),
  modelSupportedFormats: z.record(z.string(), z.array(modelSupportedFormatSchema)).optional(),
  providerMappings: providerModelMappingsSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const legacyModelProviderListSchema = z.array(legacyModelProviderConfigSchema);

const modelProviderConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean().optional(),
  systemDisabledReason: modelProviderSystemDisabledReasonSchema.optional(),
  endpoints: modelProviderEndpointsSchema,
  apiFormat: modelProviderApiFormatSchema.optional(),
  source: modelProviderSourceSchema.optional(),
  catalogSourceId: modelProviderCatalogSourceIdSchema.optional(),
  catalogProviderId: z.string().optional(),
  modelsDevProviderId: z.string().optional(),
  apiKeyRequired: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  logoUrl: z.string().optional(),
  apiKey: z.string(),
  apiKeyUrl: z.string().optional(),
  defaultKind: modelProviderKindSchema.optional(),
  models: z.array(modelProviderModelConfigSchema).default([]),
  modelDisplayNames: z.record(z.string(), z.string()).optional(),
  modelSupportedFormats: z.record(z.string(), z.array(modelSupportedFormatSchema)).optional(),
  providerMappings: providerModelMappingsSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const modelProviderListSchema = z.array(modelProviderConfigSchema);

export const modelProviderStoreFileSchema = z.object({
  schemaVersion: z.literal("zcode.model-providers.v2"),
  providers: modelProviderListSchema,
});

export const modelProviderDisplayOrderStateSchema = z.object({
  providerIds: z.array(z.string().min(1)),
  updatedAt: z.number().int().nonnegative(),
});

export function stripLegacyClaudeProviderMappings(
  providerMappings: ProviderModelMappings | undefined,
): ProviderModelMappings | undefined {
  if (!providerMappings) {
    return undefined;
  }
  const { claude: _legacyClaudeMapping, ...remainingMappings } = providerMappings;
  // v2 store 不再持久化旧 Claude 槽位，但 providerMappings 本身要保留给
  // 后续 ZCode CLI 等 provider 的槽位配置；这里只删历史子字段，未知后续 key 原样保留。
  return remainingMappings;
}

export const MODEL_PROVIDER_NEW_MODEL_CONTEXT_WINDOW = 200_000;
// 老配置和缺 metadata 的模型没有可靠 catalog 事实时，应和设置页新增模型
// 使用同一个保守默认值，避免 agent registry 与 UI 新增模型出现 128k/200k 分歧。
const LEGACY_MODEL_CONTEXT_WINDOW = MODEL_PROVIDER_NEW_MODEL_CONTEXT_WINDOW;

export function resolveModelProviderContextWindow(contextWindow: number | undefined): number {
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow)) {
    return LEGACY_MODEL_CONTEXT_WINDOW;
  }

  const normalized = Math.floor(contextWindow);
  return normalized > 0 ? normalized : LEGACY_MODEL_CONTEXT_WINDOW;
}

export function isModelProviderModelConfig(
  model: ModelProviderModelEntry,
): model is ModelProviderModelConfig {
  return typeof model === "object" && model !== null;
}

export function getModelProviderModelIds(
  provider: Pick<ModelProviderConfig, "models"> | null | undefined,
): string[] {
  if (!provider) {
    return [];
  }

  return (
    provider.models
      // 模型删除现在以 tombstone 保留在 provider.models 中用于持久化和远端合并；
      // 所有可选/下发模型目录都必须把 tombstone 当成不存在，避免聊天框和 CLI 继续看到已删模型。
      .filter((model) => !isModelProviderModelConfig(model) || model.deleted !== true)
      .map((model) => (isModelProviderModelConfig(model) ? model.id.trim() : model.trim()))
      .filter((modelId) => modelId.length > 0)
  );
}

function uniqueModelProviderKinds(kinds: readonly ModelProviderKind[]): ModelProviderKind[] {
  return [...new Set(kinds)];
}

export function mapModelProviderSupportedFormatToKind(
  format: ModelProviderSupportedFormat,
): ModelProviderKind | null {
  switch (format) {
    case "anthropic":
      return "anthropic";
    case "openai":
      return "openai-compatible";
    case "responses":
      return "openai";
    case "gemini":
      return null;
  }
}

export function createModelProviderModelConfig(params: {
  id: string;
  name?: string;
  kinds?: readonly ModelProviderKind[];
  defaultKind?: ModelProviderKind;
  contextWindow?: number;
  maxOutputTokens?: number;
  modalities?: {
    input?: readonly ModelProviderModality[];
    output?: readonly ModelProviderModality[];
  };
  reasoning?: ModelProviderReasoningSpec;
  priority?: number;
  disabledReason?: string;
  supportsTools?: boolean;
  supportsStructuredOutput?: boolean;
  modified?: boolean;
  deleted?: boolean;
}): ModelProviderModelConfig {
  const inputModalities: ModelProviderModality[] = [
    ...new Set(params.modalities?.input ?? (["text"] satisfies ModelProviderModality[])),
  ];
  const outputModalities: ModelProviderModality[] = [
    ...new Set(params.modalities?.output ?? (["text"] satisfies ModelProviderModality[])),
  ];
  return {
    id: params.id.trim(),
    name: params.name?.trim() || undefined,
    kinds: uniqueModelProviderKinds([...(params.kinds ?? [])]),
    ...(params.defaultKind ? { defaultKind: params.defaultKind } : {}),
    modalities: {
      input: inputModalities,
      output: outputModalities,
    },
    contextWindow: resolveModelProviderContextWindow(params.contextWindow),
    ...(params.maxOutputTokens ? { maxOutputTokens: params.maxOutputTokens } : {}),
    ...(params.reasoning ? { reasoning: params.reasoning } : {}),
    ...(params.priority !== undefined && Number.isFinite(params.priority)
      ? { priority: params.priority }
      : {}),
    ...(params.disabledReason ? { disabledReason: params.disabledReason } : {}),
    ...(params.supportsTools !== undefined ? { supportsTools: params.supportsTools } : {}),
    ...(params.supportsStructuredOutput !== undefined
      ? { supportsStructuredOutput: params.supportsStructuredOutput }
      : {}),
    ...(params.modified !== undefined ? { modified: params.modified } : {}),
    ...(params.deleted !== undefined ? { deleted: params.deleted } : {}),
  };
}

export function resolveModelProviderDefaultKind(
  provider: Pick<ModelProviderConfig, "apiFormat" | "defaultKind" | "endpoints">,
): ModelProviderKind {
  if (provider.defaultKind) {
    return provider.defaultKind;
  }

  const paths = provider.endpoints.paths;
  if (paths?.["openai-compatible"] !== undefined) {
    return "openai-compatible";
  }
  if (paths?.openai !== undefined) {
    return "openai";
  }
  if (paths?.anthropic !== undefined) {
    return "anthropic";
  }

  const apiFormat = resolveModelProviderApiFormat(provider);
  switch (apiFormat) {
    case "anthropic-messages":
      return "anthropic";
    case "openai-responses":
      return "openai";
    case "openai-chat-completions":
      return "openai-compatible";
  }
}

export function resolveModelProviderKindApiFormat(kind: ModelProviderKind): ModelProviderApiFormat {
  switch (kind) {
    case "anthropic":
      return "anthropic-messages";
    case "openai":
      return "openai-responses";
    case "openai-compatible":
      return "openai-chat-completions";
  }
}

function mapModelProviderApiFormatToKind(apiFormat: ModelProviderApiFormat): ModelProviderKind {
  switch (apiFormat) {
    case "anthropic-messages":
      return "anthropic";
    case "openai-responses":
      return "openai";
    case "openai-chat-completions":
      return "openai-compatible";
  }
}

export function getDefaultModelProviderEndpointPathForKind(kind: ModelProviderKind): string {
  switch (kind) {
    case "anthropic":
      return "/v1/messages";
    case "openai":
      return "/responses";
    case "openai-compatible":
      return "/chat/completions";
  }
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function collapseDuplicatedAbsoluteRuntimeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) {
    return "";
  }

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return normalized;
    }
    const marker = `${parsed.protocol}//${parsed.host}`;
    const secondMarkerIndex = normalized.indexOf(marker, marker.length);
    if (secondMarkerIndex < 0) {
      return normalized;
    }

    const firstUrl = normalized.slice(0, secondMarkerIndex).replace(/\/+$/, "");
    const secondUrl = normalized.slice(secondMarkerIndex).replace(/\/+$/, "");
    if (firstUrl === secondUrl) {
      // 旧设置页保存时可能把 runtime baseURL 当作 path 再拼一次，
      // 形成 https://host/path/https://host/path；这里只折叠完全重复的安全形态。
      return firstUrl;
    }
  } catch {
    return normalized;
  }

  return normalized;
}

function joinBaseUrlAndPath(baseURL: string, path: string): string {
  const trimmedBase = baseURL.trim();
  const trimmedPath = path.trim();
  if (!trimmedPath) {
    return trimmedBase;
  }
  if (isAbsoluteHttpUrl(trimmedPath)) {
    // 旧 endpoints.paths 可能已保存成完整 runtime baseURL。
    // 这种情况下不能再叠加 endpoints.baseURL，否则会写回重复 URL。
    return trimmedPath;
  }
  if (!trimmedBase) {
    return trimmedPath;
  }
  if (trimmedBase.endsWith("/") && trimmedPath.startsWith("/")) {
    return `${trimmedBase.slice(0, -1)}${trimmedPath}`;
  }
  if (!trimmedBase.endsWith("/") && !trimmedPath.startsWith("/")) {
    return `${trimmedBase}/${trimmedPath}`;
  }
  return `${trimmedBase}${trimmedPath}`;
}

export function normalizeModelProviderBaseUrlForKind(
  baseURL: string,
  kind: ModelProviderKind,
): string {
  const suffixes: Record<ModelProviderKind, string[]> = {
    anthropic: ["/v1/messages", "/messages"],
    // OpenAI Responses 的 SDK baseURL 通常包含 /v1，运行时只会追加 /responses。
    // 不能把 /v1/responses 整段剥掉，否则用户填写 https://host/v1 会被展示/落盘成 https://host。
    openai: ["/responses"],
    "openai-compatible": ["/chat/completions"],
  };
  let normalized = normalizeModelProviderConfiguredBaseUrl(baseURL);
  for (const suffix of suffixes[kind]) {
    if (normalized.toLowerCase().endsWith(suffix)) {
      normalized = normalized.slice(0, -suffix.length);
      break;
    }
  }
  return normalized.replace(/\/+$/, "");
}

export function normalizeModelProviderConfiguredBaseUrl(baseURL: string): string {
  // 设置页和 config.json 的 Base URL 是用户显式配置值，不能按 API 格式
  // 自动删除 /v1、/responses 或 /chat/completions 等路径段；这里只做安全的重复 URL 折叠和收尾清理。
  return collapseDuplicatedAbsoluteRuntimeBaseUrl(baseURL).replace(/\/+$/, "");
}

export function resolveModelProviderRuntimeBaseUrl(
  provider: Pick<ModelProviderConfig, "apiFormat" | "defaultKind" | "endpoints">,
  kind = mapModelProviderApiFormatToKind(resolveModelProviderApiFormat(provider)),
): string {
  const baseURL = provider.endpoints.baseURL?.trim() ?? "";
  const paths = provider.endpoints.paths ?? {};
  if (!provider.endpoints.baseURL?.trim() && !provider.endpoints.paths) {
    return "";
  }
  // baseURL 只是公共前缀，只有 paths 显式声明的 kind 才代表可用协议。
  // 否则 OpenAI-only provider 会被错误探测/同步成 Anthropic 可用。
  if (paths[kind] === undefined) {
    return "";
  }
  // catalog 的 baseURL + path 表示完整请求地址，而 OpenAI/Anthropic
  // runtime SDK 接收的是 API base URL，会自行追加 /chat/completions、/responses 或 /messages。
  // 若直接透传完整请求地址，真实发送会拼成 .../chat/completions/chat/completions。
  return normalizeModelProviderBaseUrlForKind(joinBaseUrlAndPath(baseURL, paths[kind] ?? ""), kind);
}

function pathFromModelProviderEndpointUrl(url: URL): string {
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${path}${url.search}`;
}

function buildEndpointsFromLegacyRuntimeBaseUrls(
  entries: Array<[ModelProviderKind, string]>,
): ModelProviderEndpoints {
  const normalizedEntries = entries.flatMap(([kind, rawUrl]) => {
    const url = normalizeModelProviderBaseUrlForKind(rawUrl, kind);
    return url ? [{ kind, url }] : [];
  });
  if (normalizedEntries.length === 0) {
    return {};
  }

  const parsedEntries = normalizedEntries.map((entry) => {
    try {
      return { ...entry, parsed: new URL(entry.url) };
    } catch {
      return { ...entry, parsed: null };
    }
  });
  const firstParsed = parsedEntries[0]?.parsed;
  const canShareOrigin =
    firstParsed && parsedEntries.every((entry) => entry.parsed?.origin === firstParsed.origin);

  return {
    ...(canShareOrigin ? { baseURL: firstParsed.origin } : {}),
    paths: Object.fromEntries(
      parsedEntries.map((entry) => [
        entry.kind,
        canShareOrigin && entry.parsed ? pathFromModelProviderEndpointUrl(entry.parsed) : entry.url,
      ]),
    ) as Partial<Record<ModelProviderKind, string>>,
  };
}

function resolveLegacyModelProviderDefaultKind(
  provider: Pick<z.infer<typeof legacyModelProviderConfigSchema>, "apiFormat" | "endpoints">,
): ModelProviderKind {
  switch (provider.apiFormat) {
    case "anthropic-messages":
      return "anthropic";
    case "openai-responses":
      return "openai";
    case "openai-chat-completions":
      return "openai-compatible";
    case undefined:
      break;
  }

  if (provider.endpoints.anthropic?.trim()) {
    return "anthropic";
  }
  if (provider.endpoints.openai?.trim()) {
    return "openai-compatible";
  }
  return "anthropic";
}

function getDefaultModelSupportedFormatsFromLegacyEndpoints(
  endpoints: Pick<ModelProviderEndpoints, "anthropic" | "openai">,
): ModelProviderSupportedFormat[] {
  const formats: ModelProviderSupportedFormat[] = [];
  if (endpoints.anthropic?.trim()) {
    formats.push("anthropic");
  }
  if (endpoints.openai?.trim()) {
    formats.push("openai");
  }
  return formats;
}

export function migrateLegacyModelProviderConfig(
  provider: z.infer<typeof legacyModelProviderConfigSchema>,
): ModelProviderConfig {
  const defaultKind = resolveLegacyModelProviderDefaultKind(provider);
  // 旧 provider 可能同时配置 Anthropic 与 OpenAI，迁移阶段先保留历史路径，
  // 后续服务层存储边界会按 OpenCode runtime config 收敛为单一 kind。
  const legacyEntries: Array<[ModelProviderKind, string]> = [];
  const anthropicEndpoint = provider.endpoints.anthropic?.trim();
  if (anthropicEndpoint) {
    legacyEntries.push(["anthropic", anthropicEndpoint]);
  }
  const openaiEndpoint = provider.endpoints.openai?.trim();
  if (openaiEndpoint) {
    legacyEntries.push([defaultKind === "openai" ? "openai" : "openai-compatible", openaiEndpoint]);
  }
  const endpoints = buildEndpointsFromLegacyRuntimeBaseUrls(legacyEntries);
  const migratedModels = provider.models.map((modelId) => {
    const formats =
      provider.modelSupportedFormats?.[modelId] ??
      (provider.apiFormat
        ? getDefaultModelSupportedFormatsFromApiFormat(provider.apiFormat)
        : getDefaultModelSupportedFormatsFromLegacyEndpoints(provider.endpoints));
    const kinds = uniqueModelProviderKinds(
      formats.flatMap((format) => {
        const kind = mapModelProviderSupportedFormatToKind(format);
        return kind ? [kind] : [];
      }),
    );
    const disabledReason =
      kinds.length === 0 && formats.includes("gemini")
        ? "legacy gemini format is not supported by zcode.model-providers.v2"
        : undefined;

    return createModelProviderModelConfig({
      id: modelId,
      name: provider.modelDisplayNames?.[modelId],
      kinds,
      defaultKind: kinds.includes(defaultKind) ? defaultKind : kinds[0],
      disabledReason,
    });
  });

  return {
    id: provider.id,
    name: provider.name,
    ...(provider.enabled !== undefined ? { enabled: provider.enabled } : {}),
    ...(provider.systemDisabledReason
      ? { systemDisabledReason: provider.systemDisabledReason }
      : {}),
    endpoints,
    apiFormat: provider.apiFormat,
    source: provider.source,
    modelsDevProviderId: provider.modelsDevProviderId,
    apiKeyRequired: provider.apiKeyRequired,
    headers: provider.headers,
    logoUrl: provider.logoUrl,
    apiKey: provider.apiKey,
    apiKeyUrl: provider.apiKeyUrl,
    defaultKind,
    models: migratedModels,
    providerMappings: stripLegacyClaudeProviderMappings(provider.providerMappings),
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

export function getDefaultModelSupportedFormatsFromEndpoints(
  endpoints: Partial<
    Pick<ModelProviderEndpoints, "anthropic" | "openai" | "gemini" | "baseURL" | "paths">
  >,
): ModelProviderSupportedFormat[] {
  const formats: ModelProviderSupportedFormat[] = [];
  const paths = endpoints.paths;
  if (endpoints.baseURL?.trim() || paths) {
    if (paths?.anthropic !== undefined) {
      formats.push("anthropic");
    }
    if (paths?.["openai-compatible"] !== undefined) {
      formats.push("openai");
    }
    if (paths?.openai !== undefined) {
      formats.push("responses");
    }
    return formats;
  }
  return [];
}

export function getDefaultModelSupportedFormatsFromApiFormat(
  apiFormat: ModelProviderApiFormat,
): ModelProviderSupportedFormat[] {
  switch (apiFormat) {
    case "anthropic-messages":
      return ["anthropic"];
    case "openai-responses":
      return ["responses"];
    case "openai-chat-completions":
      return ["openai"];
  }
}

export function resolveModelProviderApiFormat(
  provider: Pick<ModelProviderConfig, "apiFormat" | "endpoints"> &
    Partial<Pick<ModelProviderConfig, "defaultKind">>,
): ModelProviderApiFormat {
  if (
    provider.apiFormat === "anthropic-messages" ||
    provider.apiFormat === "openai-chat-completions" ||
    provider.apiFormat === "openai-responses"
  ) {
    return provider.apiFormat;
  }

  if (provider.defaultKind) {
    return resolveModelProviderKindApiFormat(provider.defaultKind);
  }

  // 旧迁移数据可能同时声明多个协议，未显式 defaultKind/apiFormat 时
  // 仍按 Anthropic-compatible 主链路优先，避免 Claude 语义 provider 被误切到 OpenAI。
  if (provider.endpoints.paths?.anthropic !== undefined) {
    return "anthropic-messages";
  }

  if (provider.endpoints.paths?.openai !== undefined) {
    return "openai-responses";
  }

  if (provider.endpoints.paths?.["openai-compatible"] !== undefined) {
    return "openai-chat-completions";
  }

  return "anthropic-messages";
}

/** 连通性测试错误分类 */
