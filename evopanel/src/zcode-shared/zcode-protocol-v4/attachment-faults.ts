// 附件读取/探测的结构化错误码（share 预检与发布的分类依据）。
//
// share 预检曾用 `error.message` 正则区分「附件不存在 / 未授权 / 其他」。
// 一旦 RPC 层包装、本地化或替换消息（例如 schema 校验失败抛 ZodError），分类立即失效
// 并把确定性问题降级成 deferred。仓库纪律（AGENTS.md「不依赖错误文本做流程判断」）
// 要求用稳定错误码，本模块即该契约的单一来源。
//
// 传输路径：CLI 侧抛出的 Error 带 `code` 字段，`toProtocolError` 会把 string code
// 透传到 JSON-RPC `error.data.code`；客户端读回时用 readZCodeAttachmentFaultCode。

export const ZCODE_ATTACHMENT_FAULT_CODES = {
  /** host 未实现 stat 能力。 */
  statUnsupported: "fault.attachment.statUnsupported",
  /** host 未实现读取能力。 */
  readUnsupported: "fault.attachment.readUnsupported",
  /** ref 指向的路径存在但不是普通文件。 */
  statNotFile: "fault.attachment.statNotFile",
  /** share stat 的目标行/ref 不在当前会话投影里，拒绝授权。 */
  shareStatNotAuthorized: "fault.attachment.shareStatNotAuthorized",
  /** share read 的目标行/ref 不在当前会话投影里，拒绝授权。 */
  shareReadNotAuthorized: "fault.attachment.shareReadNotAuthorized",
  /** share stat 所在连接不受信。 */
  shareStatConnectionUntrusted: "fault.attachment.shareStatConnectionUntrusted",
  /** share read 所在连接不受信。 */
  shareReadConnectionUntrusted: "fault.attachment.shareReadConnectionUntrusted",
  /** 附件已从磁盘消失（ENOENT 等确定性缺失）。 */
  shareStatNotFound: "fault.attachment.shareStatNotFound",
  /** 附件真实大小超出 stat 协议能表达的上界。 */
  shareStatTooLarge: "fault.attachment.shareStatTooLarge",
  /** 附件字节数超出预览/读取通道上限，无法搬运。 */
  previewTooLarge: "fault.attachment.previewTooLarge",
  /** 读取结果不是可预览媒体类型。 */
  previewNotMedia: "fault.attachment.previewNotMedia",
} as const;

export type ZCodeAttachmentFaultCode =
  (typeof ZCODE_ATTACHMENT_FAULT_CODES)[keyof typeof ZCODE_ATTACHMENT_FAULT_CODES];

const KNOWN_FAULT_CODES = new Set<string>(Object.values(ZCODE_ATTACHMENT_FAULT_CODES));

export function isZCodeAttachmentFaultCode(value: unknown): value is ZCodeAttachmentFaultCode {
  return typeof value === "string" && KNOWN_FAULT_CODES.has(value);
}

/**
 * 带稳定错误码的附件错误。`code` 是 string，`toProtocolError` 会把它放进
 * JSON-RPC `error.data.code`，因此同进程与跨进程都能按码分类。
 */
export class ZCodeAttachmentFaultError extends Error {
  readonly code: ZCodeAttachmentFaultCode;

  constructor(code: ZCodeAttachmentFaultCode, options?: { cause?: unknown; message?: string }) {
    // message 默认就是 fault 码本身，旧版本客户端的文本匹配仍能命中。
    super(
      options?.message ?? code,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ZCodeAttachmentFaultError";
    this.code = code;
  }
}

/**
 * 从任意错误中读出附件 fault 码：
 * - 同进程抛出的 ZCodeAttachmentFaultError / 带 code 的 Error；
 * - 跨 JSON-RPC 回传的 `error.data.code`；
 * - 旧版本 CLI 只有消息文本时的兼容兜底（见下方注释）。
 */
export function readZCodeAttachmentFaultCode(error: unknown): ZCodeAttachmentFaultCode | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; data?: unknown };
  if (isZCodeAttachmentFaultCode(candidate.code)) return candidate.code;
  if (candidate.data && typeof candidate.data === "object") {
    const data = candidate.data as { code?: unknown };
    if (isZCodeAttachmentFaultCode(data.code)) return data.code;
  }
  // 兼容兜底：桌面端可能连接尚未带结构化 code 的旧 zcode-cli。仅在消息「整体等于」
  // 某个 fault 码时命中，不做模糊匹配，避免把包装后的任意文本误判成确定分类。
  if (error instanceof Error && isZCodeAttachmentFaultCode(error.message)) return error.message;
  return undefined;
}
