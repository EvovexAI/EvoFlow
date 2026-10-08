/**
 * `chart` 预置渲染器的**实现**（recharts 在这个模块里，且只在这里）。
 *
 * 不要直接从 index 静态导入它：recharts 在模块初始化阶段会触发 decimal.js-light 的 LN10 校验，
 * 在 Electron Linux 容器里能阻断整个 renderer 启动（同 `AppUsagePanel.tsx` 里记下的那次修复）。
 * 对外的入口是 `ArtifactChart.tsx`，它用 `lazy()` 把这个模块推到首屏之外。
 *
 * 两种形态：
 * - `compact`：run 侧板卡片里的**无轴 sparkline + 最新值**；
 * - 全尺寸：`workflow-artifact` tab 里的带轴图 + 图例 + 参考线 + tooltip。
 */

import { memo, useMemo } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  Scatter,
  XAxis,
  YAxis,
  type DotItemDotProps,
} from "recharts";
import {
  applyArtifactItems,
  type ArtifactItem,
  type ChartModel,
} from "@/app-shell/workflow-artifacts/presets/apply.js";
import {
  artifactSeriesColorVar,
  artifactSeriesDash,
  artifactSeriesSymbol,
  ARTIFACT_CHART_MAX_SERIES,
} from "@/app-shell/workflow-artifacts/presets/palette.js";
import {
  fieldHeading,
  PresetEmpty,
  PresetHeading,
  REVEAL_ANIMATION_CLASS,
  type PresetLabels,
} from "@/app-shell/workflow-artifacts/presets/parts.js";
import type { ChartSpec } from "@/app-shell/workflow-artifacts/presets/spec.js";
import { cn } from "@/components/lib/utils.js";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart.js";

/** 点多到这个数以上就不画点了：一条挤满圆点的线比没有点更难读。 */
const MAX_VISIBLE_DOTS = 60;
const FULL_MARGIN = { top: 8, right: 16, bottom: 0, left: 0 } as const;
const COMPACT_MARGIN = { top: 4, right: 4, bottom: 4, left: 4 } as const;

/**
 * 新点的揭示：React key 用条目的 `sequence`（稳定），所以只有**这一帧新挂载**的点会播动画，
 * 既有的点保持同一个 DOM 节点、不重播。
 * `motion-reduce` 下类名里的 `animate-none` 直接关掉。
 */
function renderRevealDot(props: DotItemDotProps) {
  const { cx, cy, payload, stroke, index } = props;
  if (typeof cx !== "number" || typeof cy !== "number") {
    return null;
  }
  const sequence =
    payload && typeof payload === "object" && typeof payload.sequence === "number"
      ? payload.sequence
      : index;
  return (
    <circle
      className={REVEAL_ANIMATION_CLASS}
      cx={cx}
      cy={cy}
      fill={stroke}
      key={`reveal-${sequence}`}
      r={4}
    />
  );
}

function buildChartConfig(model: ChartModel): ChartConfig {
  return model.series.reduce<ChartConfig>((config, series) => {
    config[series.key] = {
      label: series.label,
      color: artifactSeriesColorVar(series.colorIndex),
    };
    return config;
  }, {});
}

function seriesMarks(model: ChartModel, showDots: boolean) {
  return model.series.map((series) => {
    const color = `var(--color-${series.key})`;
    if (model.type === "bar") {
      return <Bar dataKey={series.key} fill={color} key={series.key} isAnimationActive={false} />;
    }
    if (model.type === "scatter") {
      return (
        <Scatter
          dataKey={series.key}
          fill={color}
          isAnimationActive={false}
          key={series.key}
          // 点形是散点图上的次级编码（颜色之外的第二条身份线索），同折线的线型。
          shape={artifactSeriesSymbol(series.colorIndex)}
        />
      );
    }
    return (
      <Line
        connectNulls={false}
        dataKey={series.key}
        dot={showDots ? renderRevealDot : false}
        // recharts 自己的入场动画会在每次数据变化时把**整条线**重画一遍；实时增长的图里
        // 那就是每来一个点全线闪一次。这里关掉它，揭示动画只由新点的 CSS 负责。
        isAnimationActive={false}
        key={series.key}
        stroke={color}
        strokeDasharray={artifactSeriesDash(series.colorIndex)}
        strokeWidth={2}
        type="monotone"
      />
    );
  });
}

