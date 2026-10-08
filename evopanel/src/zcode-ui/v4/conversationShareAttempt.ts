import type { ConversationShareAttempt } from "@/store/conversationShareSelectionStore.js";

export type { ConversationShareAttempt } from "@/store/conversationShareSelectionStore.js";

interface ConversationShareAttemptIdFactory {
  now?: () => number;
  randomUUID?: () => string | undefined;
}

export function ensureConversationShareAttempt(
  current: ConversationShareAttempt | null,
  attemptKey: string,
  sessionId: string,
  factory: ConversationShareAttemptIdFactory = {},
): ConversationShareAttempt {
  if (current?.key === attemptKey) return current;

  const now = factory.now ?? Date.now;
  const disclosureAcceptedAt = now();
  const requestSuffix = factory.randomUUID?.() ?? `${sessionId}-${disclosureAcceptedAt}`;

  // 重试时必须复用同一份幂等请求体。之前只复用了 clientRequestId，
  // 却在 SessionPane 每次点击时重新生成 disclosureAcceptedAt，导致 payload_sha256 变化，
  // 服务端将同一个幂等键识别为请求体冲突并返回 409。
  return {
    key: attemptKey,
    clientRequestId: `share-${requestSuffix}`,
    disclosureAcceptedAt,
  };
}
