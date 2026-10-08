/* eslint-disable max-lines -- Coding Plan 套餐需要集中处理静态套餐、远端试算、缓存与登录态回退，避免把共享状态拆散。 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  CODING_PLAN_SYSTEM_BUSY,
  type CodingPlanBatchPreviewResponse,
  type CodingPlanProductPreviewPayment,
  type CodingPlanStaticProduct,
  type CodingPlanStaticProductsConfig,
  type StartPlanPreviewConfig,
  isZaiCodingPlanProviderId,
} from "@zcode/shared";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import {
  normalizeCodingPlanCardCopyItems,
  type CodingPlanProductDisplay,
} from "@/settings/model-provider-section/codingPlanProductPresentation.js";
import type { CodingPlanProviderId } from "@/settings/model-provider-section/constants.js";

interface CodingPlanProductsState {
  snapshot: CodingPlanProductsSnapshot | null;
  loading: boolean;
  error: string | null;
}

type CodingPlanProductsSnapshot = Omit<CodingPlanBatchPreviewResponse, "productList"> & {
  productList: CodingPlanProductDisplay[];
};

const CODING_PLAN_OAUTH_REQUIRED_ERROR = "coding_plan_oauth_required";
const ZAI_START_FREE_PRODUCT_ID = "zai-start-free";
const ZAI_START_FREE_PRODUCT_IDS = {
  month: `${ZAI_START_FREE_PRODUCT_ID}-monthly`,
  quarter: `${ZAI_START_FREE_PRODUCT_ID}-quarterly`,
  year: `${ZAI_START_FREE_PRODUCT_ID}-yearly`,
} as const;
const CODING_PLAN_PRODUCTS_CACHE_TTL_MS = 30_000;
const CODING_PLAN_STATIC_PRODUCTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const productRequestCache = new Map<string, Promise<CodingPlanProductsSnapshot>>();
const productSnapshotCache = new Map<
  string,
  { snapshot: CodingPlanProductsSnapshot; expiresAt: number }
>();
const productCacheGeneration = new Map<string, number>();
let staticProductsConfigCache: {
  config: CodingPlanStaticProductsConfig;
  expiresAt: number;
} | null = null;
let staticProductsConfigRequest: Promise<CodingPlanStaticProductsConfig> | null = null;

export function useCodingPlanProducts(
  providerId: CodingPlanProviderId,
  options?: { remotePreviewEnabled?: boolean },
) {
  const services = useOptionalServices();
  const service = services?.codingPlanSubscriptionService;
  const supportedProvider =
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    isZaiCodingPlanProviderId(providerId);
  const enabled = supportedProvider && options?.remotePreviewEnabled !== false;
  const staticSnapshot = useMemo(() => buildStaticProductsSnapshot(providerId), [providerId]);
  const [state, setState] = useState<CodingPlanProductsState>(() => ({
    snapshot: null,
    loading: supportedProvider,
    error: null,
  }));

  const refresh = useCallback(
    async (options?: { force?: boolean }) => {
      if (!supportedProvider) {
        setState({
          snapshot: staticSnapshot,
          loading: false,
          error: "unsupported",
        });
        return;
      }
      if (!enabled) {
        const loadedStaticSnapshot = service
          ? await loadCodingPlanStaticProductsSnapshotForTest(providerId, service)
          : staticSnapshot;
        setState({
          // 未登录/未连接时禁止打 paid batch-preview，但仍要展示静态套餐。
          // 之前这里返回空 snapshot + loading，导致套餐列表一直卡在加载态。
          snapshot: loadedStaticSnapshot,
          loading: false,
          error: null,
        });
        return;
      }
      if (!service) {
        setState({
          snapshot: staticSnapshot,
          loading: false,
          error: "service_unavailable",
        });
        return;
      }

      setState((current) => ({
        // 静态套餐改为远端配置后，首次查看套餐列表时没有本地数据可兜底；
        // 请求配置和试算期间必须保持空 snapshot，让外层展示整块加载态，而不是先闪空列表。
        snapshot: options?.force === true ? current.snapshot : null,
        loading: true,
        error: null,
      }));

      let loadedStaticSnapshot = staticSnapshot;
      try {
        const staticProducts = await loadCodingPlanStaticProductListForTest(providerId, service);
        loadedStaticSnapshot = buildStaticProductsSnapshotFromList(providerId, staticProducts);
        const snapshot = await loadCodingPlanProducts(
          providerId,
          service,
          options?.force === true,
          staticProducts,
        );
        setState({
          snapshot,
          loading: false,
          error: null,
        });
      } catch (error) {
        const message = normalizeErrorMessage(error);
        logger.warn("[useCodingPlanProducts] 读取 Coding Plan 套餐失败", {
          providerId,
          error: message,
        });
        setState((current) => ({
          // 手动刷新失败不能用静态套餐覆盖上一轮有效 preview。
          // soldOut/canPurchase/forbidden 只存在于 batch-preview，覆盖后周期列表会把“已售罄”误算成可订阅。
          snapshot: resolveCodingPlanProductsFailureSnapshot(
            current.snapshot,
            loadedStaticSnapshot,
          ),
          loading: false,
          error: message,
        }));
      }
    },
    [enabled, providerId, service, staticSnapshot, supportedProvider],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    ...state,
    refresh,
  };
}

async function loadCodingPlanProductsForTest(
  providerId: CodingPlanProviderId,
  service: NonNullable<ReturnType<typeof useOptionalServices>>["codingPlanSubscriptionService"],
  force: boolean,
  staticProducts?: CodingPlanStaticProduct[],
): Promise<CodingPlanProductsSnapshot> {
  const now = Date.now();
  const generation = force
    ? invalidateCodingPlanProductsCache(providerId)
    : (productCacheGeneration.get(providerId) ?? 0);
  const cachedSnapshot = productSnapshotCache.get(providerId);
  if (!force && cachedSnapshot && cachedSnapshot.expiresAt > now) {
    return cachedSnapshot.snapshot;
  }

  const cachedPromise = productRequestCache.get(providerId);
  if (!force && cachedPromise) {
    return cachedPromise;
  }

  // React 严格模式和设置页状态刷新会短时间重复挂载套餐卡，
  // BigModel/Z.AI 套餐预览接口对连发请求会偶发返回“系统繁忙”；这里合并进行中请求，并只短缓存成功结果，
  // 手动刷新、登录/连接成功和购买完成都用 force 绕过缓存，避免交易状态长期陈旧。
  // 登录/连接成功还必须让旧的未登录试算请求失去写缓存资格，避免它晚返回后覆盖新的登录态试算结果。
  const promise = loadBatchPreviewWithStaticProducts(providerId, service, staticProducts ?? []);
  productRequestCache.set(providerId, promise);

  try {
    const snapshot = await promise;
    if ((productCacheGeneration.get(providerId) ?? 0) === generation) {
      productSnapshotCache.set(providerId, {
        snapshot,
        expiresAt: now + CODING_PLAN_PRODUCTS_CACHE_TTL_MS,
      });
    }
    return snapshot;
  } finally {
    if (productRequestCache.get(providerId) === promise) {
      productRequestCache.delete(providerId);
    }
  }
}

async function loadCodingPlanStaticProductsSnapshotForTest(
  providerId: CodingPlanProviderId,
  service: NonNullable<ReturnType<typeof useOptionalServices>>["codingPlanSubscriptionService"],
): Promise<CodingPlanProductsSnapshot> {
  const staticProducts = await loadCodingPlanStaticProductListForTest(providerId, service);
  return buildStaticProductsSnapshotFromList(providerId, staticProducts);
}

const loadCodingPlanProducts = loadCodingPlanProductsForTest;

function resolveCodingPlanProductsFailureSnapshot(
  currentSnapshot: CodingPlanProductsSnapshot | null,
  fallbackSnapshot: CodingPlanProductsSnapshot,
): CodingPlanProductsSnapshot {
  return currentSnapshot ?? fallbackSnapshot;
}

function invalidateCodingPlanProductsCache(providerId: CodingPlanProviderId) {
  const nextGeneration = (productCacheGeneration.get(providerId) ?? 0) + 1;
  productCacheGeneration.set(providerId, nextGeneration);
  productRequestCache.delete(providerId);
  productSnapshotCache.delete(providerId);
  return nextGeneration;
}

async function loadBatchPreviewWithStaticProducts(
  providerId: CodingPlanProviderId,
  service: NonNullable<ReturnType<typeof useOptionalServices>>["codingPlanSubscriptionService"],
  staticProducts: CodingPlanStaticProduct[],
): Promise<CodingPlanProductsSnapshot> {
  const previewSnapshot = await service.batchPreview({ providerId });
  const previewByProductId = new Map(
    previewSnapshot.productList.map((product) => [product.productId, product]),
  );
  const productList =
    staticProducts.length > 0
      ? buildStaticProductDisplayList(staticProducts).map((product) =>
          mergeStaticProductWithPreview(product, previewByProductId.get(product.productId)),
        )
      : previewSnapshot.productList.map((product) => ({
          ...product,
          hasPreview: true,
        }));

  return {
    ...previewSnapshot,
    productList: filterCodingPlanPurchaseProducts(providerId, productList),
  };
}

function buildStaticProductsSnapshot(providerId: CodingPlanProviderId): CodingPlanProductsSnapshot {
  return buildStaticProductsSnapshotFromList(providerId, []);
}

function buildZaiStartStaticProducts(preview: StartPlanPreviewConfig): CodingPlanStaticProduct[] {
  const isChineseLocale =
    typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh");
  const previewName = preview.name.trim() || "Z.ai Start";
  const equityList = preview.entitlements.map((entitlement) => ({
    productEquityTitle: entitlement.showName,
    productEquityDetails: formatStartPlanPreviewEntitlement(entitlement, isChineseLocale),
  }));

  return [
    {
      productId: ZAI_START_FREE_PRODUCT_IDS.month,
      productName: previewName,
      productSmallTitle: "Free Coding Plan",
      description: "Free Coding Plan entry for connected Z.ai users.",
      productEquityList: equityList,
      priceUnit: "month",
      displayOrder: 0,
      priceCurrency: "USD",
      originalAmount: 0,
      payAmount: 0,
      monthlyPayAmount: 0,
    },
    {
      productId: ZAI_START_FREE_PRODUCT_IDS.quarter,
      productName: previewName,
      productSmallTitle: "Free Coding Plan",
      description: "Free Coding Plan entry for signed-in Z.ai users.",
      productEquityList: equityList,
      priceUnit: "quarter",
      displayOrder: 0,
      priceCurrency: "USD",
      originalAmount: 0,
      payAmount: 0,
      monthlyPayAmount: 0,
    },
    {
      productId: ZAI_START_FREE_PRODUCT_IDS.year,
      productName: previewName,
      productSmallTitle: "Free Coding Plan",
      description: "Free Coding Plan entry for signed-in Z.ai users.",
      productEquityList: equityList,
      priceUnit: "year",
      displayOrder: 0,
      priceCurrency: "USD",
      originalAmount: 0,
      payAmount: 0,
      monthlyPayAmount: 0,
    },
  ];
}

function formatStartPlanPreviewEntitlement(
  entitlement: StartPlanPreviewConfig["entitlements"][number],
  isChineseLocale: boolean,
): string {
  const amount = new Intl.NumberFormat(isChineseLocale ? "zh-CN" : "en-US").format(
    entitlement.grantUnits,
  );
  const unit = entitlement.unitType.trim();
  const period = entitlement.period.trim();
  return [amount, unit, period].filter(Boolean).join(" ");
}

function isZaiStartFreeProductId(productId: string | null | undefined) {
  if (!productId) {
    return false;
  }
  return (
    productId === ZAI_START_FREE_PRODUCT_ID || productId.startsWith(`${ZAI_START_FREE_PRODUCT_ID}-`)
  );
}

function buildStaticProductsSnapshotFromList(
  providerId: CodingPlanProviderId,
  staticProducts: CodingPlanStaticProduct[],
): CodingPlanProductsSnapshot {
  return {
    productList: filterCodingPlanPurchaseProducts(
      providerId,
      buildStaticProductDisplayList(staticProducts),
    ),
    isSubscribed: false,
    isAuthenticated: null,
  };
}

function buildStaticProductDisplayList(
  products: CodingPlanStaticProduct[],
): CodingPlanProductDisplay[] {
  return products.map((product) => {
    const descriptionItems = normalizeCodingPlanCardCopyItems(
      typeof product.description === "string"
        ? product.description.split(/\r?\n/)
        : product.description,
    );
    return {
      ...product,
      // 展示模型仍需要换行字符串供旧卡片逻辑读取，同时保留结构化条目，
      // 否则 client/configs 下发的单条 tooltip 会在归一化时丢失。
      productDescription:
        descriptionItems.length > 0
          ? descriptionItems.map((item) => item.text).join("\n")
          : typeof product.description === "string"
            ? product.description
            : undefined,
      descriptionItems,
      equity: normalizeCodingPlanCardCopyItems(product.equity ?? []),
      hasPreview: false,
    };
  });
}

async function loadCodingPlanStaticProductListForTest(
  providerId: CodingPlanProviderId,
  service: NonNullable<ReturnType<typeof useOptionalServices>>["codingPlanSubscriptionService"],
): Promise<CodingPlanStaticProduct[]> {
  try {
    const config = await loadCodingPlanStaticProductsConfig(service);
    // 套餐描述由远端 client/configs 统一维护，前端不能再按 Lite/Pro/Max 写死覆盖，
    // 否则远端更新后设置页仍展示旧文案。
    const remoteProducts = config[providerId] ?? [];
    if (providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan) {
      return filterCodingPlanPurchaseProducts(providerId, remoteProducts);
    }
    if (providerId !== BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan) {
      return remoteProducts;
    }

    const startPlanPreview =
      typeof service.getStartPlanPreview === "function"
        ? await service.getStartPlanPreview()
        : null;
    if (!startPlanPreview) {
      // 体验套餐是否存在由 client/configs.startPlanPreview 决定。
      // 后端缺字段时不能再用本地硬编码兜底，否则会展示已经被配置关闭的体验套餐。
      return remoteProducts;
    }

    // Start 免费档现在归属于独立的 Start Plan 入口，且必须由远端 preview 开关显式打开。
    // Z.AI - Coding Plan 的购买列表只展示付费升级项，避免把 Start 当成可购买套餐重复显示。
    const seen = new Set<string>();
    return [...buildZaiStartStaticProducts(startPlanPreview), ...remoteProducts].filter(
      (product) => {
        if (seen.has(product.productId)) {
          return false;
        }
        seen.add(product.productId);
        return true;
      },
    );
  } catch (error) {
    logger.warn("[useCodingPlanProducts] 读取远端 Coding Plan 静态套餐失败", {
      providerId,
      error: normalizeErrorMessage(error),
    });
    return [];
  }
}

function filterCodingPlanPurchaseProducts<
  TProduct extends { productId: string | null | undefined },
>(providerId: CodingPlanProviderId, products: TProduct[]): TProduct[] {
  if (providerId !== BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan) {
    return products;
  }
  return products.filter((product) => !isZaiStartFreeProductId(product.productId));
}

async function loadCodingPlanStaticProductsConfig(
  service: NonNullable<ReturnType<typeof useOptionalServices>>["codingPlanSubscriptionService"],
): Promise<CodingPlanStaticProductsConfig> {
  const now = Date.now();
  if (staticProductsConfigCache && staticProductsConfigCache.expiresAt > now) {
    return staticProductsConfigCache.config;
  }
  if (staticProductsConfigRequest) {
    return staticProductsConfigRequest;
  }

  if (typeof service.getStaticProducts !== "function") {
    return {};
  }

  // 静态套餐来自远端 client/configs，但只有用户真正查看套餐列表时才需要请求；
  // 这里做一天内存缓存和进行中请求合并，避免设置页重渲染或多个 provider 卡片重复拉配置。
  const request = service.getStaticProducts();
  staticProductsConfigRequest = request;
  try {
    const config = await request;
    staticProductsConfigCache = {
      config,
      expiresAt: now + CODING_PLAN_STATIC_PRODUCTS_CACHE_TTL_MS,
    };
    return config;
  } finally {
    if (staticProductsConfigRequest === request) {
      staticProductsConfigRequest = null;
    }
  }
}

function mergeStaticProductWithPreview(
  staticProduct: CodingPlanProductDisplay,
  previewProduct: CodingPlanProductPreviewPayment | undefined,
): CodingPlanProductDisplay {
  if (!previewProduct) {
    return {
      ...staticProduct,
      hasPreview: false,
    };
  }

  return {
    ...staticProduct,
    inCurrentPeriod: previewProduct.inCurrentPeriod,
    lastValid: previewProduct.lastValid,
    effectiveTime: previewProduct.effectiveTime,
    originalAmount: previewProduct.originalAmount,
    discountAmount: previewProduct.discountAmount,
    payAmount: previewProduct.payAmount,
    monthlyOriginalAmount: previewProduct.monthlyOriginalAmount,
    monthlyRenewAmount: previewProduct.monthlyRenewAmount,
    monthlyPayAmount: previewProduct.monthlyPayAmount,
    renewAmount: previewProduct.renewAmount,
    canPurchase: previewProduct.canPurchase,
    soldOut: previewProduct.soldOut,
    hasFirstTimeSubscriptionPromo: previewProduct.hasFirstTimeSubscriptionPromo,
    delay: previewProduct.delay,
    canRepurchase: previewProduct.canRepurchase,
    forbidden: previewProduct.forbidden,
    campaignDiscountDetails: previewProduct.campaignDiscountDetails,
    hasPreview: true,
  };
}

export function normalizeErrorMessage(error: unknown): string {
  const message = readErrorMessage(error);
  if (isCodingPlanSystemBusyMessage(message)) {
    // 支付接口可能返回 WAF HTML 或 JSON 解析错误。
    // 这类内容不能直接展示给用户，统一提示系统繁忙。
    return CODING_PLAN_SYSTEM_BUSY;
  }
  if (isCodingPlanOAuthRequiredMessage(message)) {
    // 套餐/支付接口仍依赖 OAuth 登录态。
    // token 过期、损坏或缺失时要引导用户重新登录/连接，不能直接展示后端原始 token 错误。
    return CODING_PLAN_OAUTH_REQUIRED_ERROR;
  }
  return message;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  return String(error);
}

function isCodingPlanSystemBusyMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.startsWith("<!doctype") ||
    /<\s*(html|head|body|script|style|title|meta)\b/.test(normalized) ||
    normalized.includes("errors.aliyun.com") ||
    normalized.includes("request has been blocked") ||
    normalized.includes("unexpected token '<'") ||
    normalized.includes("unexpected end of json input") ||
    normalized.includes("invalid json response")
  );
}

function isCodingPlanOAuthRequiredMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized === "bigmodel_oauth_required" ||
    normalized === "zai_oauth_required" ||
    normalized.includes("oauth_required") ||
    /\b401\b|\b403\b/.test(normalized) ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("token expired") ||
    normalized.includes("expired or incorrect") ||
    normalized.includes("invalid token") ||
    normalized.includes("access token")
  );
}
