import { type ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";

/**
 * workflow run 详情页里可折叠分区的表头栏。
 *
 * 待答问题区与产物区共用这一条栏：它们的折叠语义完全一样，各写一遍迟早在圆角、hover 色
 * 或 chevron 角度上漂开。原型是当年 Script 区那个 toggle（从它原样抽出），所以这条栏
 * **不含任何新的视觉词汇**。Results / 事件日志 / Script 三节已撤走，
 * 留下的两个调用方默认态相反（问题收起、产物展开），而那是各节自己的事，不是本组件的。
 *
 * 表头只负责「开合这件事」：正文的取数、门控与布局都留在各节自己手里。
 *
 * **刻意不 memo**：它的调用方本身都是 memo 组件，只在自己的状态或投影变化时重渲染——
 * 那时这条栏的 `expanded`/`label`/`trailing` 正好也变了。包上 memo 只会把 `onToggle` 与
 * `trailing` 逼进 `useCallback`/`useMemo`（reactStableReferences 那条守卫会要求），
 * 换来的是一层永远命中不了的比较。
 */
export function WorkflowRunSectionToggle({
  expanded,
  label,
  onToggle,
  testId,
  title,
  trailing,
}: {
  expanded: boolean;
  /** aria-label：按当前状态给「展开 X」/「收起 X」，标题本身由 `title` 承担。 */
  label: string;
  onToggle: () => void;
  testId: string;
  title: string;
  /**
   * 表头右侧的附属信息（条数、loading 提示等）。收起时也在场——折叠不能让
   * 「这一节里到底有没有东西」变得不可见。
   */
  trailing?: ReactNode;
}) {
  return (
    <button
      aria-expanded={expanded}
      aria-label={label}
      className="flex w-full items-center gap-1.5 px-4 py-2 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/40"
      data-testid={testId}
      onClick={onToggle}
      type="button"
    >
      <ChevronRightIcon
        className={cn(
          "size-3.5 shrink-0 text-foreground-subtlest transition-transform",
          expanded ? "rotate-90" : undefined,
        )}
      />
      <span className="min-w-0 flex-1 truncate text-ui-xs font-medium text-foreground-subtle">
        {title}
      </span>
      {trailing}
    </button>
  );
}
