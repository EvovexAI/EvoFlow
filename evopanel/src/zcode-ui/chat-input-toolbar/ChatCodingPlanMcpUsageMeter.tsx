import { InfoIcon } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";

export function ChatCodingPlanMcpUsageMeter({
  color,
  description,
  label,
  percentage,
  primaryQuotaCount,
  resetTime,
  value,
}: {
  color: string;
  description: string;
  label: string;
  percentage: number | null;
  primaryQuotaCount: number;
  resetTime?: string;
  value: string;
}) {
  const boundedPercentage = Number.isFinite(percentage)
    ? Math.max(0, Math.min(100, percentage ?? 0))
    : 0;
  // MCP 不必无条件占据独立横行，只有一两张主额度时会浪费网格空位；
  // 主额度占满三列时才保留贯穿行，否则沿用普通额度卡片结构补入当前行。
  const fullRow = primaryQuotaCount >= 3;
  const progressWidth = fullRow ? "calc((100% - 1rem) / 3)" : undefined;
  const labelContent = (
    <span className="flex min-w-0 items-center gap-1">
      <span className="min-w-0 truncate text-foreground-subtle">{label}</span>
      <ControlHintTooltip title={description} standalone>
        <button
          type="button"
          aria-label={description}
          className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-foreground-subtle transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          data-context-mcp-info="true"
        >
          <InfoIcon aria-hidden="true" className="size-3.5" />
        </button>
      </ControlHintTooltip>
    </span>
  );
  const valueContent = (
    <span className="min-w-0 truncate whitespace-nowrap tabular-nums">
      <span className="font-mono text-foreground">{value}</span>
      {resetTime ? <span className="text-ui-xs text-foreground-subtle"> · {resetTime}</span> : null}
    </span>
  );
  const progressContent = (
    <div
      className={cn(
        "h-1.5 min-w-10 overflow-hidden rounded-full bg-surface-hover",
        fullRow ? "shrink-0" : undefined,
      )}
      style={progressWidth ? { width: progressWidth } : undefined}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none",
          boundedPercentage > 0 ? "min-w-1.5" : undefined,
        )}
        style={{ backgroundColor: color, width: `${boundedPercentage}%` }}
      />
    </div>
  );

  if (!fullRow) {
    return (
      <div
        className="min-w-0 space-y-1.5"
        data-context-mcp-layout="card"
        data-context-mcp-usage="inline"
        data-primary-quota-count={primaryQuotaCount}
      >
        <div className="min-w-0 space-y-0.5 text-ui-sm">
          <div className="flex min-h-5 min-w-0 items-center">{labelContent}</div>
          <div className="relative min-w-0 overflow-hidden text-ui-sm">{valueContent}</div>
        </div>
        {progressContent}
      </div>
    );
  }

  return (
    <div
      className="col-span-3 mt-1 flex min-w-0 items-center gap-2 border-t border-border pt-1.5 text-ui-sm"
      data-context-mcp-layout="full-row"
      data-context-mcp-usage="inline"
      data-primary-quota-count={primaryQuotaCount}
    >
      <span className="shrink-0">{labelContent}</span>
      {/* truncate 放在内层 inline span 不会生效，长日期会溢出并遮挡固定宽度进度条；
          截断约束必须由这个实际参与 flex 收缩的容器承担。 */}
      <span className="ml-auto min-w-0 shrink overflow-hidden text-ellipsis whitespace-nowrap">
        {valueContent}
      </span>
      {progressContent}
    </div>
  );
}
