import { z } from "zod";
import { completeModelConfigDataSchema, modelConfigDataSchema } from "@zcode/shared/model-config";

const complete = completeModelConfigDataSchema.shape;
// 手动模式只冻结产品明确开放的叶子；新增系统字段默认不属于个人手动配置。
export const manualModelConfigSchema = completeModelConfigDataSchema
  .pick({ enabled: true })
  .extend({
    enabled: modelConfigDataSchema.shape.enabled,
    properties: complete.properties
      .pick({
        contextWindow: true,
        supportsJsonSchemaOutput: true,
        supportsNativeWebSearch: true,
        supportsMidConversationSystem: true,
      })
      .extend({
        inputFormat: complete.properties.shape.inputFormat.pick({
          supportsImage: true,
          supportsVideo: true,
          supportsPdf: true,
        }),
      }),
    optionSpecs: complete.optionSpecs.pick({ reasoningLevel: true }).extend({
      maxOutputTokens: complete.optionSpecs.shape.maxOutputTokens.pick({ max: true }),
    }),
  });

export type ManualModelConfig = z.infer<typeof manualModelConfigSchema>;

/** 草稿/旧完整规则提取复用 schema 结构，避免维护第二份可编辑字段清单。 */
export function extractManualModelConfig(input: unknown): ManualModelConfig {
  return manualModelConfigSchema.parse(pickSchemaFields(manualModelConfigSchema, input));
}

/** 保留独立 enabled 和系统叶子；恢复智能配置及规则合成都使用同一字段归属。 */
export function clearManualModelConfig(input: z.infer<typeof modelConfigDataSchema>) {
  return modelConfigDataSchema.parse(
    omitSchemaFields(manualModelConfigSchema.omit({ enabled: true }), input),
  );
}

function omitSchemaFields(schema: z.ZodObject, input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  return Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) => {
      const child = schema.shape[key];
      if (!child) return [[key, value]];
      if (!(child instanceof z.ZodObject) || value == null) return [];
      const remaining = omitSchemaFields(child, value);
      return remaining && typeof remaining === "object" && Object.keys(remaining).length
        ? [[key, remaining]]
        : [];
    }),
  );
}

function pickSchemaFields(schema: z.ZodObject, input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(schema.shape).flatMap(([key, child]) => {
      if (!(key in source)) return [];
      return [
        [key, child instanceof z.ZodObject ? pickSchemaFields(child, source[key]) : source[key]],
      ];
    }),
  );
}
