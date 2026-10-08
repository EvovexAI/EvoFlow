import { type ComponentProps, useCallback, useMemo } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import type { CodingPlanUsageGranularity } from "@zcode/shared";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  UsageEmptyState,
  formatCompactNumber,
  formatCompactTokenUsage,
} from "@/settings/usage-stats/usageStatsUiParts.js";

const CODING_PLAN_BAR_CHART_MARGIN = { top: 8, right: 24, left: 24 } as const;
const CODING_PLAN_BAR_CHART_MAX_BAR_SIZE = 24;
const BAR_COLORS = [
  "var(--color-usage-chart-1)",
  "var(--color-usage-chart-2)",
  "var(--color-usage-chart-3)",
  "var(--color-usage-chart-4)",
  "var(--color-usage-chart-5)",
  "var(--color-usage-chart-6)",
] as const;
type BreakdownKind = "cachedInput" | "uncachedInput" | "output";
type BarRadius = [number, number, number, number];

export type CodingPlanBarChartSeries = {
  color?: string;
  name: string;
  values: number[];
  breakdown?: {
    cachedInput: number[];
    uncachedInput: number[];
    output: number[];
  };
};

type CodingPlanBarChartRow = {
  label: string;
  time: string;
  total: number;
} & Record<string, number | string>;

type CodingPlanBarKey = {
  color: string;
  key: string;
  label: string;
  radius: BarRadius;
  stackId?: string;
};
type ChartTooltipContentProps = ComponentProps<typeof ChartTooltipContent>;

function formatChartTime(
  locale: string,
  value: string,
  granularity: CodingPlanUsageGranularity,
): string {
  if (granularity === "hour") {
    return value.slice(0, 5);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
  }).format(date);
}

function shouldShowXAxisLabel(index: number, total: number): boolean {
  if (total <= 14) {
    return true;
  }
  const step = total > 45 ? 7 : 5;
  return index === 0 || index === total - 1 || index % step === 0;
}

function hasBreakdownValues(series: CodingPlanBarChartSeries): boolean {
  const breakdown = series.breakdown;
  if (!breakdown) {
    return false;
  }
  return [...breakdown.cachedInput, ...breakdown.uncachedInput, ...breakdown.output].some(
    (value) => value > 0,
  );
}

function getModelColor(index: number, seriesColor?: string): string {
  return seriesColor ?? BAR_COLORS[index % BAR_COLORS.length] ?? BAR_COLORS[0];
}

function getModelBreakdownColor(modelColor: string, kind: BreakdownKind): string {
  if (kind === "cachedInput") {
    return `color-mix(in srgb, ${modelColor} 88%, black 12%)`;
  }
  if (kind === "uncachedInput") {
    return modelColor;
  }
  return `color-mix(in srgb, ${modelColor} 58%, white 42%)`;
}

function buildBarKeys({
  intl,
  series,
}: {
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  series: CodingPlanBarChartSeries[];
}): CodingPlanBarKey[] {
  return series.flatMap((item, index) => {
    const stackId = `series${index}`;
    const modelColor = getModelColor(index, item.color);
    if (!hasBreakdownValues(item)) {
      return [
        {
          color: modelColor,
          key: `${stackId}_total`,
          label: item.name,
          radius: [4, 4, 0, 0],
        },
      ];
    }
    return [
      {
        color: getModelBreakdownColor(modelColor, "cachedInput"),
        key: `${stackId}_cachedInput`,
        label: `${item.name}${intl.formatMessage({
          id: "settings.usage.modelChart.cachedInput",
        })}`,
        radius: [0, 0, 0, 0],
        stackId,
      },
      {
        color: getModelBreakdownColor(modelColor, "uncachedInput"),
        key: `${stackId}_uncachedInput`,
        label: `${item.name}${intl.formatMessage({
          id: "settings.usage.modelChart.uncachedInput",
        })}`,
        radius: [0, 0, 0, 0],
        stackId,
      },
      {
        color: getModelBreakdownColor(modelColor, "output"),
        key: `${stackId}_output`,
        label: `${item.name}${intl.formatMessage({
          id: "settings.usage.modelChart.output",
        })}`,
        radius: [4, 4, 0, 0],
        stackId,
      },
    ];
  });
}

