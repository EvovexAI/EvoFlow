/**
 * 遥测文本与模型身份的脱敏收口。
 *
 * ARMS 自动采集的 exception / api / click 事件，以及自定义事件里带自由文本的字段，都可能包含
 * 本机路径、邮箱、完整 URL 和凭据。这里提供纯函数实现，供 desktop main 的 `beforeReport` 与
 * renderer 侧埋点共用，避免每个埋点各写一份模式。
 *
 * 模式与 CLI 的 `apps/zcode-cli/packages/telemetry/src/error-sanitizer.ts` 保持一致；两者位于不同
 * workspace 且不允许互相依赖，扩展任一侧时必须同步另一侧。
 */

import { decodeCustomModelValue } from "./custom-model-value.js";
import { migrateLegacyModelProviderId } from "./legacy-model-provider-identity.js";
import { isBuiltinModelProviderId } from "./model-provider-types.js";
import { OFFICIAL_GLM_MODEL_IDS } from "./official-glm-model-id.js";

/** 单字段默认上限；ARMS 单字段过长会被截断或拒绝，主动截断保证关键头部一定上得去。 */
export const TELEMETRY_TEXT_MAX_LENGTH = 2_048;

/** 脱敏前的输入上限：错误可能携带整段响应正文，先有界截断再正则清洗，避免无界 CPU 成本。 */
const TELEMETRY_TEXT_SCAN_LIMIT = 4_096;

/** 路由段保留原文的最大长度；更长的段一律视为不可信内容。 */
const TELEMETRY_ROUTE_SEGMENT_MAX_LENGTH = 128;

export interface RedactTelemetryTextOptions {
  /** 输出上限，默认 {@link TELEMETRY_TEXT_MAX_LENGTH}。 */
  maxLength?: number;
}

/**
 * 把自由文本清洗成可上报形态：URL 去 query、路径/邮箱/凭据归一为占位符，并有界截断。
 *
 * 只作用于上报副本；错误展示、本地日志、崩溃归档和分类逻辑必须继续使用原值。
 */
export function redactTelemetryText(
  value: string | undefined | null,
  options: RedactTelemetryTextOptions = {},
): string {
  if (typeof value !== "string" || !value) {
    return "";
  }

  const maxLength = options.maxLength ?? TELEMETRY_TEXT_MAX_LENGTH;
  const redacted = value
    .slice(0, TELEMETRY_TEXT_SCAN_LIMIT)
    .replace(/\bhttps?:\/\/[^\s"'<>]+/giu, (match) => redactTelemetryUrl(match))
    .replace(
      /(\bauthorization\b["']?\s*[:=])\s*(?:(?:Bearer|Basic)\s+)?[^\s,"'};]+/giu,
      "$1 {redacted}",
    )
    .replace(
      /([?&](?:api[_-]?key|token|access[_-]?token|authorization|password|passwd|secret|cookie|session)=)[^&\s]+/giu,
      "$1{redacted}",
    )
    .replace(
      /(["']?(?:api[_-]?key|token|access[_-]?token|password|passwd|secret|client[_-]?secret|cookie|set-cookie|session)["']?\s*[:=]\s*["']?)(?!\{redacted\})[^\s,"'};]+/giu,
      "$1{redacted}",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, "$1 {redacted}")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/giu, "{secret}")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, "{secret}")
    .replace(/\bAKIA[A-Z0-9]{16}\b/gu, "{secret}")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/gu, "{secret}")
    .replace(/\b[^/@\s]+@[^/@\s]+\.[^/@\s]+\b/gu, "{email}")
    // 修复原因：崩溃/异常消息里的绝对路径会带上本机用户名与工作区目录名，必须在离开本机前归一。
    .replace(/\/(?:private\/)?(?:var\/folders|tmp)\/[^\s:;,)\]}]+/gu, "{path}")
    .replace(
      /\/(?:Users|home|root|workspace|workspaces|Volumes)\/[^/\s]+(?:\/[^\s:;,)\]}]+)*/gu,
      "{path}",
    )
    .replace(/\b[A-Za-z]:\\[^\\\s]+(?:\\[^\s:;,)\]}]+)*/gu, "{path}")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  return redacted.slice(0, maxLength);
}

