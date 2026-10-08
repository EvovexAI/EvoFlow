import type { ModelSelectionGhostReason } from "./model-selection-types.js";
import { decodeCustomModelValue } from "./custom-model-value.js";
import type { ZCodeProvider } from "./zcode-task-types-core.js";

export const NATIVE_SUPPLIER_KEY_PREFIX = "native:";
export const CUSTOM_SUPPLIER_KEY_PREFIX = "custom:";
export const GHOST_SUPPLIER_KEY_PREFIX = "ghost:";

const TRAILING_SLASHES_RE = /\/+$/;
const MAX_ENCODED_GHOST_IDENTITY_LENGTH = 160;

function fnv1a32(value: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
    hash >>>= 0;
  }
  return hash >>> 0;
}

function hash12(value: string): string {
  const high = fnv1a32(value, 0x811c9dc5).toString(16).padStart(8, "0");
  const low = fnv1a32(value, 0x9e3779b1).toString(16).padStart(8, "0");
  return `${high}${low}`.slice(0, 12);
}

export function normalizeSupplierBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(TRAILING_SLASHES_RE, "");
}

export function buildNativeSupplierKey(zcodeProvider: ZCodeProvider): string {
  return `${NATIVE_SUPPLIER_KEY_PREFIX}${zcodeProvider}`;
}

export function buildCustomSupplierKey(providerId: string): string {
  return `${CUSTOM_SUPPLIER_KEY_PREFIX}${providerId.trim()}`;
}

export function buildGhostSupplierIdentity(rawIdentity: string): string {
  const encodedIdentity = encodeURIComponent(rawIdentity.trim() || "unknown");
  if (encodedIdentity.length <= MAX_ENCODED_GHOST_IDENTITY_LENGTH) {
    return encodedIdentity;
  }

  // ghost identity 可能包含长 URL，直接拼 key 会放大状态串并污染日志。
  // 超长时退化成稳定摘要，避免 selectedSupplierKey 无限增长。
  return `hash=${hash12(rawIdentity)}`;
}

export function buildGhostSupplierKey(
  zcodeProvider: ZCodeProvider,
  reason: ModelSelectionGhostReason,
  rawIdentity: string,
): string {
  return [
    GHOST_SUPPLIER_KEY_PREFIX,
    zcodeProvider,
    ":",
    reason,
    ":",
    buildGhostSupplierIdentity(rawIdentity),
  ].join("");
}

export function resolveSupplierKeyFromModelDisplayValue(
  zcodeProvider: ZCodeProvider,
  value: string | boolean | undefined,
): string {
  const customModel = decodeCustomModelValue(String(value ?? ""));
  if (customModel?.providerId) {
    return buildCustomSupplierKey(customModel.providerId);
  }

  return buildNativeSupplierKey(zcodeProvider);
}
