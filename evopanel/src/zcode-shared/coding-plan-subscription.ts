/* eslint-disable max-lines -- Coding Plan 订阅协议类型需要集中导出给 UI、services 和 RPC 共享，拆散会增加跨包类型入口复杂度。 */
import type { ProviderFamilyDomain } from "./model-provider-family.js";
import type { BUILTIN_MODEL_PROVIDER_IDS } from "./model-provider-types.js";

export type CodingPlanPayType = "ALI" | "WECHAT";
export type CodingPlanOverseasPaymentChannel = "STRIPE_PAY" | "PAYPAL_PAY";
export type CodingPlanSubscriptionProviderId =
  | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;
export const CODING_PLAN_SYSTEM_BUSY = "coding_plan_system_busy" as const;

export type CodingPlanUnavailableReason = "not_authenticated" | "request_failed";

export interface CodingPlanProductPreviewPayment {
  productId: string;
  productName?: string;
  productBigTitle?: string;
  productSmallTitle?: string;
  productIntroduction?: string;
  productDescription?: string;
  relateResourcePack?: string;
  inCurrentPeriod?: boolean;
  lastValid?: boolean;
  effectiveTime?: string | null;
  originalAmount?: number;
  discountAmount?: number;
  payAmount?: number;
  monthlyOriginalAmount?: number;
  monthlyRenewAmount?: number;
  monthlyPayAmount?: number;
  renewAmount?: number;
  canPurchase?: boolean | null;
  soldOut?: boolean;
  hasFirstTimeSubscriptionPromo?: boolean;
  delay?: boolean;
  canRepurchase?: boolean | null;
  forbidden?: boolean;
  campaignDiscountDetails?: CodingPlanCampaignDiscountDetail[];
  productEquityList?: CodingPlanProductEquity[] | null;
  priceUnit?: "month" | "quarter" | "year";
  priceCurrency?: "CNY" | "USD";
}

export interface CodingPlanStaticProductEquity {
  productEquityTitle: string;
  productEquityDetails?: string;
}

export interface CodingPlanCardCopyItem {
  text: string;
  tooltip?: string;
}

export type CodingPlanCardCopyConfigItem = string | CodingPlanCardCopyItem;

export interface CodingPlanStaticProduct {
  productId: string;
  productName: string;
  productSmallTitle?: string;
  equity?: CodingPlanCardCopyConfigItem[];
  description?: string | CodingPlanCardCopyConfigItem[];
  productEquityList?: CodingPlanStaticProductEquity[];
  priceUnit: "month" | "quarter" | "year";
  displayOrder: number;
  priceCurrency: "CNY" | "USD";
  originalAmount?: number;
  discountAmount?: number;
  payAmount?: number;
  monthlyOriginalAmount?: number;
  monthlyRenewAmount?: number;
  monthlyPayAmount?: number;
  renewAmount?: number;
}

export type CodingPlanStaticProductsConfig = Partial<
  Record<CodingPlanSubscriptionProviderId, CodingPlanStaticProduct[]>
>;

export interface CodingPlanStaticTeamProduct {
  productId: string;
  productName: string;
  tier: EnterpriseCodingPlanTier;
  subscribeMode: EnterpriseCodingPlanSubscribeMode;
  subscribePeriod: EnterpriseCodingPlanSubscribePeriod;
  purchaseMethodName: string;
  priceCurrency: "CNY";
  originalAmount?: number;
  discountAmount?: number;
  payAmount?: number;
  renewAmount?: number;
  equity?: CodingPlanCardCopyConfigItem[];
  description?: CodingPlanCardCopyConfigItem[];
}

export type CodingPlanStaticTeamProductsConfig = Partial<
  Record<CodingPlanSubscriptionProviderId, CodingPlanStaticTeamProduct[]>
>;

export interface StartPlanPreviewEntitlement {
  grantUnits: number;
  meter: string;
  period: string;
  showName: string;
  unitType: string;
}

export interface StartPlanPreviewConfig {
  planId: string;
  name: string;
  entitlements: StartPlanPreviewEntitlement[];
}

export interface ForceUpdateConfig {
  minimalVersion: string;
}

