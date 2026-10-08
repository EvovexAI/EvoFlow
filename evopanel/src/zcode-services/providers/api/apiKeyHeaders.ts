const STRUCTURED_API_KEY_PATTERN = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const HEADER_VISIBLE_ASCII_PREFIX_PATTERN = /^[\x21-\x7e]+/;

export function normalizeApiKeyForHeader(value: string): string {
  const trimmed = value
    .trim()
    .replace(/^Bearer\s+/i, "")
    .trim();
  const matchedStructuredKey = trimmed.match(STRUCTURED_API_KEY_PATTERN)?.[0];
  if (matchedStructuredKey) {
    return matchedStructuredKey;
  }

  const asciiPrefix = trimmed.match(HEADER_VISIBLE_ASCII_PREFIX_PATTERN)?.[0];
  if (!asciiPrefix) {
    return "";
  }

  // 用户复制 API key 时可能把中文备注一并粘进输入框。
  // fetch header value 必须是 ByteString，发送链路统一截取 ASCII key，避免非 ASCII 字符在构造 Authorization 时直接抛错。
  return asciiPrefix.trim();
}
