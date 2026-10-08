/**
 * `chart` 预置渲染器的**入口**：懒加载 + 局部故障隔离，本模块自己不碰 recharts。
 *
 * 为什么必须懒：recharts 在模块初始化阶段会触发 decimal.js-light 的 LN10 校验，在 Electron
 * Linux 容器里会阻断整个 renderer 启动（`AppUsagePanel.tsx` 里记着的那次修复；spec 的
 * 「预置渲染器」行也把 `lazy()` 写成硬要求）。所以：
 * - 绘图体在 `ArtifactChartView.tsx`，只经 `lazy()` 的动态 import 抵达；
 * - 这个文件与 `index.ts` 的静态依赖里没有 recharts，谁 import 它们都不会把图表打进首屏。
 *
 * 调用方也可以绕过这层，自己 `lazy(() => import(".../ArtifactChartView.js"))` 并接管
 * Suspense / 错误边界——本文件只是那套接法的默认封装。
 */

import { lazy, Suspense } from "react";
import type { ArtifactItem } from "@/app-shell/workflow-artifacts/presets/apply.js";
import type { PresetLabels } from "@/app-shell/workflow-artifacts/presets/parts.js";
import type { ChartSpec } from "@/app-shell/workflow-artifacts/presets/spec.js";
import { cn } from "@/components/lib/utils.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";

const ArtifactChartView = lazy(
  () => import("@/app-shell/workflow-artifacts/presets/ArtifactChartView.js"),
);

/** 加载中的占位：只占位不说话——一句「加载中」在 200ms 的懒加载里只会闪一下。 */
function ChartSkeleton({ compact }: { compact: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "w-full animate-pulse rounded-lg bg-surface motion-reduce:animate-none",
        compact ? "h-14" : "h-56",
      )}
      data-testid="artifact-chart-skeleton"
    />
  );
}

export function ArtifactChart({
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
  return (
    // 图表崩了只塌这一块，run 侧板的其余部分照常——产物区是交付面，不该是单点故障。
    <ScopedErrorBoundary
      resetKeys={[spec, compact]}
      scope="workflow-artifact-chart"
      variant={compact ? "compact" : "inline"}
    >
      <Suspense fallback={<ChartSkeleton compact={compact} />}>
        <ArtifactChartView
          className={className}
          compact={compact}
          items={items}
          labels={labels}
          spec={spec}
        />
      </Suspense>
    </ScopedErrorBoundary>
  );
}
