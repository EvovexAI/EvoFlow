/* eslint-disable max-lines -- 定时任务编辑整页集中维护 Settings/History 两个 tab、cron builder、项目/模型选择器与运行历史，集中更利于交互一致。 */
import { useStartPlanRecommendation } from "@/hooks/useStartPlanRecommendation.js";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { completeNewModelSelection } from "@zcode/provider";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FolderOpen,
  MessageCircle,
  X,
} from "lucide-react";
import {
  resolveWorkspaceKey,
  testId,
  TID_AUTOMATION_CUSTOM_CONFIRM,
  TID_AUTOMATION_CUSTOM_INTERVAL_DECREMENT,
  TID_AUTOMATION_CUSTOM_INTERVAL_INCREMENT,
  TID_AUTOMATION_CUSTOM_INTERVAL_SELECT,
  TID_AUTOMATION_CUSTOM_REPEAT_EDIT,
  TID_AUTOMATION_CUSTOM_UNIT_OPTION,
  TID_AUTOMATION_CUSTOM_UNIT_SELECT,
  TID_AUTOMATION_FORM_PROMPT,
  TID_AUTOMATION_FORM_SUBMIT,
  TID_AUTOMATION_FORM_TITLE,
  TID_AUTOMATION_FREQUENCY_OPTION,
  TID_AUTOMATION_FREQUENCY_SELECT,
  TID_AUTOMATION_RUN_NOW,
  TID_AUTOMATION_SCHEDULE_ADD,
  TID_AUTOMATION_SCHEDULE_DELETE,
  TID_AUTOMATION_SCHEDULE_PREVIEW,
  TID_AUTOMATION_YEAR_DAY_OPTION,
  TID_AUTOMATION_YEAR_MONTH_OPTION,
  TID_AUTOMATION_YEAR_MONTHDAY,
  ZCODE_AGENT_PROVIDER,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  type ZCodeAutomationScheduleRule,
} from "@zcode/shared";
import {
  AutomationAddScheduleIcon,
  AutomationChevronDownIcon,
  AutomationContinueIcon,
  AutomationExternalLinkIcon,
  AUTOMATION_FORM_FIELD_CLASSNAME,
  AutomationHistoryEmptyState,
  AutomationMoreHorizontalIcon,
  AutomationPauseActionIcon,
  AutomationRunNowIcon,
  AutomationSettingsHistoryTabs,
  AutomationTrashIcon,
  type AutomationSettingsHistoryTab,
} from "@/settings/AutomationDesignPrimitives.js";
import {
  AUTOMATION_FORM_INPUT_TYPOGRAPHY_CLASSNAME,
  AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
  AutomationInstructionsComposer,
  AutomationInstructionsTextarea,
  AutomationInstructionsToolbar,
} from "@/settings/AutomationInstructionsComposer.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Spinner } from "@/components/ui/spinner.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { cn } from "@/components/lib/utils.js";
import { SETTINGS_FRAME_CONTENT_CLASSNAME } from "@/settings/SettingsPageParts.js";
import { resolveLocalizedAutomationCreateTitle } from "@/settings/automationEditLocalizedTitle.js";
import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import { ConfigSelect } from "@/chat-input-toolbar/display.js";
import { ChatEmptyWorkspacePreviewMenu, type ChatEmptyWorkspaceMenuTab } from "@/ChatEmptyState.js";
import {
  AUTOMATION_DEFAULT_MODE,
  buildAutomationModelSelectGroups,
  buildAutomationModeOption,
  buildAutomationThoughtLevelOption,
  resolveAutomationModelItem,
  resolveAutomationModelTriggerLabel,
  resolveAutomationPreferredModelValue,
} from "@/settings/automationAgentConfigOptions.js";
import {
  resolveChangedAutomationEditFields,
  type AutomationEditDirtyField,
  type AutomationEditFieldSignatures,
} from "@/settings/automationEditDirtyState.js";
import {
  clearAutomationEditRequiredFieldError,
  resolveAutomationEditRequiredFieldErrors,
  type AutomationEditRequiredField,
} from "@/settings/automationEditValidation.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useAutomationProjectOptions } from "@/hooks/useAutomationProjectOptions.js";
import { useModelSelectionView } from "@/hooks/useModelSelectionView.js";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { startUserAction } from "@/lib/userActionTelemetry.js";
import { logger } from "@/logger.js";
import {
  findAutomationWorkspaceOptionByKey,
  reconcileAutomationWorkspaceSelectionKey,
  resolveAutomationWorkspaceSelectionKey,
  type AutomationWorkspaceOption,
} from "@/settings/automationWorkspaceOptions.js";
import {
  buildCronExpr,
  canVisualizeCronInAutomationEditor,
  describeCronBuilder,
  formatDateTime,
  formatDuration,
  formatGmtOffset,
  isSessionCreatedAutomation as resolveIsSessionCreatedAutomation,
  parseCronToBuilder,
  resolveAutomationStatusKind,
  WEEKDAY_ORDER,
  type AutomationStatusKind,
  type CronBuilderState,
  type CronFrequency,
  type CustomRepeatUnit,
} from "@/settings/automationFormat.js";
import type {
  AutomationRunsEntry,
  CreateAutomationInput,
  UpdateAutomationInput,
} from "@/store/automationManagementStore.js";

const MODEL_ITEM_NEVER_LOCKED = () => false;
const FREQUENCIES: CronFrequency[] = ["hourly", "daily", "weekdays", "weekly", "monthly", "custom"];
const isCronFrequency = (value: string): value is CronFrequency =>
  FREQUENCIES.includes(value as CronFrequency);
/** 运行历史每页条数。 */
const RUNS_PAGE_SIZE = 8;
/** 自定义重复频率输入允许输入的视觉范围。 */
const CUSTOM_REPEAT_INTERVAL_INPUT_MIN = 0;
/** cron 的步长必须为正整数，0 不能形成有效调度。 */
const CUSTOM_REPEAT_INTERVAL_SCHEDULABLE_MIN = 1;
const CUSTOM_REPEAT_INTERVAL_MAX = 200;

/**
 * 生成分页控件的页码序列：首尾各保留 3 页、当前页左右各 1 页，其余用省略号折叠。
 * 例：current=1,total=10 → [1,2,3,"ellipsis",8,9,10]。
 */
function buildRunsPageItems(current: number, total: number): Array<number | "ellipsis"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }
  const pages = new Set<number>([
    1,
    2,
    3,
    total - 2,
    total - 1,
    total,
    current - 1,
    current,
    current + 1,
  ]);
  const sorted = [...pages].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const items: Array<number | "ellipsis"> = [];
  let previous = 0;
  for (const page of sorted) {
    if (previous && page - previous > 1) {
      items.push("ellipsis");
    }
    items.push(page);
    previous = page;
  }
  return items;
}

function workspaceLabelFromPath(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

const CUSTOM_REPEAT_SELECT_CONTENT_CLASS =
  "w-[var(--radix-select-trigger-width)] px-0 py-1.5 [&_[data-position=popper]]:px-1 [&_[data-slot=select-scroll-up-button]]:hidden [&_[data-slot=select-scroll-down-button]]:hidden";
const CUSTOM_REPEAT_SELECT_ITEM_CLASS =
  "min-h-8 rounded-[8px] px-2 py-1.5 pr-8 text-ui-base leading-5 text-foreground-subtle data-[highlighted]:bg-menu-hover data-[highlighted]:text-foreground data-[state=checked]:bg-menu-hover data-[state=checked]:text-foreground";

function CustomRepeatSelectIndicator() {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
      <ChevronDown className="size-4" strokeWidth={2} />
    </span>
  );
}

function CustomRepeatCalendarIcon({ className }: { className?: string }) {
  return <CalendarDays className={className} strokeWidth={2} />;
}

/**
 * 时间选择的单列滚动列表（小时或分钟），选中项打开时自动滚动到可见位置。
 * 时间选项属于常用交互控件，不应沿用仅用于徽标和紧凑标签的最小字号 token。
 * 已选时间属于菜单选中态，不是主操作按钮；使用菜单 hover 语义避免 Light 主题下出现突兀黑块。
 */
