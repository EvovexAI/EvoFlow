import type { ReactNode } from "react";
import type { StartPlanPreviewConfig, StartPlanPreviewEntitlement } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatCompactTokenNumber } from "@/lib/tokenNumberFormat.js";

interface StartPlanEntitlementSummary {
  grantUnitsLabel: string;
  detailsDescription: string;
  unitLabel: string;
}

export function StartPlanCard({
  preview,
  actions,
}: {
  preview: StartPlanPreviewConfig;
  actions?: ReactNode;
}) {
  const { intl, locale } = useZCodeIntl();
  const entitlementSummary = resolveStartPlanEntitlementSummary(preview, intl, locale);
  if (!entitlementSummary) {
    // 体验套餐卡片必须由远端 startPlanPreview.entitlements 驱动；
    // 没有可展示额度时不能再回退到本地硬编码 Trial plan 文案。
    return null;
  }

  const title = preview.name.trim();
  const heroMetric = entitlementSummary.grantUnitsLabel;
  const heroMetricUnit = entitlementSummary.unitLabel;
  const description = entitlementSummary.detailsDescription;

  return (
    <div className="space-y-3">
      <h3 className="text-ui-base font-semibold text-foreground">
        {intl.formatMessage({
          id: "settings.modelProvider.startPlan.quotaSectionTitle",
        })}
      </h3>
      <div className="min-h-20 overflow-hidden rounded-xl border border-border bg-[radial-gradient(circle_at_14%_12%,color-mix(in_srgb,var(--color-success)_24%,var(--color-background)_76%)_0%,color-mix(in_srgb,var(--color-success)_10%,var(--color-surface)_90%)_64%,var(--color-surface)_300%)] p-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 items-center justify-between gap-3 max-sm:flex-col max-sm:items-stretch">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="w-fit shrink-0 rounded-full border border-border bg-background px-2 py-0.5 text-ui-sm font-medium text-foreground-subtle">
                  {intl.formatMessage({
                    id: "settings.modelProvider.startPlan.eligibleNewUser",
                  })}
                </span>
                <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
                  {title}
                </span>
              </div>
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-2xl font-bold leading-none text-foreground">
                  {heroMetric}
                </span>
                <span className="text-ui-base font-medium text-foreground-subtle">
                  {heroMetricUnit}
                </span>
              </div>
            </div>
            {actions ? <div className="max-sm:[&>button]:w-full">{actions}</div> : null}
          </div>
          <p className="max-w-2xl text-ui-base leading-5 text-foreground-subtle">{description}</p>
        </div>
      </div>
    </div>
  );
}

export function resolveStartPlanEntitlementSummary(
  preview: StartPlanPreviewConfig,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  locale: string,
): StartPlanEntitlementSummary | null {
  const entitlements = (preview?.entitlements ?? []).filter(isDisplayableModelUsageEntitlement);
  if (entitlements.length === 0) {
    return null;
  }

  const primary = entitlements[0];
  if (!primary) {
    return null;
  }

  // Trial Plan 主指标展示总额度；明细按 grantUnits 分组展示各模型额度。
  // 同额度模型合并成“各 X”，避免重复文字，同时保留逐模型配额差异。
  const detailsDescription = formatEntitlementDetailsDescription(
    entitlements,
    primary,
    intl,
    locale,
  );
  const totalGrantUnits = entitlements.reduce(
    (total, entitlement) => total + entitlement.grantUnits,
    0,
  );

  return {
    grantUnitsLabel: formatHeroGrantUnits(totalGrantUnits, locale),
    detailsDescription,
    unitLabel: formatStartPlanUnitLabel(primary, intl),
  };
}

function isDisplayableModelUsageEntitlement(entitlement: StartPlanPreviewEntitlement): boolean {
  return (
    entitlement.meter === "model_usage" &&
    entitlement.grantUnits > 0 &&
    entitlement.showName.trim().length > 0
  );
}

function formatCompactUnits(value: number, locale: string): string {
  return formatCompactTokenNumber(locale, value);
}

function formatHeroGrantUnits(value: number, locale: string): string {
  if (locale.toLowerCase().startsWith("en")) {
    // 体验套餐主视觉英文需要表达完整量级（如 5 Million），
    // 但明细和其它 token 用量仍保留 compact 的 K/M/B 或中文万/亿口径。
    return new Intl.NumberFormat(locale || "en-US", {
      notation: Math.abs(value) >= 1_000 ? "compact" : "standard",
      compactDisplay: "long",
      maximumFractionDigits: 1,
      minimumFractionDigits: 0,
    })
      .format(value)
      .replace(
        /\b(thousand|million|billion|trillion)\b/g,
        (unit) => unit.slice(0, 1).toUpperCase() + unit.slice(1),
      );
  }
  return formatCompactTokenNumber(locale, value);
}

function formatEntitlementDetailsDescription(
  entitlements: StartPlanPreviewEntitlement[],
  primary: StartPlanPreviewEntitlement,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  locale: string,
): string {
  const unit = formatStartPlanUnitTypeLabel(primary, intl);
  const groups = groupEntitlementsByGrantUnits(entitlements);
  const separator = " · ";
  const details = groups
    .map((group) =>
      group.modelNames.length > 1
        ? intl.formatMessage(
            {
              id: "settings.modelProvider.startPlan.preview.entitlementGroup.each",
            },
            {
              models: formatModelList(group.modelNames, locale),
              quota: formatCompactUnits(group.grantUnits, locale),
              unit,
            },
          )
        : intl.formatMessage(
            {
              id: "settings.modelProvider.startPlan.preview.entitlementGroup.single",
            },
            {
              model: group.modelNames[0] ?? "",
              quota: formatCompactUnits(group.grantUnits, locale),
              unit,
            },
          ),
    )
    .join(separator);

  return intl.formatMessage(
    {
      id:
        primary.period === "daily"
          ? "settings.modelProvider.startPlan.preview.entitlementSummary.daily"
          : "settings.modelProvider.startPlan.preview.entitlementSummary.generic",
    },
    { details },
  );
}

function groupEntitlementsByGrantUnits(
  entitlements: StartPlanPreviewEntitlement[],
): Array<{ grantUnits: number; modelNames: string[] }> {
  const groups = new Map<number, string[]>();
  for (const entitlement of entitlements) {
    const modelNames = groups.get(entitlement.grantUnits) ?? [];
    modelNames.push(entitlement.showName);
    groups.set(entitlement.grantUnits, modelNames);
  }
  return [...groups.entries()].map(([grantUnits, modelNames]) => ({
    grantUnits,
    modelNames,
  }));
}

function formatModelList(modelNames: string[], locale: string): string {
  if (locale.toLowerCase().startsWith("zh")) {
    return modelNames.join("、");
  }
  if (modelNames.length <= 2) {
    return modelNames.join(" / ");
  }
  return modelNames.join(" / ");
}

function formatStartPlanUnitLabel(
  entitlement: StartPlanPreviewEntitlement,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
): string {
  const unit = formatStartPlanUnitTypeLabel(entitlement, intl);
  if (entitlement.period === "daily") {
    return intl.formatMessage(
      {
        id: "settings.modelProvider.startPlan.preview.period.daily",
      },
      { unit },
    );
  }
  return unit;
}

function formatStartPlanUnitTypeLabel(
  entitlement: StartPlanPreviewEntitlement,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
): string {
  return entitlement.unitType === "token"
    ? intl.formatMessage({
        id: "settings.modelProvider.startPlan.preview.unit.tokens",
      })
    : entitlement.unitType;
}
