/* oxlint-disable eslint(max-lines) -- Composer 附件的收集、恢复和序列化必须共享同一套 MIME/大小边界。 */
import { nanoid } from "nanoid";
import {
  VIDEO_INPUT_MAX_BYTES,
  type CreateTempTextAttachmentResult,
  type ZCodePromptAttachment,
} from "@zcode/shared";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import {
  OversizedInlineImageAttachmentError,
  OversizedInlinePdfAttachmentError,
  OversizedInlineVideoAttachmentError,
} from "@/lib/chatAttachmentErrors.js";
import {
  basenameFromPath,
  countClipboardTextLines,
  createClipboardTextAttachmentFilename,
  inferAttachmentMimeType,
  isTextLikeAttachment,
} from "@/lib/chatAttachmentMetadata.js";

export {
  MissingInlineImageContentError,
  MissingInlinePdfContentError,
  OversizedInlineImageAttachmentError,
  OversizedInlinePdfAttachmentError,
  OversizedInlineVideoAttachmentError,
} from "@/lib/chatAttachmentErrors.js";
export {
  countClipboardTextLines,
  formatAttachmentSize,
  shouldPreferSpreadsheetClipboardText,
} from "@/lib/chatAttachmentMetadata.js";

export const MAX_CHAT_ATTACHMENTS = 8;
const LONG_PASTE_TEXT_ATTACHMENT_CHAR_THRESHOLD = 15 * 1024;
const INLINE_IMAGE_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
const INLINE_VIDEO_ATTACHMENT_MAX_BYTES = Math.min(
  VIDEO_INPUT_MAX_BYTES,
  PROTOCOL_V4_LIMITS.attachmentMaxBytes,
);
const INLINE_TEXT_ATTACHMENT_MAX_CHARS = 64 * 1024;

export type ChatComposerAttachmentSourceKind = "clipboard-text";

export interface ChatComposerAttachment {
  id: string;
  file?: File;
  filename: string;
  sourceKind?: ChatComposerAttachmentSourceKind;
  lineCount?: number;
  charCount?: number;
  mimeType: string;
  sizeBytes: number;
  objectUrl?: string;
  localPath?: string;
}

const PDF_MIME_TYPE = "application/pdf";

function normalizeComposerMimeType(mimeType: string): string {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return normalized === PDF_MIME_TYPE ? PDF_MIME_TYPE : mimeType;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("读取附件失败"));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("读取附件失败"));
    };
    reader.readAsDataURL(file);
  });
}

export function createChatComposerAttachment(
  file: File,
  localPath?: string,
): ChatComposerAttachment {
  const mimeType = normalizeComposerMimeType(file.type || inferAttachmentMimeType(file.name));
  return {
    id: nanoid(),
    file,
    filename: file.name,
    localPath,
    mimeType,
    objectUrl: URL.createObjectURL(file),
    sizeBytes: file.size,
  };
}

export function createChatComposerPathAttachment(localPath: string): ChatComposerAttachment {
  const filename = basenameFromPath(localPath);
  return {
    id: nanoid(),
    filename,
    localPath,
    mimeType: inferAttachmentMimeType(filename),
    sizeBytes: 0,
  };
}

export function createClipboardTextPathComposerAttachment(
  text: string,
  attachment: CreateTempTextAttachmentResult,
): ChatComposerAttachment {
  return {
    id: nanoid(),
    filename: attachment.filename,
    localPath: attachment.localPath,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    charCount: text.length,
    lineCount: countClipboardTextLines(text),
    sourceKind: "clipboard-text",
  };
}

export function shouldCreateClipboardTextAttachment(text: string): boolean {
  return text.length >= LONG_PASTE_TEXT_ATTACHMENT_CHAR_THRESHOLD;
}

export function createClipboardTextAttachmentFilenameForDate(now: Date = new Date()): string {
  return createClipboardTextAttachmentFilename(now);
}

export function revokeChatComposerAttachment(attachment: ChatComposerAttachment) {
  if (attachment.objectUrl) {
    URL.revokeObjectURL(attachment.objectUrl);
  }
}

