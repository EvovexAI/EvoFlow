/* eslint-disable max-lines -- 闲时任务整页集中维护创建/编辑/History 与 composer 项目、权限、模型工具条，拆分会割裂表单状态。 */
/* 闲时任务创建/编辑整页。composer 范式：页标题 +
   返回行 + 内联保持电脑运行开关 + Settings/History tab + 标题输入 + 大 composer 盒
   （textarea + 工具条：项目/权限｜模型/推理档位）。权限四档默认 build，模型走白名单。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModelSelectionView } from "@zcode/services";
import { completeNewModelSelection } from "@zcode/provider";
import { FolderOpen } from "lucide-react";
import {
  TID_OFFPEAK_EDIT_SUBMIT,
  TID_OFFPEAK_EDIT_VIEW,
  TID_OFFPEAK_FORM_INSTRUCTIONS,
  TID_OFFPEAK_FORM_TITLE,
  ZCODE_AGENT_PROVIDER,
  type ZCodeConfigOption,
  type ZCodeOffPeakTask,
  type ModelSelection,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Input } from "@/components/ui/input.js";
import { toast } from "@/components/ui/toast.js";
import {
  AUTOMATION_FORM_FIELD_CLASSNAME,
  AutomationChevronDownIcon,
  AutomationInfoIcon,
  AutomationSettingsHistoryTabs,
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
import { OffPeakEditActionsMenu } from "@/settings/OffPeakEditActionsMenu.js";
import { OffPeakHistoryTab } from "@/settings/OffPeakHistoryTab.js";
import { AutomationSwitchToggle } from "@/settings/AutomationSwitchToggle.js";
import { cn } from "@/components/lib/utils.js";
import { SETTINGS_FRAME_CONTENT_CLASSNAME } from "@/settings/SettingsPageParts.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import {
  AUTOMATION_DEFAULT_MODE,
  buildAutomationModeOption,
} from "@/settings/automationAgentConfigOptions.js";
import { ConfigSelect } from "@/chat-input-toolbar/display.js";
import { ChatEmptyWorkspacePreviewMenu, type ChatEmptyWorkspaceMenuTab } from "@/ChatEmptyState.js";
import { useAutomationProjectOptions } from "@/hooks/useAutomationProjectOptions.js";
import {
  OFF_PEAK_CREATE_TOOLTIP_CLASSNAME,
  resolveLocalizedOffPeakCreateTitle,
  shouldShowOffPeakModelSelectionIssue,
} from "@/settings/offPeakUiPresentation.js";
import { ModelConfigSelect, type ModelSelectGroup } from "@/ModelConfigSelect.js";
import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";

const MODEL_ITEM_NEVER_LOCKED = () => false;

function buildOffPeakSubmissionModelSelection(
  providerId: string,
  modelId: string,
  displayedReasoningLevel: string | undefined,
): ModelSelection {
  const reasoningLevel = displayedReasoningLevel?.trim();
  return {
    providerId,
    modelId,
    ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
  };
}

export interface OffPeakEditSubmit {
  title: string;
  prompt: string;
  permissionMode: string;
  modelSelection: ModelSelection;
  workspacePath: string;
  workspaceIdentity?: string;
}

interface OffPeakEditViewProps {
  editing: ZCodeOffPeakTask | null;
  /** 创建态预填（New task 页模板卡跳转）；编辑态忽略。 */
  initialDraft?: { title?: string; prompt?: string } | null;
  modelSelectionView: ModelSelectionView;
  defaultWorkspacePath: string;
  defaultWorkspaceIdentity?: string;
  saving: boolean;
  /** selected Coding Plan 或服务端 availability 不允许创建时禁用提交；编辑不受影响。 */
  createBlocked?: boolean;
  createBlockedTooltip?: string;
  onBack: () => void;
  onSubmit: (input: OffPeakEditSubmit) => Promise<boolean>;
  onOpenSession?: (params: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => void;
  onDelete?: (task: ZCodeOffPeakTask) => void;
  onDeleteHistory?: (task: ZCodeOffPeakTask) => void;
  onPause?: (task: ZCodeOffPeakTask) => void;
  onContinue?: (task: ZCodeOffPeakTask) => void;
  showToast?: typeof toast;
}

function workspaceBasename(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
}

