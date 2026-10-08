const SHARE_CONTEXT_BLOCK_PATTERN =
  /(?:\n\n)?# zcode-share-context:\n```zcode-share-context\n([\s\S]*?)\n```\s*$/u;

interface ConversationShareContextReference {
  contextId: string;
  shareUrl: string;
}

/**
 * 从会话 snapshot 里取出仍可 attach 的 share handover context。
 *
 * 刻意只吃 snapshot（不接受独立参数）：这条线断过一次——composer 原本读一个平行的
 * sharedContextImport prop，而 SessionPane 从没传，于是首条消息永远不带 sharedContextRefs，
 * CLI 侧 pending→reserved→attached 一步都走不了，模型拿不到分享内容（顶部只读块却照常显示，
 * 所以肉眼看不出来）。snapshot 是 composer 必然拿到的东西，从它推导就不可能再漏接。
 *
 * legacy 形状（只有 title、没有 contextId）返回 null：没有 contextId 就无法构造
 * sharedContextRefs，attach 也就无从谈起。
 */
export function resolveAttachableShareContext(
  sharedContextImport:
    | { contextId: string; title: string; shareUrl: string; status: string }
    | { title: string }
    | null
    | undefined,
): { contextId: string; title: string; shareUrl: string; status: string } | null {
  if (!sharedContextImport || !("contextId" in sharedContextImport)) return null;
  return sharedContextImport.status === "discarded" ? null : sharedContextImport;
}

function isReference(value: unknown): value is ConversationShareContextReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => key !== "contextId" && key !== "shareUrl")) return false;
  if (typeof candidate.contextId !== "string" || typeof candidate.shareUrl !== "string")
    return false;
  try {
    const url = new URL(candidate.shareUrl);
    return /^\/cn\/share\/[^/]+$/u.test(url.pathname) && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/**
 * 从可见正文里剥掉历史消息可能带的 share URL 尾块。
 *
 * 这个块已经不再产出：它纯粹是 renderer 自产自销（CLI/shared 里没有任何消费者），唯一作用
 * 是驱动一个已被裁掉的 chip，代价却是把 share URL 塞进发给模型的正文。写入端已删除，这里
 * 只保留读取端，避免「接线修复到 chip 删除」之间发出的消息把裸 markup 当正文显示出来。
 */
export function parseConversationShareContext(text: string): {
  visibleContent: string;
  reference: ConversationShareContextReference | null;
} {
  const match = text.match(SHARE_CONTEXT_BLOCK_PATTERN);
  if (!match) return { visibleContent: text, reference: null };
  try {
    const parsed: unknown = JSON.parse(match[1] ?? "");
    return isReference(parsed)
      ? { visibleContent: text.slice(0, match.index).trimEnd(), reference: parsed }
      : { visibleContent: text, reference: null };
  } catch {
    return { visibleContent: text, reference: null };
  }
}