/**
 * 真正的绘图体，`memo` 且带自定义比较：**只在点数 / 定义域 / 序列构成变化时重渲染**。
 *
 * 理由是 portfolio 修过的第一帧冻结——recharts 会在 effect 里把 props 镜像进内部 store，
 * 父组件每次 render 都换一份 data 引用时，这条镜像链会被放大成成百上千次无意义更新。
 * 条目只追加，所以「点数 + 首尾 sequence + 定义域」足以判定数据是否真的变了。
 */
type PlotProps = { model: ChartModel; compact: boolean };

/**
 * `memo` 的比较谓词（`true` = 跳过重渲染）。单独导出是为了能直接测——「什么时候不重画」
 * 是这张图的性能契约本身，把它藏在 memo 的第二实参里就没法钉住了。
 */
export function chartPlotPropsEqual(previous: PlotProps, next: PlotProps): boolean {
  if (previous.compact !== next.compact) {
    return false;
  }
  const a = previous.model;
  const b = next.model;
  if (a.type !== b.type || a.scale !== b.scale || a.x.numeric !== b.x.numeric) {
    return false;
  }
  if (a.series.length !== b.series.length) {
    return false;
  }
  if (a.series.some((series, index) => series.label !== b.series[index]?.label)) {
    return false;
  }
  if (a.points.length !== b.points.length) {
    return false;
  }
  // 首尾 sequence：点数没变但整批条目被替换过（冷恢复重取）时也能认出来。
  if (a.points[0]?.sequence !== b.points[0]?.sequence) {
    return false;
  }
  if (a.points.at(-1)?.sequence !== b.points.at(-1)?.sequence) {
    return false;
  }
  if (a.baseline?.value !== b.baseline?.value) {
    return false;
  }
  return (
    a.domain?.xMin === b.domain?.xMin &&
    a.domain?.xMax === b.domain?.xMax &&
    a.domain?.yMin === b.domain?.yMin &&
    a.domain?.yMax === b.domain?.yMax
  );
}

const ArtifactChartPlot = memo(function ArtifactChartPlot({ model, compact }: PlotProps) {
  const config = useMemo(() => buildChartConfig(model), [model]);
  const showDots = model.points.length <= MAX_VISIBLE_DOTS;
  // 数值 x 才配数值轴；bar 天然是分类比较，一律走分类轴（band scale 才有正确的柱宽）。
  const categoricalX = model.type === "bar" || !model.x.numeric;
  const logDomain: [number, number] | undefined =
    model.scale === "log" && model.domain ? [model.domain.yMin, model.domain.yMax] : undefined;

  if (compact) {
    return (
      <ChartContainer className="h-14 w-full" config={config}>
        <ComposedChart data={model.points} margin={COMPACT_MARGIN}>
          <XAxis
            dataKey={categoricalX ? "xLabel" : "x"}
            hide
            type={categoricalX ? "category" : "number"}
          />
          <YAxis hide {...(logDomain ? { domain: logDomain, scale: "log" as const } : {})} />
          {seriesMarks(model, showDots && model.points.length <= 24)}
        </ComposedChart>
      </ChartContainer>
    );
  }

  return (
    <ChartContainer className="h-56 w-full" config={config}>
      <ComposedChart data={model.points} margin={FULL_MARGIN}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis
          axisLine={false}
          dataKey={categoricalX ? "xLabel" : "x"}
          minTickGap={16}
          tickLine={false}
          tickMargin={8}
          type={categoricalX ? "category" : "number"}
          {...(categoricalX ? {} : { domain: ["dataMin", "dataMax"] as [string, string] })}
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          tickMargin={4}
          width={44}
          {...(logDomain ? { domain: logDomain, scale: "log" as const } : {})}
        />
        {model.baseline ? (
          <ReferenceLine
            label={{
              fill: "var(--color-foreground-subtle)",
              fontSize: 10,
              position: "insideTopRight",
              value: model.baseline.label,
            }}
            stroke="var(--color-foreground-subtlest)"
            strokeDasharray="4 4"
            y={model.baseline.value}
          />
        ) : null}
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_label, payload) => {
                const point = payload?.[0]?.payload as { xLabel?: string } | undefined;
                return fieldHeading(point?.xLabel ?? "", model.x.unit);
              }}
            />
          }
          cursor={false}
        />
        {seriesMarks(model, showDots)}
      </ComposedChart>
    </ChartContainer>
  );
}, chartPlotPropsEqual);

