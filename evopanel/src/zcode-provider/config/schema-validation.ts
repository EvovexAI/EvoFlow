import type { z } from "zod";
import type { ConfigValidationIssue } from "../config-overlay.js";

/** 翻译已有问题协议，不维护另一份字段或内容校验清单。 */
export function validateConfigSchema(
  schema: z.ZodType,
  value: unknown,
  path: readonly string[],
  optionSpec = false,
): readonly ConfigValidationIssue[] {
  const result = schema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue): ConfigValidationIssue => {
    const issuePath = [...path, ...issue.path.map(String)];
    let fieldValue: unknown = value;
    for (const key of issue.path) {
      fieldValue =
        fieldValue !== null && typeof fieldValue === "object"
          ? Reflect.get(fieldValue, key)
          : undefined;
    }
    // literal/enum 缺失在 Zod 中是 invalid_value，仍须维持“缺字段”的既有问题分类。
    const missing =
      ((issue.code === "invalid_type" || issue.code === "invalid_value") && fieldValue == null) ||
      (issue.code === "custom" && issue.params?.configIssueCode === "required-field-missing");
    const invalidUrl = issue.code === "invalid_format" && issue.format === "url";
    return {
      code: missing
        ? "required-field-missing"
        : invalidUrl
          ? "invalid-url"
          : optionSpec || issue.path.includes("optionSpecs")
            ? "invalid-option-spec"
            : "invalid-config",
      path: issuePath,
      message: missing
        ? `缺少必填配置 ${issuePath.join(".")}`
        : invalidUrl
          ? `配置 ${issuePath.join(".")} 必须是有效 URL`
          : issue.message,
    };
  });
}
