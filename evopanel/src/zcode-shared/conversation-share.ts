import { z } from "zod";

import type { Locale } from "./protocol.js";
import {
  conversationArtifactTypeSchema,
  conversationRowSchema,
  type ConversationRow,
} from "./zcode-protocol-v4/rows.js";

/**
 * 分享站按语言分路径：中文站带 /cn 前缀，英文站是裸 /share。
 * web 路由、发布回链改写、导入回链共用这一份定义，避免三处各写一遍前缀。
 */
const CONVERSATION_SHARE_LOCALE_PATH_PREFIX: Readonly<Record<Locale, string>> = {
  "zh-CN": "/cn",
  "en-US": "",
};

const CONVERSATION_SHARE_PATHNAME_RE = /^\/(cn\/)?share\/([^/]+)\/?$/u;

/**
 * 解析分享页 pathname，返回未解码的 code 段与该路径对应的语言。
 * 只认 `/share/<code>` 与 `/cn/share/<code>` 两种形状；调用方负责 code 的解码与安全校验。
 */
export function parseConversationSharePathname(
  pathname: string,
): { rawCode: string; locale: Locale } | null {
  const match = CONVERSATION_SHARE_PATHNAME_RE.exec(pathname);
  if (!match) return null;
  return { rawCode: match[2]!, locale: match[1] ? "zh-CN" : "en-US" };
}

/**
 * 把分享链接改写到目标语言站点。
 *
 * 只在 pathname 精确匹配已知分享形状时改写，且只替换语言前缀、不碰 code 段
 * （避免 decode/encode 往返改变 code）。其它任何形状原样返回 —— 服务端将来若改用
 * 别的 URL 形状或独立域名，这里会安静地不作为，而不是改错。
 */
export function localizeConversationShareUrl(shareUrl: string, locale: Locale): string {
  let url: URL;
  try {
    url = new URL(shareUrl);
  } catch {
    return shareUrl;
  }
  const parsed = parseConversationSharePathname(url.pathname);
  if (!parsed) return shareUrl;
  url.pathname = `${CONVERSATION_SHARE_LOCALE_PATH_PREFIX[locale]}/share/${parsed.rawCode}`;
  return url.toString();
}

export const conversationShareAccessModeSchema = z.enum([
  "private",
  "public_readonly",
  "public_importable",
]);
export type ConversationShareAccessMode = z.infer<typeof conversationShareAccessModeSchema>;

/**
 * 本端产出与理解的分享载荷版本。
 *
 * 只有 rows 的语义发生「不可跳过的」破坏性变化时才 bump（新增 row kind / enum 值不算——
 * 那些由 decodeConversationShareRows 逐行降级消化）。bump 一次就等于让所有存量客户端和
 * 所有已部署的落地页镜像同时看不了新分享，所以 bump 前必须先看存量版本占比。
 */
export const CONVERSATION_SHARE_SCHEMA_VERSION = 1;

/**
 * 入站 schema_version 一律先按数字收下，再由 isConversationShareSchemaVersionSupported
 * 判定。用 z.literal 会让「版本太新」和「响应形状不对」挤进同一个 invalid_contract，
 * 用户看到的是「分享格式无效」而不是「请升级 ZCode」。
 */
const conversationShareSchemaVersionSchema = z.number().int().positive();

/** 版本高于本端认知时不猜语义：调用方必须转成「请升级」而不是通用契约错误。 */
export function isConversationShareSchemaVersionSupported(version: number): boolean {
  return version <= CONVERSATION_SHARE_SCHEMA_VERSION;
}

/**
 * 逐行解码公开投影 rows，认不出的行跳过并计数。
 *
 * 传输层刻意不理解 row 语义（wire 上 rows 是 unknown[]）：整份分享不能因为其中一行用了
 * 新 kind、新 enum 值或新 timelineMarker type 就打不开。一个机制覆盖这三种情况，因此
 * 也不需要给任何 enum 配 .catch(fallback)——猜错枚举语义比丢一行危险得多。
 *
 * 渲染链本来就容错（buildConversationTurnRenderUnits 把认不出的 kind 归入 assistantWork，
 * ConversationShareReadonlyTimeline 的 switch 认不出就不渲染），所以这里只需要不抛。
 * 计数交给调用方转成「部分内容需要更新 ZCode 查看」的软提示，不能静默。
 */
export function decodeConversationShareRows(rows: readonly unknown[]): {
  rows: ConversationRow[];
  unsupportedCount: number;
  unsupportedKinds: string[];
} {
  const decoded: ConversationRow[] = [];
  const unsupportedKinds: string[] = [];
  let unsupportedCount = 0;
  for (const row of rows) {
    const parsed = conversationRowSchema.safeParse(row);
    if (parsed.success) {
      decoded.push(parsed.data);
      continue;
    }
    unsupportedCount += 1;
    const kind = (row as { kind?: unknown } | null)?.kind;
    const label = typeof kind === "string" && kind.trim() ? kind.trim() : "unknown";
    if (!unsupportedKinds.includes(label)) unsupportedKinds.push(label);
  }
  return { rows: decoded, unsupportedCount, unsupportedKinds };
}

