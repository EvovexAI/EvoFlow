/* oxlint-disable eslint(max-lines) -- 一个端点一个方法 + 统一的鉴权/脱敏/错误归一化 requestData，拆分会让 HTTP 契约失去单一入口。 */
import {
  conversationShareArtifactDescriptorSchema,
  conversationShareArtifactUploadDataSchema,
  conversationShareCapabilitiesWireSchema,
  narrowConversationShareCapabilities,
  conversationShareConfirmDataSchema,
  conversationShareConfirmRequestSchema,
  conversationShareContinuationDataSchema,
  conversationShareContinuationRequestSchema,
  conversationShareErrorEnvelopeSchema,
  conversationShareKnownErrorCodeSchema,
  conversationSharePreparationDataSchema,
  conversationSharePreparationRequestSchema,
  conversationSharePreviewDataSchema,
  createConversationShareSuccessEnvelopeSchema,
  decodeConversationShareRows,
  isConversationShareSchemaVersionSupported,
  type ApiClient,
  type ApiRequestInit,
  type ConversationShareApiErrorCode,
  type ConversationShareArtifactDescriptor,
  type ConversationShareArtifactUpload,
  type ConversationShareCapabilities,
  type ConversationShareConfirmRequest,
  type ConversationShareContinuation,
  type ConversationShareContinuationRequest,
  type ConversationSharePreparation,
  type ConversationSharePreparationRequest,
  type ConversationSharePreview,
  type ConversationShareRecord,
} from "@zcode/shared";
import type { z } from "zod";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { REQUEST_ID_HEADER_NAME, withRequestIdHeader } from "../providers/api/requestIdHeaders.js";
import { verifyConversationShareIntegrity } from "./conversationShareIntegrity.js";

const log = createServiceLogger("conversation-share-http");

export type ConversationShareClientErrorKind =
  | "authentication_required"
  | "feature_disabled"
  | "invalid_contract"
  | "invalid_conversation"
  | "disclosure_required"
  | "unsafe_structure"
  | "artifact_not_allowed"
  | "limit_exceeded"
  | "upload_incomplete"
  | "not_found"
  | "expired"
  | "import_not_allowed"
  | "rate_limited"
  | "network"
  | "safety_check_pending"
  | "unsupported_schema_version"
  | "unknown";

export class ConversationShareClientError extends Error {
  readonly kind: ConversationShareClientErrorKind;
  readonly status?: number;
  readonly code?: ConversationShareApiErrorCode;
  /** 服务端响应的请求 ID，用于和后端日志对账。 */
  readonly requestId?: string;
  /** 复用现有 RPC details 字段，把安全诊断信息传到 Renderer。 */
  readonly details?: { requestId?: string };
  declare readonly retryAfterMs?: number;

