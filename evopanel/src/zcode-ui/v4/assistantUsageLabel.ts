import type { AssistantUsage } from "@zcode/shared/zcode-protocol-v4";

// 复刻旧版气泡 meta 的用量串（chat-normalize.js 的 formatUsageTokenStr /
// formatUsageTokenTitle）：`↑in ↓out · ⚡cacheRead`，缺明细退 `N tokens`，
// 数字保持原始整数（对齐旧 AnimatedTokenInline 展示，不做 K/M 压缩）。
export function formatAssistantUsageLabel(
  usage: AssistantUsage | null | undefined,
): string | null {
  if (!usage) return null;
  const input = Number(usage.inputTokens) || 0;
  const output = Number(usage.outputTokens) || 0;
  const total = Number(usage.totalTokens) || input + output;
  if (input <= 0 && output <= 0 && total <= 0) return null;
  const base = input > 0 && output > 0 ? `↑${input} ↓${output}` : `${total} tokens`;
  const cacheRead = Number(usage.cacheReadTokens) || 0;
  return cacheRead > 0 ? `${base} · ⚡${cacheRead}` : base;
}

// hover 明细：中文文案对齐旧版 formatUsageTokenTitle；
// 厂商未报缓存（read/write 均无）时不显示明细——不能把全部输入反推成「未命中」。
export function formatAssistantUsageTitle(
  usage: AssistantUsage | null | undefined,
): string | null {
  if (!usage) return null;
  const input = Number(usage.inputTokens) || 0;
  const cacheRead = Number(usage.cacheReadTokens) || 0;
  const cacheWrite = Number(usage.cacheWriteTokens) || 0;
  if (cacheRead <= 0 && cacheWrite <= 0) return null;
  const parts: string[] = [];
  if (cacheRead > 0) parts.push(`缓存命中 ${cacheRead}`);
  if (cacheWrite > 0) parts.push(`写入缓存 ${cacheWrite}`);
  const cacheMiss = input - cacheRead - cacheWrite;
  if (cacheMiss > 0) parts.push(`未命中 ${cacheMiss}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
