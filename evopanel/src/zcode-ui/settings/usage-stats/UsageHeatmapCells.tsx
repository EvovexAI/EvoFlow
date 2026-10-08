import type { CSSProperties } from "react";
import type { AppUsageHeatmapCell } from "@zcode/shared";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";

const HEATMAP_LEVEL_STYLES = [
  "var(--color-usage-heatmap-0)",
  "var(--color-usage-heatmap-1)",
  "var(--color-usage-heatmap-2)",
  "var(--color-usage-heatmap-3)",
  "var(--color-usage-heatmap-4)",
];

export type TokenActivityMode = "daily" | "weekly" | "cumulative";

export interface HeatmapDisplayCell {
  key: string;
  tooltipTitle?: string;
  level: AppUsageHeatmapCell["level"];
  hasUsage: boolean;
  columnHover: boolean;
}

export interface HeatmapDisplayColumn {
  key: string;
  monthDate: string;
  tooltipTitle: string | null;
  cells: HeatmapDisplayCell[];
}

function getHeatmapCellStyle(level: number): CSSProperties {
  return {
    backgroundColor: HEATMAP_LEVEL_STYLES[level] ?? HEATMAP_LEVEL_STYLES[0],
  };
}

export function HeatmapColumn({
  column,
  mode,
}: {
  column: HeatmapDisplayColumn;
  mode: TokenActivityMode;
}) {
  const node = (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1",
        mode !== "daily" && "group/usage-heatmap-column",
      )}
    >
      {column.cells.map((cell) => (
        <HeatmapCell key={cell.key} cell={cell} />
      ))}
    </div>
  );

  if (!column.tooltipTitle) {
    return node;
  }

  return <ControlHintTooltip title={column.tooltipTitle}>{node}</ControlHintTooltip>;
}

function HeatmapCell({ cell }: { cell: HeatmapDisplayCell }) {
  const node = (
    <div
      className={cn(
        "aspect-square w-full min-w-0 rounded-[4px] border transition-transform hover:scale-110 hover:border-border-hover",
        cell.hasUsage ? "border-border" : "border-transparent",
        cell.columnHover && "group-hover/usage-heatmap-column:border-border-hover",
      )}
      style={getHeatmapCellStyle(cell.level)}
    />
  );

  if (cell.tooltipTitle) {
    return <ControlHintTooltip title={cell.tooltipTitle}>{node}</ControlHintTooltip>;
  }

  return node;
}
