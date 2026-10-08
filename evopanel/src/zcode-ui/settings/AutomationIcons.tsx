import type { SVGProps } from "react";
import {
  ChevronDown,
  CirclePlay,
  CircleStop,
  Clock,
  Ellipsis,
  ExternalLink,
  Info,
  Moon,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Square,
  Trash2,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";

type AutomationSvgIconProps = SVGProps<SVGSVGElement>;

/**
 * Automations 统一使用 Lucide 原生 24×24 viewBox 与 2px 描边。
 * 旧设计稿 glyph 先裁切到 14.6667px 再放大，会连同描边一起放粗。
 */
const AUTOMATION_ICON_PROPS = {
  size: 16,
  strokeWidth: 2,
} as const;

export function AutomationChevronDownIcon({
  size = 12,
  containerSize = 20,
}: {
  size?: 12 | 14;
  containerSize?: 18 | 20;
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center",
        containerSize === 18 ? "size-4.5" : "size-5",
      )}
      aria-hidden="true"
    >
      <ChevronDown size={size} strokeWidth={2} className={size === 14 ? "size-3.5" : "size-3"} />
    </span>
  );
}

export function AutomationAddScheduleIcon(props: AutomationSvgIconProps) {
  return <Plus {...AUTOMATION_ICON_PROPS} {...props} />;
}

export function AutomationInfoIcon(props: AutomationSvgIconProps) {
  return <Info {...AUTOMATION_ICON_PROPS} {...props} />;
}

export function AutomationIdleTimeIcon(props: AutomationSvgIconProps) {
  return <Moon {...AUTOMATION_ICON_PROPS} {...props} />;
}

export function AutomationPausedIcon(props: AutomationSvgIconProps) {
  return <CircleStop {...AUTOMATION_ICON_PROPS} {...props} />;
}

export function AutomationPauseActionIcon(props: AutomationSvgIconProps) {
  return <CircleStop {...AUTOMATION_ICON_PROPS} {...props} />;
}

export function AutomationEditActionIcon(props: AutomationSvgIconProps) {
  return <Pencil {...AUTOMATION_ICON_PROPS} {...props} />;
}

export function AutomationRunNowIcon(props: AutomationSvgIconProps) {
  return <Play {...AUTOMATION_ICON_PROPS} {...props} />;
}

export function AutomationContinueIcon(props: AutomationSvgIconProps) {
  return <CirclePlay {...AUTOMATION_ICON_PROPS} {...props} />;
}

export function AutomationCancelActionIcon(props: AutomationSvgIconProps) {
  return <Square {...AUTOMATION_ICON_PROPS} fill="currentColor" {...props} />;
}

export function AutomationClockIcon(props: AutomationSvgIconProps) {
  return <Clock {...AUTOMATION_ICON_PROPS} {...props} />;
}

export function AutomationMoreHorizontalIcon(props: AutomationSvgIconProps) {
  return <Ellipsis {...AUTOMATION_ICON_PROPS} {...props} />;
}

export function AutomationExternalLinkIcon(props: AutomationSvgIconProps) {
  return <ExternalLink {...AUTOMATION_ICON_PROPS} {...props} />;
}

export function AutomationRefreshIcon(props: AutomationSvgIconProps) {
  return <RefreshCw {...AUTOMATION_ICON_PROPS} {...props} />;
}

export function AutomationTrashIcon() {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
      <Trash2 className="size-4" {...AUTOMATION_ICON_PROPS} />
    </span>
  );
}