export async function serializeChatComposerAttachment(
  attachment: ChatComposerAttachment,
): Promise<ZCodePromptAttachment> {
  const mimeType = normalizeComposerMimeType(
    attachment.mimeType || inferAttachmentMimeType(attachment.filename),
  );
  if (mimeType.startsWith("image/")) {
    if (!attachment.localPath && attachment.sizeBytes > INLINE_IMAGE_ATTACHMENT_MAX_BYTES) {
      // 这里是底层序列化边界，不能直接拼用户可见中文文案；
      // 抛结构化错误交给 UI 层按当前 locale 格式化，避免英文环境混入中文。
      throw new OversizedInlineImageAttachmentError({
        filename: attachment.filename,
        maxSizeBytes: INLINE_IMAGE_ATTACHMENT_MAX_BYTES,
        sizeBytes: attachment.sizeBytes,
      });
    }

    if (
      attachment.localPath &&
      (!attachment.file || attachment.sizeBytes > INLINE_IMAGE_ATTACHMENT_MAX_BYTES)
    ) {
      // 大图片如果在 renderer 里转 base64，会同时放大内存和 RPC payload。
      // 有真实本地路径时改交给 agent 的图片读取链路，它已有 20MiB 等阈值和降级策略。
      return {
        kind: "image",
        filename: attachment.filename,
        localPath: attachment.localPath,
        mimeType,
        sizeBytes: attachment.sizeBytes,
      };
    }

    const dataBase64 = await readAttachmentBase64(attachment);
    return {
      kind: "image",
      filename: attachment.filename,
      mimeType,
      dataBase64,
      ...(attachment.localPath ? { localPath: attachment.localPath } : {}),
      sizeBytes: attachment.sizeBytes,
    };
  }

  // video：桌面 localPath 零拷贝；Web inline 在 base64 编码前遵守 V4 现有 transport 上限。
  if (mimeType.startsWith("video/")) {
    if (attachment.localPath) {
      return {
        kind: "video",
        filename: attachment.filename,
        localPath: attachment.localPath,
        mimeType,
        sizeBytes: attachment.sizeBytes,
      };
    }
    // Web 无 localPath 时曾按全局 video 产品上限放行，完成整文件 base64 编码后
    // 才被 V4 20MiB 上传边界拒绝，既浪费内存又只能展示裸协议错误。
    if (attachment.sizeBytes > INLINE_VIDEO_ATTACHMENT_MAX_BYTES) {
      throw new OversizedInlineVideoAttachmentError({
        filename: attachment.filename,
        maxSizeBytes: INLINE_VIDEO_ATTACHMENT_MAX_BYTES,
        sizeBytes: attachment.sizeBytes,
      });
    }
    const dataBase64 = await readAttachmentBase64(attachment);
    return {
      kind: "video",
      filename: attachment.filename,
      mimeType,
      dataBase64,
      sizeBytes: attachment.sizeBytes,
    };
  }

  if (mimeType.split(";", 1)[0]?.trim().toLowerCase() === PDF_MIME_TYPE) {
    if (attachment.localPath) {
      return {
        kind: "pdf",
        filename: attachment.filename,
        localPath: attachment.localPath,
        mimeType,
        sizeBytes: attachment.sizeBytes,
      };
    }
    if (attachment.sizeBytes > PROTOCOL_V4_LIMITS.attachmentMaxBytes) {
      throw new OversizedInlinePdfAttachmentError({
        filename: attachment.filename,
        maxSizeBytes: PROTOCOL_V4_LIMITS.attachmentMaxBytes,
        sizeBytes: attachment.sizeBytes,
      });
    }
    const dataBase64 = await readAttachmentBase64(attachment);
    return {
      kind: "pdf",
      filename: attachment.filename,
      mimeType,
      dataBase64,
      sizeBytes: attachment.sizeBytes,
    };
  }

  if (attachment.localPath) {
    // 普通文件过去会被 renderer 读成 base64 再进入 session/send，
    // 既占用内存也绕过 agent 侧文件读取阈值。桌面端已有真实路径时只传路径引用。
    return {
      kind: "file",
      filename: attachment.filename,
      localPath: attachment.localPath,
      mimeType,
      ...(attachment.sourceKind === "clipboard-text" ? { sourceKind: "clipboard-text" } : {}),
      sizeBytes: attachment.sizeBytes,
    };
  }

  const textContent =
    attachment.file && isTextLikeAttachment(attachment)
      ? await readAttachmentText(attachment.file)
      : undefined;
  return {
    kind: "file",
    filename: attachment.filename,
    mimeType,
    sizeBytes: attachment.sizeBytes,
    ...(textContent !== undefined ? { textContent } : {}),
  };
}

async function readAttachmentBase64(attachment: ChatComposerAttachment): Promise<string> {
  if (!attachment.file) {
    throw new Error("附件缺少可读取内容");
  }
  const dataUrl = await readFileAsDataUrl(attachment.file);
  const base64MarkerIndex = dataUrl.indexOf(",");
  if (base64MarkerIndex === -1) {
    throw new Error("附件数据格式不正确");
  }
  return dataUrl.slice(base64MarkerIndex + 1);
}

export function isImageChatComposerAttachment(attachment: ChatComposerAttachment): boolean {
  return attachment.mimeType.startsWith("image/");
}

export function isVideoChatComposerAttachment(attachment: ChatComposerAttachment): boolean {
  return attachment.mimeType.startsWith("video/");
}

export function isPdfChatComposerAttachment(attachment: ChatComposerAttachment): boolean {
  return attachment.mimeType.split(";", 1)[0]?.trim().toLowerCase() === PDF_MIME_TYPE;
}

/** 图片与视频同属媒体组：输入框与消息流统一按媒体卡片渲染。 */
export function isMediaChatComposerAttachment(attachment: ChatComposerAttachment): boolean {
  return isImageChatComposerAttachment(attachment) || isVideoChatComposerAttachment(attachment);
}

async function readAttachmentText(file: File): Promise<string> {
  const text = await file.text();
  return text.length > INLINE_TEXT_ATTACHMENT_MAX_CHARS
    ? `${text.slice(0, INLINE_TEXT_ATTACHMENT_MAX_CHARS)}\n\n[内容过长，已截断]`
    : text;
}
