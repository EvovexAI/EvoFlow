import { memo, useCallback, useMemo } from "react";
import { LightbulbIcon, XIcon, ChevronDownIcon } from "lucide-react";
import {
  TID_CHAT_MODE_SELECT_TRIGGER,
  TID_CHAT_MODE_SELECT_ITEM,
  TID_V4_COMPOSER_INPUT,
  ZCODE_AGENT_PROVIDER,
  getZCodeAgentAvailableModes,
  testId,
  type ZCodeConfigOption,
} from "@zcode/shared";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  getModeOptionDisplayLabel,
  getModeOptionDescriptionMessageId,
  resolveModeOptionIcon,
} from "@/chat-input-toolbar/display.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isCoarseTouchDevice } from "@/lib/pickerFocus.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  getNextConfigSelectValue,
  useToolbarShortcutBindings,
} from "@/v4/composer/toolbarShortcuts.js";
import type { V4ComposerToolbarProps } from "@/v4/composer/V4ComposerToolbar.js";

function noop(): void {}

/** Plan 是独立勾选项，三种权限仍为单选；只编辑草稿，不向 Runtime 发切换命令。 */
function V4ComposerModeSwitchImpl({
  provider,
  draftConfig,
  disabled,
  activeConfigPicker,
  onConfigPickerOpenChange,
  onSwitchMode,
}: Pick<
  V4ComposerToolbarProps,
  | "workspacePath"
  | "workspaceIdentity"
  | "provider"
  | "draftConfig"
  | "disabled"
  | "activeConfigPicker"
  | "onConfigPickerOpenChange"
  | "onSwitchMode"
>) {
  const { intl } = useZCodeIntl();
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  const modeShortcutLabel = useShortcutCommandLabel("cycleSessionMode");
  const modes = getZCodeAgentAvailableModes();
  const permissions = modes.filter((mode) => mode.id !== "plan");
  const selected = permissions.find((mode) => mode.id === draftConfig?.mode);
  const label = (mode: (typeof modes)[number]) =>
    getModeOptionDisplayLabel(intl, displayProvider, { value: mode.id, name: mode.name });
  const plan = modes.find((mode) => mode.id === "plan")!;
  const planLabel = label(plan);
  // Plan 拆成独立勾选项后仍需保留原菜单说明，复用相同的国际化映射。
  const planDescriptionId = getModeOptionDescriptionMessageId(displayProvider, { value: plan.id });
  const modeOption = useMemo<ZCodeConfigOption>(
    () => ({
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: draftConfig?.mode ?? "build",
      options: getZCodeAgentAvailableModes()
        .filter((mode) => mode.id !== "plan")
        .map((mode) => ({ value: mode.id, name: mode.name })),
    }),
    [draftConfig?.mode],
  );
  const cycle = useCallback(() => {
    const next = getNextConfigSelectValue(modeOption);
    if (next) onSwitchMode(next);
  }, [modeOption, onSwitchMode]);
  useToolbarShortcutBindings({
    hasAnyOption: Boolean(selected),
    toolbarDisabled: disabled,
    modelMenuDisabled: true,
    modeOption,
    onCycleSessionMode: cycle,
    onOpenModelMenu: noop,
    onCycleThoughtLevel: noop,
  });
  if (!selected) return null;
  const Icon = resolveModeOptionIcon(selected.id);
  return (
    <div className="flex min-w-0 items-center gap-1">
      <DropdownMenu
        open={activeConfigPicker === "mode"}
        onOpenChange={(open) => onConfigPickerOpenChange("mode", open)}
      >
        <ControlHintTooltip
          title={intl.formatMessage({ id: "chat.toolbar.mode.label" })}
          shortcut={modeShortcutLabel}
          open={activeConfigPicker === "mode" ? false : undefined}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              data-testid={TID_CHAT_MODE_SELECT_TRIGGER}
              data-composer-collapse-priority="1"
              aria-label={intl.formatMessage({ id: "chat.toolbar.mode.label" })}
              className={cn(
                "group/mode h-7 gap-1 rounded-lg px-2 text-ui-base data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0",
                selected.id === "yolo" && "text-warning hover:text-warning",
              )}
            >
              <Icon className="size-4" />
              <span className="inline group-data-[composer-compact=true]/mode:hidden">
                {label(selected)}
              </span>
              <ChevronDownIcon className="size-3.5 group-data-[composer-compact=true]/mode:hidden" />
            </Button>
          </DropdownMenuTrigger>
        </ControlHintTooltip>
        <DropdownMenuContent
          side="top"
          sideOffset={4}
          className="w-64"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!isCoarseTouchDevice())
              document
                .querySelector<HTMLElement>(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`)
                ?.focus();
          }}
        >
          <DropdownMenuCheckboxItem
            checked={draftConfig?.planEnabled ?? false}
            onCheckedChange={(checked) => onSwitchMode(checked ? "plan" : "plan-off")}
            data-testid={testId(TID_CHAT_MODE_SELECT_ITEM, "plan")}
            className="min-h-13 items-start gap-3 py-2"
          >
            <LightbulbIcon className="mt-0.5 size-4.5 shrink-0" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span>{planLabel}</span>
              {planDescriptionId && (
                <span className="text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: planDescriptionId })}
                </span>
              )}
            </span>
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup value={selected.id} onValueChange={onSwitchMode}>
            {permissions.map((mode) => {
              const ModeIcon = resolveModeOptionIcon(mode.id);
              const descriptionId = getModeOptionDescriptionMessageId(displayProvider, {
                value: mode.id,
              });
              return (
                <DropdownMenuRadioItem
                  key={mode.id}
                  value={mode.id}
                  data-testid={testId(TID_CHAT_MODE_SELECT_ITEM, mode.id)}
                  className="min-h-13 items-start gap-3 py-2"
                >
                  <ModeIcon className="mt-0.5 size-4.5 shrink-0" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span>{label(mode)}</span>
                    {descriptionId && (
                      <span className="text-ui-sm text-foreground-subtle">
                        {intl.formatMessage({ id: descriptionId })}
                      </span>
                    )}
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {draftConfig?.planEnabled && (
        <span data-testid="v4-composer-plan-marker" className="flex items-center gap-1">
          <span
            role="separator"
            aria-orientation="vertical"
            className="h-3 w-px shrink-0 bg-border"
          />
          <ControlHintTooltip title={intl.formatMessage({ id: "chat.plan.removeMarker" })}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              data-composer-collapse-priority="2"
              onClick={() => onSwitchMode("plan-off")}
              aria-label={intl.formatMessage({ id: "chat.plan.removeMarker" })}
              className="group/plan h-7 gap-1 rounded-lg px-2 text-ui-base text-foreground-subtle hover:text-foreground-subtle data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0"
            >
              <LightbulbIcon className="size-4 group-hover/plan:hidden group-focus-visible/plan:hidden" />
              <XIcon className="hidden size-4 group-hover/plan:block group-focus-visible/plan:block" />
              <span className="inline group-data-[composer-compact=true]/plan:hidden">
                {intl.formatMessage({ id: "mode.plan" })}
              </span>
            </Button>
          </ControlHintTooltip>
        </span>
      )}
    </div>
  );
}
export const V4ComposerModeSwitch = memo(V4ComposerModeSwitchImpl);
