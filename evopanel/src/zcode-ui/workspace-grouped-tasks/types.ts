import type { ZCodeTaskGroupColor } from "@zcode/services";

interface TaskGroupMenuItem {
  id: string;
  title: string;
  color: ZCodeTaskGroupColor;
}
const TASK_GROUP_COLORS = [
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
] satisfies ZCodeTaskGroupColor[];
const TASK_GROUP_COLOR_CLASS: Record<ZCodeTaskGroupColor, string> = {
  gray: "bg-zinc-300 text-zinc-800 dark:bg-zinc-400/32 dark:text-zinc-100",
  red: "bg-rose-300 text-rose-900 dark:bg-rose-400/32 dark:text-rose-50",
  orange: "bg-orange-300 text-orange-900 dark:bg-orange-400/32 dark:text-orange-50",
  yellow: "bg-amber-300 text-amber-900 dark:bg-amber-300/32 dark:text-amber-50",
  green: "bg-emerald-300 text-emerald-900 dark:bg-emerald-400/32 dark:text-emerald-50",
  blue: "bg-sky-300 text-sky-900 dark:bg-sky-400/32 dark:text-sky-50",
  purple: "bg-violet-300 text-violet-900 dark:bg-violet-400/32 dark:text-violet-50",
};
const TASK_GROUP_BORDER_COLOR_CLASS: Record<ZCodeTaskGroupColor, string> = {
  gray: "border-zinc-500/70 dark:border-zinc-400/55",
  red: "border-rose-500/70 dark:border-rose-400/52",
  orange: "border-orange-500/70 dark:border-orange-400/52",
  yellow: "border-amber-500/70 dark:border-amber-300/52",
  green: "border-emerald-500/70 dark:border-emerald-400/52",
  blue: "border-sky-500/70 dark:border-sky-400/52",
  purple: "border-violet-500/70 dark:border-violet-400/52",
};
const TASK_GROUP_CONTAINER_CLASS =
  "relative pt-2.5 pb-0 transition-[width,max-width] duration-200 ease-out";
const TASK_GROUP_HEADER_CLASS =
  "mb-0.5 flex h-8 items-center gap-1 rounded-lg border border-transparent pl-1.5 pr-1 text-ui-base text-foreground transition-[background-color,border-color,box-shadow] hover:bg-surface-hover";
const TASK_GROUP_TITLE_CLASS =
  "min-w-0 max-w-full cursor-pointer truncate rounded-sm px-1 text-left text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused";
const TASK_GROUP_COUNT_BADGE_CLASS =
  "inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-tag/50 px-1.5 py-0.5 text-ui-sm font-medium leading-none text-foreground-subtle";
const TASK_GROUP_CONTENT_CLASS = "ml-4 border-l py-px pl-2";
// 行是纵向列：首行（标题 + 右侧元信息）固定 28px，其下可挂工作流运行行，所以外层只定 min-h。
const TASK_GROUP_ROW_CLASS =
  "flex min-h-7 w-full min-w-0 flex-col justify-center rounded-lg border border-transparent pl-2.5 pr-1 text-left text-ui-base transition-[background-color,border-color,color,opacity]";
const TASK_GROUP_ROW_LINE_CLASS = "flex h-7 w-full min-w-0 items-center gap-2";
export {
  TASK_GROUP_ROW_LINE_CLASS,
  TASK_GROUP_COLOR_CLASS,
  TASK_GROUP_BORDER_COLOR_CLASS,
  TASK_GROUP_COLORS,
  TASK_GROUP_CONTAINER_CLASS,
  TASK_GROUP_CONTENT_CLASS,
  TASK_GROUP_COUNT_BADGE_CLASS,
  TASK_GROUP_HEADER_CLASS,
  TASK_GROUP_ROW_CLASS,
  TASK_GROUP_TITLE_CLASS,
};

export type { TaskGroupMenuItem };
