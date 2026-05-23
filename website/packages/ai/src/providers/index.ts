export const providers = {
  defaultChatModel: "openai:gpt-5.4",
  defaultFastChatModel: "openai:gpt-5.4-mini",
  defaultReasoningModel: "anthropic:claude-sonnet",
  defaultEmbeddingModel: "openai:text-embedding-3-large",
} as const;

export type ProviderKey = keyof typeof providers;
