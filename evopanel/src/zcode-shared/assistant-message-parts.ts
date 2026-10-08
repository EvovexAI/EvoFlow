export type ZCodeAssistantMessagePart =
  | {
      type: "content";
      content: string;
    }
  | {
      type: "thought";
      content: string;
    }
  | {
      type: "tool-call";
      toolId: string;
    };

export function appendAssistantMessagePart(
  parts: readonly ZCodeAssistantMessagePart[] | undefined,
  nextPart: ZCodeAssistantMessagePart,
) {
  const currentParts = parts ?? [];
  const lastPart = currentParts[currentParts.length - 1];

  // UI latestPart 和第三方完成消息都依赖消息 part 边界。
  // 连续文本 chunk 必须合并成同一个 content/thought part，否则第三方会按 token 边界误判最新正文。
  if (
    lastPart &&
    lastPart.type === nextPart.type &&
    (lastPart.type === "content" || lastPart.type === "thought") &&
    (nextPart.type === "content" || nextPart.type === "thought")
  ) {
    return [
      ...currentParts.slice(0, -1),
      {
        ...lastPart,
        content: lastPart.content + nextPart.content,
      },
    ];
  }

  return [...currentParts, nextPart];
}

export function getLatestAssistantContentPart(parts: readonly ZCodeAssistantMessagePart[]) {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part?.type === "content") {
      return part;
    }
  }
  return null;
}

export function getLatestAssistantContentText(parts: readonly ZCodeAssistantMessagePart[]) {
  return getLatestAssistantContentPart(parts)?.content ?? "";
}