function TimeUnitColumn({
  count,
  selected,
  onSelect,
}: {
  count: number;
  selected: number;
  onSelect: (value: number) => void;
}) {
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "center" });
  }, []);
  return (
    <ScrollArea className="h-52 w-14 shrink-0">
      <div className="flex flex-col gap-0.5 p-1">
        {Array.from({ length: count }, (_, value) => value).map((value) => (
          <button
            key={value}
            ref={value === selected ? selectedRef : undefined}
            type="button"
            onClick={() => onSelect(value)}
            className={cn(
              "rounded-md px-2 py-1 text-center text-ui-base tabular-nums transition-colors",
              value === selected
                ? "bg-menu-hover text-foreground"
                : "text-foreground-subtle hover:bg-menu-hover hover:text-foreground",
            )}
          >
            {pad2(value)}
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}

/**
 * HH:MM 时间选择器：一个 pill 触发器 + 弹层内小时/分钟两列滚动选择。
 * 时间选择触发器属于常用交互控件，应使用正文基准字号 text-ui-base。
 */
function TimeOfDayPicker({
  hour,
  minute,
  onChange,
  ariaLabel,
}: {
  hour: number;
  minute: number;
  onChange: (hour: number, minute: number) => void;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className="inline-flex h-auto items-center gap-1 rounded-full bg-hover py-px pl-2 pr-1.5 text-ui-base leading-5 tabular-nums text-foreground transition-colors hover:bg-selected focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
        >
          {pad2(hour)}:{pad2(minute)}
          <span className="shrink-0 text-foreground-subtle">
            <AutomationChevronDownIcon />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={4}
        className="w-29 flex-row gap-0 p-0"
      >
        <TimeUnitColumn count={24} selected={hour} onSelect={(value) => onChange(value, minute)} />
        <div className="w-px shrink-0 bg-border" />
        <TimeUnitColumn count={60} selected={minute} onSelect={(value) => onChange(hour, value)} />
      </PopoverContent>
    </Popover>
  );
}

/** 月/日单列滚动列表（1-based 值），样式对齐 TimeUnitColumn。 */
function ScrollNumberColumn({
  values,
  selected,
  onSelect,
  buttonTestIdPrefix,
}: {
  values: number[];
  selected: number;
  onSelect: (value: number) => void;
  /** 提供时每个数字按钮带 `${prefix}-${value}` 的 data-testid（e2e 用）。 */
  buttonTestIdPrefix?: string;
}) {
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "center" });
  }, []);
  return (
    <ScrollArea className="h-52 w-14 shrink-0">
      <div className="flex flex-col gap-0.5 p-1">
        {values.map((value) => (
          <button
            key={value}
            ref={value === selected ? selectedRef : undefined}
            type="button"
            data-testid={buttonTestIdPrefix ? testId(buttonTestIdPrefix, String(value)) : undefined}
            onClick={() => onSelect(value)}
            className={cn(
              "rounded-md px-2 py-1 text-center text-ui-sm tabular-nums transition-colors",
              value === selected
                ? "bg-primary text-primary-foreground"
                : "text-foreground-subtle hover:bg-surface-hover",
            )}
          >
            {pad2(value)}
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}

/** 某月天数（用闰年 2024 作参照，使 2 月可选到 29）；month 为 1-12。 */
function daysInMonth(month: number): number {
  return new Date(2024, month, 0).getDate();
}

/**
 * 月/日选择器（custom → yearly 用）：一个 pill 触发器 + 弹层内月/日两列滚动选择，
 * 样式与 TimeOfDayPicker 对齐。切月后当前日超过该月最大天数时自动收敛。
 */
function MonthDayPicker({
  month,
  day,
  intl,
  onChange,
}: {
  month: number;
  day: number;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  onChange: (month: number, day: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const months = Array.from({ length: 12 }, (_, index) => index + 1);
  const days = Array.from({ length: daysInMonth(month) }, (_, index) => index + 1);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={TID_AUTOMATION_YEAR_MONTHDAY}
          aria-label={intl.formatMessage({
            id: "automations.form.schedule.yearDateLabel",
          })}
          className="inline-flex h-auto items-center gap-1 rounded-full bg-hover py-px pl-2 pr-1.5 text-ui-base leading-5 tabular-nums text-foreground transition-colors hover:bg-selected focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
        >
          {intl.formatMessage(
            { id: "automations.form.schedule.monthDayValue" },
            { month: String(month), day: String(day) },
          )}
          <span className="shrink-0 text-foreground-subtle">
            <AutomationChevronDownIcon />
          </span>
        </button>
      </PopoverTrigger>
      {/* 与 TimeOfDayPicker 一致：flex-row 覆盖 PopoverContent 默认的 flex-col，月/日两列并排。 */}
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={4}
        className="w-29 flex-row gap-0 p-0"
      >
        <ScrollNumberColumn
          values={months}
          selected={month}
          buttonTestIdPrefix={TID_AUTOMATION_YEAR_MONTH_OPTION}
          onSelect={(value) => onChange(value, Math.min(day, daysInMonth(value)))}
        />
        <div className="w-px shrink-0 bg-border" />
        <ScrollNumberColumn
          values={days}
          selected={day}
          buttonTestIdPrefix={TID_AUTOMATION_YEAR_DAY_OPTION}
          onSelect={(value) => onChange(month, value)}
        />
      </PopoverContent>
    </Popover>
  );
}

/** 每周日期选择：保持语句式 trigger，并禁止清空最后一个日期。 */
function WeekdayPicker({
  weekdays,
  intl,
  onChange,
}: {
  weekdays: number[];
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  onChange: (weekdays: number[]) => void;
}) {
  const label = WEEKDAY_ORDER.filter((day) => weekdays.includes(day))
    .map((day) => intl.formatMessage({ id: `automations.weekday.${day}` }))
    .join(intl.formatMessage({ id: "automations.weekday.separator" }));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={intl.formatMessage({
            id: "automations.form.schedule.weekdaysLabel",
          })}
          // 星期多选 trigger 与同层频率、时间 tag 使用相同高亮，避免亮度不一致。
          className="inline-flex h-auto max-w-full items-center gap-0.5 rounded-full bg-hover py-px pl-2 pr-0.5 text-ui-base leading-5 text-foreground transition-colors hover:bg-selected data-[state=open]:bg-selected focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
        >
          <span className="truncate">{label}</span>
          <AutomationChevronDownIcon />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-40 p-1">
        {WEEKDAY_ORDER.map((day) => {
          const active = weekdays.includes(day);
          return (
            <button
              key={day}
              type="button"
              onClick={() => {
                if (active && weekdays.length === 1) return;
                onChange(
                  active ? weekdays.filter((candidate) => candidate !== day) : [...weekdays, day],
                );
              }}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-ui-base text-foreground transition-colors hover:bg-menu-hover"
            >
              {/* 勾选位放在行首会让星期菜单偏离标准的尾部状态布局。 */}
              <span className="min-w-0 flex-1 truncate">
                {intl.formatMessage({ id: `automations.weekday.${day}` })}
              </span>
              <span className="flex size-4 shrink-0 items-center justify-center">
                {active ? <Check className="size-3.5" aria-hidden="true" /> : null}
              </span>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

function toDateInputValue(timestamp: number | undefined): string {
  const date = timestamp ? new Date(timestamp) : new Date(Date.now() + 24 * 60 * 60 * 1_000);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function localDateEndTimestamp(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999);
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}

function parseDateInputValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function EndDatePicker({
  disabled,
  intl,
  min,
  onChange,
  value,
}: {
  disabled: boolean;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  min: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const selectedDate = parseDateInputValue(value);
  const minDate = parseDateInputValue(min);
  const [visibleMonth, setVisibleMonth] = useState(() => selectedDate ?? minDate ?? new Date());

  useEffect(() => {
    if (open && selectedDate) setVisibleMonth(selectedDate);
  }, [open, selectedDate?.getTime()]);

  const year = visibleMonth.getFullYear();
  const month = visibleMonth.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayValue = toDateInputValue(Date.now());
  const monthLabel = intl.formatMessage(
    { id: "automations.customRepeat.monthLabel" },
    { year: String(year), month: String(month + 1) },
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex h-9 w-[135px] items-center justify-center gap-1.5 rounded-lg border border-input-border bg-input pl-3 pr-3.5 text-ui-base font-normal leading-5 tracking-[-0.18px] text-foreground transition-colors hover:border-input-border-hover hover:bg-input/80 data-[state=open]:border-input-border-hover data-[state=open]:bg-input/80 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-input-border disabled:hover:bg-input"
        >
          <CustomRepeatCalendarIcon className="size-5 shrink-0 text-foreground-subtle" />
          <span className="tabular-nums">
            {selectedDate
              ? `${selectedDate.getFullYear()}/${pad2(selectedDate.getMonth() + 1)}/${pad2(selectedDate.getDate())}`
              : value}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-72 p-3">
        <div className="mb-3 flex h-8 items-center justify-between">
          <span className="text-ui-sm font-medium text-foreground">{monthLabel}</span>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setVisibleMonth(new Date(year, month - 1, 1))}
              aria-label={intl.formatMessage({
                id: "automations.customRepeat.previousMonth",
              })}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setVisibleMonth(new Date(year, month + 1, 1))}
              aria-label={intl.formatMessage({
                id: "automations.customRepeat.nextMonth",
              })}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-1">
          {[0, 1, 2, 3, 4, 5, 6].map((day) => (
            <span
              key={day}
              className="flex size-8 items-center justify-center text-ui-sm text-foreground-subtlest"
            >
              {intl.formatMessage({ id: `automations.weekday.${day}` })}
            </span>
          ))}
          {Array.from({ length: firstWeekday }, (_, index) => (
            <span key={`blank-${index}`} className="size-8" />
          ))}
          {Array.from({ length: daysInMonth }, (_, index) => index + 1).map((day) => {
            const dateValue = `${year}-${pad2(month + 1)}-${pad2(day)}`;
            const selected = dateValue === value;
            const isToday = dateValue === todayValue;
            const unavailable = dateValue < min;
            return (
              <button
                key={day}
                type="button"
                disabled={unavailable}
                onClick={() => {
                  onChange(dateValue);
                  setOpen(false);
                }}
                className={cn(
                  "flex size-8 items-center justify-center rounded-[8px] text-ui-base tabular-nums transition-colors",
                  selected
                    ? "bg-primary text-primary-foreground"
                    : "text-foreground hover:bg-menu-hover",
                  isToday && !selected && "ring-1 ring-inset ring-border-hover",
                  unavailable && "cursor-not-allowed text-foreground-subtlest opacity-35",
                )}
              >
                {day}
              </button>
            );
          })}
          {Array.from({ length: 42 - firstWeekday - daysInMonth }, (_, index) => (
            <span key={`trailing-blank-${index}`} className="size-8" />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function CustomRepeatDialog({
  builder,
  endAt,
  intl,
  onConfirm,
  onOpenChange,
  open,
}: {
  builder: CronBuilderState;
  endAt: number | undefined;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  onConfirm: (value: {
    interval: number;
    unit: CustomRepeatUnit;
    weekdays: number[];
    monthDays: number[];
    monthlyMode: CronBuilderState["customMonthlyMode"];
    endAt?: number;
  }) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [intervalInput, setIntervalInput] = useState(String(builder.customInterval));
  const [unit, setUnit] = useState<CustomRepeatUnit>(builder.customUnit);
  const [weekdays, setWeekdays] = useState(builder.customWeekdays);
  const [monthDays, setMonthDays] = useState(builder.customMonthDays);
  const [monthlyMode, setMonthlyMode] = useState(builder.customMonthlyMode);
  const [ends, setEnds] = useState(endAt !== undefined);
  const [endDate, setEndDate] = useState(toDateInputValue(endAt));

  useEffect(() => {
    if (!open) return;
    setIntervalInput(String(builder.customInterval));
    setUnit(builder.customUnit);
    setWeekdays(builder.customWeekdays);
    setMonthDays(builder.customMonthDays);
    setMonthlyMode(builder.customMonthlyMode);
    setEnds(endAt !== undefined);
    setEndDate(toDateInputValue(endAt));
  }, [builder, endAt, open]);

  const interval = Number(intervalInput);
  const isIntervalValid =
    /^\d+$/.test(intervalInput) &&
    Number.isInteger(interval) &&
    interval >= CUSTOM_REPEAT_INTERVAL_SCHEDULABLE_MIN &&
    interval <= CUSTOM_REPEAT_INTERVAL_MAX;
  const canIncrementInterval = intervalInput === "" || interval < CUSTOM_REPEAT_INTERVAL_MAX;
  const canDecrementInterval = intervalInput !== "" && interval > CUSTOM_REPEAT_INTERVAL_INPUT_MIN;
  const stepInterval = (delta: 1 | -1) => {
    const currentInterval = /^\d+$/.test(intervalInput)
      ? interval
      : CUSTOM_REPEAT_INTERVAL_INPUT_MIN;
    const nextInterval = Math.min(
      CUSTOM_REPEAT_INTERVAL_MAX,
      Math.max(CUSTOM_REPEAT_INTERVAL_INPUT_MIN, currentInterval + delta),
    );
    setIntervalInput(String(nextInterval));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100vh-2rem)] w-[400px] gap-0 overflow-y-auto border-border bg-card p-0 shadow-[0_20px_25px_-5px_rgba(0,0,0,0.1),0_8px_10px_-6px_rgba(0,0,0,0.1)]"
        aria-describedby={undefined}
        showCloseButton={false}
      >
        <DialogHeader className="px-5 pb-5 pt-5">
          <DialogTitle className="text-ui-xl font-medium leading-[26px] tracking-[-0.12px]">
            {intl.formatMessage({ id: "automations.customRepeat.title" })}
          </DialogTitle>
          <DialogClose asChild>
            <button
              type="button"
              aria-label={intl.formatMessage({ id: "common.close" })}
              className="absolute right-5 top-5 flex size-6 items-center justify-center rounded-[6px] opacity-80 transition-colors hover:bg-surface-hover hover:opacity-100"
            >
              <X className="size-4" strokeWidth={2} aria-hidden="true" />
            </button>
          </DialogClose>
        </DialogHeader>

        <div className="space-y-5 px-5">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="automation-custom-interval"
              className="text-ui-base leading-5 tracking-[-0.18px] text-foreground"
            >
              {intl.formatMessage({ id: "automations.customRepeat.frequency" })}
            </label>
            <div className="grid grid-cols-2 gap-4">
              <div className="relative">
                <Input
                  id="automation-custom-interval"
                  type="number"
                  min={CUSTOM_REPEAT_INTERVAL_INPUT_MIN}
                  max={CUSTOM_REPEAT_INTERVAL_MAX}
                  step={1}
                  inputMode="numeric"
                  value={intervalInput}
                  aria-invalid={!isIntervalValid}
                  className="h-9 rounded-lg px-3 pr-10 text-mobile-input-safe leading-6 tracking-[-0.18px] [appearance:textfield] md:text-ui-base md:leading-5 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  data-testid={TID_AUTOMATION_CUSTOM_INTERVAL_SELECT}
                  onChange={(event) => {
                    const value = event.target.value;
                    // number 输入允许空值和科学计数法；保留空值便于编辑，
                    // 但只接收非负整数文本，避免将无效值写进 cron / scheduleRule。
                    if (value === "" || /^\d+$/.test(value)) setIntervalInput(value);
                  }}
                />
                {/* 原生 number spinner 在系统浏览器与 WebView 的尺寸、主题反馈不一致；
                    使用受控步进按钮，统一桌面与手机 Web 的点击样式。 */}
                <div className="absolute inset-y-px right-px flex w-8 flex-col overflow-hidden rounded-r-[7px] border-l border-input-border bg-input">
                  <button
                    type="button"
                    aria-label="+1"
                    title="+1"
                    data-testid={TID_AUTOMATION_CUSTOM_INTERVAL_INCREMENT}
                    disabled={!canIncrementInterval}
                    onClick={() => stepInterval(1)}
                    className="flex flex-1 items-center justify-center border-b border-input-border text-foreground-subtle transition-colors hover:bg-input-focused hover:text-foreground focus-visible:z-10 focus-visible:bg-input-focused focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40"
                  >
                    <ChevronUp className="size-3" strokeWidth={2} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label="-1"
                    title="-1"
                    data-testid={TID_AUTOMATION_CUSTOM_INTERVAL_DECREMENT}
                    disabled={!canDecrementInterval}
                    onClick={() => stepInterval(-1)}
                    className="flex flex-1 items-center justify-center text-foreground-subtle transition-colors hover:bg-input-focused hover:text-foreground focus-visible:z-10 focus-visible:bg-input-focused focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40"
                  >
                    <ChevronDown className="size-3" strokeWidth={2} aria-hidden="true" />
                  </button>
                </div>
              </div>
              <Select
                value={unit}
                onValueChange={(value) => {
                  const nextUnit = value as CustomRepeatUnit;
                  setUnit(nextUnit);
                  if (nextUnit === "yearly") setMonthDays([new Date().getDate()]);
                }}
              >
                <SelectTrigger
                  className="h-9 w-full rounded-[8px] px-3 text-ui-base leading-5 tracking-[-0.18px] hover:bg-input/80 data-[state=open]:border-input-border-hover data-[state=open]:bg-input/80"
                  data-testid={TID_AUTOMATION_CUSTOM_UNIT_SELECT}
                  indicator={<CustomRepeatSelectIndicator />}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent
                  position="popper"
                  align="start"
                  side="bottom"
                  sideOffset={4}
                  collisionPadding={8}
                  className={CUSTOM_REPEAT_SELECT_CONTENT_CLASS}
                >
                  <SelectItem
                    value="minute"
                    className={CUSTOM_REPEAT_SELECT_ITEM_CLASS}
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "minute")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.minute",
                    })}
                  </SelectItem>
                  <SelectItem
                    value="hourly"
                    className={CUSTOM_REPEAT_SELECT_ITEM_CLASS}
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "hourly")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.hour",
                    })}
                  </SelectItem>
                  <SelectItem
                    value="daily"
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "daily")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.day",
                    })}
                  </SelectItem>
                  <SelectItem
                    value="weekly"
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "weekly")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.week",
                    })}
                  </SelectItem>
                  <SelectItem
                    value="monthly"
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "monthly")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.month",
                    })}
                  </SelectItem>
                  <SelectItem
                    value="yearly"
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "yearly")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.year",
                    })}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {unit === "weekly" ? (
            <div className="grid grid-cols-7 gap-2">
              {WEEKDAY_ORDER.map((day) => {
                const active = weekdays.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => {
                      if (active && weekdays.length === 1) return;
                      setWeekdays(
                        active
                          ? weekdays.filter((candidate) => candidate !== day)
                          : [...weekdays, day],
                      );
                    }}
                    className={cn(
                      "flex h-9 items-center justify-center rounded-md border text-ui-base",
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:bg-surface-hover",
                    )}
                  >
                    {intl.formatMessage({ id: `automations.weekday.${day}` })}
                  </button>
                );
              })}
            </div>
          ) : null}

          {unit === "monthly" ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-ui-base text-foreground">
                  {intl.formatMessage({ id: "automations.customRepeat.rule" })}
                </span>
                <Select
                  value={monthlyMode}
                  onValueChange={(value) =>
                    setMonthlyMode(value as CronBuilderState["customMonthlyMode"])
                  }
                >
                  <SelectTrigger
                    className="h-9 w-32 rounded-[8px] px-3 text-ui-base hover:bg-input/80 data-[state=open]:border-input-border-hover data-[state=open]:bg-input/80"
                    indicator={<CustomRepeatSelectIndicator />}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent
                    position="popper"
                    align="start"
                    side="bottom"
                    sideOffset={4}
                    collisionPadding={8}
                    className={CUSTOM_REPEAT_SELECT_CONTENT_CLASS}
                  >
                    <SelectItem value="date" className={CUSTOM_REPEAT_SELECT_ITEM_CLASS}>
                      {intl.formatMessage({
                        id: "automations.customRepeat.byDate",
                      })}
                    </SelectItem>
                    <SelectItem value="weekday" className={CUSTOM_REPEAT_SELECT_ITEM_CLASS}>
                      {intl.formatMessage({
                        id: "automations.customRepeat.byWeekday",
                      })}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {monthlyMode === "date" ? (
                <div className="grid grid-cols-10 gap-2.5">
                  {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => {
                    const active = monthDays.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        onClick={() => {
                          if (active && monthDays.length === 1) return;
                          setMonthDays(
                            active
                              ? monthDays.filter((candidate) => candidate !== day)
                              : [...monthDays, day],
                          );
                        }}
                        className={cn(
                          "flex h-7 w-full items-center justify-center rounded-[8px] border text-ui-sm",
                          active
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border hover:bg-surface-hover",
                        )}
                      >
                        {day}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="grid grid-cols-7 gap-2">
                  {WEEKDAY_ORDER.map((day) => {
                    const active = weekdays.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        onClick={() => setWeekdays([day])}
                        className={cn(
                          "flex h-9 items-center justify-center rounded-md border text-ui-base",
                          active
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border hover:bg-surface-hover",
                        )}
                      >
                        {intl.formatMessage({
                          id: `automations.weekday.${day}`,
                        })}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <span className="text-ui-base leading-5 tracking-[-0.18px] text-foreground">
              {intl.formatMessage({ id: "automations.customRepeat.ends" })}
            </span>
            <div className="flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={() => setEnds(false)}
                className="flex h-9 items-center gap-2 rounded-[8px] px-2 text-ui-base leading-5 tracking-[-0.18px] transition-colors hover:bg-surface-hover"
              >
                <span className="flex size-5 items-center justify-center">
                  <span
                    className={cn(
                      "flex size-4 items-center justify-center rounded-full border-[1.33px]",
                      !ends ? "border-[#4099FF] bg-[#4099FF]" : "border-border",
                    )}
                  >
                    {!ends ? <span className="size-1.5 rounded-full bg-white" /> : null}
                  </span>
                </span>
                {intl.formatMessage({
                  id: "automations.customRepeat.neverEnds",
                })}
              </button>
              <button
                type="button"
                onClick={() => setEnds(true)}
                className="flex h-9 items-center gap-2 rounded-[8px] px-2 text-ui-base leading-5 tracking-[-0.18px] transition-colors hover:bg-surface-hover"
              >
                <span className="flex size-5 items-center justify-center">
                  <span
                    className={cn(
                      "flex size-4 items-center justify-center rounded-full border-[1.33px]",
                      ends ? "border-[#4099FF] bg-[#4099FF]" : "border-border",
                    )}
                  >
                    {ends ? <span className="size-1.5 rounded-full bg-white" /> : null}
                  </span>
                </span>
                {intl.formatMessage({
                  id: "automations.customRepeat.endsOption",
                })}
              </button>
            </div>
            {/* 原生 date input 会在暗色主题中弹出不可控的系统白色月历。*/}
            <EndDatePicker
              value={endDate}
              min={toDateInputValue(Date.now())}
              disabled={!ends}
              intl={intl}
              onChange={setEndDate}
            />
          </div>
        </div>

        <DialogFooter className="gap-3 px-5 pb-5 pt-5">
          <DialogClose asChild>
            <Button
              type="button"
              variant="outline"
              className="h-9 rounded-[8px] px-4 text-ui-base font-medium leading-5 tracking-[-0.18px] hover:border-border-hover hover:bg-input/50"
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
          </DialogClose>
          <Button
            type="button"
            className="h-9 rounded-[8px] px-4 text-ui-base font-medium leading-5 tracking-[-0.18px] hover:bg-primary/80"
            data-testid={TID_AUTOMATION_CUSTOM_CONFIRM}
            disabled={!isIntervalValid || (ends && !localDateEndTimestamp(endDate))}
            onClick={() => {
              onConfirm({
                interval,
                unit,
                weekdays,
                monthDays,
                monthlyMode,
                ...(ends ? { endAt: localDateEndTimestamp(endDate) } : {}),
              });
              onOpenChange(false);
            }}
          >
            {intl.formatMessage({ id: "common.confirm" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface AutomationEditSubmit {
  input: CreateAutomationInput | UpdateAutomationInput;
  /** 目标项目(创建时可能不同于当前列表项目)。 */
  workspacePath: string;
  workspaceIdentity?: string;
}

interface AutomationEditViewProps {
  /** null = 新建；否则编辑。 */
  editing: ZCodeAutomation | null;
  /** 新建预填(来自 More ideas 模板)。 */
  initialDraft?: { title: string; cronExpr: string; prompt: string } | null;
  /** 当前列表所在项目,作为新建的默认目标项目。 */
  defaultWorkspacePath: string;
  defaultWorkspaceIdentity?: string;
  onManageModels?: () => void;
  saving: boolean;
  onSubmit: (params: AutomationEditSubmit) => Promise<boolean>;
  onBack: () => void;
  /** 编辑态:立即运行 / 启停 / 删除。 */
  onRunNow?: (automation: ZCodeAutomation) => Promise<void> | void;
  onToggle?: (automation: ZCodeAutomation, enabled: boolean) => void;
  onDelete?: (automation: ZCodeAutomation) => void;
  /** History tab 运行历史。 */
  runsEntry?: AutomationRunsEntry;
  onLoadRuns?: () => void;
  onDeleteRun?: (runId: string) => void;
  onOpenSession?: (sessionId: string) => void;
}

async function saveAndRunAutomation(
  save: () => Promise<boolean>,
  run: () => Promise<void> | void,
): Promise<boolean> {
  if (!(await save())) return false;
  await run();
  return true;
}

function defaultBuilder(): CronBuilderState {
  return {
    frequency: "daily",
    hour: 9,
    minute: 0,
    weekdays: [1],
    dayOfMonth: 1,
    rawExpr: "0 9 * * *",
    customInterval: 1,
    customUnit: "daily",
    customWeekdays: [1],
    customMonthDays: [1],
    customMonth: new Date().getMonth() + 1,
    customMonthlyMode: "date",
  };
}

function initialBuilder(
  editing: ZCodeAutomation | null,
  initialDraft?: { title: string; cronExpr: string; prompt: string } | null,
): CronBuilderState {
  if (!editing) {
    return initialDraft ? parseCronToBuilder(initialDraft.cronExpr) : defaultBuilder();
  }

  const parsedBuilder = parseCronToBuilder(editing.cronExpr);
  if (!editing.scheduleRule) return parsedBuilder;

  return {
    ...parsedBuilder,
    frequency: "custom",
    hour: editing.scheduleRule.hour,
    minute: editing.scheduleRule.minute,
    customInterval: editing.scheduleRule.interval,
    customUnit: editing.scheduleRule.unit,
    customWeekdays: editing.scheduleRule.weekdays ?? [1],
    customMonthDays: editing.scheduleRule.monthDays ?? [1],
    customMonth:
      editing.scheduleRule.months?.[0] ?? new Date(editing.scheduleRule.anchorAt).getMonth() + 1,
    customMonthlyMode: editing.scheduleRule.monthlyMode ?? "date",
  };
}

// ---- 运行历史状态映射(与 AutomationRunsDialog 保持一致) ----
type RunStatusKind = "running" | "succeeded" | "failed" | "stopped" | "skipped";
function resolveRunStatus(run: ZCodeAutomationRun): RunStatusKind {
  if (run.dispatchStatus === "skipped") return "skipped";
  if (run.dispatchStatus === "failed_to_dispatch") return "failed";
  switch (run.outcome) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    default:
      return "running";
  }
}
// 运行状态用「圆点 + 彩色文字」呈现（Scheduled 历史表密度规格）。
const RUN_STATUS_DOT_CLASS: Record<RunStatusKind, string> = {
  running: "bg-primary",
  succeeded: "bg-success",
  failed: "bg-destructive",
  stopped: "bg-foreground-subtlest",
  skipped: "bg-warning",
};
const RUN_STATUS_TEXT_CLASS: Record<RunStatusKind, string> = {
  running: "text-primary",
  succeeded: "text-success",
  failed: "text-destructive",
  stopped: "text-foreground-subtle",
  skipped: "text-warning",
};

const AUTOMATION_STATUS_DOT_CLASS: Record<AutomationStatusKind, string> = {
  active: "bg-success",
  paused: "bg-warning",
  failed: "bg-destructive",
  completed: "bg-foreground-subtlest",
};

function normalizeAutomationScheduleRule(
  rule: ZCodeAutomationScheduleRule | null | undefined,
): Record<string, unknown> | null {
  if (!rule) return null;
  return {
    unit: rule.unit,
    interval: rule.interval,
    hour: rule.hour,
    minute: rule.minute,
    anchorAt: rule.anchorAt,
    weekdays: rule.weekdays ?? [],
    monthDays: rule.monthDays ?? [],
    months: rule.months ?? [],
    monthlyMode: rule.monthlyMode ?? "date",
  };
}

export function AutomationEditView({
  editing,
  initialDraft,
  defaultWorkspacePath,
  defaultWorkspaceIdentity,
  onManageModels,
  saving,
  onSubmit,
  onBack,
  onRunNow,
  onToggle,
  onDelete,
  runsEntry,
  onLoadRuns,
  onDeleteRun,
  onOpenSession,
}: AutomationEditViewProps) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const [tab, setTab] = useState<AutomationSettingsHistoryTab>("settings");
  const [runsPage, setRunsPage] = useState(1);
  const onLoadRunsRef = useRef(onLoadRuns);
  const saveAndRunPendingRef = useRef(false);
  const [saveAndRunPending, setSaveAndRunPending] = useState(false);
  const localizedDefaultCreateTitle = intl.formatMessage({
    id: "automations.edit.titlePlaceholder",
  });
  const previousLocalizedDefaultTitleRef = useRef(localizedDefaultCreateTitle);
  const titleTouchedRef = useRef(false);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState<string>("");
  const modelSelection = useRef("");
  const [mode, setMode] = useState<string>(AUTOMATION_DEFAULT_MODE);
  const modeRef = useRef(AUTOMATION_DEFAULT_MODE);
  const [thoughtLevel, setThoughtLevel] = useState<string>("");
  const thoughtLevelRef = useRef("");
  const modelManuallyChangedRef = useRef(false);
  const thoughtManuallyChangedRef = useRef(false);
  const thoughtTriggerRef = useRef<HTMLSpanElement | null>(null);
  // 不能首帧先渲染默认的“每天 09:00”、再由 effect 回填持久化调度。
  // 子级调度控件会先注册 value 回调，从而把默认值误记成 dirty baseline；编辑态必须首帧即使用真实值。
  const [builder, setBuilder] = useState<CronBuilderState>(() =>
    initialBuilder(editing, initialDraft),
  );
  // 新建任务默认不带日程，通过「Add schedule」显式添加；移除后未补齐标红提示。
  const [scheduleRemoved, setScheduleRemoved] = useState(!editing && !initialDraft);
  const [validationErrors, setValidationErrors] = useState<
    ReadonlySet<AutomationEditRequiredField>
  >(() => new Set());
  const [customRepeatOpen, setCustomRepeatOpen] = useState(false);
  const [touchedFields, setTouchedFields] = useState<ReadonlySet<AutomationEditDirtyField>>(
    () => new Set(),
  );
  const currentEditSignaturesRef = useRef<AutomationEditFieldSignatures | null>(null);
  const touchedFieldBaselinesRef = useRef<Partial<AutomationEditFieldSignatures>>({});
  const [endAt, setEndAt] = useState<number | undefined>(() => editing?.endAt);
  // 目标项目 key(仅新建时可改;编辑锁定为 automation 所属项目)。
  const [workspaceKey, setWorkspaceKey] = useState<string | null>(null);

  const localWorkspaceOptions = useAutomationProjectOptions({
    includeConversationWorkspace: true,
  });
  const editingWorkspaceOption = editing
    ? findAutomationWorkspaceOptionByKey(localWorkspaceOptions, editing.workspaceKey)
    : undefined;
  const workspaceOptions = useMemo<AutomationWorkspaceOption[]>(
    () =>
      editing
        ? [
            {
              workspacePath: editing.workspacePath,
              workspaceIdentity: editing.workspaceIdentity,
              label: workspaceLabelFromPath(editing.workspacePath),
              ...(editingWorkspaceOption?.remoteSessionId
                ? { remoteSessionId: editingWorkspaceOption.remoteSessionId }
                : {}),
              ...(editingWorkspaceOption?.remoteTarget
                ? { remoteTarget: editingWorkspaceOption.remoteTarget }
                : {}),
              ...(editingWorkspaceOption?.workspacePurpose
                ? { workspacePurpose: editingWorkspaceOption.workspacePurpose }
                : {}),
            },
          ]
        : localWorkspaceOptions,
    [editing, editingWorkspaceOption, localWorkspaceOptions],
  );
  const workspaceOptionsRef = useRef(workspaceOptions);
  workspaceOptionsRef.current = workspaceOptions;

  // 打开/切换编辑对象时重置表单。
  useEffect(() => {
    setTab("settings");
    setRunsPage(1);
    setTouchedFields(new Set());
    setValidationErrors(new Set());
    touchedFieldBaselinesRef.current = {};
    if (editing) {
      setScheduleRemoved(false);
      titleTouchedRef.current = false;
      modelManuallyChangedRef.current = false;
      thoughtManuallyChangedRef.current = false;
      setTitle(editing.title);
      setPrompt(editing.prompt);
      const editingModel = editing.modelSelection
        ? encodeCustomModelValue(editing.modelSelection.providerId, editing.modelSelection.modelId)
        : "";
      const editingThoughtLevel = editing.modelSelection?.options?.reasoningLevel?.trim() ?? "";
      modelSelection.current = editingModel;
      thoughtLevelRef.current = editingThoughtLevel;
      setModel(editingModel);
      const editingMode = editing.mode?.trim() || AUTOMATION_DEFAULT_MODE;
      modeRef.current = editingMode;
      setMode(editingMode);
      setThoughtLevel(editingThoughtLevel);
      setBuilder(initialBuilder(editing, initialDraft));
      setEndAt(editing.endAt);
      setWorkspaceKey(
        resolveWorkspaceKey({
          workspacePath: editing.workspacePath,
          workspaceIdentity: editing.workspaceIdentity,
        }),
      );
    } else {
      setScheduleRemoved(!initialDraft);
      // 新建页的默认标题可随 locale 更新；模板标题仍属于用户明确选择的内容。
      titleTouchedRef.current = false;
      modelManuallyChangedRef.current = false;
      thoughtManuallyChangedRef.current = false;
      setTitle(initialDraft?.title ?? localizedDefaultCreateTitle);
      setPrompt(initialDraft?.prompt ?? "");
      modelSelection.current = "";
      setModel("");
      modeRef.current = AUTOMATION_DEFAULT_MODE;
      thoughtLevelRef.current = "";
      setMode(AUTOMATION_DEFAULT_MODE);
      setThoughtLevel("");
      setBuilder(initialBuilder(editing, initialDraft));
      setEndAt(undefined);
      setWorkspaceKey(
        reconcileAutomationWorkspaceSelectionKey(workspaceOptionsRef.current, null, {
          workspacePath: defaultWorkspacePath,
          workspaceIdentity: defaultWorkspaceIdentity,
        }),
      );
    }
  }, [editing, initialDraft, defaultWorkspacePath, defaultWorkspaceIdentity]);

  useEffect(() => {
    const nextTitle = resolveLocalizedAutomationCreateTitle({
      currentTitle: title,
      hasInitialDraft: Boolean(initialDraft),
      isEditing: Boolean(editing),
      nextDefaultTitle: localizedDefaultCreateTitle,
      previousDefaultTitle: previousLocalizedDefaultTitleRef.current,
      titleTouched: titleTouchedRef.current,
    });
    previousLocalizedDefaultTitleRef.current = localizedDefaultCreateTitle;
    if (nextTitle !== title) {
      setTitle(nextTitle);
    }
  }, [editing, initialDraft, localizedDefaultCreateTitle, title]);

  useEffect(() => {
    if (editing) return;
    // 候选为空或默认项目已失效时不能保留 default workspace 并允许落库。
    // 任何 tab 变化都重新把选择收敛到当前有效项目；没有候选时必须明确置空。
    setWorkspaceKey((currentWorkspaceKey) =>
      reconcileAutomationWorkspaceSelectionKey(workspaceOptions, currentWorkspaceKey, {
        workspacePath: defaultWorkspacePath,
        workspaceIdentity: defaultWorkspaceIdentity,
      }),
    );
  }, [defaultWorkspaceIdentity, defaultWorkspacePath, editing, workspaceOptions]);

  const markFieldTouched = useCallback((field: AutomationEditDirtyField) => {
    if (touchedFieldBaselinesRef.current[field] === undefined) {
      touchedFieldBaselinesRef.current[field] = currentEditSignaturesRef.current?.[field];
    }
    setTouchedFields((previous) => {
      if (previous.has(field)) return previous;
      const next = new Set(previous);
      next.add(field);
      return next;
    });
  }, []);

  const clearRequiredFieldValidation = useCallback((field: AutomationEditRequiredField) => {
    setValidationErrors((current) => clearAutomationEditRequiredFieldError(current, field));
  }, []);

  const handleRemoveSchedule = useCallback(() => {
    markFieldTouched("schedule");
    setScheduleRemoved(true);
    // 删除计划曾直接开启 destructive 校验态，把普通编辑误当成提交失败。
    clearRequiredFieldValidation("schedule");
    logger.debug("[AutomationEditView] 删除计划草稿", {
      automationId: editing?.automationId ?? null,
      validationVisible: false,
    });
  }, [clearRequiredFieldValidation, editing?.automationId, markFieldTouched]);

  useEffect(() => {
    onLoadRunsRef.current = onLoadRuns;
  }, [onLoadRuns]);

  // 切到 History tab(编辑态)时加载运行历史，并在停留期间轻量刷新。
  // cron run/outcome 由 scheduler/host 异步写入；只加载一次会让用户看到会话已结束但历史仍为空。
  // onLoadRuns 由父组件 inline 传入，不能作为依赖，否则每次 runsCache 更新都会重启 effect 形成请求循环。
  useEffect(() => {
    if (tab !== "history" || !editing) {
      return;
    }
    onLoadRunsRef.current?.();
    const timer = window.setInterval(() => {
      onLoadRunsRef.current?.();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [tab, editing?.automationId]);

  const isSessionCreatedAutomation = resolveIsSessionCreatedAutomation(editing);
  // 会话来源但无法由 UI 安全回显的旧 cron 保持只读；用户显式重设后以持久化标记退出该路径。
  const preserveSessionCreatedSchedule =
    isSessionCreatedAutomation &&
    !editing?.scheduleEditedByUser &&
    Boolean(editing && !canVisualizeCronInAutomationEditor(editing.cronExpr)) &&
    !touchedFields.has("schedule");
  const cronExpr = useMemo(
    () =>
      scheduleRemoved
        ? ""
        : preserveSessionCreatedSchedule
          ? (editing?.cronExpr ?? "")
          : buildCronExpr(builder),
    [builder, editing?.cronExpr, preserveSessionCreatedSchedule, scheduleRemoved],
  );
  const schedulePreview = useMemo(
    () => (cronExpr ? describeCronBuilder(builder, intl) : ""),
    [builder, cronExpr, intl],
  );
  const selectedWorkspace =
    findAutomationWorkspaceOptionByKey(workspaceOptions, workspaceKey) ??
    (editing
      ? {
          workspacePath: editing.workspacePath,
          workspaceIdentity: editing.workspaceIdentity,
          label: workspaceLabelFromPath(editing.workspacePath),
        }
      : null);
  // 复用输入框空态的项目选择菜单：把表单的项目候选映射成它的 tab 结构。
  const workspaceMenuTabs = useMemo<ChatEmptyWorkspaceMenuTab[]>(
    () =>
      workspaceOptions.map((option) => ({
        workspacePath: option.workspacePath,
        label: option.label,
        ...(option.workspaceIdentity ? { workspaceIdentity: option.workspaceIdentity } : {}),
        ...(option.workspacePurpose ? { workspacePurpose: option.workspacePurpose } : {}),
      })),
    [workspaceOptions],
  );
  // 新建态无有效项目时保留空目标，避免模型配置读取悄悄回退到 conversation/default workspace。
  const selectedWorkspacePath = selectedWorkspace?.workspacePath ?? "";
  const selectedWorkspaceIdentity = selectedWorkspace?.workspaceIdentity;
  const originalSelection = useMemo(() => {
    if (!model) return null;
    const identity = parseModelPickerValue(model);
    return identity
      ? { ...identity, ...(thoughtLevel ? { options: { reasoningLevel: thoughtLevel } } : {}) }
      : null;
  }, [model, thoughtLevel]);
  // 模型候选属于当前表单目标 Host。项目切换时立即切换订阅；远程目标未连接时
  // useModelSelectionView 会保持 unavailable，绝不能退回当前设置页的 Local Host。
  const modelSelectionRead = useModelSelectionView(
    selectedWorkspacePath || null,
    selectedWorkspace?.remoteSessionId,
    selectedWorkspaceIdentity,
    selectedWorkspace?.remoteTarget,
    { selection: originalSelection },
  );
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  const effectiveSelection = modelSelectionView?.effectiveSelection;
  const effectiveModelValue = effectiveSelection
    ? encodeCustomModelValue(effectiveSelection.providerId, effectiveSelection.modelId)
    : "";
  const effectiveReasoningLevel = effectiveSelection?.options?.reasoningLevel ?? "";
  const modelSelectGroups = useMemo(() => {
    if (!modelSelectionView) return [];
    return buildAutomationModelSelectGroups({
      selectedProvider: ZCODE_AGENT_PROVIDER,
      labels: {
        apiKeyLabel: intl.formatMessage({ id: "settings.modelProvider.apiKey" }),
        apiKeyBadgeLabel: intl.formatMessage({
          id: "settings.modelProvider.connectionMode.apiKeyBadge",
        }),
        codingPlanLabel: intl.formatMessage({
          id: "settings.modelProvider.connectionMode.codingPlan",
        }),
        codingPlanBadgeLabel: intl.formatMessage({
          id: "settings.modelProvider.connectionMode.codingPlanBadge",
        }),
        startPlanLabel: intl.formatMessage({
          id: "settings.modelProvider.connectionMode.startPlan",
        }),
        startPlanBadgeLabel: intl.formatMessage({
          id: "settings.modelProvider.connectionMode.startPlanBadge",
        }),
        teamPlanBadgeLabel: intl.formatMessage({
          id: "settings.modelProvider.connectionMode.teamPlanBadge",
        }),
        teamPlanFallbackLabel: intl.formatMessage({
          id: "settings.modelProvider.connectionMode.teamPlan",
        }),
      },
      registrySelectionView: modelSelectionView,
    });
  }, [intl, modelSelectionView]);
  const isSelectedConversationWorkspace = selectedWorkspace?.workspacePurpose === "conversation";
  // automation 数据只持久化 workspaceKey/path，编辑态曾直接把 conversation
  // backing path 当项目展示成 default。匹配当前 canonical 候选恢复 purpose 后，
  // 继续复用会话侧文案；无法匹配的历史目标仍回退到路径名称。
  const selectedWorkspaceDisplayLabel = isSelectedConversationWorkspace
    ? intl.formatMessage({ id: "chat.empty.workOutsideProject" })
    : (selectedWorkspace?.label ?? workspaceLabelFromPath(defaultWorkspacePath));
  const conversationWorkspace = workspaceOptions.find(
    (option) => option.workspacePurpose === "conversation",
  );
  const handleSelectWorkspace = (workspace: ChatEmptyWorkspaceMenuTab) => {
    modelManuallyChangedRef.current = false;
    thoughtManuallyChangedRef.current = false;
    modelSelection.current = "";
    setModel("");
    // 远程工作区可以共享同一实际路径；旧回调只传 path 再 find，永远命中第一个
    // 候选。选择事件必须携带 identity，确保模型预览、保存和派发使用用户点击的 workspaceKey。
    setWorkspaceKey(resolveAutomationWorkspaceSelectionKey(workspace));
  };
  const handleSelectConversationWorkspace = () => {
    if (!conversationWorkspace) return;
    modelManuallyChangedRef.current = false;
    thoughtManuallyChangedRef.current = false;
    modelSelection.current = "";
    setModel("");
    // conversation backing workspace 曾被降格成名为 default 的普通项目，
    // 导致菜单泄露内部目录名和 Folder 图标。这里按 purpose 选择 canonical backing，
    // 展示则交给会话侧固定的「不在项目中工作」菜单项。
    setWorkspaceKey(resolveAutomationWorkspaceSelectionKey(conversationWorkspace));
  };
  const modelTriggerLabel = resolveAutomationModelTriggerLabel({
    modelGroups: modelSelectGroups,
    modelSelectionView,
    modelValue: effectiveModelValue,
    fallbackLabel: intl.formatMessage({ id: "chat.toolbar.model.label" }),
  });
  // 主动选模型才初始化最高档；历史恢复和 View 刷新仍保留缺失档位。
  const handleModelValueChange = useCallback(
    (value: string) => {
      modelManuallyChangedRef.current = true;
      thoughtManuallyChangedRef.current = false;
      modelSelection.current = value;
      setModel(value);
      const selection =
        value && modelSelectionView
          ? completeNewModelSelection(modelSelectionView, parseModelPickerValue(value))
          : undefined;
      const level = selection?.options?.reasoningLevel ?? "";
      thoughtLevelRef.current = level;
      setThoughtLevel(level);
      markFieldTouched("model");
    },
    [markFieldTouched, modelSelectionView],
  );
  // 定时任务编辑页只维护表单草稿，不能为了读取选项调用 workspace 默认配置接口；
  // 否则用户仅打开后取消，也会改掉当前项目或 draft session 的模型、模式和思考强度。
  const modeOption = useMemo(() => buildAutomationModeOption(mode), [mode]);
  const selectedModelItem = useMemo(
    () => resolveAutomationModelItem(modelSelectGroups, effectiveModelValue),
    [effectiveModelValue, modelSelectGroups],
  );
  const preferredModelValue = useMemo(
    () => (modelSelectionView ? resolveAutomationPreferredModelValue(modelSelectionView) : null),
    [modelSelectionView],
  );
  const persistedSelectionInvalid = Boolean(
    originalSelection && modelSelectionView && modelSelectionView.selectionIssue,
  );
  const invalidSelectionNoticeKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!persistedSelectionInvalid || !editing || !modelSelectionView) return;
    const noticeKey = `${editing.automationId}:${modelSelectionView.revision}`;
    if (invalidSelectionNoticeKeyRef.current === noticeKey) return;
    invalidSelectionNoticeKeyRef.current = noticeKey;
    toast(intl.formatMessage({ id: "modelSelection.invalidated.reselect" }), {
      variant: "warning",
      position: "bottom-center",
      dedupeKey: `automation-model-selection-invalidated:${editing.automationId}`,
    });
  }, [editing, intl, modelSelectionView, persistedSelectionInvalid]);
  useEffect(() => {
    if (
      editing ||
      !preferredModelValue ||
      modelManuallyChangedRef.current ||
      persistedSelectionInvalid
    )
      return;
    if (model) return;
    // 旧表单把“默认模型”保存为空值，却又要求提交前必须存在具体候选，
    // 导致初次创建按钮永远禁用。目标 Host ready 后直接选中并固化 preferredSelection。
    modelSelection.current = preferredModelValue;
    setModel(preferredModelValue);
    thoughtManuallyChangedRef.current = false;
    const preferredReasoning =
      modelSelectionView?.preferredSelection?.options?.reasoningLevel ?? "";
    thoughtLevelRef.current = preferredReasoning;
    setThoughtLevel(preferredReasoning);
  }, [editing, model, modelSelectionView, persistedSelectionInvalid, preferredModelValue]);
  const selectedModelMetadataThoughtOption = useMemo(() => {
    if (!selectedModelItem) return null;
    const decodedModel = decodeCustomModelValue(selectedModelItem.value);
    if (!decodedModel?.modelName) return null;
    // 与会话 composer 复用同一模型静态事实，避免 workspace runtime catalog 暂未投影
    // thought_level 时，定时任务把支持推理的模型误显示成无思考档位。
    return modelSelectionView
      ? resolveModelThoughtOption({
          modelSelectionView,
          providerId: decodedModel.providerId,
          modelId: decodedModel.modelName,
        })
      : null;
  }, [modelSelectionView, selectedModelItem]);
  // 所选模型的 Option Specs 只来自目标 Host View；不能为预览再创建 deferred Session。
  const activeThoughtOption = selectedModelMetadataThoughtOption ?? undefined;
  const thoughtLevelOption = useMemo(
    () => buildAutomationThoughtLevelOption(activeThoughtOption, effectiveReasoningLevel),
    [activeThoughtOption, effectiveReasoningLevel],
  );

  const requiredFieldErrors = useMemo(
    () =>
      resolveAutomationEditRequiredFieldErrors({
        title,
        cronExpr,
        prompt,
      }),
    [cronExpr, prompt, title],
  );
  const hasValidWorkspace = Boolean(editing || selectedWorkspace);
  const submissionContextReady =
    hasValidWorkspace &&
    (Boolean(editing) || selectedWorkspace !== null) &&
    modelSelectionRead.state.status === "ready" &&
    selectedModelItem !== null &&
    Boolean(effectiveReasoningLevel) &&
    !modelSelectionView?.selectionIssue;
  const canSubmit = submissionContextReady && requiredFieldErrors.length === 0;

  const requestRequiredFieldValidation = useCallback(
    (source: "save" | "run-now") => {
      setValidationErrors(new Set(requiredFieldErrors));
      logger.debug("[AutomationEditView] 提交前校验必填字段", {
        automationId: editing?.automationId ?? null,
        source,
        invalidFields: requiredFieldErrors,
      });
      return requiredFieldErrors.length === 0;
    },
    [editing?.automationId, requiredFieldErrors],
  );

  const currentScheduleRule = useMemo<ZCodeAutomationScheduleRule | undefined>(
    () =>
      builder.frequency === "custom"
        ? {
            unit: builder.customUnit,
            interval: builder.customInterval,
            hour: builder.hour,
            minute: builder.minute,
            anchorAt: editing?.scheduleRule?.anchorAt ?? Date.now(),
            weekdays: builder.customWeekdays,
            monthDays: builder.customMonthDays,
            // months 仅对 yearly 有意义；其它单位置空，JSON.stringify 会丢弃 undefined。
            months: builder.customUnit === "yearly" ? [builder.customMonth] : undefined,
            monthlyMode: builder.customMonthlyMode,
          }
        : undefined,
    [builder, editing?.scheduleRule?.anchorAt],
  );

  const buildSubmitInput = useCallback(
    ({ modeValue }: { modeValue: string }): CreateAutomationInput | UpdateAutomationInput => {
      if (!effectiveSelection || !effectiveReasoningLevel) {
        throw new Error("Automation model selection is required");
      }
      return {
        title: title.trim(),
        cronExpr,
        prompt: prompt.trim(),
        // 编辑会话内创建的有限次任务时，不能固定改成循环任务。
        recurring: editing?.recurring ?? true,
        ...(editing ? { endAt: endAt ?? null } : endAt ? { endAt } : {}),
        ...(editing
          ? preserveSessionCreatedSchedule
            ? {}
            : { scheduleRule: currentScheduleRule ?? null }
          : currentScheduleRule
            ? { scheduleRule: currentScheduleRule }
            : {}),
        ...(editing && touchedFields.has("schedule") ? { scheduleEditedByUser: true } : {}),
        mode: modeValue,
        modelSelection: effectiveSelection,
      };
    },
    [
      cronExpr,
      currentScheduleRule,
      editing,
      endAt,
      preserveSessionCreatedSchedule,
      prompt,
      effectiveSelection,
      effectiveReasoningLevel,
      title,
      touchedFields,
    ],
  );

  const currentEditSignatures = useMemo<AutomationEditFieldSignatures | null>(() => {
    if (!editing) return null;
    return {
      title: title.trim(),
      prompt: prompt.trim(),
      schedule: JSON.stringify({
        cronExpr,
        endAt: endAt ?? null,
        scheduleRule: preserveSessionCreatedSchedule
          ? null
          : normalizeAutomationScheduleRule(currentScheduleRule ?? null),
      }),
      mode,
      thoughtLevel,
      model,
    };
  }, [
    cronExpr,
    currentScheduleRule,
    editing,
    endAt,
    preserveSessionCreatedSchedule,
    mode,
    model,
    prompt,
    thoughtLevel,
    title,
  ]);
  currentEditSignaturesRef.current = currentEditSignatures;

  const changedFields = useMemo(
    () =>
      currentEditSignatures
        ? resolveChangedAutomationEditFields({
            touchedFields,
            current: currentEditSignatures,
            baseline: touchedFieldBaselinesRef.current,
          })
        : [],
    [currentEditSignatures, touchedFields],
  );
  // 模型元数据和 cron builder 会在打开页面后异步归一化；只有用户实际操作过的
  // 字段才能触发未保存提示，否则仅打开已有任务再返回也会被误判为修改。
  const hasUnsavedChanges = Boolean(editing) && changedFields.length > 0;

  const recommendStartPlan = useStartPlanRecommendation(modelSelectionView);
  const submitAutomation = useCallback(
    async (options: { validationSource: "save" | "run-now"; returnToList?: boolean }) => {
      if (saving) return false;
      if (!requestRequiredFieldValidation(options.validationSource)) {
        return false;
      }
      if (!canSubmit) return false;
      // 防止刚改选择尚未取得对应 View 时，快速保存采用上一个输入的有效结果。
      if (modelSelection.current !== model || thoughtLevelRef.current !== thoughtLevel)
        return false;
      const input: CreateAutomationInput | UpdateAutomationInput = {
        // 权限下拉和保存按钮是两个独立控件，快速选择 Plan 后立即保存时，
        // React state 可能还没刷新到 submit 闭包；用 ref 保留最后一次选择，避免落库成默认 build。
        ...buildSubmitInput({
          modeValue: modeRef.current,
        }),
      };
      // 编辑态锁定原项目;新建态用选中的项目。
      const target = editing
        ? {
            workspacePath: editing.workspacePath,
            workspaceIdentity: editing.workspaceIdentity,
          }
        : selectedWorkspace
          ? {
              workspacePath: selectedWorkspace.workspacePath,
              workspaceIdentity: selectedWorkspace.workspaceIdentity,
            }
          : null;
      // 只禁用按钮无法覆盖快捷键或异步回调；提交边界也必须拒绝无有效项目的新建。
      if (!target) return false;
      if (input.modelSelection && (!editing || changedFields.includes("model"))) {
        const chosen = await recommendStartPlan(input.modelSelection);
        if (!chosen) return false;
        input.modelSelection = chosen;
      }
      const trace = startUserAction({
        featureId: "automation.lifecycle",
        action: editing ? "update" : "create",
        trigger: "button",
        workspaceKind: editing?.workspaceIdentity?.trim() ? "remote" : "local",
        automationKind: "scheduled",
      });
      try {
        const ok = await onSubmit({ input, ...target });
        if (ok) {
          trace.complete({ resultSource: "platform_result" });
          if (options?.returnToList !== false) onBack();
        } else {
          trace.reject({ resultSource: "platform_result" });
        }
        return ok;
      } catch (error) {
        trace.fail({ failureStage: "automation_save" });
        throw error;
      }
    },
    [
      buildSubmitInput,
      changedFields,
      recommendStartPlan,
      canSubmit,
      editing,
      onBack,
      onSubmit,
      requestRequiredFieldValidation,
      saving,
      model,
      thoughtLevel,
      selectedWorkspace?.workspaceIdentity,
      selectedWorkspace?.workspacePath,
    ],
  );

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    await submitAutomation({ validationSource: "save" });
  };

  const handleSaveAndRun = useCallback(async () => {
    if (!editing || !onRunNow || saveAndRunPendingRef.current) return;
    saveAndRunPendingRef.current = true;
    setSaveAndRunPending(true);
    logger.debug("[AutomationEditView] 保存并立即运行开始", {
      automationId: editing.automationId,
      changedFields,
    });
    try {
      const completed = await saveAndRunAutomation(
        () =>
          submitAutomation({
            returnToList: false,
            validationSource: "run-now",
          }),
        () => onRunNow(editing),
      );
      logger.debug("[AutomationEditView] 保存并立即运行结束", {
        automationId: editing.automationId,
        completed,
      });
    } finally {
      saveAndRunPendingRef.current = false;
      setSaveAndRunPending(false);
    }
  }, [changedFields, editing, onRunNow, submitAutomation]);

  const handleBackClick = useCallback(async () => {
    logger.debug("[AutomationEditView] 返回前检查未保存更改", {
      automationId: editing?.automationId ?? null,
      touchedFields: [...touchedFields],
      changedFields,
    });
    if (!hasUnsavedChanges) {
      onBack();
      return;
    }

    // 定时任务曾单独维护“保存 / 放弃修改”弹窗，与闲时任务的确认弹窗
    // 尺寸和动作持续漂移；统一复用远程 Automation presentation，仅保留“取消 / 丢弃”语义。
    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "automations.unsaved.title" }),
      description: intl.formatMessage({
        id: "automations.unsaved.description",
      }),
      confirmLabel: intl.formatMessage({
        id: "automations.unsaved.discard",
      }),
      confirmVariant: "destructive",
      showCloseButton: true,
      showKeyboardHints: false,
      presentation: "automation-confirmation",
    });
    logger.debug("[AutomationEditView] 未保存更改确认结果", {
      automationId: editing?.automationId ?? null,
      discarded: confirmed,
    });
    if (confirmed) onBack();
  }, [
    changedFields,
    confirmDialog,
    editing?.automationId,
    hasUnsavedChanges,
    intl,
    onBack,
    touchedFields,
  ]);

  const handleTabChange = useCallback(
    (nextTab: AutomationSettingsHistoryTab) => {
      // 新建定时任务曾直接禁用 History trigger，和闲时任务可查看空历史的交互不一致。
      logger.debug("[AutomationEditView] 切换设置页签", {
        automationId: editing?.automationId ?? null,
        nextTab,
        willLoadRuns: nextTab === "history" && Boolean(editing),
      });
      setTab(nextTab);
    },
    [editing],
  );

  const runs = runsEntry?.runs ?? [];
  const runsLoading = runsEntry?.status === "loading";
  // 运行历史客户端分页：数据已整份加载，这里按页切片展示。删除后条数变化时把页码收敛到有效范围。
  const runsTotalPages = Math.max(1, Math.ceil(runs.length / RUNS_PAGE_SIZE));
  const runsCurrentPage = Math.min(runsPage, runsTotalPages);
  const pagedRuns = runs.slice(
    (runsCurrentPage - 1) * RUNS_PAGE_SIZE,
    runsCurrentPage * RUNS_PAGE_SIZE,
  );
  const runsPageItems = buildRunsPageItems(runsCurrentPage, runsTotalPages);
  const editStatus = editing ? resolveAutomationStatusKind(editing) : null;
  const showEditingSettingsActions = Boolean(editing && tab === "settings");
  const showCreateSettingsAction = !editing && tab === "settings";

  return (
    <>
      <div className={cn(SETTINGS_FRAME_CONTENT_CLASSNAME, "flex flex-col gap-6")}>
        <SettingsBreadcrumbReporter
          items={[
            {
              label: editing?.title ?? intl.formatMessage({ id: "automations.edit.newTask" }),
            },
          ]}
          onSectionSelect={() => void handleBackClick()}
        />

        <div className="space-y-1.5">
          <h1
            data-testid="automation-edit-title"
            className="text-ui-xl font-semibold text-foreground"
          >
            {intl.formatMessage({
              id: editing ? "automations.form.editTitle" : "automations.form.createTitle",
            })}
          </h1>
          <p data-testid="automation-edit-subtitle" className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({
              id: editing ? "automations.edit.editSubtitle" : "automations.edit.createSubtitle",
            })}
          </p>
        </div>

        {/* tab + 右侧操作 */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <AutomationSettingsHistoryTabs
            value={tab}
            settingsLabel={intl.formatMessage({
              id: "automations.edit.tab.settings",
            })}
            historyLabel={intl.formatMessage({
              id: "automations.edit.tab.history",
            })}
            onValueChange={handleTabChange}
          />

          <div className="flex items-center gap-1.5">
            {editing ? (
              <>
                {showEditingSettingsActions ? (
                  <button
                    type="submit"
                    form="automation-edit-form"
                    data-testid={TID_AUTOMATION_FORM_SUBMIT}
                    className="inline-flex h-8 items-center rounded-lg border-0 bg-white px-3 text-ui-base font-medium text-black shadow-none outline-none transition-colors hover:bg-white/90 focus-visible:ring-0 disabled:pointer-events-none disabled:opacity-40"
                    disabled={!submissionContextReady || saving}
                  >
                    {intl.formatMessage({
                      id: saving ? "automations.form.saving" : "automations.form.save",
                    })}
                  </button>
                ) : null}
                {showEditingSettingsActions && onRunNow ? (
                  <button
                    type="button"
                    data-testid={TID_AUTOMATION_RUN_NOW}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border-0 bg-white/[0.06] px-3 text-ui-base font-medium text-foreground shadow-none outline-none transition-colors hover:bg-white/10 focus-visible:ring-0 disabled:pointer-events-none disabled:cursor-not-allowed disabled:text-foreground-subtlest disabled:opacity-40"
                    disabled={!submissionContextReady || saving || saveAndRunPending}
                    onClick={() => void handleSaveAndRun()}
                  >
                    <AutomationRunNowIcon className="size-4" aria-hidden="true" />
                    {intl.formatMessage({ id: "automations.runNow" })}
                  </button>
                ) : null}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={intl.formatMessage({
                        id: "automations.moreActions",
                      })}
                      className="flex size-8 items-center justify-center rounded-lg border-0 bg-white/[0.06] text-foreground-subtle shadow-none outline-none transition-colors hover:bg-white/10 hover:text-foreground data-[state=open]:bg-white/10 data-[state=open]:text-foreground focus-visible:ring-0"
                    >
                      <AutomationMoreHorizontalIcon className="size-4" aria-hidden="true" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" sideOffset={4} className="min-w-[180px]">
                    {/* 终态任务(completed/failed)不展示 pause/resume：Resume 对终态无意义，改存即复活。 */}
                    {onToggle &&
                    editing.lifecycleStatus !== "completed" &&
                    editing.lifecycleStatus !== "failed" ? (
                      <DropdownMenuItem
                        className="gap-1"
                        onSelect={() => onToggle(editing, !editing.enabled)}
                      >
                        <span className="flex size-5 items-center justify-center">
                          {editing.enabled ? (
                            <AutomationPauseActionIcon className="size-4" aria-hidden="true" />
                          ) : (
                            <AutomationContinueIcon className="size-4" aria-hidden="true" />
                          )}
                        </span>
                        {intl.formatMessage({
                          id: editing.enabled ? "automations.pause" : "automations.resume",
                        })}
                      </DropdownMenuItem>
                    ) : null}
                    {onDelete ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="gap-1 !text-destructive data-[highlighted]:!bg-menu-hover data-[highlighted]:!text-destructive focus:!text-destructive [&_svg]:!text-destructive"
                          onSelect={() => onDelete(editing)}
                        >
                          <AutomationTrashIcon />
                          {intl.formatMessage({ id: "automations.delete" })}
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : showCreateSettingsAction ? (
              <Button
                type="submit"
                form="automation-edit-form"
                variant="default"
                size="lg"
                data-testid={TID_AUTOMATION_FORM_SUBMIT}
                disabled={!canSubmit || saving}
              >
                {intl.formatMessage({
                  id: saving ? "automations.form.saving" : "automations.edit.createButton",
                })}
              </Button>
            ) : null}
          </div>
        </div>

        {tab === "settings" ? (
          <form
            id="automation-edit-form"
            className="space-y-4"
            onSubmit={(e) => void handleSubmit(e)}
          >
            {editStatus ? (
              <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
                <div className="text-ui-base font-normal leading-5 text-foreground-subtle">
                  {intl.formatMessage({ id: "automations.form.status.label" })}
                </div>
                <div className="flex min-h-8 flex-wrap items-center gap-2">
                  {/* 状态圆点与胶囊沿用了偏大的 8px / 36px 尺寸，未遵循 6px glyph + 20px frame 的规格。 */}
                  <span className="inline-flex h-8 max-w-full items-center gap-1 rounded-lg bg-card pl-2 pr-4 text-ui-base leading-5 text-foreground">
                    <span className="flex size-5 shrink-0 items-center justify-center">
                      <span
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          AUTOMATION_STATUS_DOT_CLASS[editStatus],
                        )}
                        aria-hidden="true"
                      />
                    </span>
                    <span className="min-w-0 truncate">
                      {intl.formatMessage({
                        id: `automations.lifecycle.${editStatus}`,
                      })}
                    </span>
                  </span>
                </div>
              </div>
            ) : null}

            {/* Task title */}
            <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
              <label
                className="text-ui-base font-normal leading-5 text-foreground-subtle"
                htmlFor="automation-title"
              >
                {intl.formatMessage({ id: "automations.form.title.label" })}
              </label>
              {/* Task title 是标准 Input，不能局部移除全局描边语义。*/}
              <Input
                id="automation-title"
                size="lg"
                data-testid={TID_AUTOMATION_FORM_TITLE}
                value={title}
                onChange={(e) => {
                  titleTouchedRef.current = true;
                  markFieldTouched("title");
                  clearRequiredFieldValidation("title");
                  setTitle(e.target.value);
                }}
                placeholder={intl.formatMessage({
                  id: "automations.edit.titlePlaceholder",
                })}
                aria-invalid={validationErrors.has("title") && !title.trim()}
                maxLength={200}
                className={cn(
                  "h-9 rounded-xl bg-input px-3 text-foreground",
                  AUTOMATION_FORM_INPUT_TYPOGRAPHY_CLASSNAME,
                )}
              />
            </div>

            {/* 会话来源的旧 cron 无法可靠回显；删除后切换到标准 UI 调度编辑流程。 */}
            {preserveSessionCreatedSchedule ? (
              <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
                <label className="inline-flex items-center gap-1.5 text-ui-base font-normal leading-5 text-foreground-subtle">
                  {intl.formatMessage({
                    id: "automations.form.schedule.label",
                  })}
                </label>
                <div
                  data-testid={TID_AUTOMATION_SCHEDULE_PREVIEW}
                  className="relative flex h-9 items-center overflow-hidden rounded-xl border border-input-border bg-input px-2 pr-9 text-ui-base leading-5 text-foreground-subtle transition-colors hover:border-input-border-hover focus-within:border-input-border-focused focus-within:bg-input-focused"
                >
                  <span className="min-w-0 truncate">
                    {intl.formatMessage({ id: "automations.frequency.custom" })}
                  </span>
                  <button
                    type="button"
                    data-testid={TID_AUTOMATION_SCHEDULE_DELETE}
                    onClick={handleRemoveSchedule}
                    className="absolute right-2 top-2 flex size-5 items-center justify-center text-foreground-subtle transition-colors hover:text-foreground"
                    aria-label={intl.formatMessage({ id: "common.delete" })}
                  >
                    <AutomationTrashIcon />
                  </button>
                </div>
              </div>
            ) : (
              <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
                <label className="inline-flex items-center gap-1.5 text-ui-base font-normal leading-5 text-foreground-subtle">
                  {intl.formatMessage({
                    id: "automations.form.schedule.label",
                  })}
                </label>
                {scheduleRemoved ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        data-testid={TID_AUTOMATION_SCHEDULE_ADD}
                        aria-invalid={scheduleRemoved && validationErrors.has("schedule")}
                        className={cn(
                          "flex h-9 w-full items-center gap-1 rounded-xl border bg-input px-2 text-ui-base font-normal leading-5 text-foreground-subtle transition-colors hover:border-input-border-hover hover:text-foreground focus-visible:border-input-border-focused focus-visible:bg-input-focused data-[state=open]:border-input-border-focused data-[state=open]:bg-input-focused data-[state=open]:text-foreground",
                          validationErrors.has("schedule")
                            ? "!border-destructive !ring-2 !ring-destructive/20"
                            : "border-input-border",
                        )}
                      >
                        <span className="flex size-5 shrink-0 items-center justify-center">
                          <AutomationAddScheduleIcon aria-hidden="true" />
                        </span>
                        {intl.formatMessage({
                          id: "scheduledPreview.addSchedule",
                        })}
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" sideOffset={4} className="w-[148px] p-1.5">
                      {FREQUENCIES.map((frequency) => (
                        <DropdownMenuItem
                          key={frequency}
                          data-testid={testId(TID_AUTOMATION_FREQUENCY_OPTION, frequency)}
                          // raw 白色 5% 只在深色菜单可见，Light 下高亮状态近似透明。
                          className="min-h-8 px-2 py-2 text-ui-base text-foreground-subtle data-[highlighted]:bg-menu-hover data-[highlighted]:text-foreground"
                          onSelect={() => {
                            markFieldTouched("schedule");
                            if (frequency === "custom") {
                              setCustomRepeatOpen(true);
                              return;
                            }
                            setBuilder((previous) => ({
                              ...previous,
                              frequency,
                              ...(frequency === "weekdays" ? { weekdays: [1, 2, 3, 4, 5] } : {}),
                            }));
                            setScheduleRemoved(false);
                            clearRequiredFieldValidation("schedule");
                          }}
                        >
                          {intl.formatMessage({
                            id: `automations.frequency.${frequency}`,
                          })}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : (
                  <>
                    {/* 调度栏不用 min-height、换行布局和全行摘要——那些会在新增 tag 后被第二行撑高。
                        恢复全局 Input 的 1px 描边后，用 7px 左内边距抵消边框占位，保持首个 tag
                        距外边缘仍为 8px；tag 增加上下各 1px padding 后仍在 36px input 内垂直居中。 */}
                    <div className="relative flex h-9 flex-nowrap items-center gap-1 overflow-hidden rounded-xl border border-input-border bg-input py-1 pl-[7px] pr-9 text-ui-base leading-5 text-foreground transition-colors hover:border-input-border-hover focus-within:border-input-border-focused focus-within:bg-input-focused">
                      <Select
                        value={builder.frequency}
                        onValueChange={(value) => {
                          // Radix Select 在编辑旧 cron 的控件注册阶段可能发出空值，不能覆盖已解析频率。
                          if (!isCronFrequency(value)) {
                            logger.warn("[AutomationEditView] 忽略非法的频率选择值", {
                              automationId: editing?.automationId,
                              cronExpr: editing?.cronExpr,
                              value,
                            });
                            return;
                          }
                          markFieldTouched("schedule");
                          if (value === "custom") {
                            setCustomRepeatOpen(true);
                            return;
                          }
                          setBuilder((prev) => ({
                            ...prev,
                            frequency: value,
                            ...(value === "weekdays" ? { weekdays: [1, 2, 3, 4, 5] } : {}),
                          }));
                        }}
                      >
                        {/* 频率触发器曾写死深色值，导致浅色主题下对比失真；
                            改用 hover/selected 语义 token，并在 20px 行高外增加上下各 1px padding。 */}
                        <SelectTrigger
                          variant="ghost"
                          data-testid={TID_AUTOMATION_FREQUENCY_SELECT}
                          className="h-auto min-w-24 rounded-full border-0 bg-hover py-px pl-2 text-ui-base leading-5 text-foreground hover:bg-selected aria-expanded:bg-selected"
                          indicator={<AutomationChevronDownIcon />}
                        >
                          <SelectValue>
                            {intl.formatMessage({
                              id: `automations.frequency.${builder.frequency}`,
                            })}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {FREQUENCIES.map((freq) => (
                            <SelectItem
                              key={freq}
                              value={freq}
                              data-testid={testId(TID_AUTOMATION_FREQUENCY_OPTION, freq)}
                            >
                              {intl.formatMessage({
                                id: `automations.frequency.${freq}`,
                              })}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      {builder.frequency === "monthly" ? (
                        <Select
                          value={String(builder.dayOfMonth)}
                          onValueChange={(value) => {
                            markFieldTouched("schedule");
                            setBuilder((prev) => ({
                              ...prev,
                              dayOfMonth: Number(value),
                            }));
                          }}
                        >
                          <SelectTrigger
                            variant="ghost"
                            className="h-auto w-auto rounded-full border-0 bg-hover py-px pl-2 pr-0.5 text-ui-base leading-5 text-foreground hover:bg-selected aria-expanded:bg-selected"
                            indicator={<AutomationChevronDownIcon />}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="max-h-60">
                            {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                              <SelectItem key={day} value={String(day)}>
                                {intl.formatMessage(
                                  { id: "automations.form.dayOfMonth" },
                                  { day: String(day) },
                                )}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : null}

                      {builder.frequency === "weekly" ? (
                        <WeekdayPicker
                          weekdays={builder.weekdays}
                          intl={intl}
                          onChange={(weekdays) => {
                            markFieldTouched("schedule");
                            setBuilder((prev) => ({ ...prev, weekdays }));
                          }}
                        />
                      ) : null}

                      {/* 重复周期曾写死 #F8F8F8 且三段 tag 圆角不一致；统一语义文字色与 pill 圆角。*/}
                      {builder.frequency === "custom" ? (
                        <button
                          type="button"
                          // 视觉重构误删了 E2E 稳定选择器，导致保存后无法重新打开 Custom Repeat 验证复原值。
                          data-testid={TID_AUTOMATION_CUSTOM_REPEAT_EDIT}
                          onClick={() => setCustomRepeatOpen(true)}
                          className="inline-flex h-auto items-center gap-0.5 rounded-full bg-hover py-px pl-2 pr-0.5 text-ui-base leading-5 text-foreground hover:bg-selected"
                        >
                          <span>
                            {intl.formatMessage(
                              {
                                id: "automations.customRepeat.compactFrequency",
                              },
                              {
                                interval: String(builder.customInterval),
                                unit: intl.formatMessage({
                                  id: `automations.customRepeat.unit.${
                                    builder.customUnit === "minute"
                                      ? "minute"
                                      : builder.customUnit === "daily"
                                        ? "day"
                                        : builder.customUnit === "weekly"
                                          ? "week"
                                          : builder.customUnit === "monthly"
                                            ? "month"
                                            : builder.customUnit === "yearly"
                                              ? "year"
                                              : "hour"
                                  }`,
                                }),
                              },
                            )}
                          </span>
                          <AutomationChevronDownIcon />
                        </button>
                      ) : null}

                      {builder.frequency !== "custom" && builder.frequency !== "hourly" ? (
                        <>
                          {/* 连接词曾单独使用二级色，和相邻 tag 主文字形成错误的高亮断层。*/}
                          <span className="text-foreground">
                            {intl.formatMessage({
                              id: "automations.form.schedule.at",
                            })}
                          </span>
                          <TimeOfDayPicker
                            hour={builder.hour}
                            minute={builder.minute}
                            ariaLabel={intl.formatMessage({
                              id: "automations.form.schedule.label",
                            })}
                            onChange={(hour, minute) => {
                              markFieldTouched("schedule");
                              setBuilder((prev) => ({ ...prev, hour, minute }));
                            }}
                          />
                          <span className="whitespace-nowrap text-foreground-subtle">
                            {formatGmtOffset()}
                          </span>
                        </>
                      ) : null}

                      {builder.frequency === "hourly" ? (
                        <div className="flex items-center gap-1 text-ui-base leading-5 text-foreground">
                          <span>
                            {intl.formatMessage({
                              id: "automations.form.schedule.minutePrefix",
                            })}
                          </span>
                          <Select
                            value={String(builder.minute)}
                            onValueChange={(value) => {
                              markFieldTouched("schedule");
                              setBuilder((prev) => ({
                                ...prev,
                                minute: Number(value),
                              }));
                            }}
                          >
                            <SelectTrigger
                              variant="ghost"
                              className="h-auto w-14 rounded-full border-0 bg-hover py-px pl-2 text-ui-base leading-5 tabular-nums hover:bg-selected"
                            >
                              <SelectValue>{pad2(builder.minute)}</SelectValue>
                            </SelectTrigger>
                            <SelectContent className="max-h-60">
                              {Array.from({ length: 60 }, (_, value) => (
                                <SelectItem key={value} value={String(value)}>
                                  {pad2(value)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <span>
                            {intl.formatMessage({
                              id: "automations.form.schedule.minuteSuffix",
                            })}
                          </span>
                        </div>
                      ) : null}

                      {builder.frequency === "custom" && builder.customUnit === "hourly" ? (
                        <div className="flex items-center gap-1 text-ui-base leading-5 text-foreground">
                          <span>
                            {intl.formatMessage({
                              id: "automations.form.schedule.at",
                            })}
                          </span>
                          <Select
                            value={String(builder.minute)}
                            onValueChange={(value) => {
                              markFieldTouched("schedule");
                              setBuilder((prev) => ({
                                ...prev,
                                minute: Number(value),
                              }));
                            }}
                          >
                            <SelectTrigger
                              variant="ghost"
                              className="h-auto w-16 rounded-full border-0 bg-hover py-px pl-2 text-ui-base leading-5 tabular-nums hover:bg-selected"
                            >
                              <SelectValue>{pad2(builder.minute)}</SelectValue>
                            </SelectTrigger>
                            <SelectContent className="max-h-60">
                              {Array.from({ length: 60 }, (_, value) => (
                                <SelectItem key={value} value={String(value)}>
                                  {pad2(value)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <span>
                            {intl.formatMessage({
                              id: "automations.customRepeat.minutes",
                            })}
                          </span>
                        </div>
                      ) : null}

                      {builder.frequency === "custom" && builder.customUnit === "yearly" ? (
                        <MonthDayPicker
                          month={builder.customMonth}
                          day={builder.customMonthDays[0] ?? 1}
                          intl={intl}
                          onChange={(month, day) => {
                            markFieldTouched("schedule");
                            setBuilder((prev) => ({
                              ...prev,
                              customMonth: month,
                              customMonthDays: [day],
                            }));
                          }}
                        />
                      ) : null}

                      {builder.frequency === "custom" &&
                      builder.customUnit !== "hourly" &&
                      builder.customUnit !== "minute" ? (
                        <>
                          <span className="text-foreground">
                            {intl.formatMessage({
                              id: "automations.form.schedule.at",
                            })}
                          </span>
                          <TimeOfDayPicker
                            hour={builder.hour}
                            minute={builder.minute}
                            onChange={(hour, minute) => {
                              markFieldTouched("schedule");
                              setBuilder((prev) => ({ ...prev, hour, minute }));
                            }}
                          />
                          <span className="text-foreground-subtle">{formatGmtOffset()}</span>
                        </>
                      ) : null}

                      {schedulePreview ? (
                        <span
                          data-testid={TID_AUTOMATION_SCHEDULE_PREVIEW}
                          className="min-w-0 flex-1 truncate text-ui-base text-foreground-subtle sm:ml-1"
                        >
                          {schedulePreview}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        data-testid={TID_AUTOMATION_SCHEDULE_DELETE}
                        onClick={handleRemoveSchedule}
                        className="absolute right-2 top-2 flex size-5 items-center justify-center text-foreground-subtle transition-colors hover:text-foreground"
                        aria-label={intl.formatMessage({ id: "common.delete" })}
                      >
                        <AutomationTrashIcon />
                      </button>
                    </div>
                  </>
                )}

                <CustomRepeatDialog
                  builder={builder}
                  endAt={endAt}
                  intl={intl}
                  open={customRepeatOpen}
                  onOpenChange={setCustomRepeatOpen}
                  onConfirm={({
                    interval,
                    unit,
                    weekdays,
                    monthDays,
                    monthlyMode,
                    endAt: nextEndAt,
                  }) => {
                    markFieldTouched("schedule");
                    setScheduleRemoved(false);
                    clearRequiredFieldValidation("schedule");
                    setBuilder((prev) => ({
                      ...prev,
                      frequency: "custom",
                      customInterval: interval,
                      customUnit: unit,
                      customWeekdays: weekdays,
                      customMonthDays: monthDays,
                      customMonthlyMode: monthlyMode,
                    }));
                    setEndAt(nextEndAt);
                  }}
                />
              </div>
            )}

            {/* Instructions + 底部项目/模型选择器 */}
            <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
              <label
                className="text-ui-base font-normal leading-5 text-foreground-subtle"
                htmlFor="automation-prompt"
              >
                {intl.formatMessage({ id: "automations.form.prompt.label" })}
              </label>
              <AutomationInstructionsComposer
                invalid={validationErrors.has("prompt") && !prompt.trim()}
              >
                <AutomationInstructionsTextarea
                  id="automation-prompt"
                  data-testid={TID_AUTOMATION_FORM_PROMPT}
                  value={prompt}
                  onChange={(event) => {
                    markFieldTouched("prompt");
                    clearRequiredFieldValidation("prompt");
                    setPrompt(event.target.value);
                  }}
                  placeholder={intl.formatMessage({
                    id: "automations.edit.promptPlaceholder",
                  })}
                  aria-invalid={validationErrors.has("prompt") && !prompt.trim()}
                />
                <AutomationInstructionsToolbar>
                  <div className="flex min-w-0 flex-wrap items-center gap-0 text-foreground-subtle">
                    {/* 项目选择器:新建复用输入框空态的项目菜单;编辑锁定为 automation 所属项目 */}
                    {editing ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled
                        className="h-auto min-h-7 gap-1 rounded-full px-2 py-1 text-ui-base font-normal leading-normal"
                      >
                        {isSelectedConversationWorkspace ? (
                          <MessageCircle className="size-3.5" aria-hidden="true" />
                        ) : (
                          <FolderOpen className="size-3.5" aria-hidden="true" />
                        )}
                        <span className="max-w-40 truncate">{selectedWorkspaceDisplayLabel}</span>
                      </Button>
                    ) : workspaceMenuTabs.length > 0 ? (
                      // Automations 工具条与会话 composer 控件统一使用 rounded-lg，普通会话 chip 不变。
                      <ChatEmptyWorkspacePreviewMenu
                        workspacePath={selectedWorkspacePath}
                        workspaceTabs={workspaceMenuTabs}
                        // 定时任务允许选择 canonical conversation backing，但不提供 chip 上的快捷 X；
                        // 菜单展示统一复用会话侧「不在项目中工作」文案和 MessageCircle 图标。
                        allowConversationWorkspaceSelection={Boolean(conversationWorkspace)}
                        allowConversationWorkspaceDetach={false}
                        onSelectWorkspace={handleSelectWorkspace}
                        onSelectConversationWorkspace={handleSelectConversationWorkspace}
                        allowOpenWorkspace={false}
                        allowRemoteWorkspace={false}
                        onOpenFolder={() => {}}
                        onConnectRemote={async () => ""}
                        onSelectRemoteProject={async () => {}}
                        onCancelRemoteProject={async (_sessionId) => {}}
                        containerClassName="contents"
                        triggerClassName={cn(
                          AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
                          "min-w-0 gap-1 px-2",
                        )}
                      />
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled
                        className="h-auto min-h-7 gap-1 rounded-full px-2 py-1 text-ui-base font-normal leading-normal text-foreground-subtlest"
                      >
                        <FolderOpen className="size-3.5" aria-hidden="true" />
                        {intl.formatMessage({
                          id: "automations.form.project.localRequired",
                        })}
                      </Button>
                    )}

                    {/* 自动化曾复制首页权限菜单，导致图标、字号和选中态逐渐分叉。
                        直接复用首页 ConfigSelect，只覆盖紧凑 trigger 布局。 */}
                    <ConfigSelect
                      option={modeOption}
                      onValueChange={(value) => {
                        markFieldTouched("mode");
                        modeRef.current = value;
                        setMode(value);
                      }}
                      tooltipTitle={intl.formatMessage({
                        id: "chat.toolbar.mode.label",
                      })}
                      triggerVariant="ghost"
                      triggerSize="default"
                      triggerClassName={cn(
                        AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
                        "w-fit max-w-56 min-w-0 shrink justify-start gap-1 px-2",
                      )}
                      labelVisibilityClassName="inline-flex min-w-0 truncate text-left"
                      provider={ZCODE_AGENT_PROVIDER}
                      restoreFocusSelector={null}
                    />
                  </div>

                  {/* 模型 / 推理强度在右侧成组，和左侧 workspace / 权限形成清晰分区。 */}
                  <div className="flex min-w-0 flex-wrap items-center justify-end gap-0 text-foreground-subtle">
                    <ModelConfigSelect
                      modelGroups={modelSelectGroups}
                      normalizedValue={selectedModelItem?.value ?? ""}
                      triggerLabel={modelTriggerLabel}
                      showManageModelsAction={Boolean(onManageModels)}
                      lockReasonMessage=""
                      isItemLocked={MODEL_ITEM_NEVER_LOCKED}
                      onValueChange={handleModelValueChange}
                      tooltipTitle={intl.formatMessage({
                        id: "chat.toolbar.model.label",
                      })}
                      manageModelsLabel={intl.formatMessage({
                        id: "chat.toolbar.model.manageModels",
                      })}
                      onManageModels={onManageModels}
                      contentSide="top"
                      focusSelectorOnClose={null}
                      labelVisibilityClassName="hidden @sm/composer:inline-flex"
                      indicatorClassName="hidden @sm/composer:block"
                      triggerClassName={cn(
                        AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
                        "w-fit max-w-72 min-w-0 shrink @max-sm/composer:size-7 @max-sm/composer:justify-center @max-sm/composer:gap-0 @max-sm/composer:p-0",
                      )}
                      triggerIconClassName="inline-flex @sm/composer:hidden"
                      disabled={modelSelectionRead.state.status !== "ready"}
                    />
                    {modelSelectionRead.state.status === "error" ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={modelSelectionRead.reload}
                      >
                        {intl.formatMessage({ id: "common.retry" })}
                      </Button>
                    ) : null}
                    {thoughtLevelOption ? (
                      <ThoughtLevelCycleControl
                        intl={intl}
                        option={thoughtLevelOption}
                        provider={ZCODE_AGENT_PROVIDER}
                        triggerRef={thoughtTriggerRef}
                        indicatorClassName="hidden @xl/composer:block"
                        triggerClassName={cn(
                          AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
                          "@max-sm/composer:size-7 @max-sm/composer:justify-center @max-sm/composer:p-0",
                        )}
                        restoreFocusSelector={null}
                        labelVisibilityClassName="hidden @xl/composer:inline-flex"
                        onValueChange={(value) => {
                          if (!effectiveSelection) return;
                          markFieldTouched("thoughtLevel");
                          // 用户改档位时以正在显示的模型身份形成新意图；只读刷新不改表单。
                          modelSelection.current = effectiveModelValue;
                          setModel(effectiveModelValue);
                          thoughtManuallyChangedRef.current = true;
                          thoughtLevelRef.current = value;
                          setThoughtLevel(value);
                        }}
                      />
                    ) : null}
                  </div>
                </AutomationInstructionsToolbar>
              </AutomationInstructionsComposer>
            </div>
          </form>
        ) : (
          // History tab：运行历史内联表
          <div>
            {/* 运行条件已在设置入口说明，历史页重复提示会挤占表格上方空间。*/}
            {runsLoading && runs.length === 0 ? (
              <div className="flex h-32 items-center justify-center">
                <Spinner className="size-5" />
              </div>
            ) : runsEntry?.status === "error" ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-sm text-destructive">
                {runsEntry.error}
              </div>
            ) : runs.length === 0 ? (
              // 定时任务曾仅渲染透明的 py-10 文本块，缺少与闲时任务一致的空态背景、边框和高度。
              <AutomationHistoryEmptyState>
                {intl.formatMessage({ id: "automations.runs.empty" })}
              </AutomationHistoryEmptyState>
            ) : (
              <div className="overflow-x-auto rounded-[8px]">
                {/* 运行历史使用可缩放字号，不能继续绑定固定 18px 行高。*/}
                <table className="w-full text-left text-ui-base font-normal leading-normal tracking-[-0.08px]">
                  <thead className="bg-surface text-foreground-subtle">
                    <tr className="h-[30px] border-b border-border">
                      <th className="px-4 font-normal">
                        {intl.formatMessage({
                          id: "automations.runs.col.triggered",
                        })}
                      </th>
                      <th className="px-4 font-normal">
                        {intl.formatMessage({
                          id: "automations.runs.col.trigger",
                        })}
                      </th>
                      <th className="px-4 font-normal">
                        {intl.formatMessage({
                          id: "automations.runs.col.status",
                        })}
                      </th>
                      <th className="px-4 font-normal">
                        {intl.formatMessage({
                          id: "automations.runs.col.duration",
                        })}
                      </th>
                      <th className="px-4 font-normal" />
                    </tr>
                  </thead>
                  <tbody>
                    {pagedRuns.map((run) => {
                      const status = resolveRunStatus(run);
                      const statusLabel = intl.formatMessage({
                        id: `automations.runs.status.${status}`,
                      });
                      const statusBadge = (
                        <span className="flex items-center text-ui-base leading-5 tracking-[-0.18px]">
                          <span className="flex size-5 shrink-0 items-center justify-center">
                            <span
                              className={cn(
                                "inline-block size-1.5 rounded-full",
                                RUN_STATUS_DOT_CLASS[status],
                              )}
                            />
                          </span>
                          <span className={RUN_STATUS_TEXT_CLASS[status]}>{statusLabel}</span>
                        </span>
                      );
                      const canOpenSession = Boolean(run.sessionId && onOpenSession);
                      const hasActions = canOpenSession || Boolean(onDeleteRun);
                      return (
                        <tr
                          key={run.runId}
                          className="h-[46px] border-b border-border transition-colors last:border-b-0 hover:bg-surface-hover"
                        >
                          <td className="whitespace-nowrap px-4 text-foreground-subtle">
                            {formatDateTime(run.scheduledAt ?? run.createdAt)}
                          </td>
                          <td className="whitespace-nowrap px-4 text-foreground-subtle">
                            {intl.formatMessage({
                              id: `automations.trigger.${run.trigger}`,
                            })}
                          </td>
                          <td className="px-4">
                            {status === "failed" ? (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>{statusBadge}</TooltipTrigger>
                                  <TooltipContent
                                    side="top"
                                    align="start"
                                    sideOffset={6}
                                    className="max-w-96 whitespace-normal break-words"
                                  >
                                    {run.error?.trim() ||
                                      intl.formatMessage({
                                        id: "automations.runs.errorUnavailable",
                                      })}
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            ) : (
                              statusBadge
                            )}
                          </td>
                          <td className="whitespace-nowrap px-4 text-foreground-subtle">
                            {formatDuration(run.createdAt, run.updatedAt)}
                          </td>
                          <td className="px-4">
                            <div className="flex items-center justify-end">
                              {hasActions ? (
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <button
                                      type="button"
                                      aria-label={intl.formatMessage({
                                        id: "automations.moreActions",
                                      })}
                                      className="flex size-6 items-center justify-center rounded-[6px] text-foreground-subtle transition-colors hover:bg-white/10 hover:text-foreground data-[state=open]:bg-white/10 data-[state=open]:text-foreground"
                                    >
                                      <AutomationMoreHorizontalIcon
                                        className="size-4"
                                        aria-hidden="true"
                                      />
                                    </button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent
                                    align="end"
                                    sideOffset={4}
                                    className="min-w-[160px]"
                                  >
                                    {canOpenSession ? (
                                      <DropdownMenuItem
                                        onSelect={() => onOpenSession?.(run.sessionId!)}
                                      >
                                        <AutomationExternalLinkIcon
                                          className="size-3.5"
                                          aria-hidden="true"
                                        />
                                        {intl.formatMessage({
                                          id: "automations.runs.openSession",
                                        })}
                                      </DropdownMenuItem>
                                    ) : null}
                                    {onDeleteRun ? (
                                      <>
                                        {canOpenSession ? <DropdownMenuSeparator /> : null}
                                        <DropdownMenuItem
                                          variant="destructive"
                                          onSelect={() => onDeleteRun(run.runId)}
                                        >
                                          <AutomationTrashIcon />
                                          {intl.formatMessage({
                                            id: "automations.runs.delete",
                                          })}
                                        </DropdownMenuItem>
                                      </>
                                    ) : null}
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {runs.length > 0 && runsTotalPages > 1 ? (
              <nav className="mt-4 flex items-center justify-between text-ui-base">
                <button
                  type="button"
                  disabled={runsCurrentPage <= 1}
                  onClick={() => setRunsPage(Math.max(1, runsCurrentPage - 1))}
                  className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-foreground-subtle transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                >
                  <ArrowLeft className="size-3.5" aria-hidden="true" />
                  {intl.formatMessage({ id: "automations.runs.prevPage" })}
                </button>
                <div className="flex items-center gap-1">
                  {runsPageItems.map((item, index) =>
                    item === "ellipsis" ? (
                      <span
                        key={`ellipsis-${index}`}
                        className="flex size-7 items-center justify-center text-foreground-subtlest"
                        aria-hidden="true"
                      >
                        …
                      </span>
                    ) : (
                      <button
                        key={item}
                        type="button"
                        aria-current={item === runsCurrentPage ? "page" : undefined}
                        onClick={() => setRunsPage(item)}
                        className={cn(
                          "inline-flex size-7 items-center justify-center rounded-[6px] transition-colors",
                          item === runsCurrentPage
                            ? "bg-surface text-foreground"
                            : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
                        )}
                      >
                        {item}
                      </button>
                    ),
                  )}
                </div>
                <button
                  type="button"
                  disabled={runsCurrentPage >= runsTotalPages}
                  onClick={() => setRunsPage(Math.min(runsTotalPages, runsCurrentPage + 1))}
                  className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-foreground-subtle transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                >
                  {intl.formatMessage({ id: "automations.runs.nextPage" })}
                  <ArrowRight className="size-3.5" aria-hidden="true" />
                </button>
              </nav>
            ) : null}
          </div>
        )}
      </div>
    </>
  );
}
