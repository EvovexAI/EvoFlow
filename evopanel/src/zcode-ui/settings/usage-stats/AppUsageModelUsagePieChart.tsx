import { useCallback, useMemo } from "react";
import { Cell, Pie, PieChart } from "recharts";
import type { AppUsageSnapshot } from "@zcode/shared";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildAppUsageModelPieChartViewModel,
  type AppUsageModelPieSlice,
} from "@/settings/usage-stats/appUsageModelPieChartViewModel.js";
import {
  UsageEmptyState,
  formatCompactTokenUsage,
  formatPercent,
} from "@/settings/usage-stats/usageStatsUiParts.js";

const APP_USAGE_MODEL_PIE_CHART_MARGIN = {
  top: 4,
  right: 4,
  bottom: 4,
  left: 4,
} as const;

export function AppUsageModelUsagePieChart({ snapshot }: { snapshot: AppUsageSnapshot }) {
  const { intl, locale } = useZCodeIntl();
  const { chartConfig, chartData, totalModelTokens } = useMemo(
    // Recharts 会镜像 data/config props 到内部 store；稳定饼图数据可避免设置页刷新时重复派发。
    () => buildAppUsageModelPieChartViewModel({ intl, snapshot }),
    [intl, snapshot],
  );
  const tokenUnit = intl.formatMessage({ id: "settings.usage.tokenUnit" });
  const formatTooltipItem = useCallback(
    (value: unknown, _name: unknown, item: { color?: string; payload?: unknown }) => {
      const slice = item.payload as AppUsageModelPieSlice | undefined;
      const totalTokens = typeof value === "number" ? value : (slice?.totalTokens ?? 0);
      const share = slice?.share ?? 0;
      return (
        <>
          <span
            className="size-2 shrink-0 self-center rounded-full"
            style={{ backgroundColor: item.color ?? slice?.color }}
          />
          <div className="grid min-w-0 flex-1 gap-1">
            <div className="truncate text-foreground-subtle">{slice?.label ?? String(_name)}</div>
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-baseline gap-1 text-foreground">
                <span className="font-mono font-medium tabular-nums">
                  {formatCompactTokenUsage(locale, totalTokens)}
                </span>
                <span className="text-foreground-subtle">{tokenUnit}</span>
              </span>
              <span className="font-mono text-foreground-subtle tabular-nums">
                {formatPercent(locale, share)}
              </span>
            </div>
          </div>
        </>
      );
    },
    [locale, tokenUnit],
  );
  const tooltipContent = useMemo(
    () => <ChartTooltipContent hideLabel indicator="line" formatter={formatTooltipItem} />,
    [formatTooltipItem],
  );

  return (
    <section className="space-y-3 rounded-xl bg-surface p-4">
      <h3 className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "settings.usage.modelChartTitle" })}
      </h3>
      {totalModelTokens <= 0 ? (
        <UsageEmptyState
          title={intl.formatMessage({ id: "settings.usage.emptyTitle" })}
          description={intl.formatMessage({
            id: "settings.usage.emptyDescription",
          })}
        />
      ) : (
        <div className="grid gap-4 px-3 py-3 md:grid-cols-2">
          <div className="relative mx-auto h-56 w-full max-w-64 self-center md:h-64 md:max-w-72">
            <ChartContainer config={chartConfig} className="relative z-20 h-56 w-full md:h-64">
              <PieChart accessibilityLayer margin={APP_USAGE_MODEL_PIE_CHART_MARGIN}>
                <ChartTooltip cursor={false} content={tooltipContent} />
                <Pie
                  data={chartData}
                  dataKey="totalTokens"
                  nameKey="key"
                  innerRadius="56%"
                  outerRadius="86%"
                  paddingAngle={chartData.length > 1 ? 2 : 0}
                  stroke="var(--color-surface)"
                  strokeWidth={2}
                >
                  {chartData.map((slice) => (
                    <Cell key={slice.key} fill={`var(--color-${slice.key})`} />
                  ))}
                </Pie>
              </PieChart>
            </ChartContainer>
            <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center px-8 text-center">
              <div className="max-w-full truncate text-ui-sm font-semibold text-foreground">
                {formatCompactTokenUsage(locale, totalModelTokens)}
              </div>
              <div className="max-w-full truncate text-ui-sm text-foreground-subtle">
                {tokenUnit}
              </div>
            </div>
          </div>
          <div className="min-w-0 self-center" role="list">
            {chartData.map((slice) => (
              <div
                key={slice.key}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 border-b border-border/70 py-2 last:border-b-0"
                role="listitem"
              >
                <span
                  className="size-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: slice.color }}
                />
                <span className="min-w-0 truncate font-mono text-ui-sm text-foreground">
                  {slice.label}
                </span>
                <span className="font-mono text-ui-sm text-foreground-subtle tabular-nums">
                  {formatPercent(locale, slice.share)}
                </span>
                <span className="col-start-2 min-w-0 truncate text-ui-sm text-foreground-subtle">
                  {formatCompactTokenUsage(locale, slice.totalTokens)} {tokenUnit}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
