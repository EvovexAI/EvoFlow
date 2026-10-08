/**
 * 四个预置渲染器共用的小零件：labels 契约、空态、字段标签、揭示动画的类名。
 *
 * 这些组件**一律不碰 i18n**：run 侧板与 `workflow-artifact` tab 各自持有 intl，
 * 把已翻译的文案经 `labels` 传进来。理由是渲染器要能被侧板、tab、（将来的）中枢详情页
 * 三处复用，谁在什么语境下叫什么由调用方决定；组件自己去查 message id 会把这三处焊死。
 */

import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";

/** 调用方必须提供的三句译文（其余文案全部来自 spec 里作者自己写的 label / title）。 */
export type PresetLabels = {
  /** 看板里承接「未在 columns 里列出的 status」的那一列的名字。 */
  otherColumn: string;
  /** 一条数据都还没到时的提示。 */
  empty: string;
  /** 「N 条」——表格行数、看板卡片数。 */
  itemsCount: (count: number) => string;
};

/**
 * 新元素的揭示动画。稳定 React key + 只在**挂载**时播一次，所以老点不会随着新点到达重播；
 * `motion-reduce` 下整个关掉。
 */
export const REVEAL_ANIMATION_CLASS =
  "animate-in fade-in duration-300 ease-out motion-reduce:animate-none";

/** 一条数据都没有时的占位。压到最低存在感：看板本身在运行期就是会先空着的。 */
export function PresetEmpty({ label, compact }: { label: string; compact?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-lg border border-dashed border-border text-foreground-subtlest",
        compact ? "px-2 py-3 text-ui-xs" : "px-4 py-8 text-ui-sm",
      )}
      data-testid="artifact-preset-empty"
    >
      {label}
    </div>
  );
}

/** 字段名 + 单位的统一写法：单位跟在标签后面的括号里，不重复到每一个值上（dataviz 惯例）。 */
export function fieldHeading(label: string, unit?: string): string {
  return unit ? `${label} (${unit})` : label;
}

/**
 * 全尺寸形态的标题条：spec 的 title / description 由作者用用户语言写好，这里原样呈现。
 * 三样都没有时整块**缺席**（连外边距一起消失）——所以外边距由这里带，而不是调用方包一层 div。
 */
export function PresetHeading({
  title,
  description,
  trailing,
  className,
}: {
  title?: string;
  description?: string;
  trailing?: ReactNode;
  className?: string;
}) {
  if (!title && !description && !trailing) {
    return null;
  }
  return (
    <div className={cn("flex items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        {title ? (
          <div className="truncate text-ui-base font-medium text-foreground">{title}</div>
        ) : null}
        {description ? (
          <div className="mt-0.5 text-ui-sm text-foreground-subtle">{description}</div>
        ) : null}
      </div>
      {trailing ? <div className="shrink-0">{trailing}</div> : null}
    </div>
  );
}