  constructor(options: {
    kind: ConversationShareClientErrorKind;
    message: string;
    status?: number;
    code?: ConversationShareApiErrorCode;
    retryAfterMs?: number;
    requestId?: string;
    cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ConversationShareClientError";
    this.kind = options.kind;
    this.status = options.status;
    this.code = options.code;
    const requestId = options.requestId?.trim();
    if (requestId && /^[A-Za-z0-9._:-]{1,128}$/u.test(requestId)) {
      this.requestId = requestId;
      this.details = { requestId };
    }
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

const ERROR_KIND_BY_CODE: Record<ConversationShareApiErrorCode, ConversationShareClientErrorKind> =
  {
    3001: "invalid_contract",
    3002: "rate_limited",
    3200: "feature_disabled",
    3201: "authentication_required",
    3203: "invalid_contract",
    3204: "invalid_contract",
    3205: "invalid_conversation",
    3206: "disclosure_required",
    3207: "unsafe_structure",
    3208: "artifact_not_allowed",
    3209: "limit_exceeded",
    3210: "upload_incomplete",
    3211: "not_found",
    3212: "expired",
    3213: "authentication_required",
    3214: "import_not_allowed",
    3215: "safety_check_pending",
  };

const IMF_FIXDATE_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?:0[1-9]|[12]\d|3[01]) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d GMT$/u;
const RFC_850_DATE_PATTERN =
  /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (?:0[1-9]|[12]\d|3[01])-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d GMT$/u;
const ASCTIME_DATE_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: [1-9]|0[1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d \d{4}$/u;
const HTTP_WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
const HTTP_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function formatHttpTime(date: Date): string {
  return [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function parseHttpDate(value: string): number | undefined {
  if (IMF_FIXDATE_PATTERN.test(value)) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toUTCString() === value
      ? timestamp
      : undefined;
  }
  if (RFC_850_DATE_PATTERN.test(value)) {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return undefined;
    const date = new Date(timestamp);
    const canonical = `${HTTP_WEEKDAYS[date.getUTCDay()]}, ${String(date.getUTCDate()).padStart(2, "0")}-${HTTP_MONTHS[date.getUTCMonth()]}-${String(date.getUTCFullYear()).slice(-2)} ${formatHttpTime(date)} GMT`;
    return canonical === value ? timestamp : undefined;
  }
  if (ASCTIME_DATE_PATTERN.test(value)) {
    const timestamp = Date.parse(`${value} GMT`);
    if (!Number.isFinite(timestamp)) return undefined;
    const date = new Date(timestamp);
    const canonical = `${date.toUTCString().slice(0, 3)} ${HTTP_MONTHS[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, " ")} ${formatHttpTime(date)} ${date.getUTCFullYear()}`;
    return canonical === value ? timestamp : undefined;
  }
  return undefined;
}

function parseRetryAfterMs(value: string | null, now = Date.now()): number | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (/^\d+$/u.test(normalized)) {
    const delayMs = Number(normalized) * 1_000;
    return Number.isSafeInteger(delayMs) && delayMs > 0 ? delayMs : undefined;
  }
  // Date.parse 会接受 ISO/本地化日期并归一化不存在的日期；先按 HTTP-date 语法严格校验。
  const retryAt = parseHttpDate(normalized);
  if (retryAt === undefined) return undefined;
  const delayMs = retryAt - now;
  return delayMs > 0 ? delayMs : undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;
// confirm 期间服务端同步跑安全检查，单次请求会被挂住远超 30s（实测 50s+ 被 abort）。只放宽这一个
// 端点：全局抬到 2min 会让断网时的能力发现也僵 2min。与 confirmUntilReady 的轮询超时无关——
// 后者管的是服务端已返回 pending 之后的重试窗口，救不了请求本身。
const CONFIRM_TIMEOUT_MS = 120_000;
// uploadArtifact 不能沿用 30s 默认超时——confirm 单请求会被挂 50s+，更大的
// artifact 在慢速上行上必然超时，且上传无自动重试，超时即整个发布失败。按体积动态放宽：
// 30s 建连/服务端处理余量 + 保底 128KB/s 上行带宽，下限仍是全局默认超时（小文件不被缩短）。
const UPLOAD_TIMEOUT_BASE_MS = 30_000;
const UPLOAD_MIN_THROUGHPUT_BYTES_PER_SEC = 128 * 1024;

function computeUploadTimeoutMs(fileSizeBytes: number, floorMs: number): number {
  return Math.max(
    floorMs,
    UPLOAD_TIMEOUT_BASE_MS + Math.ceil(fileSizeBytes / UPLOAD_MIN_THROUGHPUT_BYTES_PER_SEC) * 1_000,
  );
}

function normalizeRequestId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^[A-Za-z0-9._:-]{1,128}$/u.test(trimmed) ? trimmed : undefined;
}

interface ConversationShareHttpClientOptions {
  apiClient: ApiClient;
  baseUrl: string;
  tokenProvider: () => Promise<string | null>;
  timeoutMs?: number;
  /** confirm 单次请求超时；缺省 2min。 */
  confirmTimeoutMs?: number;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/${path.replace(/^\/+/, "")}`;
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

export class ConversationShareHttpClient {
  private readonly apiClient: ApiClient;
  private readonly baseUrl: string;
  private readonly tokenProvider: () => Promise<string | null>;
  private readonly timeoutMs: number;
  private readonly confirmTimeoutMs: number;

  constructor(options: ConversationShareHttpClientOptions) {
    this.apiClient = options.apiClient;
    this.baseUrl = options.baseUrl;
    this.tokenProvider = options.tokenProvider;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS;
  }

  async getCapabilities(): Promise<ConversationShareCapabilities> {
    const wire = await this.requestData(
      "/shares/capabilities",
      { method: "GET" },
      conversationShareCapabilitiesWireSchema,
      "required",
    );
    const { capabilities, unsupportedArtifactTypes, unsupportedAccessModes } =
      narrowConversationShareCapabilities(wire);
    if (unsupportedArtifactTypes.length > 0 || unsupportedAccessModes.length > 0) {
      // 后端新增结果物类型/访问模式时留一条可检索的记录：能力发现不再被打死，
      // 但需要知道该补哪一种。
      log.info(undefined, "conversation share capabilities dropped unsupported values", {
        types: unsupportedArtifactTypes,
        accessModes: unsupportedAccessModes,
        supportedCount: capabilities.allowed_artifacts.length,
      });
    }
    return capabilities;
  }

  createPreparation(
    input: ConversationSharePreparationRequest,
  ): Promise<ConversationSharePreparation> {
    const body = conversationSharePreparationRequestSchema.parse(input);
    return this.requestData(
      "/shares/preparations",
      this.jsonRequest("POST", body),
      conversationSharePreparationDataSchema,
      "required",
    );
  }

  uploadArtifact(
    preparationId: string,
    descriptor: ConversationShareArtifactDescriptor,
    file: Blob,
  ): Promise<ConversationShareArtifactUpload> {
    const parsedDescriptor = conversationShareArtifactDescriptorSchema.parse(descriptor);
    // 安全边界：只记录公开 ID、类型与字节数，不记录 descriptor、文件名、路径、正文或鉴权头。
    log.debug(undefined, "conversation share artifact upload prepared", {
      preparationId,
      artifactId: parsedDescriptor.artifact_id,
      artifactType: parsedDescriptor.artifact_type,
      fileSizeBytes: file.size,
    });
    const form = new FormData();
    form.append("descriptor", JSON.stringify(parsedDescriptor));
    form.append("file", file, parsedDescriptor.display_name);
    return this.requestData(
      `/shares/preparations/${encodeURIComponent(preparationId)}/artifacts`,
      { method: "POST", body: form },
      conversationShareArtifactUploadDataSchema,
      "required",
      computeUploadTimeoutMs(file.size, this.timeoutMs),
    );
  }

  confirm(
    preparationId: string,
    input: ConversationShareConfirmRequest,
  ): Promise<ConversationShareRecord> {
    const body = conversationShareConfirmRequestSchema.parse(input);
    return this.requestData(
      `/shares/preparations/${encodeURIComponent(preparationId)}/confirm`,
      this.jsonRequest("POST", body),
      conversationShareConfirmDataSchema,
      "required",
      this.confirmTimeoutMs,
    );
  }

  async getPreview(shareCode: string): Promise<ConversationSharePreview> {
    const wire = await this.requestData(
      `/shares/${encodeURIComponent(shareCode)}/preview`,
      { method: "GET" },
      conversationSharePreviewDataSchema,
      "optional",
    );
    this.assertSupportedSchemaVersion(wire.schema_version, "preview");
    const decoded = this.decodeRows(wire.rows, "preview");
    return { ...wire, rows: decoded.rows, unsupportedRowCount: decoded.unsupportedCount };
  }

  async getContinuation(
    shareCode: string,
    input: ConversationShareContinuationRequest,
  ): Promise<ConversationShareContinuation> {
    const body = conversationShareContinuationRequestSchema.parse(input);
    const wire = await this.requestData(
      `/shares/${encodeURIComponent(shareCode)}/continuation`,
      this.jsonRequest("POST", body),
      conversationShareContinuationDataSchema,
      // public_importable 分享的 continuation 由 share code + client request id 授权，
      // 不应因为 ZCode 本地没有登录态而在请求发出前被客户端拦截。
      "optional",
    );
    this.assertSupportedSchemaVersion(wire.schema_version, "continuation");
    // 完整性对服务端原样发来的值校验，不对解析产物——否则发布端加一个 optional 字段就会
    // 让所有老客户端算出不同的哈希（详见 verifyConversationShareIntegrity 的注释）。
    if (
      !verifyConversationShareIntegrity({
        rawRows: wire.rows,
        rawArtifacts: wire.artifacts,
        integrity: wire.integrity,
      })
    ) {
      throw new ConversationShareClientError({
        kind: "invalid_contract",
        message: "Conversation share integrity check failed",
      });
    }
    const decoded = this.decodeRows(wire.rows, "continuation");
    return {
      ...wire,
      rows: decoded.rows,
      rawRows: wire.rows,
      unsupportedRowCount: decoded.unsupportedCount,
    };
  }

  /**
   * 版本高于本端认知时不猜语义，也不混进 invalid_contract：用户该看到「请升级 ZCode」，
   * 不是「分享格式无效」。低于或等于本端版本一律继续——新增 kind/enum 由逐行降级消化。
   */
  private assertSupportedSchemaVersion(version: number, endpoint: string): void {
    if (isConversationShareSchemaVersionSupported(version)) return;
    log.warn(undefined, "conversation share payload schema version is newer than this client", {
      endpoint,
      version,
    });
    throw new ConversationShareClientError({
      kind: "unsupported_schema_version",
      message: "Conversation share payload requires a newer ZCode version",
    });
  }

  private decodeRows(
    rows: readonly unknown[],
    endpoint: string,
  ): ReturnType<typeof decodeConversationShareRows> {
    const decoded = decodeConversationShareRows(rows);
    if (decoded.unsupportedCount > 0) {
      // 不静默：认不出的行会从展示里消失，必须留一条可检索的记录说明该补哪种 row。
      log.info(undefined, "conversation share dropped rows this client cannot render", {
        endpoint,
        kinds: decoded.unsupportedKinds,
        droppedCount: decoded.unsupportedCount,
        keptCount: decoded.rows.length,
      });
    }
    return decoded;
  }

  private jsonRequest(method: "POST", body: unknown): ApiRequestInit {
    return {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
  }

  private async requestData<T>(
    path: string,
    init: ApiRequestInit,
    dataSchema: z.ZodType<T>,
    auth: "required" | "optional",
    timeoutMsOverride?: number,
  ): Promise<T> {
    const token = (await this.tokenProvider())?.trim() || null;
    if (auth === "required" && !token) {
      throw new ConversationShareClientError({
        kind: "authentication_required",
        message: "Conversation share authentication required",
        status: 401,
      });
    }

    // ApiClient 会兜底注入 request id；在这里先生成并保留同一个值，确保非标准 ApiClient
    //（例如远端 Host facade 或测试替身）也能把请求 ID 和服务端响应关联起来。
    const headers = withRequestIdHeader(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const url = joinUrl(this.baseUrl, path);
    let response: Response;
    try {
      response = await this.apiClient.request(url, {
        ...init,
        headers: Object.fromEntries(headers.entries()),
        timeoutMs: timeoutMsOverride ?? this.timeoutMs,
      });
    } catch (error) {
      if (error instanceof ConversationShareClientError) throw error;
      throw new ConversationShareClientError({
        kind: "network",
        message: error instanceof Error ? error.message : "Conversation share network error",
        cause: error,
      });
    }

    const text = await response.text();
    const responseRequestId = normalizeRequestId(response.headers.get(REQUEST_ID_HEADER_NAME));
    if (!response.ok) {
      if (response.status === 401 && !text.trim()) {
        throw new ConversationShareClientError({
          kind: "authentication_required",
          message: "Conversation share authentication required",
          status: 401,
          requestId: responseRequestId,
        });
      }
      let parsedError: ReturnType<typeof conversationShareErrorEnvelopeSchema.safeParse> | null =
        null;
      if (text.trim()) {
        try {
          parsedError = conversationShareErrorEnvelopeSchema.safeParse(parseJson(text));
        } catch (error) {
          // 网关的 502/504 可能返回 HTML 错误页。5xx 的非 JSON 响应归为 network，
          // 避免将基础设施故障误报为响应契约错误；其他状态的解析失败仍归为 invalid_contract。
          if (response.status >= 500) {
            log.warn(undefined, "conversation share API upstream unavailable", {
              path,
              method: init.method ?? "GET",
              status: response.status,
              requestId: responseRequestId,
            });
            throw new ConversationShareClientError({
              kind: "network",
              message: `Conversation share API upstream failed with HTTP ${response.status}`,
              status: response.status,
              ...(responseRequestId === undefined ? {} : { requestId: responseRequestId }),
              cause: error,
            });
          }
          log.warn(undefined, "conversation share API returned invalid JSON", {
            path,
            method: init.method ?? "GET",
            status: response.status,
            requestId: responseRequestId,
          });
          throw new ConversationShareClientError({
            kind: "invalid_contract",
            message: "Conversation share API returned invalid JSON",
            status: response.status,
            ...(responseRequestId === undefined ? {} : { requestId: responseRequestId }),
            cause: error,
          });
        }
      }
      if (parsedError?.success) {
        // 未知业务码不再让整条信封解析失败（那样会丢掉服务端 msg，退化成没有上下文的
        // "HTTP 4xx"）。认得的码走既有映射，认不得的落 unknown 但保留 msg 与 status。
        const knownCode = conversationShareKnownErrorCodeSchema.safeParse(parsedError.data.code);
        const code = knownCode.success ? knownCode.data : undefined;
        const kind = code === undefined ? "unknown" : ERROR_KIND_BY_CODE[code];
        const retryAfterMs =
          code === 3215 ? parseRetryAfterMs(response.headers.get("retry-after")) : undefined;
        log.warn(undefined, "conversation share API request rejected", {
          path,
          method: init.method ?? "GET",
          status: response.status,
          kind,
          code: parsedError.data.code,
          requestId: responseRequestId,
        });
        throw new ConversationShareClientError({
          kind,
          message: parsedError.data.msg,
          status: response.status,
          ...(code === undefined ? {} : { code }),
          requestId: responseRequestId,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        });
      }
      log.warn(undefined, "conversation share API request rejected", {
        path,
        method: init.method ?? "GET",
        status: response.status,
        requestId: responseRequestId,
      });
      // 空 body 或 body 不是合法错误 envelope 时的兜底分类：5xx 是基础设施故障（network），
      // 不能落进 unknown/invalid_contract；429 维持 rate_limited，其余才是 unknown。
      throw new ConversationShareClientError({
        kind:
          response.status >= 500 ? "network" : response.status === 429 ? "rate_limited" : "unknown",
        message: `Conversation share API failed with HTTP ${response.status}`,
        status: response.status,
        ...(responseRequestId === undefined ? {} : { requestId: responseRequestId }),
      });
    }

    try {
      const envelope = createConversationShareSuccessEnvelopeSchema(dataSchema).parse(
        parseJson(text),
      );
      return envelope.data;
    } catch (error) {
      if (error instanceof ConversationShareClientError) throw error;
      throw new ConversationShareClientError({
        kind: "invalid_contract",
        message: "Conversation share API response does not match the client contract",
        status: response.status,
        ...(responseRequestId === undefined ? {} : { requestId: responseRequestId }),
        cause: error,
      });
    }
  }
}