/**
 * 闲时任务客户端配置：client/configs 只下发入口曝光开关；模型展示来自 Built-in
 * offpeak Provider。准入/低峰判断仍以服务端为准（3006 兜底）。
 * 有效开启判据 = enable_offpeak_task===true 且 Built-in 模型成员非空。
 * 额度不再经 client/configs 下发；改由专用 availability 接口提供服务端即时快照。
 */
export interface CodingPlanProductInfoRequest {
  providerId?: CodingPlanSubscriptionProviderId;
  productId: string;
}

export interface CodingPlanProductEquity {
  id?: number;
  productId?: string;
  productEquityTitle?: string;
  productEquityDetails?: string;
  createTime?: string;
  updateTime?: string;
}

export interface CodingPlanProductInfo {
  id?: number;
  productId: string;
  productName?: string;
  productBigTitle?: string;
  productSmallTitle?: string;
  productIntroduction?: string;
  buyLimit?: number;
  salePrice?: number;
  productStatus?: string;
  description?: string;
  relateResourcePack?: string;
  stock?: number;
  saleCount?: number;
  userAllowBuyNum?: number;
  isAllowBuy?: boolean;
  isEnable?: boolean;
  errorMessage?: string | null;
  displayOrder?: number;
  productEquityList?: CodingPlanProductEquity[] | null;
  priceUnit?: "month" | "quarter" | "year";
}

export interface CodingPlanCampaignDiscountDetail {
  campaignName?: string;
  campaignDiscountAmount?: number;
  rewardMode?: string;
  rewardAmount?: number;
  rewardDetail?: string;
  applyScene?: string;
}

export interface CodingPlanBatchPreviewRequest {
  providerId?: CodingPlanSubscriptionProviderId;
  invitationCode?: string;
}

export interface CodingPlanBatchPreviewResponse {
  productList: CodingPlanProductPreviewPayment[];
  isSubscribed: boolean;
  isAuthenticated: boolean | null;
}

export interface CodingPlanPreviewRequest {
  providerId?: CodingPlanSubscriptionProviderId;
  productId: string;
  invitationCode?: string;
  imRef?: string | null;
  ticket?: string | null;
  randstr?: string | null;
  salesChannel?: string;
}

export interface CodingPlanLastSubscriptionSummary {
  productId?: string;
  orderNo?: string;
  agreementNo?: string;
}

export interface CodingPlanPreviewResponse extends CodingPlanProductPreviewPayment {
  bizId: string;
  cashAmount?: number;
  giveAmount?: number;
  thirdPartyAmount?: number;
  refundAmount?: number;
  residualAmount?: number;
  renew?: boolean | null;
  refundBreakdown?: {
    cashRefund?: number;
    giveRefund?: number;
    thirdPartyRefund?: number;
  } | null;
  orderValueCompositionFeatureEnabled?: boolean;
  lastSubscriptionSummary?: CodingPlanLastSubscriptionSummary | null;
}

export interface CodingPlanCreateSignRequest {
  providerId?: CodingPlanSubscriptionProviderId;
  bizId: string;
  payType?: CodingPlanPayType;
  invitationCode?: string;
  renew?: boolean | null;
  isDelay?: 0 | 1;
  effectiveTime?: string | null;
}

export interface CodingPlanUpdateSignRequest {
  providerId?: CodingPlanSubscriptionProviderId;
  bizId: string;
  payType?: CodingPlanPayType;
}

export interface CodingPlanAgreementResponse {
  orderId?: string;
  sign: string;
  signType?: string;
}

export interface CodingPlanPaymentCheckRequest {
  providerId?: CodingPlanSubscriptionProviderId;
  bizId: string;
}

export interface CodingPlanPaymentCheckResponse {
  status: string;
}

export interface CodingPlanEstimatePayAmount {
  cashPayAmount?: number;
  givePayAmount?: number;
  thirdPartyPayAmount?: number;
}

export interface CodingPlanStripeCard {
  id?: number;
  brand?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
  isDefault?: boolean;
  isDeleted?: boolean;
  paymentMethodId: string;
}

export interface CodingPlanStripeBindRequest {
  providerId?: CodingPlanSubscriptionProviderId;
  paymentMethodId: string;
  returnUrl?: string;
  trackingContext?: Record<string, unknown>;
}

