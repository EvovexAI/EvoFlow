import type { IServiceAccessor } from "@zcode/services";
import type { EnterpriseCodingPlanPricingProduct, ProviderFamilyDomain } from "@zcode/shared";
import { logger } from "@/logger.js";

type EnterprisePricingProductsResult =
  | { status: "success"; productList: EnterpriseCodingPlanPricingProduct[] }
  | { status: "error" };

export async function getEnterprisePricingProducts(
  services: IServiceAccessor,
  domain: ProviderFamilyDomain,
): Promise<EnterprisePricingProductsResult> {
  // 两个账号域均须按自身 Family 查询；失败与明确空列表分开，不能据此自动改掉已有连接。
  try {
    const pricing = await services.codingPlanSubscriptionService.getEnterprisePricing({
      authenticated: true,
      family: domain,
    });
    return { status: "success", productList: pricing.productList };
  } catch (error) {
    logger.warn("[Root] 刷新登录后团队套餐失败", { domain, error });
    return { status: "error" };
  }
}

export async function getEnterprisePricingProductsOrEmpty(
  services: IServiceAccessor,
  domain: ProviderFamilyDomain,
): Promise<EnterpriseCodingPlanPricingProduct[]> {
  const pricing = await getEnterprisePricingProducts(services, domain);
  return pricing.status === "success" ? pricing.productList : [];
}
