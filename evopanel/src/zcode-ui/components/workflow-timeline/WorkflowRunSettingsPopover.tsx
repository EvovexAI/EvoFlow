// ============================================================
// 「配置」弹层
// ============================================================
// run 卡的 Configure 钮、详情页的 Configure 钮与详情页摘要行的模型段打开同一个弹层：两个字段、
// 一句后果、Apply。Apply 就是一次 GUI 修订——`amendWorkflowRunSettings` 命令，不经模型轮、不开
// 确认窗；那一下点击就是
// 同意，与中枢的「运行」同一条规则。
//
// 一个弹层、多个触发点：锚点是**打开它的那个元素**（虚拟锚），所以详情页上两个入口各自对齐。
// 表单只在打开时挂载——模型清单的订阅也随之只活在打开期间。

import { useCallback, useMemo, useRef, useState, type RefObject } from "react";
import { completeNewModelSelection } from "@zcode/provider";
import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import type { CommandAck, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverAnchor, PopoverContent, PopoverTitle } from "@/components/ui/popover.js";
import { Spinner } from "@/components/ui/spinner.js";
import { useModelSelectionView } from "@/hooks/useModelSelectionView.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { logger } from "@/logger.js";
import { formatProviderModelLabel } from "@/v4/composer/modelTriggerDisplay.js";
import { describeWorkflowSubagentModel } from "./subagent-model-label.js";
import {
  WorkflowRunSettingsBoundField,
  WorkflowRunSettingsModelField,
} from "./WorkflowRunSettingsFields.js";
import {
  describeWorkflowRunSettingsRejection,
  initialWorkflowRunSettingsDraft,
  workflowRunSettingsCeiling,
  workflowRunSettingsChange,
  workflowRunSettingsConsequenceId,
  workflowRunSettingsModelCanonical,
  workflowRunSettingsRejectionDetail,
  workflowRunSettingsRejectionMessageId,
  type WorkflowRunSettingsChange,
  type WorkflowRunSettingsDraft,
  type WorkflowRunSettingsRejection,
} from "./workflowRunSettings.js";

/** 菜单里「会话模型」那一项的值：落在 encodeCustomModelValue 的值域之外，不会与真实模型相撞。 */
const SESSION_MODEL_VALUE = "workflow-settings:session-model";

/** 宿主给弹层的一切：模型清单的作用域、会话模型、以及发命令的那一下。 */
export interface WorkflowRunSettingsHost {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** 会话当前模型（首项与触发器用它的名字）；缺席时首项只写「会话模型」。 */
  sessionModel?: { providerId: string; modelId: string };
  /** 发 `amendWorkflowRunSettings`（宿主补 workId 与会话），回 ACK。 */
  apply: (change: WorkflowRunSettingsChange) => Promise<CommandAck>;
}

/** 被接受后新 run 的两把钥匙（ACK.result）。 */
export interface WorkflowRunSettingsAccepted {
  runId: string;
  toolCallId: string;
}

/** 触发点的开关与锚点：点同一个触发点再点一次是关，点另一个是移过去重开。 */
export function useWorkflowRunSettingsPopoverState() {
  const anchorRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const toggleFrom = useCallback(
    (element: HTMLElement) => {
      if (open && anchorRef.current === element) {
        setOpen(false);
        return;
      }
      anchorRef.current = element;
      setOpen(true);
    },
    [open],
  );
  return { anchorRef, open, setOpen, toggleFrom };
}

export function WorkflowRunSettingsPopover({
  anchorRef,
  host,
  onAccepted,
  onOpenChange,
  open,
  run,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  host: WorkflowRunSettingsHost;
  onAccepted?: (accepted: WorkflowRunSettingsAccepted) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  run: WorkflowRunState;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={anchorRef as RefObject<HTMLElement>} />
      <PopoverContent
        align="end"
        className="gap-2.5"
        data-testid="workflow-run-settings-popover"
        // 弹层 portal 在外，但 React 事件仍沿组件树冒泡：不拦的话，点弹层空白处会让 run 卡以为
        // 点了卡身而收起（卡身整张是折叠开关），数字框里的回车也会被卡当成 Enter 切换。
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") event.stopPropagation();
        }}
        // 点打开它的那个触发点本身不算「点在外面」：否则先被关掉、再被那一下点击重新打开。
        onInteractOutside={(event) => {
          const target = event.target;
          if (target instanceof Node && anchorRef.current?.contains(target)) event.preventDefault();
        }}
      >
        <WorkflowRunSettingsForm
          host={host}
          onClose={() => onOpenChange(false)}
          run={run}
          {...(onAccepted === undefined ? {} : { onAccepted })}
        />
      </PopoverContent>
    </Popover>
  );
}