/**
 * 图例。**永远在场（≥1 条序列）**，且每条除了颜色还带自己的线型与最新值——
 * 身份从不只由颜色承担（见 palette.ts 里关于色槽在色觉障碍下不两两可分的那段）。
 */
function ChartLegendRow({ model }: { model: ChartModel }) {
  const latest = model.points.at(-1);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1" role="list">
      {model.series.map((series) => {
        const value = latest?.[series.key];
        return (
          <span
            className="flex min-w-0 items-center gap-1.5 text-ui-sm"
            data-testid="artifact-chart-legend-item"
            key={series.key}
            role="listitem"
          >
            <svg aria-hidden="true" className="shrink-0" height={8} width={16}>
              <line
                stroke={artifactSeriesColorVar(series.colorIndex)}
                strokeDasharray={artifactSeriesDash(series.colorIndex)}
                strokeWidth={2}
                x1={0}
                x2={16}
                y1={4}
                y2={4}
              />
            </svg>
            <span className="truncate text-foreground-subtle">{series.label}</span>
            {typeof value === "number" ? (
              // 直接标注最新值：图例不只是一块色块 + 名字，它同时是这条序列此刻的读数。
              <span className="shrink-0 font-mono text-ui-xs text-foreground tabular-nums">
                {series.unit ? `${value} ${series.unit}` : String(value)}
              </span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

/** compact 形态右侧的「最新值」——sparkline 自己不带轴，数值得由它来交代。 */
function CompactLatestValue({ model }: { model: ChartModel }) {
  const series = model.series[0];
  const latest = model.points.at(-1);
  const value = series && latest ? latest[series.key] : undefined;
  if (typeof value !== "number") {
    return null;
  }
  return (
    <span className="flex shrink-0 items-baseline gap-1" data-testid="artifact-chart-latest">
      <span
        className={cn(
          "font-mono text-ui-base font-medium text-foreground tabular-nums",
          REVEAL_ANIMATION_CLASS,
        )}
        key={`latest-${latest?.sequence ?? "none"}`}
      >
        {value}
      </span>
      {series?.unit ? (
        <span className="text-ui-xs text-foreground-subtle">{series.unit}</span>
      ) : null}
    </span>
  );
}

export function ArtifactChartView({
  spec,
  items,
  compact = false,
  labels,
  className,
}: {
  spec: ChartSpec;
  items: readonly ArtifactItem[];
  compact?: boolean;
  labels: PresetLabels;
  className?: string;
}) {
  const model = useMemo(() => {
    const built = applyArtifactItems("chart", spec, items);
    // 色槽只有 6 个，多出来的序列不画——循环复用颜色会让两条序列长得一模一样。
    return built.series.length > ARTIFACT_CHART_MAX_SERIES
      ? { ...built, series: built.series.slice(0, ARTIFACT_CHART_MAX_SERIES) }
      : built;
  }, [spec, items]);

  if (model.points.length === 0) {
    return (
      <div className={className}>
        {compact ? null : (
          <PresetHeading className="mb-3" description={spec.description} title={spec.title} />
        )}
        <PresetEmpty compact={compact} label={labels.empty} />
      </div>
    );
  }

  if (compact) {
    return (
      <div
        className={cn("flex min-w-0 items-center gap-2", className)}
        data-testid="artifact-chart-compact"
      >
        <div className="min-w-0 flex-1">
          <ArtifactChartPlot compact model={model} />
        </div>
        <CompactLatestValue model={model} />
      </div>
    );
  }

  return (
    <div className={cn("min-w-0", className)} data-testid="artifact-chart">
      <PresetHeading className="mb-2" description={spec.description} title={spec.title} />
      <div className="mb-2">
        <ChartLegendRow model={model} />
      </div>
      <ArtifactChartPlot compact={false} model={model} />
      <div className="mt-1 text-center text-ui-xs text-foreground-subtlest">
        {fieldHeading(model.x.label, model.x.unit)}
      </div>
    </div>
  );
}

export default ArtifactChartView;
