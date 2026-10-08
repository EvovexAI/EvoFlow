// 附件命令面（UI 侧）：ZCodePromptAttachment（composer 序列化产物）→ AttachmentRef
// （v4 sendText/createSession attachments 引用模型）。
//
// 分派规则（与 CLI attachment-refs.ts 的映射对偶）：
// - localPath（desktop 主流：native picker / 拖拽 getPathForFile / 长粘贴临时文件 /
//   oversized 大图路径降级）→ ref 直接携带绝对路径，零上传；
// - dataBase64（粘贴截图等内联图）→ 高层 put（内部 begin/chunk/commit）→ artifact ref；
// - textContent（无路径文本，web 回退面）→ 编码后同走 put；
// - 三者皆无（元信息-only）→ 丢弃并告警（无内容可发，不伪造引用）。
import type { ZCodePromptAttachment } from "@zcode/shared";
import type {
  AttachmentRef,
  V4AttachmentPutParams,
  V4AttachmentPutResult,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import type { AttachmentUploadOptions } from "@/v4/attachmentUploadTransaction.js";

export type AttachmentPutFn = (
  params: V4AttachmentPutParams,
  options?: AttachmentUploadOptions,
) => Promise<V4AttachmentPutResult>;

function encodeTextToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ByteLength(dataBase64: string): number {
  const padding = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
  return Math.floor((dataBase64.length * 3) / 4) - padding;
}

/** 单个附件 → AttachmentRef（需要上传时经 chunk transaction）。返回 null = 无内容可发（丢弃）。 */
export async function uploadComposerAttachment(
  put: AttachmentPutFn,
  sessionId: string,
  attachment: ZCodePromptAttachment,
  options?: AttachmentUploadOptions,
): Promise<AttachmentRef | null> {
  const fileName = attachment.filename;
  const mime = attachment.mimeType;
  // audio 变体无 sizeBytes 字段；统一经窄化读取。
  const sizeBytes =
    "sizeBytes" in attachment && typeof attachment.sizeBytes === "number"
      ? attachment.sizeBytes
      : undefined;
  if (attachment.localPath) {
    return {
      ref: attachment.localPath,
      fileName,
      mime,
      bytes: sizeBytes ?? 0,
    };
  }
  const dataBase64 =
    "dataBase64" in attachment && attachment.dataBase64
      ? attachment.dataBase64
      : "textContent" in attachment && attachment.textContent !== undefined
        ? encodeTextToBase64(attachment.textContent)
        : null;
  if (dataBase64 === null) {
    logger.warn(
      `[v4-composer] 附件无内容可发（无 localPath/dataBase64/textContent），已丢弃: ${fileName}`,
    );
    return null;
  }
  const { ref } = await put({ sessionId, fileName, mime, dataBase64 }, options);
  return {
    ref,
    fileName,
    mime,
    bytes: sizeBytes ?? base64ByteLength(dataBase64),
  };
}