export interface CodingPlanStripeBindResponse extends CodingPlanStripeCard {
  errorDetail?: string;
  clientSecret?: string;
  requiresAction?: boolean;
}

export interface CodingPlanStripeUnbindRequest {
  providerId?: CodingPlanSubscriptionProviderId;
  paymentMethodId: string;
}

export interface CodingPlanStripePayRequest {
  providerId?: CodingPlanSubscriptionProviderId;
  productId: string;
  paymentMethodId?: string;
  isSubscribe?: boolean;
  returnUrl?: string;
  channelCode?: string;
  estimatePayAmount?: CodingPlanEstimatePayAmount;
  invitationCode?: string;
  bizId?: string;
  renew?: boolean;
}

export interface CodingPlanStripePayResponse {
  orderId?: string;
  paymentIntentId?: string;
  clientSecret?: string;
  amount?: number;
  status?: string;
  createTime?: string;
  paymentMethodBrand?: string;
  paymentMethodLast4?: string;
  requiresAction?: boolean;
  agreementNo?: string;
  isThirdPartyPayment?: boolean;
}

export interface CodingPlanPaypalSupportRequest {
  providerId?: CodingPlanSubscriptionProviderId;
}

export interface CodingPlanPaypalSupportResponse {
  resultStatus?: string;
  isSupport?: boolean;
}

export interface CodingPlanPaypalSetupTokenRequest {
  providerId?: CodingPlanSubscriptionProviderId;
  returnUrl: string;
  cancelUrl: string;
}

export interface CodingPlanPaypalSetupTokenResponse {
  resultStatus?: string;
  setupTokenId?: string;
  approveUrl?: string;
  paymentTokenStatus?: string;
}

export interface CodingPlanPaypalSubscribeRequest {
  providerId?: CodingPlanSubscriptionProviderId;
  productId: string;
  productDesc?: string;
  setupTokenId?: string;
  amount?: number;
  isSubscribe?: boolean;
  estimatePayAmount?: CodingPlanEstimatePayAmount;
  invitationCode?: string;
  bizId?: string;
  channelCode?: string;
}

export interface CodingPlanPaypalSubscribeResponse {
  resultStatus?: string;
  payStatus?: string;
  orderId?: string;
}

export interface CodingPlanPendingOrderCheckResponse {
  hasPendingOrders: boolean;
}

export interface CodingPlanPendingOrderCheckRequest {
  providerId?: CodingPlanSubscriptionProviderId;
}

export type EnterpriseCodingPlanTier = "LITE" | "PRO" | "MAX";
export type EnterpriseCodingPlanSubscribeMode = "CONTINUOUS" | "ONE_TIME";
export type EnterpriseCodingPlanSubscribePeriod = "MONTHLY" | "QUARTERLY" | "YEARLY";
export type EnterpriseCodingPlanPurchaseType = "PAY" | "RENEW";
export type EnterpriseCodingPlanPaymentStatus =
  | "WAIT_PAY"
  | "SUCCESS"
  | "FAIL"
  | "CLOSED"
  | "CANCELLED"
  | string;

export interface EnterpriseCodingPlanPricingProduct {
  productId: string;
  tier: EnterpriseCodingPlanTier;
  subscribeMode: EnterpriseCodingPlanSubscribeMode;
  subscribePeriod: EnterpriseCodingPlanSubscribePeriod;
  purchaseMethodName?: string;
  originalAmount?: number;
  discountAmount?: number;
  payAmount?: number;
  renewAmount?: number;
  canRepurchase?: boolean | null;
  subscribed?: boolean | null;
  organizationId?: string | null;
  organizationName?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  teamProjects?: EnterpriseCodingPlanProjectContext[];
  apiKeyStatus?: EnterpriseCodingPlanProjectApiKeyStatus;
  apiKeyUnavailableReason?: EnterpriseCodingPlanProjectApiKeyUnavailableReason | null;
  apiKeyUnavailableMessage?: string | null;
  campaignDiscountDetails?: CodingPlanCampaignDiscountDetail[];
}

