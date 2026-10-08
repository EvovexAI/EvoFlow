import type {
  CodingPlanModelData,
  CodingPlanToolData,
  CodingPlanUsageDetailMetric,
  CodingPlanUsageDetailSubject,
} from "@zcode/shared";

type CodingPlanLineChartSeries = Array<{
  name: string;
  values: number[];
  breakdown?: {
    cachedInput: number[];
    uncachedInput: number[];
    output: number[];
  };
}>;

export function buildCodingPlanModelLineChartSeries(
  modelDataList: CodingPlanModelData[],
): CodingPlanLineChartSeries {
  return modelDataList.map((item) => ({
    name: item.modelName,
    values: item.tokensUsage,
  }));
}

export function buildCodingPlanToolLineChartSeries(
  toolDataList: CodingPlanToolData[],
): CodingPlanLineChartSeries {
  return toolDataList.map((item) => ({
    name: item.toolName,
    values: item.usageCount,
  }));
}

export function buildCodingPlanUsageDetailLineChartSeries(params: {
  metric: CodingPlanUsageDetailMetric;
  subject: CodingPlanUsageDetailSubject;
  modelDataList: CodingPlanModelData[];
  toolDataList: CodingPlanToolData[];
}): CodingPlanLineChartSeries {
  if (params.subject === "model") {
    return params.modelDataList.map((item) => ({
      name: item.modelName,
      values: params.metric === "credits" ? (item.creditsUsage ?? []) : item.tokensUsage,
      breakdown: {
        cachedInput:
          params.metric === "credits"
            ? (item.cachedInputCreditsUsage ?? [])
            : (item.cachedInputTokensUsage ?? []),
        uncachedInput:
          params.metric === "credits"
            ? (item.uncachedInputCreditsUsage ?? [])
            : (item.uncachedInputTokensUsage ?? []),
        output:
          params.metric === "credits"
            ? (item.outputCreditsUsage ?? [])
            : (item.outputTokensUsage ?? []),
      },
    }));
  }
  return params.toolDataList.map((item) => ({
    name: item.toolName,
    values: params.metric === "credits" ? (item.creditsUsage ?? []) : item.usageCount,
  }));
}