function buildChartData({
  granularity,
  locale,
  series,
  xTime,
}: {
  granularity: CodingPlanUsageGranularity;
  locale: string;
  series: CodingPlanBarChartSeries[];
  xTime: string[];
}): CodingPlanBarChartRow[] {
  return xTime.map((time, dateIndex) => {
    const row: CodingPlanBarChartRow = {
      label: formatChartTime(locale, time, granularity),
      time,
      total: 0,
    };

    series.forEach((item, seriesIndex) => {
      const stackId = `series${seriesIndex}`;
      if (hasBreakdownValues(item)) {
        const cachedInput = item.breakdown?.cachedInput[dateIndex] ?? 0;
        const uncachedInput = item.breakdown?.uncachedInput[dateIndex] ?? 0;
        const output = item.breakdown?.output[dateIndex] ?? 0;
        row[`${stackId}_cachedInput`] = cachedInput;
        row[`${stackId}_uncachedInput`] = uncachedInput;
        row[`${stackId}_output`] = output;
        row.total += cachedInput + uncachedInput + output;
      } else {
        const total = item.values[dateIndex] ?? 0;
        row[`${stackId}_total`] = total;
        row.total += total;
      }
    });

    return row;
  });
}

export function calculateCodingPlanBarChartMaxValue(
  series: CodingPlanBarChartSeries[],
  xTimeLength: number,
): number {
  let maxValue = 0;
  for (let dateIndex = 0; dateIndex < xTimeLength; dateIndex++) {
    for (const item of series) {
      const value = hasBreakdownValues(item)
        ? (item.breakdown?.cachedInput[dateIndex] ?? 0) +
          (item.breakdown?.uncachedInput[dateIndex] ?? 0) +
          (item.breakdown?.output[dateIndex] ?? 0)
        : (item.values[dateIndex] ?? 0);
      maxValue = Math.max(maxValue, value);
    }
  }
  return maxValue;
}

function CodingPlanBarTooltipContent(props: ChartTooltipContentProps) {
  const filteredPayload = useMemo(
    () =>
      (props.payload ?? []).filter((item) => {
        const value = typeof item.value === "number" ? item.value : Number(item.value);
        return Number.isFinite(value) && value > 0;
      }),
    [props.payload],
  );

  if (!props.active || filteredPayload.length === 0) {
    return null;
  }

  return <ChartTooltipContent {...props} payload={filteredPayload} />;
}

