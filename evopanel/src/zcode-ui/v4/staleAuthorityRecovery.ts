const STALE_AUTHORITY_REASON_CODES = new Set([
  "proto.staleLogEpoch",
  "proto.staleRevision",
  "proto.staleTarget",
]);

function faultReasonCode(value: unknown): string | undefined {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as { status?: unknown; reasonCode?: unknown };
  if (candidate.status !== undefined && candidate.status !== "stale") return undefined;
  return typeof candidate.reasonCode === "string" ? candidate.reasonCode : undefined;
}

/** row command/query 的权威 projection 已跨 revision/epoch/entity 时，统一走 same-sub recovery。 */
export function shouldResyncForStaleAuthority(value: unknown): boolean {
  return STALE_AUTHORITY_REASON_CODES.has(faultReasonCode(value) ?? "");
}
