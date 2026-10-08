/**
 * Provider / Model 配置中的 ID、URL、密钥和 JSON 是技术字段，不是自然语言。
 * 统一禁用拼写检查和自动改写，避免模型 ID 出现误导性红线或被系统改写。
 */
export const TECHNICAL_INPUT_ATTRIBUTES = {
  autoCapitalize: "none",
  autoComplete: "off",
  autoCorrect: "off",
  spellCheck: false,
} as const;