export const conversationShareSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

const conversationShareArtifactDescriptorFields = {
  artifact_id: z.string().trim().min(1),
  logical_artifact_key: z.string().trim().min(1),
  producer_product_turn_id: z.string().trim().min(1),
  artifact_version: z.number().int().positive(),
  state: z.literal("current"),
  ref: z.string().regex(/^zcode-artifact:\/\/share\/[A-Za-z0-9._~-]+$/u),
  artifact_type: conversationArtifactTypeSchema,
  display_name: z.string().trim().min(1),
  original_path: z.string().min(1).optional(),
  extension: z.string().trim().min(1),
  mime_type: z.string().trim().min(1),
  size_bytes: z.number().int().nonnegative(),
  sha256: conversationShareSha256Schema,
} as const;

/**
 * 出站 descriptor（upload / confirm）：严格，用来抓自己的 bug。
 *
 * 出站严格、入站宽容是这份契约的通用纪律：我们发出去的东西多一个字段是我们的错，
 * 服务端回来的东西多一个字段是它的自由。
 */
export const conversationShareArtifactDescriptorSchema = z
  .object(conversationShareArtifactDescriptorFields)
  .strict();
export type ConversationShareArtifactDescriptor = z.infer<
  typeof conversationShareArtifactDescriptorSchema
>;

/** 入站 descriptor（preview / continuation 回显）：允许服务端加字段。 */
export const conversationShareInboundArtifactDescriptorSchema = z.object(
  conversationShareArtifactDescriptorFields,
);

const conversationShareAllowedArtifactShapeSchema = z.object({
  // 故意不用 artifact type 枚举：capabilities 是服务端的能力发现列表，后端新增一种
  // 结果物类型不能让整个响应校验失败、把发布（包括不含任何结果物的发布）一起打死。
  // 未知类型在 narrow 时丢弃——客户端产不出这种类型，参与不了任何 allow 判断。
  type: z.string().trim().min(1),
  extensions: z.array(z.string().trim().min(1)),
  mime_types: z.array(z.string().trim().min(1)),
});

const conversationShareCapabilitiesBaseFields = {
  ttl_ms: z.number().int().positive(),
  max_rows: z.number().int().positive(),
  max_payload_bytes: z.number().int().positive(),
  max_artifact_count: z.number().int().nonnegative(),
  max_artifact_bytes: z.number().int().positive(),
  max_total_artifact_bytes: z.number().int().positive(),
};

/**
 * 线上响应形状：非 strict，且 type / access mode 的取值向前兼容。
 *
 * access_modes 与 allowed_artifacts 同理：后端上线一种新访问模式，不能把老客户端的
 * 能力发现（即整个发布入口）打死。未知取值在 narrow 时丢弃——客户端选不出它不认识的模式。
 */
export const conversationShareCapabilitiesWireSchema = z.object({
  ...conversationShareCapabilitiesBaseFields,
  schema_version: conversationShareSchemaVersionSchema,
  access_modes: z.array(z.string().trim().min(1)),
  allowed_artifacts: z.array(conversationShareAllowedArtifactShapeSchema),
});
export type ConversationShareCapabilitiesWire = z.infer<
  typeof conversationShareCapabilitiesWireSchema
>;

/** narrow 之后的内部形状：取值已收窄到本端认识的枚举，可以继续严格。 */
export const conversationShareCapabilitiesDataSchema = z
  .object({
    ...conversationShareCapabilitiesBaseFields,
    schema_version: conversationShareSchemaVersionSchema,
    access_modes: z.array(conversationShareAccessModeSchema),
    allowed_artifacts: z.array(
      z
        .object({
          type: conversationArtifactTypeSchema,
          extensions: z.array(z.string().trim().min(1)),
          mime_types: z.array(z.string().trim().min(1)),
        })
        .strict(),
    ),
  })
  .strict();
export type ConversationShareCapabilities = z.infer<typeof conversationShareCapabilitiesDataSchema>;

/**
 * 丢弃客户端不认识的结果物类型与访问模式，并把被丢弃的取值回报给调用方做日志。
 *
 * 注意丢弃只对「客户端确实产不出/选不出的取值」无损。一旦本地能把某个可上传扩展名抽成
 * 预览候选（见 conversation-preview-artifacts 的 PREVIEW_FILE_TYPES），却没有把对应类型加进
 * conversationArtifactTypeSchema，这里就会把服务端明明允许的类型削掉，然后拿被削过的白名单
 * 反过来告诉用户「该类型不支持」——md 曾经就是这样被误判的。video/audio 是只用于内部预览
 * warning 的明确例外，不应加入可上传 artifact 枚举。
 */
