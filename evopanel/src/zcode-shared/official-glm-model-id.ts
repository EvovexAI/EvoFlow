// 只供官方模型名单、telemetry 模型白名单与单向迁移入口使用；不能用于 Registry 比较或通用请求改写。
const canonicalIds = [
  "GLM-5.3",
  "GLM-5.3-Flash",
  "GLM-5V-Turbo",
  "GLM-5.2",
  "GLM-5.1",
  "GLM-5.1-Highspeed",
  "GLM-5",
  "GLM-5-Turbo",
  "GLM-4.7",
  "GLM-4.7-FlashX",
  "GLM-4.7-Flash",
  "GLM-4.6",
  "GLM-4.5-Air",
  "GLM-4.5",
  "GLM-4.6V",
  "GLM-4.6V-Flash",
  "GLM-4.6V-FlashX",
  "GLM-4.1V-Thinking-FlashX",
  "GLM-4.1V-Thinking-Flash",
  "GLM-4-FlashX-250414",
  "GLM-4-Flash-250414",
  "GLM-4V-Flash",
];
const byLowercase = new Map(canonicalIds.map((id) => [id.toLowerCase(), id]));

/** 官方 GLM 模型规范 ID 名单；telemetry 白名单以此为来源，新增官方模型时同步进入白名单。 */
export const OFFICIAL_GLM_MODEL_IDS: readonly string[] = canonicalIds;

export function normalizeOfficialGlmModelId(modelId: string): string {
  return byLowercase.get(modelId.toLowerCase()) ?? modelId;
}
