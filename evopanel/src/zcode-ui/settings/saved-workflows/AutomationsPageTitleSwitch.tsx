import { useCallback, type KeyboardEvent } from "react";
import { TID_AUTOMATIONS_PAGE_TAB, testId } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 自动化页的两个顶级标签。 */
export type AutomationsPageTab = "automation" | "workflow";

const AUTOMATIONS_PAGE_TABS: readonly AutomationsPageTab[] = ["automation", "workflow"];

/**
 * 自动化页的标题。动态工作流灰度未命中时
 * 页面只有「自动化」一件事，标题就退回引入「工作流」标签之前的那个平铺 h1——不留一个只有
 * 一项的 tablist，也不把方向键切换留在原地。
 */
export function AutomationsPageTitle({
  workflowTabEnabled,
  value,
  onValueChange,
}: {
  workflowTabEnabled: boolean;
  value: AutomationsPageTab;
  onValueChange: (tab: AutomationsPageTab) => void;
}) {
  const { intl } = useZCodeIntl();
  if (!workflowTabEnabled) {
    // 字号与切换态同源：30/34 页面标题层级，切换在不在场不该改变标题的视觉层级。
    return (
      <h1 className="text-[30px] font-medium leading-[34px] tracking-[0.114px] text-foreground">
        {intl.formatMessage({ id: "settings.automations.title" })}
      </h1>
    );
  }
  return <AutomationsPageTitleSwitch value={value} onValueChange={onValueChange} />;
}

/**
 * 页标题本身就是切换：「自动化 / 工作流」两个 30px 标题词并排，未选中的用次级色。
 * 不在标题下再长一排标签——定时任务 / 闲时任务的胶囊行留在「自动化」内部，两级各用一种视觉。
 * 字号沿用 AutomationsSection 原 h1 的标题层级。
 */
export function AutomationsPageTitleSwitch({
  value,
  onValueChange,
}: {
  value: AutomationsPageTab;
  onValueChange: (tab: AutomationsPageTab) => void;
}) {
  const { intl } = useZCodeIntl();
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const index = AUTOMATIONS_PAGE_TABS.indexOf(value);
      const next =
        AUTOMATIONS_PAGE_TABS[
          (index + (event.key === "ArrowRight" ? 1 : -1) + AUTOMATIONS_PAGE_TABS.length) %
            AUTOMATIONS_PAGE_TABS.length
        ]!;
      onValueChange(next);
    },
    [onValueChange, value],
  );

  return (
    <div
      role="tablist"
      aria-label={intl.formatMessage({ id: "automations.pageTab.ariaLabel" })}
      className="flex items-baseline gap-5"
      onKeyDown={handleKeyDown}
    >
      {AUTOMATIONS_PAGE_TABS.map((tab) => {
        const active = tab === value;
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            data-testid={testId(TID_AUTOMATIONS_PAGE_TAB, tab)}
            onClick={() => onValueChange(tab)}
            className={cn(
              "rounded-md text-[30px] font-medium leading-[34px] tracking-[0.114px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
              active ? "text-foreground" : "text-foreground-subtle hover:text-foreground",
            )}
          >
            {intl.formatMessage({ id: `automations.pageTab.${tab}` })}
          </button>
        );
      })}
    </div>
  );
}
