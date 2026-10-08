/** 从 URL 提取可安全展示的 http(s) 主机名；非 http(s) 或解析失败返回空串。 */
export function resolveSafeEndpointHostname(value: string | null | undefined): string {
  const normalized = value?.trim();
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    return parsed.hostname.toLowerCase();
  } catch {
    return "";
  }
}
