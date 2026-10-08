import { z } from "zod";
import { modelConfigDataSchema } from "@zcode/shared/model-config";
import { manualModelConfigSchema } from "./manual-model-config.js";
export { manualModelConfigSchema, type ManualModelConfig } from "./manual-model-config.js";
import {
  apiKeyAccessDataSchema,
  personalProviderApiDataSchema,
  providerConfigDataSchema,
  providerGroupDataSchema,
  providerTemplateDataSchema,
} from "./provider-data-schema.js";

const idSchema = z.string().min(1);
const patternSchema = z
  .string()
  .min(1)
  .refine((pattern) => {
    try {
      new RegExp(`^(?:${pattern})$`);
      return true;
    } catch {
      return false;
    }
  }, "无效匹配正则");

export const modelMatchConfigRuleSchema = z
  .object({
    modelMatch: patternSchema,
    config: modelConfigDataSchema,
  })
  .strict();
export const modelApiMatchConfigRuleSchema = modelMatchConfigRuleSchema.extend({
  apiTypeMatch: patternSchema,
});
export const providerSiteMatchConfigRuleSchema = modelMatchConfigRuleSchema.extend({
  baseUrlMatch: patternSchema,
  apiTypeMatch: patternSchema.optional(),
});
export const templateModelConfigRuleSchema = z
  .object({
    templateId: idSchema,
    modelId: idSchema,
    config: modelConfigDataSchema,
  })
  .strict();
export const providerModelConfigRuleSchema = templateModelConfigRuleSchema
  .omit({ templateId: true })
  .extend({
    providerId: idSchema,
  });
export const manualProviderModelConfigRuleSchema = providerModelConfigRuleSchema.extend({
  config: manualModelConfigSchema,
});

export const builtinModelConfigRulesSchema = z
  .object({
    modelRules: z.array(modelMatchConfigRuleSchema),
    modelApiRules: z.array(modelApiMatchConfigRuleSchema),
    providerSiteRules: z.array(providerSiteMatchConfigRuleSchema),
    templateModelRules: z.array(templateModelConfigRuleSchema),
    builtinProviderModelRules: z.array(providerModelConfigRuleSchema),
  })
  .strict();
export const personalModelConfigRulesSchema = z
  .object({
    providerModelRules: z.array(providerModelConfigRuleSchema),
    manualProviderModelRules: z.array(manualProviderModelConfigRuleSchema),
  })
  .strict()
  .superRefine((rules, context) => {
    // 不能通过最后一次覆盖掩盖矛盾模式；身份用元组编码，避免模型 ID 自带分隔符碰撞。
    const smartIds = new Set(
      rules.providerModelRules.map((rule) => JSON.stringify([rule.providerId, rule.modelId])),
    );
    rules.manualProviderModelRules.forEach((rule, index) => {
      if (smartIds.has(JSON.stringify([rule.providerId, rule.modelId]))) {
        context.addIssue({
          code: "custom",
          path: ["manualProviderModelRules", index],
          message: "同一 Provider/Model 不能同时声明智能和手动配置",
        });
      }
    });
  });

// 身份、模板引用和实例名属于规则，不再成为可向执行配置叠加的叶子。
export const providerConfigRuleSchema = z
  .object({
    providerId: idSchema,
    templateId: idSchema.nullable().optional(),
    providerName: idSchema.nullable().optional(),
    enabled: z.boolean().optional(),
    config: providerConfigDataSchema,
  })
  .strict();
export const providerTemplateConfigRuleSchema = providerTemplateDataSchema.extend({
  config: providerConfigDataSchema
    .pick({ logo: true, access: true, api: true, builtinModelIds: true })
    .extend({
      access: apiKeyAccessDataSchema.omit({ apiKey: true }).nullable().optional(),
    }),
});
export const builtinProviderConfigRuleSchema = providerConfigRuleSchema.extend({
  config: providerConfigDataSchema.omit({ personalModelIds: true, modelOrder: true }).extend({
    group: providerGroupDataSchema.exclude(["standard-personal"]),
  }),
});
const personalProviderConfigRuleSchema = providerConfigRuleSchema
  .extend({
    config: providerConfigDataSchema.omit({ builtinModelIds: true }).extend({
      group: providerGroupDataSchema.extract(["standard-personal"]).nullable().optional(),
      api: personalProviderApiDataSchema.nullable().optional(),
    }),
  })
  .superRefine((rule, context) => {
    if (rule.providerId.startsWith("account:") && rule.config.access !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["config", "access"],
        message: "固定 Account Provider 的 Access 只能由 ZCode Built-in Config 声明",
      });
    }
  });
export const builtinProviderConfigRulesSchema = z
  .object({
    templateRules: z.array(providerTemplateConfigRuleSchema),
    providerRules: z.array(builtinProviderConfigRuleSchema),
  })
  .strict()
  .superRefine((rules, context) => {
    checkUniqueIds(
      rules.templateRules.map((rule) => rule.templateId),
      "templateRules",
      "templateId",
      context,
    );
    checkUniqueIds(
      rules.providerRules.map((rule) => rule.providerId),
      "providerRules",
      "providerId",
      context,
    );
  });
export const personalProviderConfigRulesSchema = z
  .object({
    providerRules: z.array(personalProviderConfigRuleSchema),
  })
  .strict()
  .superRefine((rules, context) => {
    checkUniqueIds(
      rules.providerRules.map((rule) => rule.providerId),
      "providerRules",
      "providerId",
      context,
    );
  });

function checkUniqueIds(
  ids: readonly string[],
  group: string,
  key: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  ids.forEach((id, index) => {
    if (seen.has(id))
      context.addIssue({
        code: "custom",
        path: [group, index, key],
        message: `重复 ${key}: ${id}`,
      });
    seen.add(id);
  });
}

export type ModelMatchConfigRuleData = z.infer<typeof modelMatchConfigRuleSchema>;
export type ModelApiMatchConfigRuleData = z.infer<typeof modelApiMatchConfigRuleSchema>;
export type ProviderSiteMatchConfigRuleData = z.infer<typeof providerSiteMatchConfigRuleSchema>;
export type TemplateModelConfigRuleData = z.infer<typeof templateModelConfigRuleSchema>;
export type ProviderModelConfigRuleData = z.infer<typeof providerModelConfigRuleSchema>;
export type ManualProviderModelConfigRuleData = z.infer<typeof manualProviderModelConfigRuleSchema>;
export type BuiltinModelConfigRulesData = z.infer<typeof builtinModelConfigRulesSchema>;
export type PersonalModelConfigRulesData = z.infer<typeof personalModelConfigRulesSchema>;
export type ProviderConfigRuleData = z.infer<typeof providerConfigRuleSchema>;
export type ProviderTemplateConfigRuleData = z.infer<typeof providerTemplateConfigRuleSchema>;
