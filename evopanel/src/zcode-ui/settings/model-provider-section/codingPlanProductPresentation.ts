import type { CodingPlanCardCopyItem, CodingPlanProductPreviewPayment } from "@zcode/shared";

export function normalizeCodingPlanCardCopyItems(items: unknown): CodingPlanCardCopyItem[] {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.flatMap((item) => {
    if (typeof item !== "string" && (!item || typeof item !== "object")) {
      return [];
    }
    const text =
      typeof item === "string"
        ? item.trim()
        : typeof (item as { text?: unknown }).text === "string"
          ? (item as { text: string }).text.trim()
          : "";
    if (!text) {
      return [];
    }
    const tooltip =
      typeof item === "string" || typeof (item as { tooltip?: unknown }).tooltip !== "string"
        ? ""
        : (item as { tooltip: string }).tooltip.trim();
    return [{ text, ...(tooltip ? { tooltip } : {}) }];
  });
}
export type CodingPlanPriceCurrency = "CNY" | "USD";
export type CodingPlanPriceUnit = "month" | "quarter" | "year";

export type CodingPlanProductDisplay = CodingPlanProductPreviewPayment & {
  priceCurrency?: CodingPlanPriceCurrency;
  externalPurchaseUrl?: string;
  hasPreview?: boolean;
  equity?: CodingPlanCardCopyItem[];
  descriptionItems?: CodingPlanCardCopyItem[];
};

const CODING_PLAN_CURRENCY_LABELS_ZH: Record<CodingPlanPriceCurrency, string> = {
  CNY: "人民币",
  USD: "美元",
};

export function pickProductPrice(product: CodingPlanProductPreviewPayment): number | null {
  return product.payAmount ?? product.discountAmount ?? product.renewAmount ?? null;
}

function normalizeCodingPlanCurrency(currency: string | null | undefined): CodingPlanPriceCurrency {
  return currency?.trim().toUpperCase() === "USD" ? "USD" : "CNY";
}

export function formatCodingPlanAmount(
  amount: number,
  currency: string | null | undefined,
  locale: string,
): string {
  const resolvedCurrency = normalizeCodingPlanCurrency(currency);
  const isChineseLocale = locale.toLowerCase().startsWith("zh");
  const formattedAmount = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
  const currencyPrefix = isChineseLocale
    ? resolvedCurrency === "USD"
      ? "$"
      : "¥"
    : resolvedCurrency === "USD"
      ? "US$"
      : "CN¥";
  const formatted = `${currencyPrefix}${formattedAmount}`;

  // 套餐页需要同时展示中英文和跨币种价格；依赖 Intl currency 会在不同 locale 下输出
  // 不一致的 ISO code/符号组合，因此这里按产品文案规范固定符号和中文币种名。
  return isChineseLocale
    ? `${formatted} ${CODING_PLAN_CURRENCY_LABELS_ZH[resolvedCurrency]}`
    : formatted;
}
