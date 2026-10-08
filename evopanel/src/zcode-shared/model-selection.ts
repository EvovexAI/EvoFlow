import { z } from "zod";

/** 用户对后续模型执行的完整选择；不表达已经创建的 Active Model。 */
export const modelSelectionSchema = z
  .object({
    providerId: z.string().trim().min(1),
    modelId: z.string().trim().min(1),
    options: z
      .object({
        reasoningLevel: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ModelSelection = z.infer<typeof modelSelectionSchema>;

/** 公共解析结果。页面可以展示不完整选择，执行入口必须同时检查 selectionIssue。 */
export interface EffectiveModelSelectionResult {
  readonly effectiveSelection: ModelSelection | null;
  readonly selectionIssue?:
    | "selection-missing"
    | "account-connection-unavailable"
    | "provider-not-found"
    | "model-not-found"
    | "reasoning-level-missing"
    | "reasoning-level-not-supported";
}

export const ZCODE_MODEL_REASONING_SEPARATOR = "$";

/** UI Picker/legacy CLI 的展示值；不是可逆的 ModelSelection 序列化格式。 */
export function formatModelPickerValue(selection: ModelSelection | undefined): string {
  // 只在显示边界把未绑定表示为空；实际执行仍校验完整 ModelSelection。
  if (!selection) return "";
  const base = `${selection.providerId}/${selection.modelId}`;
  const reasoningLevel = selection.options?.reasoningLevel;
  return reasoningLevel ? `${base}${ZCODE_MODEL_REASONING_SEPARATOR}${reasoningLevel}` : base;
}

/** 只解析 Picker/legacy 字符串边界；领域状态与协议必须直接保存 ModelSelection。 */
export function parseModelPickerValue(value: string): ModelSelection {
  const normalized = value.trim();
  const providerSeparatorIndex = normalized.indexOf("/");
  if (providerSeparatorIndex <= 0) {
    throw new Error(`模型选择缺少 Provider: ${normalized}`);
  }
  const providerId = normalized.slice(0, providerSeparatorIndex);
  const rawModelId = normalized.slice(providerSeparatorIndex + 1);
  const reasoningSeparatorIndex = rawModelId.indexOf(ZCODE_MODEL_REASONING_SEPARATOR);
  if (reasoningSeparatorIndex <= 0 || reasoningSeparatorIndex >= rawModelId.length - 1) {
    return modelSelectionSchema.parse({ providerId, modelId: rawModelId });
  }
  return modelSelectionSchema.parse({
    providerId,
    modelId: rawModelId.slice(0, reasoningSeparatorIndex),
    options: { reasoningLevel: rawModelId.slice(reasoningSeparatorIndex + 1) },
  });
}
