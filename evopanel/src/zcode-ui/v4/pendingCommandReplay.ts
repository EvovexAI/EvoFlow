import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";

export type PendingCommandReplay =
  | {
      kind: "input";
      type: "sendText" | "sendGoalCommand" | "compact" | "createSession";
      payload: Record<string, unknown>;
      baseRevision?: number;
    }
  | {
      kind: "sensitiveDigest";
      type:
        | "resolveInteraction"
        | "respondWorkspaceHookReview"
        | "toggleWorkspaceHookReviewItem"
        | "revokeWorkspaceHookTrust";
      digest: string;
    };

export function pendingCommandReplayFor(envelope: CommandEnvelope): PendingCommandReplay | null {
  if (
    envelope.type === "sendText" ||
    envelope.type === "sendGoalCommand" ||
    envelope.type === "compact"
  ) {
    return {
      kind: "input",
      type: envelope.type,
      payload: clonePayload(envelope.payload),
      ...(envelope.baseRevision !== undefined ? { baseRevision: envelope.baseRevision } : {}),
    };
  }
  if (envelope.type === "createSession") {
    const payload = envelope.payload as Record<string, unknown>;
    if (!("firstInput" in payload)) return null;
    return {
      kind: "input",
      type: "createSession",
      payload: clonePayload(payload),
    };
  }
  if (
    envelope.type === "resolveInteraction" ||
    envelope.type === "respondWorkspaceHookReview" ||
    envelope.type === "toggleWorkspaceHookReviewItem" ||
    envelope.type === "revokeWorkspaceHookTrust"
  ) {
    return {
      kind: "sensitiveDigest",
      type: envelope.type,
      digest: digestSensitivePayload(envelope.payload),
    };
  }
  return null;
}

function clonePayload(payload: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 非安全校验摘要；目的只是对账时识别 payload，绝不用于鉴权。 */
function digestSensitivePayload(payload: unknown): string {
  const text = stableJson(payload);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
