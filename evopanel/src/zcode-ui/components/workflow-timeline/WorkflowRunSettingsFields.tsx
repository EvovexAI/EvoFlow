// ============================================================
// 「配置」弹层的两个字段
// ============================================================
// 从 WorkflowRunSettingsPopover.tsx 拆出：那边管表单状态、命令与后果句，这里只画两个受控字段——
// 子代理模型（composer 的模型菜单 + 思考档）与「同时运行上限」步进器。props 全是烹熟的值。

import { useMemo, useRef, useState } from "react";
import { MinusIcon, PlusIcon } from "lucide-react";
import { ZCODE_AGENT_PROVIDER, type ZCodeConfigOption } from "@zcode/shared";
import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import { cn } from "@/components/lib/utils.js";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  MODEL_CONFIG_SELECT_BADGE_CLASS_NAME,
  ModelConfigSelect,
  type ModelSelectGroup,
  type ModelSelectGroupItem,
} from "@/ModelConfigSelect.js";
import { clampWorkflowRunSettingsBound } from "./workflowRunSettings.js";

const MODEL_ITEM_NEVER_LOCKED = () => false;

/** 字段标签：12px、次要色，控件上方 4px。 */
function FieldLabel({ children }: { children: string }) {
  return <div className="text-ui-sm text-foreground-subtle">{children}</div>;
}

/**
 * 子代理模型：composer 的同一份模型菜单，「会话模型」排第一；所选模型有思考档时，触发器旁边是
 * 设置页子代理那一格用的同一个思考档控件。清单为空时整格换成一句话（上限仍可调）。
 */
export function WorkflowRunSettingsModelField({
  badge,
  disabled,
  groups,
  leadingItem,
  noCatalog,
  onLevelChange,
  onValueChange,
  thoughtOption,
  triggerLabel,
  value,
}: {
  /** 触发器里的徽标：「会话模型」或「不可用」；缺席即无。 */
  badge?: { text: string; tone: "subtle" | "warning" };
  disabled: boolean;
  groups: readonly ModelSelectGroup[];
  leadingItem: ModelSelectGroupItem;
  /** 当前 agent 没有可选模型：整格退成一句话。 */
  noCatalog: boolean;
  onLevelChange: (level: string) => void;
  onValueChange: (value: string) => void;
  /** 所选模型的思考档；缺席即不画思考档控件。 */
  thoughtOption: ZCodeConfigOption | null;
  triggerLabel: string;
  value: string;
}) {
  const { intl } = useZCodeIntl();
  const levelTriggerRef = useRef<HTMLSpanElement | null>(null);
  const [levelOpen, setLevelOpen] = useState(false);
  const label = intl.formatMessage({ id: "chat.toolCall.workflow.run.settings.model" });
  // ModelConfigSelect 是 memo 组件：内联数组每次渲染都是新引用，会让它的 memo 形同虚设。
  const leadingItems = useMemo(() => [leadingItem], [leadingItem]);
  if (noCatalog) {
    return (
      <div className="flex flex-col gap-1" data-testid="workflow-run-settings-model">
        <FieldLabel>{label}</FieldLabel>
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "chat.toolCall.workflow.run.settings.model.noCatalog" })}
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1" data-testid="workflow-run-settings-model">
      <FieldLabel>{label}</FieldLabel>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="inline-flex min-w-0 flex-1" data-model-current-value={value}>
          <ModelConfigSelect
            modelGroups={groups}
            normalizedValue={value}
            triggerLabel={triggerLabel}
            showManageModelsAction={false}
            lockReasonMessage=""
            isItemLocked={MODEL_ITEM_NEVER_LOCKED}
            onValueChange={onValueChange}
            leadingItems={leadingItems}
            contentSide="bottom"
            contentAlign="start"
            focusSelectorOnClose={null}
            labelVisibilityClassName="inline-flex min-w-0"
            triggerClassName="h-7 w-full min-w-0 justify-between rounded-md border border-input-border bg-input px-2 text-foreground hover:border-input-border-hover hover:bg-input focus-visible:border-input-border-focused focus-visible:bg-input-focused"
            triggerLabelClassName="inline-flex min-w-0 flex-1 truncate text-left"
            triggerTestId="workflow-run-settings-model-trigger"
            {...(badge === undefined
              ? {}
              : {
                  triggerBadge: (
                    <span
                      className={cn(
                        MODEL_CONFIG_SELECT_BADGE_CLASS_NAME,
                        badge.tone === "warning" && "text-warning",
                      )}
                      data-testid="workflow-run-settings-model-badge"
                    >
                      {badge.text}
                    </span>
                  ),
                })}
            disabled={disabled}
          />
        </span>
        {thoughtOption === null ? null : (
          <ThoughtLevelCycleControl
            intl={intl}
            option={thoughtOption}
            provider={ZCODE_AGENT_PROVIDER}
            onCurrentValueCommit={onLevelChange}
            showInvalidCurrentValue
            disabled={disabled}
            open={disabled ? false : levelOpen}
            onOpenChange={setLevelOpen}
            triggerRef={levelTriggerRef}
            restoreFocusSelector={null}
            labelVisibilityClassName="inline-flex"
            triggerClassName="h-7 shrink-0 rounded-md border border-input-border bg-input px-2 text-foreground hover:border-input-border-hover hover:bg-input"
            onValueChange={onLevelChange}
          />
        )}
      </div>
    </div>
  );
}

