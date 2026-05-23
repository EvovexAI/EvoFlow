/**
 * Sanitize user input before passing to LLM prompts.
 * Strips common prompt injection patterns and dangerous delimiters.
 */
export function sanitizePromptInput(input: string): string {
  let sanitized = input;

  sanitized = sanitized
    .replace(/```system\b/gi, "```")
    .replace(/\[SYSTEM\]/gi, "")
    .replace(/\[INST\]/gi, "")
    .replace(/\[\/INST\]/gi, "")
    .replace(/<\|im_start\|>/gi, "")
    .replace(/<\|im_end\|>/gi, "")
    .replace(/<\|system\|>/gi, "")
    .replace(/<\|user\|>/gi, "")
    .replace(/<\|assistant\|>/gi, "")
    .replace(/<\|endoftext\|>/gi, "");

  sanitized = sanitized.replace(
    /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?|prompts?|context)/gi,
    "[filtered]",
  );

  sanitized = sanitized.replace(
    /you\s+are\s+now\s+(a|an|the)\s+/gi,
    "[filtered] ",
  );

  return sanitized.trim();
}

type ContentPart = { type: "text"; text: string } | { type: "image"; image: string };
type MessageContent = string | ContentPart[];

/**
 * Sanitize message content that may be a plain string or multi-part array.
 */
export function sanitizeMessageContent(content: MessageContent): MessageContent {
  if (typeof content === "string") return sanitizePromptInput(content);
  return content.map((part) => {
    if (part.type === "text") return { ...part, text: sanitizePromptInput(part.text) };
    return part;
  });
}

/**
 * Extract the text portion from message content (for RAG query, etc.)
 */
export function extractTextContent(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ");
}

/**
 * Filter out system-role messages from client-provided message arrays.
 * On a public site, clients should never inject system messages.
 */
export function filterClientMessages<T extends { role: string }>(
  messages: T[],
): T[] {
  return messages.filter((m) => m.role !== "system");
}
