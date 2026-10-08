const SPREADSHEET_CLIPBOARD_HTML_PATTERN =
  /(?:<table\b|urn:schemas-microsoft-com:office:excel|\bExcel\.Sheet\b|\bMicrosoft\s+Excel\b|\bmso-(?:number-format|displayed-decimal-separator)\b)/iu;

/**
 * Excel 会同时写入 plain text、HTML 和一张合成 PNG；有表格文本证据时应让文本获胜。
 * 制表符覆盖多列复制，Excel HTML 标记覆盖单单元格和单列复制。
 */
export function shouldPreferSpreadsheetClipboardText(text: string, html: string): boolean {
  if (text.length === 0) return false;
  return text.includes("\t") || SPREADSHEET_CLIPBOARD_HTML_PATTERN.test(html);
}

export function countClipboardTextLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n") {
      lines += 1;
      continue;
    }
    if (char === "\r") {
      lines += 1;
      if (text[index + 1] === "\n") {
        index += 1;
      }
    }
  }
  return lines;
}

export function createClipboardTextAttachmentFilename(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join("");
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map(pad).join("");
  return `pasted-text-${date}-${time}.txt`;
}

export function basenameFromPath(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).pop() ?? path;
}

export function inferAttachmentMimeType(filename: string): string {
  const extension = filename.split(".").pop()?.toLocaleLowerCase() ?? "";
  if (extension === "md") return "text/markdown";
  if (extension === "json") return "application/json";
  if (extension === "csv") return "text/csv";
  if (extension === "txt" || extension === "log") return "text/plain";
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  if (extension === "svg") return "image/svg+xml";
  if (extension === "mp4") return "video/mp4";
  if (extension === "m4v") return "video/x-m4v";
  if (extension === "mov") return "video/quicktime";
  if (extension === "webm") return "video/webm";
  if (extension === "mkv") return "video/x-matroska";
  if (extension === "avi") return "video/x-msvideo";
  if (extension === "pdf") return "application/pdf";
  return "application/octet-stream";
}

export function isTextLikeAttachment(attachment: { filename: string; mimeType: string }): boolean {
  const mimeType = attachment.mimeType || inferAttachmentMimeType(attachment.filename);
  if (mimeType.startsWith("text/")) {
    return true;
  }

  return /\.(cjs|conf|cpp|cs|css|csv|go|h|hpp|html|ini|java|js|json|jsx|log|md|mjs|py|rs|sh|sql|toml|ts|tsx|txt|xml|yaml|yml)$/iu.test(
    attachment.filename,
  );
}

export function formatAttachmentSize(sizeBytes: number): string {
  const mib = sizeBytes / (1024 * 1024);
  return mib >= 1 ? `${mib.toFixed(mib >= 10 ? 0 : 1)} MB` : `${Math.ceil(sizeBytes / 1024)} KB`;
}
