import {
  ModelConfig,
  ModelConfigRules,
  ModelOptionSpecsConfig,
  type ModelSelection,
  type ProviderRegistryServiceSnapshot,
} from "@zcode/provider";
import { legacyReasoningLevelRenames as renames } from "./legacy-reasoning-level-renames.js";

const oldRulesCache = new WeakMap<ModelConfigRules, ModelConfigRules>();

/** 只为历史 Selection 恢复已知 Built-in 旧值域；不迁移 Personal 配置或在执行层放宽校验。 */
export function resolveLegacyReasoningLevel(
  snapshot: ProviderRegistryServiceSnapshot,
  selection: ModelSelection,
): string | undefined {
  const oldLevel = selection.options?.reasoningLevel;
  if (oldLevel !== "off" && oldLevel !== "nothink") return undefined;
  const personal = snapshot.config.personalModels.getExactRule(
    selection.providerId,
    selection.modelId,
  );
  if (
    personal &&
    (personal.type === "manual-provider-model" ||
      personal.config.optionSpecs?.reasoningLevel?.values !== undefined ||
      personal.config.optionSpecs?.reasoningLevel?.map !== undefined)
  )
    return undefined;
  const provider = snapshot.resolution.effectiveProviders.get(selection.providerId);
  if (!provider) return undefined;
  const builtin = snapshot.config.zcodeBuiltinModelRules;
  let oldRules = oldRulesCache.get(builtin);
  if (!oldRules) {
    oldRules = new ModelConfigRules(
      builtin.rules().map((rule) => {
        // 必须是已裁决的原始无站点/无 API 限制规则；新增同名站点规则不能误继承旧别名。
        const rename =
          rule.type === "model"
            ? renames.find((entry) => entry.modelMatch === rule.modelMatch)
            : undefined;
        const values = rule.config.optionSpecs?.reasoningLevel?.values;
        return rename && values?.includes("disabled")
          ? {
              ...rule,
              config: rule.config.overlay(
                new ModelConfig({
                  optionSpecs: new ModelOptionSpecsConfig({
                    reasoningLevel: {
                      values: values.map((value) =>
                        value === "disabled" ? rename.oldLevel : value,
                      ),
                    },
                  }),
                }),
              ),
            }
          : rule;
      }),
    );
    oldRulesCache.set(builtin, oldRules);
  }
  // 用原规则引擎处理大小写、前后缀、API/站点与后续覆盖，不复制第二套匹配逻辑。
  const values = oldRules.resolve({
    providerId: selection.providerId,
    modelId: selection.modelId,
    templateId: snapshot.resolution.effectiveProviders.getRule(selection.providerId)?.templateId,
    apiType: provider.api?.type,
    baseUrl: provider.api?.baseUrl,
  }).optionSpecs?.reasoningLevel?.values;
  return values?.includes(oldLevel) ? "disabled" : undefined;
}
