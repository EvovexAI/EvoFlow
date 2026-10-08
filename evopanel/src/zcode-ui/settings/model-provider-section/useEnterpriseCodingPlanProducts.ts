import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getModelProviderFamilySpec,
  type CodingPlanStaticTeamProduct,
  type EnterpriseCodingPlanPricingResponse,
  type ProviderFamilyDomain,
} from "@zcode/shared";
import { useOptionalServices } from "@/hooks/useServices.js";
import { isRemoteWorkspaceDisconnectedError } from "@/lib/remoteWorkspaceServiceError.js";
import { logger } from "@/logger.js";
import {
  resolveEnterpriseCodingPlanProductList,
  type EnterpriseCodingPlanProductDisplay,
} from "@/settings/model-provider-section/enterpriseCodingPlanProducts.js";
import { normalizeErrorMessage } from "@/settings/model-provider-section/useCodingPlanProducts.js";

interface EnterpriseCodingPlanProductsState {
  snapshot: EnterpriseCodingPlanProductsSnapshot | null;
  loading: boolean;
  error: string | null;
}

interface EnterpriseCodingPlanProductsSnapshot {
  productList: EnterpriseCodingPlanProductDisplay[];
  raw: EnterpriseCodingPlanPricingResponse;
  authenticated: boolean;
  /** 静态目录控制购买横幅，不能用实时 pricing 补造目录中缺失的商品。 */
  staticProductIds?: string[];
}

function shouldRetainEnterprisePricingSnapshotForRefresh(
  snapshot: EnterpriseCodingPlanProductsSnapshot | null,
  authenticated: boolean,
): boolean {
  return snapshot?.authenticated === authenticated;
}

function resolveEnterprisePricingFailureSnapshot({
  currentSnapshot,
  authenticated,
  staticProducts,
  family = "bigmodel",
}: {
  currentSnapshot: EnterpriseCodingPlanProductsSnapshot | null;
  authenticated: boolean;
  staticProducts: CodingPlanStaticTeamProduct[] | undefined;
  family?: ProviderFamilyDomain;
}): EnterpriseCodingPlanProductsSnapshot | null {
  if (shouldRetainEnterprisePricingSnapshotForRefresh(currentSnapshot, authenticated)) {
    return currentSnapshot;
  }
  if (!Array.isArray(staticProducts)) {
    return null;
  }
  const raw: EnterpriseCodingPlanPricingResponse = { productList: [] };
  return {
    raw,
    productList: tagEnterpriseProductsFamily(
      resolveEnterpriseCodingPlanProductList(staticProducts, raw.productList),
      family,
    ),
    authenticated,
  };
}

/**
 * 给企业套餐展示列表打上 family 标记（zai / bigmodel）。
 * 下游可见性函数（appendSubscribedTeamPlanItems 等）需要按 family
 * 找到对应 codingPlanItem 和 team key 前缀；原列表无 family 字段，只能按
 * bigmodelCodingPlan 派生，导致 zai team plan 无法渲染。
 */
function tagEnterpriseProductsFamily(
  products: EnterpriseCodingPlanProductDisplay[],
  family: ProviderFamilyDomain,
): EnterpriseCodingPlanProductDisplay[] {
  return products.map((product) => ({ ...product, family }));
}

/**
 * 原 hook 只服务 bigmodel family，getStaticTeamProducts 硬编码
 * 读 bigmodelCodingPlan bucket、getEnterprisePricing 不传 family。
 * zai family 对称化后，hook 接受 family 参数：
 *   - 按 family 读 static bucket（zaiCodingPlan / bigmodelCodingPlan）
 *   - 传 family 给 service.getEnterprisePricing，service 据此路由到对应 provider
 * 缺省 family 时保持 bigmodel，向后兼容既有调用点。
 */