function WorkflowRunSettingsForm({
  host,
  onAccepted,
  onClose,
  run,
}: {
  host: WorkflowRunSettingsHost;
  onAccepted?: (accepted: WorkflowRunSettingsAccepted) => void;
  onClose: () => void;
  run: WorkflowRunState;
}) {
  const { intl } = useZCodeIntl();
  const format = useCallback(
    (id: string, values?: Record<string, string | number>) => intl.formatMessage({ id }, values),
    [intl],
  );
  const modelRead = useModelSelectionView(
    host.workspacePath,
    host.remoteSessionId,
    host.workspaceIdentity,
  );
  const view = modelRead.state.status === "ready" ? modelRead.state.view : null;
  const groups = useMemo(
    () =>
      view === null
        ? []
        : buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, view, {
            apiKeyLabel: format("settings.modelProvider.apiKey"),
            apiKeyBadgeLabel: format("settings.modelProvider.connectionMode.apiKeyBadge"),
            codingPlanLabel: format("settings.modelProvider.connectionMode.codingPlan"),
            codingPlanBadgeLabel: format("settings.modelProvider.connectionMode.codingPlanBadge"),
            startPlanLabel: format("settings.modelProvider.connectionMode.startPlan"),
            startPlanBadgeLabel: format("settings.modelProvider.connectionMode.startPlanBadge"),
            teamPlanBadgeLabel: format("settings.modelProvider.connectionMode.teamPlanBadge"),
            teamPlanFallbackLabel: format("settings.modelProvider.connectionMode.teamPlan"),
          }),
    [format, view],
  );
  const providerName = useCallback(
    (providerId: string) =>
      view?.providers.find((provider) => provider.providerId === providerId)?.providerName ??
      undefined,
    [view],
  );

  // 起点在打开那一刻定下：run 状态在弹层开着时变了，也不该把用户正在改的表单拽回去。
  const [initial] = useState(() => initialWorkflowRunSettingsDraft(run));
  const [draft, setDraft] = useState<WorkflowRunSettingsDraft>(initial);
  const [pending, setPending] = useState(false);
  const [rejection, setRejection] = useState<WorkflowRunSettingsRejection | undefined>(undefined);
  const ceiling = workflowRunSettingsCeiling(run);
  const change = workflowRunSettingsChange(initial, draft, ceiling);
  const updateDraft = (next: WorkflowRunSettingsDraft) => {
    setDraft(next);
    setRejection(undefined);
  };

  const sessionModelName =
    host.sessionModel === undefined
      ? format("chat.toolCall.workflow.run.settings.model.sessionFallback")
      : formatProviderModelLabel(
          host.sessionModel.providerId,
          providerName(host.sessionModel.providerId),
          host.sessionModel.modelId,
        );
  const sessionBadge = format("chat.toolCall.workflow.run.settings.model.session");
  // 两个字段都是字符串，所以这一项只在文案真变了时换引用；下游的模型选择器是 memo 组件。
  const sessionModelItem = useMemo(
    () => ({
      key: "workflow-settings:session-model",
      value: SESSION_MODEL_VALUE,
      name: sessionModelName,
      badgeLabel: sessionBadge,
    }),
    [sessionModelName, sessionBadge],
  );
  const draftModel = draft.model;
  const modelValue =
    draftModel.kind === "session"
      ? SESSION_MODEL_VALUE
      : encodeCustomModelValue(draftModel.providerId, draftModel.modelId);
  const listed = groups.some((group) => group.items.some((item) => item.value === modelValue));
  // 清单读好了、却找不到这个模型：它已被删或停用。Apply 等用户换一个——沿用它只会让 agent 回
  // model_unavailable（同工具「沿用的模型已不可用」那条失败，在点下去之前就说出来）。
  const unavailable = draftModel.kind === "model" && view !== null && groups.length > 0 && !listed;
  const canonical = workflowRunSettingsModelCanonical(draftModel);
  const triggerLabel =
    draftModel.kind === "session" || canonical === undefined
      ? sessionModelName
      : describeWorkflowSubagentModel(canonical, {
          formatMessage: intl.formatMessage.bind(intl),
          providerName,
        }).name;
  const thoughtOption =
    draftModel.kind === "model" && view !== null && !unavailable
      ? resolveModelThoughtOption({
          modelSelectionView: view,
          providerId: draftModel.providerId,
          modelId: draftModel.modelId,
          ...(draftModel.level === undefined ? {} : { currentValue: draftModel.level }),
        })
      : null;

  const handleModelChange = (value: string) => {
    if (value === SESSION_MODEL_VALUE) {
      updateDraft({ ...draft, model: { kind: "session" } });
      return;
    }
    const picked = parseModelPickerValue(value);
    const same =
      draftModel.kind === "model" &&
      draftModel.providerId === picked.providerId &&
      draftModel.modelId === picked.modelId;
    // 换模型即取它在注册表里的默认思考档（与设置页子代理那一格同一条规则）；同一个模型保留当前档。
    const level = same
      ? draftModel.level
      : view === null
        ? undefined
        : completeNewModelSelection(view, picked)?.options?.reasoningLevel;
    updateDraft({
      ...draft,
      model: {
        kind: "model",
        providerId: picked.providerId,
        modelId: picked.modelId,
        ...(level === undefined ? {} : { level }),
      },
    });
  };

  const handleApply = () => {
    if (change === undefined) return;
    setPending(true);
    setRejection(undefined);
    host.apply(change).then(
      (ack) => {
        const next = describeWorkflowRunSettingsRejection(ack);
        if (next !== undefined) {
          logger.warn("[workflow-run] 调整设置被拒绝", {
            reasonCode: ack.reasonCode,
            runId: run.runId,
            status: ack.status,
          });
          setRejection(next);
          setPending(false);
          return;
        }
        const result = ack.result;
        if (result?.type === "amendWorkflowRunSettings") {
          onAccepted?.({ runId: result.runId, toolCallId: result.toolCallId });
        }
        onClose();
      },
      (error: unknown) => {
        logger.warn("[workflow-run] 调整设置命令失败", { runId: run.runId, error: String(error) });
        setRejection({
          reason: "generic",
          code: error instanceof Error ? error.message : String(error),
        });
        setPending(false);
      },
    );
  };

  const rejectionDetail =
    rejection === undefined ? undefined : workflowRunSettingsRejectionDetail(rejection);
  return (
    <>
      <PopoverTitle>{format("chat.toolCall.workflow.run.settings.title")}</PopoverTitle>
      <WorkflowRunSettingsModelField
        disabled={pending || view === null}
        groups={groups}
        leadingItem={sessionModelItem}
        noCatalog={view !== null && groups.length === 0}
        onLevelChange={(level) => {
          if (draftModel.kind !== "model" || level === draftModel.level) return;
          updateDraft({ ...draft, model: { ...draftModel, level } });
        }}
        onValueChange={handleModelChange}
        thoughtOption={thoughtOption}
        triggerLabel={triggerLabel}
        value={modelValue}
        {...(draftModel.kind === "session"
          ? { badge: { text: sessionBadge, tone: "subtle" as const } }
          : unavailable
            ? {
                badge: {
                  text: format("chat.toolCall.workflow.run.settings.model.unavailable"),
                  tone: "warning" as const,
                },
              }
            : {})}
      />
      <WorkflowRunSettingsBoundField
        bound={draft.bound}
        ceiling={ceiling}
        disabled={pending}
        onChange={(bound) => updateDraft({ ...draft, bound })}
      />
      <p
        className="text-ui-sm text-foreground-subtle"
        data-testid="workflow-run-settings-consequence"
      >
        {format(workflowRunSettingsConsequenceId(run.status, change))}
      </p>
      {rejection === undefined ? null : (
        <div
          className="text-ui-xs text-warning"
          data-testid="workflow-run-settings-rejection"
          role="status"
        >
          <span>
            {format(workflowRunSettingsRejectionMessageId(rejection), {
              code: rejection.code,
              message: rejection.message ?? rejection.code,
            })}
          </span>
          {rejectionDetail === undefined ? null : (
            <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-ui-xs text-foreground-subtle">
              {rejectionDetail}
            </pre>
          )}
        </div>
      )}
      <div className="flex justify-end">
        <Button
          data-testid="workflow-run-settings-apply"
          disabled={change === undefined || pending || unavailable}
          onClick={handleApply}
          size="default"
          type="button"
          variant="default"
        >
          {pending ? <Spinner className="size-3.5" /> : null}
          {format(
            pending
              ? "chat.toolCall.workflow.run.settings.applying"
              : "chat.toolCall.workflow.run.settings.apply",
          )}
        </Button>
      </div>
    </>
  );
}
