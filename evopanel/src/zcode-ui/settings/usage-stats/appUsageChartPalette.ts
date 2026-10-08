export const APP_USAGE_MODEL_CHART_COLORS = [
  "var(--color-usage-chart-1)",
  "var(--color-usage-chart-2)",
  "var(--color-usage-chart-3)",
  "var(--color-usage-chart-4)",
  "var(--color-usage-chart-5)",
  "var(--color-usage-chart-6)",
] as const;

export function getAppUsageModelChartColor(index: number): string {
  return (
    APP_USAGE_MODEL_CHART_COLORS[index % APP_USAGE_MODEL_CHART_COLORS.length] ??
    APP_USAGE_MODEL_CHART_COLORS[0]
  );
}
