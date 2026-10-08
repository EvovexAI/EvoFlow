import { TID_AUTOMATION_CREATE_MANUALLY, TID_AUTOMATION_CREATE_MENU } from "@zcode/shared";
import type { ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { AutomationSwitchToggle } from "@/settings/AutomationSwitchToggle.js";
import { AutomationChevronDownIcon, AutomationInfoIcon } from "@/settings/AutomationIcons.js";
import { Button } from "@/components/ui/button.js";
import { SettingsSegmentedTabs } from "@/settings/SettingsSegmentedTabs.js";

export {
  AutomationAddScheduleIcon,
  AutomationCancelActionIcon,
  AutomationChevronDownIcon,
  AutomationClockIcon,
  AutomationContinueIcon,
  AutomationEditActionIcon,
  AutomationExternalLinkIcon,
  AutomationIdleTimeIcon,
  AutomationInfoIcon,
  AutomationMoreHorizontalIcon,
  AutomationPauseActionIcon,
  AutomationPausedIcon,
  AutomationRefreshIcon,
  AutomationRunNowIcon,
  AutomationTrashIcon,
} from "@/settings/AutomationIcons.js";

// space-y 给行内 label 添加 margin 时会受字体行盒影响，实际视觉间距小于设计稿的 6px。
export const AUTOMATION_FORM_FIELD_CLASSNAME = "flex flex-col gap-1.5";

export type AutomationSettingsHistoryTab = "settings" | "history";

/** 定时与闲时共用运行历史空态，防止透明留白与卡片容器样式再次漂移。 */
export function AutomationHistoryEmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[226px] items-center justify-center rounded-xl border border-dashed border-card-border bg-background px-4 text-center text-ui-base text-foreground-subtle">
      {children}
    </div>
  );
}

/** 定时与闲时设置页复用 Hooks scope tabs 的 pill 视觉，避免详情页分段样式漂移。 */
export function AutomationSettingsHistoryTabs({
  value,
  settingsLabel,
  historyLabel,
  onValueChange,
}: {
  value: AutomationSettingsHistoryTab;
  settingsLabel: string;
  historyLabel: string;
  onValueChange: (value: AutomationSettingsHistoryTab) => void;
}) {
  return (
    <SettingsSegmentedTabs
      value={value}
      items={[
        { value: "settings", label: settingsLabel },
        { value: "history", label: historyLabel },
      ]}
      onValueChange={onValueChange}
    />
  );
}

/** Keep-awake 提示条；开关值由调用方接入全局共享设置，而非页面级 mock store。 */
export function AutomationKeepAwakeNotice({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  // 桌面断点曾清空提示栏的垂直内边距，导致实际样式偏离 12px 规格。
  return (
    <div
      data-automations-keep-awake
      className="flex min-h-11 w-full items-center gap-3 overflow-hidden rounded-[10px] bg-surface px-3 py-3 text-foreground-subtle"
    >
      <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
        <AutomationInfoIcon className="size-4" />
      </span>
      <p className="min-w-0 flex-1 text-ui-base leading-5">
        {intl.formatMessage({ id: "offPeak.keepAwakeBanner" })}
      </p>
      <AutomationSwitchToggle
        checked={checked}
        ariaLabel={intl.formatMessage({ id: "offPeak.keepAwakeBanner" })}
        onChange={onChange}
        color="blue"
        size="sm"
      />
    </div>
  );
}

export function AutomationCreateDropdown({
  onViaChat,
  onManually,
}: {
  onViaChat: () => void;
  onManually: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <DropdownMenu>
      <div className="inline-flex h-7 items-center overflow-hidden rounded-lg">
        <Button
          type="button"
          variant="default"
          size="default"
          className="rounded-none border-0"
          data-testid={TID_AUTOMATION_CREATE_MANUALLY}
          onClick={onManually}
        >
          {intl.formatMessage({ id: "automations.createManually" })}
        </Button>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="default"
            size="icon-md"
            data-testid={TID_AUTOMATION_CREATE_MENU}
            aria-label={intl.formatMessage({ id: "automations.create" })}
            className="!w-6 rounded-none border-0"
          >
            <AutomationChevronDownIcon size={14} />
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="end" sideOffset={4} className="w-auto min-w-0">
        <DropdownMenuItem className="pr-6" onSelect={onViaChat}>
          {intl.formatMessage({ id: "automations.createViaChat" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
