import type { ProviderConfigObject } from "@zcode/provider";

/** 产品展示例外：套餐 GLM-5.3 的图片输入是服务端桥接，不能把桥接标为原生视觉。 */
export function shouldShowModelVisionBadge(
  modelId: string,
  supportsImage: boolean | null | undefined,
  access?: ProviderConfigObject["access"],
): boolean {
  if (supportsImage !== true) return false;
  // 体验套餐也在展示例外之内；与 Coding Plan 一样只隐藏 GLM-5.3 徽标。
  const hideGlm53Vision =
    access?.type === "zhipu-coding-plan-api-key" ||
    (access?.type === "zhipu-account" &&
      (access.mode === "individual-coding-plan" ||
        access.mode === "team-coding-plan" ||
        access.mode === "start-plan"));
  // 只控制徽标，不改能力事实、附件校验或精确模型身份；Flash 和其他型号不受影响。
  return !(hideGlm53Vision && modelId.toLowerCase() === "glm-5.3");
}