export function useEnterpriseCodingPlanProducts({
  enabled,
  authenticated,
  family = "bigmodel",
  staticOnly = false,
}: {
  enabled: boolean;
  /** 未登录购买横幅只读取公开静态目录，不请求实时 pricing。 */
  staticOnly?: boolean;
  authenticated: boolean;
  family?: ProviderFamilyDomain;
}) {
  const services = useOptionalServices();
  const service = services?.codingPlanSubscriptionService;
  const codingPlanProviderId = getModelProviderFamilySpec(family).individualCodingPlanProviderId;
  const [state, setState] = useState<EnterpriseCodingPlanProductsState>({
    snapshot: null,
    loading: enabled,
    error: null,
  });

  const refresh = useCallback(
    async (_options?: { force?: boolean }) => {
      if (!enabled) {
        setState((current) => ({
          snapshot: current.snapshot,
          loading: false,
          error: null,
        }));
        return;
      }
      if (!service) {
        setState({
          snapshot: null,
          loading: false,
          error: "service_unavailable",
        });
        return;
      }

      setState((current) => ({
        // 企业/个人切换和登录态刷新时不应把套餐区域替换成整块 loading；
        // 保留上一轮企业套餐数据，让刷新状态只体现在刷新按钮和卡片局部状态上。
        // 但公开 pricing 与登录态 pricing 的字段语义不同，切换鉴权来源时必须丢弃旧数据，
        // 否则升级 Coding Plan 列表页会继续展示未鉴权的套餐结果。
        snapshot: shouldRetainEnterprisePricingSnapshotForRefresh(current.snapshot, authenticated)
          ? current.snapshot
          : null,
        loading: true,
        error: null,
      }));

      try {
        // 静态目录是展示配置，pricing 是订阅身份与实时价格的权威来源。
        // 两者必须独立请求，避免灰度环境缺少新配置字段时阻断已购 Team Plan 的恢复。
        const [staticResult, pricingResult] = await Promise.allSettled([
          service.getStaticTeamProducts(),
          staticOnly
            ? Promise.resolve<EnterpriseCodingPlanPricingResponse>({ productList: [] })
            : service.getEnterprisePricing({ authenticated, family }),
        ]);
        const staticProducts =
          staticResult.status === "fulfilled"
            ? Object.prototype.hasOwnProperty.call(staticResult.value, codingPlanProviderId)
              ? staticResult.value[codingPlanProviderId]
              : undefined
            : undefined;
        const raw: EnterpriseCodingPlanPricingResponse =
          pricingResult.status === "fulfilled" ? pricingResult.value : { productList: [] };
        const pricingError = pricingResult.status === "rejected" ? pricingResult.reason : null;
        if (pricingError) {
          const message = normalizeErrorMessage(pricingError);
          setState((current) => ({
            // pricing 刷新失败代表实时状态未知，不能用静态目录或空列表覆盖
            // 同鉴权态下上一轮有效的订阅身份与价格；首次失败时才展示静态禁用卡片。
            snapshot: resolveEnterprisePricingFailureSnapshot({
              currentSnapshot: current.snapshot,
              authenticated,
              staticProducts,
              family,
            }),
            loading: false,
            error: message,
          }));
          if (!isRemoteWorkspaceDisconnectedError(pricingError)) {
            logger.warn("[useEnterpriseCodingPlanProducts] 读取企业实时定价失败", {
              authenticated,
              error: message,
            });
          }
          return;
        }
        setState({
          snapshot: {
            raw,
            staticProductIds: staticProducts?.map((product) => product.productId) ?? [],
            productList: tagEnterpriseProductsFamily(
              resolveEnterpriseCodingPlanProductList(staticProducts, raw.productList),
              family,
            ),
            authenticated,
          },
          loading: false,
          error: pricingError ? normalizeErrorMessage(pricingError) : null,
        });
        if (
          staticResult.status === "rejected" &&
          !isRemoteWorkspaceDisconnectedError(staticResult.reason)
        ) {
          logger.warn("[useEnterpriseCodingPlanProducts] 读取团队静态配置失败，回退实时 pricing", {
            authenticated,
            error: normalizeErrorMessage(staticResult.reason),
          });
        }
      } catch (error) {
        const message = normalizeErrorMessage(error);
        // 远端 workspace 壳层会早于 attachment 绑定短暂渲染；此时断连代理报错是
        // 可预期的初始化等待态，不应伪装成 pricing 故障。真实 RPC 错误仍保留 warn。
        if (!isRemoteWorkspaceDisconnectedError(error)) {
          logger.warn("[useEnterpriseCodingPlanProducts] 读取企业 Coding Plan 套餐失败", {
            authenticated,
            error: message,
          });
        }
        setState((current) => ({
          // 企业定价接口失败时如果直接清空 snapshot，
          // 切换到团队套餐页会只剩“暂无可购买的编程套餐”，用户无法分辨是接口失败还是确实无商品。
          // 保留上一轮可见套餐并把错误显式抛给 UI，避免把可恢复的刷新失败伪装成空列表。
          snapshot: shouldRetainEnterprisePricingSnapshotForRefresh(current.snapshot, authenticated)
            ? current.snapshot
            : null,
          loading: false,
          error: message,
        }));
      }
    },
    [authenticated, codingPlanProviderId, enabled, family, service, staticOnly],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return useMemo(
    () => ({
      ...state,
      refresh,
    }),
    [refresh, state],
  );
}