export function OffPeakEditView({
  editing,
  initialDraft,
  modelSelectionView,
  defaultWorkspacePath,
  defaultWorkspaceIdentity,
  saving,
  createBlocked = false,
  createBlockedTooltip,
  onBack,
  onSubmit,
  onOpenSession,
  onDelete,
  onDeleteHistory,
  onPause,
  onContinue,
  showToast = toast,
}: OffPeakEditViewProps) {
  const { intl } = useZCodeIntl();
  const { settings, update: updateSettings } = useSettings();
  const confirmDialog = useConfirmDialog();
  const localWorkspaceOptions = useAutomationProjectOptions();
  const preferredLocalWorkspace =
    localWorkspaceOptions.find(
      (option) => !defaultWorkspaceIdentity && option.workspacePath === defaultWorkspacePath,
    ) ?? localWorkspaceOptions[0];

  const [tab, setTab] = useState<AutomationSettingsHistoryTab>("settings");
  const fullAccessWarningShownRef = useRef(false);
  const readOnlyRef = useRef(false);
  const titleTouchedRef = useRef(false);
  const thoughtTriggerRef = useRef<HTMLSpanElement | null>(null);
  const localizedDefaultCreateTitle = intl.formatMessage({
    id: "offPeak.create.defaultTitle",
  });
  const defaultCreateTitle = initialDraft?.title ?? localizedDefaultCreateTitle;
  const previousLocalizedDefaultTitleRef = useRef(localizedDefaultCreateTitle);
  const [title, setTitle] = useState(editing?.title ?? defaultCreateTitle);
  const [prompt, setPrompt] = useState(editing?.prompt ?? initialDraft?.prompt ?? "");
  const [mode, setMode] = useState<string>(editing?.permissionMode ?? AUTOMATION_DEFAULT_MODE);
  const offPeakProviderId =
    editing?.modelSelection?.providerId ?? modelSelectionView.providers[0]?.providerId ?? "";
  const allowedModels = useMemo(
    () =>
      modelSelectionView.providers
        .find((provider) => provider.providerId === offPeakProviderId)
        ?.models.map((candidate) => candidate.modelId) ?? [],
    [modelSelectionView, offPeakProviderId],
  );
  const initialModel = editing ? (editing.modelSelection?.modelId ?? "") : (allowedModels[0] ?? "");
  const [model, setModel] = useState(initialModel);
  const [thoughtLevel, setThoughtLevel] = useState<string | undefined>(() =>
    editing
      ? editing.modelSelection?.options?.reasoningLevel
      : completeNewModelSelection(modelSelectionView, {
          providerId: offPeakProviderId,
          modelId: initialModel,
        })?.options?.reasoningLevel,
  );
  const handleModelChange = useCallback(
    (value: string) => {
      setModel(value);
      setThoughtLevel(
        completeNewModelSelection(modelSelectionView, {
          providerId: offPeakProviderId,
          modelId: value,
        })?.options?.reasoningLevel,
      );
    },
    [modelSelectionView, offPeakProviderId],
  );
  const [createWorkspacePath, setCreateWorkspacePath] = useState(
    preferredLocalWorkspace?.workspacePath ?? "",
  );
  const modelSelectGroups = useMemo<ModelSelectGroup[]>(
    () =>
      allowedModels.length > 0
        ? [
            {
              key: "off-peak",
              label: "",
              items: allowedModels.map((allowedModel) => ({
                key: allowedModel,
                value: allowedModel,
                name: allowedModel,
              })),
            },
          ]
        : [],
    [allowedModels],
  );
  const workspaceMenuTabs = useMemo<ChatEmptyWorkspaceMenuTab[]>(
    () =>
      localWorkspaceOptions.map((option) => ({
        workspacePath: option.workspacePath,
        label: option.label,
      })),
    [localWorkspaceOptions],
  );
  useEffect(() => {
    if (editing || localWorkspaceOptions.length === 0) return;
    if (localWorkspaceOptions.some((option) => option.workspacePath === createWorkspacePath)) {
      return;
    }
    // 当前项目为远端或本地 tab 已关闭时，回落到仍可用的第一个本地项目。
    setCreateWorkspacePath(preferredLocalWorkspace?.workspacePath ?? "");
    initialRef.current.workspacePath = preferredLocalWorkspace?.workspacePath ?? "";
  }, [createWorkspacePath, editing, localWorkspaceOptions, preferredLocalWorkspace?.workspacePath]);
  // 闲时任务模型和 reasoning 档位只读取 Host 投影的 Built-in Config，
  // 避免 Renderer 按模型名重建第二份模型事实。
  const thoughtLevelOption = useMemo<ZCodeConfigOption | null>(
    () =>
      resolveModelThoughtOption({
        modelSelectionView,
        providerId: offPeakProviderId,
        modelId: model,
        currentValue: thoughtLevel,
        formatLevelName: (level) => intl.formatMessage({ id: `offPeak.thought.${level}` }),
      }),
    [intl, model, modelSelectionView, offPeakProviderId, thoughtLevel],
  );
  const effectiveThoughtLevel =
    typeof thoughtLevelOption?.currentValue === "string" &&
    thoughtLevelOption.currentValue.trim().length > 0
      ? thoughtLevelOption.currentValue
      : undefined;

  // 丢弃草稿守卫：
  // 初值快照固定于首渲染，返回时有未保存改动 → 确认弹窗。
  const initialRef = useRef({
    title: editing?.title ?? defaultCreateTitle,
    prompt: editing?.prompt ?? initialDraft?.prompt ?? "",
    mode: editing?.permissionMode ?? AUTOMATION_DEFAULT_MODE,
    model: initialModel,
    thoughtLevel: editing?.modelSelection?.options?.reasoningLevel,
    workspacePath: editing?.workspacePath ?? preferredLocalWorkspace?.workspacePath ?? "",
  });
  useEffect(() => {
    const nextTitle = resolveLocalizedOffPeakCreateTitle({
      currentTitle: title,
      hasInitialTitle: Boolean(initialDraft?.title),
      isEditing: Boolean(editing),
      nextDefaultTitle: localizedDefaultCreateTitle,
      previousDefaultTitle: previousLocalizedDefaultTitleRef.current,
      titleTouched: titleTouchedRef.current,
    });
    previousLocalizedDefaultTitleRef.current = localizedDefaultCreateTitle;
    if (nextTitle === title) return;
    setTitle(nextTitle);
    initialRef.current.title = nextTitle;
  }, [editing, initialDraft?.title, localizedDefaultCreateTitle, title]);
  const dirty =
    title !== initialRef.current.title ||
    prompt !== initialRef.current.prompt ||
    mode !== initialRef.current.mode ||
    model !== initialRef.current.model ||
    thoughtLevel !== initialRef.current.thoughtLevel ||
    (!editing && createWorkspacePath !== initialRef.current.workspacePath);
  const handleBack = useCallback(async () => {
    if (!dirty || readOnlyRef.current) {
      onBack();
      return;
    }
    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "offPeak.discard.title" }),
      description: intl.formatMessage({ id: "offPeak.discard.description" }),
      confirmLabel: intl.formatMessage({ id: "offPeak.discard.confirm" }),
      confirmVariant: "destructive",
      showCloseButton: true,
      showKeyboardHints: false,
      presentation: "automation-confirmation",
    });
    if (confirmed) onBack();
  }, [confirmDialog, dirty, intl, onBack]);

  const keepAwake = settings?.keepAwakeWhileRunning ?? false;
  // queued/paused 全字段可编辑；running 起锁定编辑、终态只读。
  const readOnly = Boolean(editing && editing.status !== "queued" && editing.status !== "paused");
  readOnlyRef.current = readOnly;
  const workspacePath = editing?.workspacePath ?? createWorkspacePath;
  const canSubmit =
    title.trim().length > 0 &&
    prompt.trim().length > 0 &&
    Boolean(workspacePath) &&
    Boolean(model) &&
    Boolean(effectiveThoughtLevel) &&
    !saving &&
    !createBlocked &&
    !readOnly;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    if (mode !== "yolo" && !fullAccessWarningShownRef.current) {
      fullAccessWarningShownRef.current = true;
      // 权限建议是非阻塞提示，使用 warning 会把中性建议渲染成橙色警告。
      // 第一次非 Full access 提交时用 Info 提示，但同一次点击继续创建，不引入二次确认。
      showToast(intl.formatMessage({ id: "offPeak.form.fullAccessHint" }), {
        durationMs: 8000,
        position: "top-center",
        variant: "info",
        dismissible: true,
        dismissLabel: intl.formatMessage({ id: "common.close" }),
      });
    }
    const ok = await onSubmit({
      title: title.trim(),
      prompt: prompt.trim(),
      permissionMode: mode,
      modelSelection: buildOffPeakSubmissionModelSelection(
        offPeakProviderId,
        model,
        effectiveThoughtLevel,
      ),
      workspacePath,
      ...(editing?.workspaceIdentity ? { workspaceIdentity: editing.workspaceIdentity } : {}),
    });
    if (ok) onBack();
  }, [
    canSubmit,
    editing,
    effectiveThoughtLevel,
    intl,
    mode,
    model,
    offPeakProviderId,
    onBack,
    onSubmit,
    prompt,
    title,
    workspacePath,
  ]);

  // 闲时与定时任务复用同一权限 option，并通过 provider 保持会话权限词表一致。
  const modeOption = useMemo(() => buildAutomationModeOption(mode), [mode]);
  const createSubmitButton = (
    <Button
      type="button"
      variant="default"
      size="lg"
      data-testid={TID_OFFPEAK_EDIT_SUBMIT}
      disabled={!canSubmit}
      onClick={() => void handleSubmit()}
    >
      {intl.formatMessage({ id: "offPeak.create.submit" })}
    </Button>
  );

  return (
    <div
      className={cn(SETTINGS_FRAME_CONTENT_CLASSNAME, "relative flex flex-col gap-6")}
      data-testid={TID_OFFPEAK_EDIT_VIEW}
    >
      <SettingsBreadcrumbReporter
        items={[
          {
            label: editing?.title ?? intl.formatMessage({ id: "offPeak.create.title" }),
          },
        ]}
        onSectionSelect={() => void handleBack()}
      />

      <div className="space-y-1.5">
        <h1 data-testid="offpeak-edit-title" className="text-ui-xl font-semibold text-foreground">
          {intl.formatMessage({
            id: editing ? "offPeak.edit.title" : "offPeak.create.title",
          })}
        </h1>
        <p data-testid="offpeak-edit-subtitle" className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({
            id: editing ? "offPeak.edit.subtitle" : "offPeak.create.subtitle",
          })}
        </p>
      </div>

      {editing?.modelSelectionIssue && shouldShowOffPeakModelSelectionIssue(editing.status) ? (
        <div
          role="status"
          className="flex items-center gap-2 rounded-[10px] border border-warning/40 bg-warning/10 px-3 py-2 text-ui-base text-warning"
        >
          <AutomationInfoIcon className="size-4 shrink-0" aria-hidden="true" />
          {intl.formatMessage({ id: "offPeak.modelSelection.repairRequired" })}
        </div>
      ) : null}

      <div className="flex min-w-0 flex-wrap items-center gap-4 sm:flex-nowrap">
        <div className="flex shrink-0 items-center gap-2">
          <AutomationSwitchToggle
            checked={keepAwake}
            ariaLabel={intl.formatMessage({
              id: "offPeak.form.keepAwakeLabel",
            })}
            onChange={(value) => void updateSettings({ keepAwakeWhileRunning: value })}
            color="blue"
            size="sm"
          />
          <span className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "offPeak.form.keepAwakeLabel" })}
          </span>
        </div>
      </div>

      {/* Settings/History 分段 tab（左）+ 创建按钮（右上）；与定时任务编辑页同款分段样式。 */}
      <div className="flex items-center justify-between">
        <AutomationSettingsHistoryTabs
          value={tab}
          settingsLabel={intl.formatMessage({ id: "offPeak.tab.settings" })}
          historyLabel={intl.formatMessage({ id: "offPeak.tab.history" })}
          onValueChange={setTab}
        />
        {tab !== "history" && !editing ? (
          createBlockedTooltip ? (
            <ControlHintTooltip
              title={createBlockedTooltip}
              side="top"
              align="center"
              className={OFF_PEAK_CREATE_TOOLTIP_CLASSNAME}
            >
              <span className="inline-flex">{createSubmitButton}</span>
            </ControlHintTooltip>
          ) : (
            createSubmitButton
          )
        ) : tab !== "history" && !readOnly ? (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              data-testid={TID_OFFPEAK_EDIT_SUBMIT}
              disabled={!canSubmit}
              onClick={() => void handleSubmit()}
              className="inline-flex h-8 items-center rounded-lg border-0 bg-white px-3 text-ui-base font-medium text-black shadow-none outline-none transition-colors hover:bg-white/90 focus-visible:ring-0 disabled:pointer-events-none disabled:opacity-40"
            >
              {intl.formatMessage({ id: "offPeak.edit.save" })}
            </button>
            {editing ? (
              <OffPeakEditActionsMenu
                task={editing}
                {...(onPause ? { onPause } : {})}
                {...(onContinue ? { onContinue } : {})}
                {...(onDelete ? { onDelete } : {})}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      {editing && tab === "settings" ? (
        <div className="flex min-h-11 items-center gap-3 rounded-[10px] bg-surface px-3 py-3 text-ui-base leading-5 text-foreground-subtle sm:py-0">
          <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
            <AutomationInfoIcon className="size-4" aria-hidden="true" />
          </span>
          {intl.formatMessage({ id: "offPeak.keepAwakeBanner" })}
        </div>
      ) : null}

      {tab === "history" ? (
        <OffPeakHistoryTab
          task={editing}
          {...(onOpenSession
            ? {
                onOpenSession: (task: ZCodeOffPeakTask) =>
                  task.sessionId
                    ? onOpenSession({
                        sessionId: task.sessionId,
                        workspacePath: task.workspacePath,
                        ...(task.workspaceIdentity
                          ? { workspaceIdentity: task.workspaceIdentity }
                          : {}),
                      })
                    : undefined,
              }
            : {})}
          {...(onDeleteHistory ? { onDelete: onDeleteHistory } : {})}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {editing?.sessionId ? (
            // 会话内创建的任务绑定并运行在创建它的会话里；露出会话标题与跳转，并提示 Stop 即取消。
            <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
              <div className="flex min-w-0 items-center gap-2 text-ui-base leading-5">
                <span className="min-w-0 truncate text-foreground">
                  {intl.formatMessage(
                    { id: "offPeak.boundSession.label" },
                    { title: editing.sessionTitle ?? editing.sessionId },
                  )}
                </span>
                {onOpenSession ? (
                  <button
                    type="button"
                    className="shrink-0 text-foreground-subtle underline-offset-2 hover:underline"
                    onClick={() =>
                      onOpenSession({
                        sessionId: editing.sessionId!,
                        workspacePath: editing.workspacePath,
                        ...(editing.workspaceIdentity
                          ? { workspaceIdentity: editing.workspaceIdentity }
                          : {}),
                      })
                    }
                  >
                    {intl.formatMessage({ id: "offPeak.goToSession" })}
                  </button>
                ) : null}
              </div>
              <span className="text-ui-base leading-5 text-foreground-subtle">
                {intl.formatMessage({ id: "offPeak.boundSession.hint" })}
              </span>
            </div>
          ) : null}
          {/* 任务标题 */}
          <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
            <span className="text-ui-base font-normal leading-5 text-foreground-subtle">
              {intl.formatMessage({ id: "offPeak.form.titleLabel" })}
            </span>
            {/* 闲时任务标题曾用透明边框覆盖共享 Input 状态，导致与定时任务及 Instructions 描边不一致。 */}
            <Input
              value={title}
              disabled={readOnly}
              data-testid={TID_OFFPEAK_FORM_TITLE}
              placeholder={intl.formatMessage({
                id: "offPeak.form.titlePlaceholder",
              })}
              onChange={(event) => {
                titleTouchedRef.current = true;
                setTitle(event.target.value);
              }}
              className={cn(
                "h-9 rounded-lg bg-card px-2 text-foreground hover:bg-surface-hover focus-visible:bg-card",
                AUTOMATION_FORM_INPUT_TYPOGRAPHY_CLASSNAME,
              )}
            />
          </div>

          {/* 任务指令 = composer 盒：textarea + 底部工具条（项目 / 权限 | 模型） */}
          <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
            <span className="text-ui-base font-normal leading-5 text-foreground-subtle">
              {intl.formatMessage({ id: "offPeak.form.instructionsLabel" })}
            </span>
            <AutomationInstructionsComposer>
              <AutomationInstructionsTextarea
                data-testid={TID_OFFPEAK_FORM_INSTRUCTIONS}
                value={prompt}
                disabled={readOnly}
                placeholder={intl.formatMessage({
                  id: "offPeak.form.instructionsPlaceholder",
                })}
                onChange={(event) => setPrompt(event.target.value)}
              />
              <AutomationInstructionsToolbar>
                <div className="flex min-w-0 flex-wrap items-center gap-0">
                  {/* 项目：创建态仅当前窗口已打开的本地项目；编辑态锁定原项目。 */}
                  {/* UI 字号会随设置缩放，固定 18px 行高会在大字号下挤压项目文案。*/}
                  {editing ? (
                    <span className="flex h-7 min-w-0 items-center gap-1 rounded-full px-2 text-ui-base font-normal leading-snug text-foreground-subtle">
                      <FolderOpen className="size-4 shrink-0" aria-hidden="true" />
                      <span className="max-w-40 truncate" title={workspacePath}>
                        {workspaceBasename(workspacePath)}
                      </span>
                    </span>
                  ) : workspaceMenuTabs.length > 0 ? (
                    // 仅 Automations 调用收敛到共享 trigger；普通会话 workspace chip 不受影响。
                    <ChatEmptyWorkspacePreviewMenu
                      workspacePath={workspacePath}
                      workspaceTabs={workspaceMenuTabs}
                      allowConversationWorkspaceSelection={false}
                      onSelectWorkspace={(workspace) =>
                        setCreateWorkspacePath(workspace.workspacePath)
                      }
                      onSelectConversationWorkspace={() => {}}
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
                      triggerIndicator={
                        <span className="text-foreground-subtle">
                          <AutomationChevronDownIcon size={14} containerSize={20} />
                        </span>
                      }
                    />
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled
                      className={cn(
                        AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
                        "gap-1 px-2 text-foreground-subtlest",
                      )}
                    >
                      <FolderOpen className="size-4" aria-hidden="true" />
                      {intl.formatMessage({
                        id: "automations.form.project.localRequired",
                      })}
                    </Button>
                  )}
                  {/* 闲时权限菜单曾单独渲染，缺少首页的模式图标和标准选中态。
                      复用 ConfigSelect，避免两处样式再次分叉。 */}
                  <ConfigSelect
                    option={modeOption}
                    provider={ZCODE_AGENT_PROVIDER}
                    onValueChange={setMode}
                    disabled={readOnly}
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
                    restoreFocusSelector={null}
                  />
                </div>
                {/* 右侧组曾允许自身和子 trigger 收缩，模型与推理内容会被压成纵向多行。
                    小屏时整组占据下一行，组内始终保持单行。 */}
                <div className="flex w-full shrink-0 flex-nowrap items-center justify-end gap-0 sm:w-auto">
                  {/* 模型仍由闲时白名单驱动，只复用 New Task 的纯展示选择器。 */}
                  <ModelConfigSelect
                    modelGroups={modelSelectGroups}
                    normalizedValue={model}
                    triggerLabel={model || intl.formatMessage({ id: "offPeak.form.modelLabel" })}
                    showProviderLevel={false}
                    showManageModelsAction={false}
                    lockReasonMessage=""
                    isItemLocked={MODEL_ITEM_NEVER_LOCKED}
                    onValueChange={handleModelChange}
                    disabled={readOnly || allowedModels.length === 0}
                    tooltipTitle={intl.formatMessage({
                      id: "offPeak.form.modelLabel",
                    })}
                    contentSide="top"
                    contentAlign="end"
                    focusSelectorOnClose={null}
                    labelVisibilityClassName="inline-flex min-w-0"
                    triggerClassName={cn(
                      AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
                      "w-fit max-w-72 min-w-0 shrink justify-between px-2",
                    )}
                    triggerLabelClassName="inline-flex min-w-0 truncate text-left"
                  />
                  {/* 推理档位：仅推理模型显示；缺省=workspace 默认 */}
                  {thoughtLevelOption ? (
                    <ThoughtLevelCycleControl
                      intl={intl}
                      option={thoughtLevelOption}
                      provider={ZCODE_AGENT_PROVIDER}
                      disabled={readOnly}
                      triggerRef={thoughtTriggerRef}
                      triggerClassName={AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME}
                      interactionMode="select"
                      restoreFocusSelector={null}
                      labelVisibilityClassName="inline-flex min-w-0"
                      onValueChange={setThoughtLevel}
                    />
                  ) : null}
                </div>
              </AutomationInstructionsToolbar>
            </AutomationInstructionsComposer>
            {/* 该文案是运行机制说明而非风险告警，橙色三角会错误强化语义；
                与复合输入额外拉开 4px，避免辅助说明贴近输入框边界。 */}
            <div className="mt-1 flex items-start gap-1.5 text-ui-base leading-5 text-foreground-subtle">
              <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
                <AutomationInfoIcon className="size-4" />
              </span>
              {intl.formatMessage({ id: "offPeak.form.permissionWarning" })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