export function CodingPlanUsageBarChart({
  emptyDescription,
  granularity,
  series,
  valueKind = "count",
  xTime,
}: {
  emptyDescription: string;
  granularity: CodingPlanUsageGranularity;
  series: CodingPlanBarChartSeries[];
  valueKind?: "count" | "credit" | "speed" | "token";
  xTime: string[];
}) {
  const { intl, locale } = useZCodeIntl();
  const tokenUnit = intl.formatMessage({ id: "settings.usage.tokenUnit" });
  const creditUnit = intl.formatMessage({ id: "settings.usage.creditUnit" });
  const visibleSeries = useMemo(() => series.slice(0, 6), [series]);
  const barKeys = useMemo(
    () => buildBarKeys({ intl, series: visibleSeries }),
    [intl, visibleSeries],
  );
  const chartConfig = useMemo(
    () =>
      barKeys.reduce<ChartConfig>((config, item) => {
        config[item.key] = {
          label: item.label,
          color: item.color,
        };
        return config;
      }, {}),
    [barKeys],
  );
  const chartData = useMemo(
    () => buildChartData({ granularity, locale, series: visibleSeries, xTime }),
    [granularity, locale, visibleSeries, xTime],
  );
  const maxValue = useMemo(
    // tooltip 的总量是当天所有模型合计，但柱子是按模型并排展示。
    // Y 轴如果用合计值做 domain，会把每根并排柱压矮，导致图表上方空白过多。
    () => calculateCodingPlanBarChartMaxValue(visibleSeries, xTime.length),
    [visibleSeries, xTime.length],
  );
  const shouldShowAxisLabel = useCallback(
    (value: string, index: number) => (shouldShowXAxisLabel(index, chartData.length) ? value : ""),
    [chartData.length],
  );
  const formatTooltipValue = useCallback(
    (value: unknown, name: unknown, item: unknown) => {
      const tooltipItem = item as { color?: unknown };
      const indicatorColor =
        typeof tooltipItem.color === "string" ? tooltipItem.color : "var(--color-border)";
      return (
        <>
          <span
            className="size-2 shrink-0 self-center rounded-full"
            style={{ backgroundColor: indicatorColor }}
          />
          <span className="min-w-0 flex-1 truncate text-foreground-subtle">{String(name)}</span>
          <span className="flex shrink-0 items-baseline gap-1 text-foreground">
            <span className="font-mono font-medium tabular-nums">
              {typeof value === "number"
                ? valueKind === "token"
                  ? formatCompactTokenUsage(locale, value)
                  : formatCompactNumber(locale, value)
                : String(value)}
            </span>
            {typeof value === "number" && valueKind === "token" ? (
              <span className="text-foreground-subtle">{tokenUnit}</span>
            ) : typeof value === "number" && valueKind === "credit" ? (
              <span className="text-foreground-subtle">{creditUnit}</span>
            ) : typeof value === "number" && valueKind === "speed" ? (
              <span className="text-foreground-subtle">tokens/s</span>
            ) : null}
          </span>
        </>
      );
    },
    [creditUnit, locale, tokenUnit, valueKind],
  );
  const formatTooltipLabel = useCallback(
    (_: unknown, payload: readonly { payload?: unknown }[]) => {
      const row = payload[0]?.payload as CodingPlanBarChartRow | undefined;
      const total = typeof row?.total === "number" ? row.total : 0;
      const formattedTotal =
        valueKind === "token"
          ? formatCompactTokenUsage(locale, total)
          : formatCompactNumber(locale, total);
      return (
        <>
          <div className="text-foreground-subtle">{row?.label ?? ""}</div>
          <div className="mt-3 flex items-center justify-between gap-8 text-foreground">
            <span>
              {intl.formatMessage({
                id: "settings.usage.codingPlanLegendTotal",
              })}
              :
            </span>
            <span className="flex items-baseline gap-1">
              <span className="font-mono font-medium tabular-nums">{formattedTotal}</span>
              {valueKind === "token" ? (
                <span className="text-foreground-subtle">{tokenUnit}</span>
              ) : valueKind === "credit" ? (
                <span className="text-foreground-subtle">{creditUnit}</span>
              ) : null}
            </span>
          </div>
          <div className="mt-3 border-t border-border" />
        </>
      );
    },
    [creditUnit, intl, locale, tokenUnit, valueKind],
  );
  const tooltipContent = useMemo(
    () => (
      <CodingPlanBarTooltipContent
        className="max-w-96 min-w-72"
        indicator="dot"
        labelFormatter={formatTooltipLabel}
        formatter={formatTooltipValue}
      />
    ),
    [formatTooltipLabel, formatTooltipValue],
  );

  if (visibleSeries.length === 0 || xTime.length === 0 || maxValue <= 0) {
    return (
      <UsageEmptyState
        title={intl.formatMessage({ id: "settings.usage.emptyTitle" })}
        description={emptyDescription}
      />
    );
  }

  return (
    <div className="px-3 py-3">
      <ChartContainer config={chartConfig} className="h-64 w-full">
        <BarChart accessibilityLayer data={chartData} margin={CODING_PLAN_BAR_CHART_MARGIN}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            interval={0}
            minTickGap={0}
            tickMargin={8}
            tickFormatter={shouldShowAxisLabel}
          />
          <YAxis hide domain={[0, maxValue]} />
          <ChartTooltip cursor={false} content={tooltipContent} />
          {barKeys.map((item) => (
            <Bar
              key={item.key}
              dataKey={item.key}
              fill={`var(--color-${item.key})`}
              // Recharts 默认把 dataKey 当 tooltip name，导致堆叠段展示
              // series0_cachedInput 这类内部字段。这里显式传产品文案给 tooltip formatter。
              name={item.label}
              maxBarSize={CODING_PLAN_BAR_CHART_MAX_BAR_SIZE}
              radius={item.radius}
              stackId={item.stackId}
            />
          ))}
        </BarChart>
      </ChartContainer>
    </div>
  );
}