export function narrowConversationShareCapabilities(wire: ConversationShareCapabilitiesWire): {
  capabilities: ConversationShareCapabilities;
  unsupportedArtifactTypes: string[];
  unsupportedAccessModes: string[];
} {
  const supported: ConversationShareCapabilities["allowed_artifacts"] = [];
  const unsupportedArtifactTypes: string[] = [];
  for (const entry of wire.allowed_artifacts) {
    const type = conversationArtifactTypeSchema.safeParse(entry.type);
    if (type.success) supported.push({ ...entry, type: type.data });
    else if (!unsupportedArtifactTypes.includes(entry.type))
      unsupportedArtifactTypes.push(entry.type);
  }
  const accessModes: ConversationShareAccessMode[] = [];
  const unsupportedAccessModes: string[] = [];
  for (const mode of wire.access_modes) {
    const parsed = conversationShareAccessModeSchema.safeParse(mode);
    if (parsed.success) accessModes.push(parsed.data);
    else if (!unsupportedAccessModes.includes(mode)) unsupportedAccessModes.push(mode);
  }
  return {
    capabilities: { ...wire, access_modes: accessModes, allowed_artifacts: supported },
    unsupportedArtifactTypes,
    unsupportedAccessModes,
  };
}

export const conversationShareConfirmDataSchema = z.object({
  share_code: z.string().trim().min(1),
  share_url: z.string().url(),
  access_mode: conversationShareAccessModeSchema,
  expires_at: z.number().int().nonnegative(),
});
export type ConversationShareRecord = z.infer<typeof conversationShareConfirmDataSchema>;

// 出站请求保持 strict：schema_version 写死本端常量，多一个字段是我们自己的 bug。
export const conversationSharePreparationRequestSchema = z
  .object({
    client_request_id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    schema_version: z.literal(CONVERSATION_SHARE_SCHEMA_VERSION),
    access_mode: conversationShareAccessModeSchema,
    payload_sha256: conversationShareSha256Schema,
    artifact_count: z.number().int().nonnegative(),
  })
  .strict();
export type ConversationSharePreparationRequest = z.infer<
  typeof conversationSharePreparationRequestSchema
>;

const conversationSharePreparationBaseFields = {
  preparation_id: z.string().trim().min(1),
  access_mode: conversationShareAccessModeSchema,
  expires_at: z.number().int().nonnegative(),
} as const;

export const conversationSharePreparationDataSchema = z.discriminatedUnion("status", [
  z.object({
    ...conversationSharePreparationBaseFields,
    status: z.literal("preparing"),
  }),
  z.object({
    ...conversationSharePreparationBaseFields,
    status: z.literal("confirmed"),
    share: conversationShareConfirmDataSchema,
  }),
]);
export type ConversationSharePreparation = z.infer<typeof conversationSharePreparationDataSchema>;

export const conversationShareArtifactUploadDataSchema = z.object({
  artifact_id: z.string().trim().min(1),
  size_bytes: z.number().int().nonnegative(),
  sha256: conversationShareSha256Schema,
  status: z.literal("uploaded"),
  safety_status: z.string().trim().min(1),
});
export type ConversationShareArtifactUpload = z.infer<
  typeof conversationShareArtifactUploadDataSchema
>;

const conversationShareIntegrityFields = {
  projection_sha256: conversationShareSha256Schema,
  artifact_set_sha256: conversationShareSha256Schema,
} as const;

/** 入站 integrity：非 strict，服务端将来多带一个摘要字段不该打死响应。 */
export const conversationShareIntegritySchema = z.object(conversationShareIntegrityFields);
export type ConversationShareIntegrity = z.infer<typeof conversationShareIntegritySchema>;

/**
 * 出站 integrity：strict。confirm 只提交两个摘要（不含 payload_sha256），
 * 多带一个字段是本端的 bug，必须当场炸掉而不是发到线上。
 */
const conversationShareOutboundIntegritySchema = z
  .object(conversationShareIntegrityFields)
  .strict();

// 出站请求：rows 用正式 row schema 且全程 strict——发出去的投影必须是我们完全理解的东西。
export const conversationShareConfirmRequestSchema = z
  .object({
    selected_product_turn_ids: z.array(z.string().trim().min(1)).min(1),
    projection: z
      .object({
        rows: z.array(conversationRowSchema).min(1),
      })
      .strict(),
    integrity: conversationShareOutboundIntegritySchema,
    disclosure_confirmation: z
      .object({
        version: z.literal(1),
        accepted_at: z.number().int().nonnegative(),
        acknowledged_no_secret_detection: z.literal(true),
      })
      .strict(),
  })
  .strict();