export interface EnterpriseCodingPlanProjectContext {
  organizationId: string;
  organizationName?: string | null;
  projectId: string;
  projectName?: string | null;
  apiKeyStatus?: EnterpriseCodingPlanProjectApiKeyStatus;
  apiKeyUnavailableReason?: EnterpriseCodingPlanProjectApiKeyUnavailableReason | null;
  apiKeyUnavailableMessage?: string | null;
}

export type EnterpriseCodingPlanProjectApiKeyStatus = "available" | "unavailable" | "unknown";

export type EnterpriseCodingPlanProjectApiKeyUnavailableReason =
  | "no_valid_team_plan_authorization"
  | "request_failed";

export interface EnterpriseCodingPlanPricingResponse {
  productList: EnterpriseCodingPlanPricingProduct[];
}

export interface EnterpriseCodingPlanPricingRequest {
  authenticated?: boolean;
  /**
   * 指定按哪个 family 读取企业定价。
   * 缺省时按 bigmodel 处理，向后兼容既有调用点。
   * service 层据此路由到对应 family 的 subscription provider。
   */
  family?: ProviderFamilyDomain;
}

export interface EnterpriseCodingPlanBalanceResponse {
  giveBalance: number;
  cashBalance: number;
  totalBalance: number;
}

export interface EnterpriseCodingPlanDiscountDetail {
  discountType?: string;
  discountName?: string;
  discountAmount?: number;
}

export interface EnterpriseCodingPlanOrderCalculateRequest {
  productId: string;
  maxSeats: number;
  subscribePeriod: EnterpriseCodingPlanSubscribePeriod;
  subscribeMode: EnterpriseCodingPlanSubscribeMode;
  duration?: number | null;
  giveAmount?: number;
  balanceDeductAmount?: number;
}

export interface EnterpriseCodingPlanOrderCalculateResponse {
  totalOriginalAmount: number;
  campaignDiscountAmount?: number;
  discountDetails?: EnterpriseCodingPlanDiscountDetail[];
  totalPayAmount: number;
  giveDeductAmount?: number;
  balanceDeductAmount?: number;
  thirdPayAmount: number;
}

export interface EnterpriseCodingPlanCreateOrderRequest {
  productId: string;
  maxSeats: number;
  subscribePeriod?: EnterpriseCodingPlanSubscribePeriod;
  subscribeMode?: EnterpriseCodingPlanSubscribeMode;
  purchaseType: EnterpriseCodingPlanPurchaseType;
  duration?: number | null;
  giveAmount?: number;
  balanceDeductAmount?: number;
  totalOriginalAmount: number;
  totalPayAmount: number;
  thirdPayAmount: number;
  subscriptionNo?: string;
}

export interface EnterpriseCodingPlanCreateOrderResponse {
  orderNo: string;
  subscriptionNo?: string;
  totalOriginalAmount: number;
  campaignDiscountAmount?: number;
  totalPayAmount: number;
  thirdPayAmount: number;
  discountDetails?: EnterpriseCodingPlanDiscountDetail[];
  payUrl?: string | null;
  alipayJumpSchema?: string | null;
  expireTime?: string | null;
}

export interface EnterpriseCodingPlanPendingOrder {
  orderNo: string;
  productId: string;
  amount: number;
  totalAmount: number;
  deductionAmount?: number;
  paymentStatus: EnterpriseCodingPlanPaymentStatus;
  createTime: string;
  subscriptionNo?: string;
  seatCount: number;
}

export interface EnterpriseCodingPlanCancelOrderRequest {
  orderNo: string;
}

export interface EnterpriseCodingPlanCancelOrderResponse {
  orderNo: string;
  status: EnterpriseCodingPlanPaymentStatus;
}

export interface EnterpriseCodingPlanContinuePayRequest {
  orderNo: string;
}

export interface EnterpriseCodingPlanOrderStatusRequest {
  orderNo: string;
}

export interface EnterpriseCodingPlanOrderStatusResponse {
  orderNo: string;
  paymentStatus: EnterpriseCodingPlanPaymentStatus;
  productPurchaseType?: "ENTERPRISE" | "PERSONAL" | string;
  organizationId?: string | null;
  projectId?: string | null;
}