/**
 * 「同时运行上限」步进器：减、等宽数字、加，从 1 到本机天花板。天花板本身即「本 run 没有自己的界」，
 * 提示改写成「= 本机上限」。天花板未知（老 CLI）时没有上限、没有提示，数字可以直接敲。
 */
export function WorkflowRunSettingsBoundField({
  bound,
  ceiling,
  disabled,
  onChange,
}: {
  bound: number | null;
  ceiling: number | undefined;
  disabled: boolean;
  onChange: (bound: number) => void;
}) {
  const { intl } = useZCodeIntl();
  const hint =
    ceiling === undefined
      ? undefined
      : bound !== null && bound >= ceiling
        ? intl.formatMessage({ id: "chat.toolCall.workflow.run.settings.limit.atCeiling" })
        : intl.formatMessage(
            { id: "chat.toolCall.workflow.run.settings.limit.ceiling" },
            { n: ceiling },
          );
  return (
    <div className="flex flex-col gap-1" data-testid="workflow-run-settings-bound">
      <FieldLabel>
        {intl.formatMessage({ id: "chat.toolCall.workflow.run.settings.limit" })}
      </FieldLabel>
      <div className="flex items-center gap-2">
        <InputGroup className="w-auto shrink-0">
          <InputGroupAddon align="inline-start">
            <InputGroupButton
              aria-label={intl.formatMessage({
                id: "chat.toolCall.workflow.run.settings.limit.decrease",
              })}
              data-testid="workflow-run-settings-bound-decrease"
              disabled={disabled || bound === null || bound <= 1}
              onClick={() =>
                bound !== null && onChange(clampWorkflowRunSettingsBound(bound - 1, ceiling))
              }
              size="icon-xs"
            >
              <MinusIcon className="size-3.5" />
            </InputGroupButton>
          </InputGroupAddon>
          <InputGroupInput
            aria-label={intl.formatMessage({ id: "chat.toolCall.workflow.run.settings.limit" })}
            className="h-7 w-9 px-0 text-center font-mono tabular-nums"
            data-testid="workflow-run-settings-bound-value"
            disabled={disabled}
            inputMode="numeric"
            onChange={(event) => {
              const parsed = Number.parseInt(event.target.value, 10);
              if (Number.isFinite(parsed)) onChange(clampWorkflowRunSettingsBound(parsed, ceiling));
            }}
            placeholder="—"
            value={bound === null ? "" : String(bound)}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              aria-label={intl.formatMessage({
                id: "chat.toolCall.workflow.run.settings.limit.increase",
              })}
              data-testid="workflow-run-settings-bound-increase"
              disabled={disabled || bound === null || (ceiling !== undefined && bound >= ceiling)}
              onClick={() =>
                bound !== null && onChange(clampWorkflowRunSettingsBound(bound + 1, ceiling))
              }
              size="icon-xs"
            >
              <PlusIcon className="size-3.5" />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        {hint === undefined ? null : (
          <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">{hint}</span>
        )}
      </div>
    </div>
  );
}