export type ConversationShareConfirmRequest = z.infer<typeof conversationShareConfirmRequestSchema>;

const conversationSharePublicMetadataSchema = z.object({
  title: z.string(),
  access_mode: conversationShareAccessModeSchema,
  created_at: z.number().int().nonnegative(),
  expires_at: z.number().int().nonnegative(),
});

export const conversationSharePreviewArtifactSchema =
  conversationShareInboundArtifactDescriptorSchema.extend({
    url: z.string().url(),
    url_expires_at: z.number().int().nonnegative(),
  });

/**
 * 入站 wire 形状：rows 是 unknown[]，由 decodeConversationShareRows 逐行降级。
 *
 * 传输层不理解 row 语义是刻意的——否则老客户端遇到一行新 kind 就整份分享打不开。
 * 对外类型 ConversationSharePreview 是「解码后」的形状，不从这份 schema 推断。
 */
export const conversationSharePreviewDataSchema = z.object({
  schema_version: conversationShareSchemaVersionSchema,
  share: conversationSharePublicMetadataSchema,
  rows: z.array(z.unknown()),
  artifacts: z.array(conversationSharePreviewArtifactSchema),
  integrity: conversationShareIntegritySchema,
});
export type ConversationSharePreviewWire = z.infer<typeof conversationSharePreviewDataSchema>;
export type ConversationSharePreview = Omit<ConversationSharePreviewWire, "rows"> & {
  rows: ConversationRow[];
  /** 本端认不出、已跳过的行数；>0 时 UI 必须给「部分内容需要更新 ZCode 查看」软提示。 */
  unsupportedRowCount: number;
};

export const conversationShareContinuationRequestSchema = z
  .object({
    schema_version: z.literal(CONVERSATION_SHARE_SCHEMA_VERSION),
    client_request_id: z.string().trim().min(1),
  })
  .strict();
export type ConversationShareContinuationRequest = z.infer<
  typeof conversationShareContinuationRequestSchema
>;

export const conversationShareContinuationArtifactSchema =
  conversationShareInboundArtifactDescriptorSchema.extend({
    download_url: z.string().url(),
    download_url_expires_at: z.number().int().nonnegative(),
  });

export const conversationShareContinuationDataSchema = z.object({
  schema_version: conversationShareSchemaVersionSchema,
  import_grant_id: z.string().trim().min(1),
  import_grant_expires_at: z.number().int().nonnegative(),
  share: conversationSharePublicMetadataSchema.extend({
    share_id: z.string().trim().min(1),
  }),
  rows: z.array(z.unknown()),
  artifacts: z.array(conversationShareContinuationArtifactSchema),
  integrity: conversationShareIntegritySchema,
});
export type ConversationShareContinuationWire = z.infer<
  typeof conversationShareContinuationDataSchema
>;
export type ConversationShareContinuation = Omit<ConversationShareContinuationWire, "rows"> & {
  rows: ConversationRow[];
  /** 未解析的原始 rows：落盘只读副本时按原样保存，避免未知字段被本端永久抹掉。 */
  rawRows: readonly unknown[];
  /** 本端认不出、已跳过的行数；>0 时 UI 必须给「部分内容需要更新 ZCode 查看」软提示。 */
  unsupportedRowCount: number;
};

/** 本端已知的业务错误码；wire 上不做枚举校验，未知码保留服务端 msg 并落 unknown。 */
export const conversationShareKnownErrorCodeSchema = z.union([
  z.literal(3001),
  z.literal(3002),
  z.literal(3200),
  z.literal(3201),
  z.literal(3203),
  z.literal(3204),
  z.literal(3205),
  z.literal(3206),
  z.literal(3207),
  z.literal(3208),
  z.literal(3209),
  z.literal(3210),
  z.literal(3211),
  z.literal(3212),
  z.literal(3213),
  z.literal(3214),
  z.literal(3215),
]);
export type ConversationShareApiErrorCode = z.infer<typeof conversationShareKnownErrorCodeSchema>;

/**
 * 错误信封对 code 不设枚举：后端上线一个新业务码时，老客户端应该照样能拿到服务端 msg，
 * 而不是整条信封解析失败、退化成没有上下文的 "HTTP 4xx"。
 */
export const conversationShareErrorEnvelopeSchema = z.object({
  code: z.number().int(),
  msg: z.string(),
});
export type ConversationShareErrorEnvelope = z.infer<typeof conversationShareErrorEnvelopeSchema>;

export function createConversationShareSuccessEnvelopeSchema<TSchema extends z.ZodType>(
  dataSchema: TSchema,
) {
  return z.object({
    code: z.literal(0),
    // msg 曾是 z.literal("")：后端哪天回个 "ok" 就会把所有成功响应判成契约错误。
    msg: z.string(),
    data: dataSchema,
  });
}