/**
 * 把 URL 清洗成 `protocol//host` 加归一化路由；丢弃 query 与 fragment。
 *
 * `file://`、本地绝对路径归一为 `local_file`，`blob:` / `data:` 只保留协议标记，
 * 无法解析时返回 `unknown`，不回退到原值。
 */
export function redactTelemetryUrl(value: string | undefined | null): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return "unknown";
  }
  if (/^blob:/iu.test(raw)) {
    return "blob";
  }
  if (/^data:/iu.test(raw)) {
    return "data";
  }
  // Bug 根因：枚举常见根目录会漏掉 /opt、/root、/mnt 等合法 POSIX 绝对路径。
  if (/^file:/iu.test(raw) || /^[a-zA-Z]:[\\/]/u.test(raw) || raw.startsWith("/")) {
    return "local_file";
  }

  try {
    // Bug 根因：无条件补 `https://` 会让 `!!!` 之类的普通文本被 URL 解析成 host 后原样回显。
    // 只有本身带 scheme，或看起来确实是 host[:port][/path] 的输入才进入解析。
    const candidate = raw.includes("://")
      ? raw
      : /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?(?:[/?#]|$)/iu.test(raw)
        ? `https://${raw}`
        : "";
    if (!candidate) {
      return "unknown";
    }
    const parsed = new URL(candidate);
    if (parsed.protocol === "file:" || !parsed.host) {
      return "local_file";
    }
    const route = parsed.pathname
      .split("/")
      .map((segment) => redactTelemetryRouteSegment(segment))
      .join("/");
    return `${parsed.protocol}//${parsed.host}${route}`;
  } catch {
    return "unknown";
  }
}

function redactTelemetryRouteSegment(segment: string): string {
  if (!segment) {
    return segment;
  }
  if (
    // 邮箱、长数字 ID、hash 和 UUID 都是高基数身份，不能原样留在路由里。
    /@/u.test(segment) ||
    /^\d{7,}$/u.test(segment) ||
    /^[0-9a-f]{16,}$/iu.test(segment) ||
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(segment)
  ) {
    return "{segment}";
  }
  return segment.slice(0, TELEMETRY_ROUTE_SEGMENT_MAX_LENGTH);
}

/** 官方 GLM 名单之外的历史内置模型；仍是 ZCode 自己发布的稳定 ID，不是用户命名。 */
const TELEMETRY_LEGACY_BUILTIN_MODEL_IDS: readonly string[] = ["charglm-4", "codegeex-4", "emohaa"];

/**
 * telemetry 模型白名单：只有这里的内置稳定模型 ID 允许原样进入遥测。
 *
 * 白名单独立于账号返回的运行时 catalog，但以人工维护的官方 GLM 名单为来源：
 * 修复原因：此前手抄一份列表漏掉了 GLM-5.3 / GLM-5.3-Flash / GLM-5V-Turbo，导致旗舰模型在
 * plan_* / perf_ui_* 里整体写成 `custom`。派生自官方名单后，两处不会再各自漂移。
 */
export const TELEMETRY_SAFE_BUILTIN_MODEL_IDS: ReadonlySet<string> = new Set([
  ...OFFICIAL_GLM_MODEL_IDS.map((id) => id.toLowerCase()),
  ...TELEMETRY_LEGACY_BUILTIN_MODEL_IDS,
]);

export type TelemetryProviderScope = "builtin" | "custom" | "unknown";

export interface TelemetryProviderIdentity {
  providerId: string;
  providerScope: TelemetryProviderScope;
}

/**
 * 旧报表身份（`builtin:zai` / `builtin:zai-start-plan` 等）是 ZCode 自己的固定 ID。
 *
 * 修复原因：V4 supervisor 投影 /report detail 时会用 legacyTelemetryProviderId 把运行时
 * `account:*` 映射成这些旧身份，plan_ttft / perf_ui_* 复用同一份 detail。只认 `account:*`
 * 会让全部内置用户被当成自定义 provider 归一为 `custom`。复用 shared 的单向迁移表判定，
 * 未知的 `builtin:` 前缀仍按自定义处理，不能借前缀混入。
 */
function isLegacyBuiltinTelemetryProviderId(providerId: string): boolean {
  const migrated = migrateLegacyModelProviderId(providerId);
  return migrated !== undefined && migrated !== providerId;
}

/** 内置 provider 保留稳定 ID；自定义 provider 由用户命名，原样上报会泄露私有名称并制造高基数。 */
export function resolveTelemetryProviderScope(
  providerId: string | undefined | null,
): TelemetryProviderIdentity {
  const normalized = providerId?.trim();
  if (!normalized) {
    return { providerId: "", providerScope: "unknown" };
  }
  if (isBuiltinModelProviderId(normalized) || isLegacyBuiltinTelemetryProviderId(normalized)) {
    return { providerId: normalized, providerScope: "builtin" };
  }
  return { providerId: "custom", providerScope: "custom" };
}

/**
 * 从 `custom:<providerId>:<modelName>` 编码值或 `<providerId>/<modelId>` 复合值里剥出裸模型 ID。
 * 裸 ID 只用于查白名单，无论 provider 部分是什么都不会原样进入遥测。
 */
function extractBareModelId(value: string): string {
  const decoded = decodeCustomModelValue(value);
  if (decoded) {
    return decoded.modelName ?? "";
  }
  const separator = value.indexOf("/");
  return separator > 0 ? value.slice(separator + 1) : value;
}

/**
 * 只保留白名单内的内置模型 ID。
 *
 * 自定义 provider 的模型、内置 provider 下未命中白名单的模型统一写 `custom`；
 * provider scope 未知或模型缺失时写空串，与既有留空口径一致。
 */
export function resolveTelemetryModelId(
  providerScope: TelemetryProviderScope,
  modelId: string | undefined | null,
): string {
  const normalized = modelId?.trim();
  if (!normalized || providerScope === "unknown") {
    return "";
  }
  if (providerScope === "custom") {
    return "custom";
  }
  // 修复原因：supervisor 投影出的 detail.model_name 是 `<providerId>/<modelId>` 复合值或
  // `custom:` 编码值，直接整串查白名单必然落空；先剥出裸模型 ID 再判定。
  const bareModelId = extractBareModelId(normalized).toLowerCase();
  return TELEMETRY_SAFE_BUILTIN_MODEL_IDS.has(bareModelId) ? bareModelId : "custom";
}

/**
 * 归一化「只拿到一个模型值、没有独立 provider 字段」的场景。
 *
 * 支持三种形态：`custom:<providerId>[:<modelName>]` 编码值、`<providerId>/<modelId>` 复合值和
 * 裸模型 ID。裸 ID 直接按白名单判定，未命中一律降级为 `custom`——这正是「新增内置模型未进入
 * 白名单时必须默认降级」的要求，因此不需要调用方额外传 provider。
 */
export function sanitizeTelemetryModelValue(value: string | undefined | null): string {
  const normalized = value?.trim();
  if (!normalized) {
    return "";
  }

  // `custom:` 前缀本身就表示非内置 provider，无需解码出用户命名即可判定。
  const decoded = decodeCustomModelValue(normalized);
  if (decoded) {
    return resolveTelemetryModelId(
      resolveTelemetryProviderScope(decoded.providerId).providerScope,
      decoded.modelName,
    );
  }

  const separator = normalized.indexOf("/");
  if (separator > 0) {
    const { providerScope } = resolveTelemetryProviderScope(normalized.slice(0, separator));
    return resolveTelemetryModelId(providerScope, normalized.slice(separator + 1));
  }

  return resolveTelemetryModelId("builtin", normalized);
}
