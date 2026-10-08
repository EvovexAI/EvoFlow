import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useOnboardingRecordService } from "@/hooks/useOnboardingRecordService.js";
import {
  advanceRecommendedPromptPane,
  getRecommendedPromptsForPane,
  getRecommendedPromptsRevision,
  registerRecommendedPromptPane,
  subscribeRecommendedPrompts,
  unregisterRecommendedPromptPane,
} from "@/v4/featureSuggestedPromptRotation.js";
/* oxlint-disable eslint(max-lines) -- 推荐 Prompt 同时收口 latest-wins、取消、可信解析、操作反馈和 Composer 收尾，拆分会打散这条状态机。 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { AutomationsNavigationTab } from "@/lib/taskNavigationHistory.js";
import { reportPromptTemplateClick } from "@/lib/promptTemplateTelemetry.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  ConversationDraftSuggestedPrompts,
  type DraftSuggestedPromptItem,
} from "@/v4/ConversationDraftSuggestedPrompts.js";
import { buildDraftSuggestedPluginMention } from "@/v4/draftSuggestedPromptPrefill.js";
import { resolveDraftSuggestedPromptText } from "@/v4/draftSuggestedPromptItems.js";
import {
  DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS,
  DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS_OFFPEAK,
} from "@/v4/draftSuggestedPromptItems.js";
import {
  resolveDraftSuggestedPluginFlowStage,
  type ConversationDraftSuggestedPromptsContainerProps,
  type DraftSuggestedPluginFlow,
  type DraftSuggestedPluginOperation,
  trackDraftSuggestedPluginOperation,
} from "@/v4/ConversationDraftSuggestedPluginFlow.js";
import { useDraftSuggestedPromptItems } from "@/v4/useDraftSuggestedPromptItems.js";
import { useDraftSuggestedPluginActionPopover } from "@/v4/useDraftSuggestedPluginActionPopover.js";
import { getComposerDraftRevision } from "@/v4/composer/composerDraftRevision.js";
import { useComposerTextInsertApplied } from "@/v4/useComposerTextInsertApplied.js";

type PluginMutationKind = "install" | "enable";

const INSTALL_OPERATION_TIMEOUT_MS = 10_000;

type Props = ConversationDraftSuggestedPromptsContainerProps & {
  proactive?: boolean;
  onOpenAutomations?: (automationTab?: AutomationsNavigationTab) => void;
};

let draftSuggestedPluginOperationSequence = 0;

function createDraftSuggestedPluginOperation(
  requestVersion: number,
): DraftSuggestedPluginOperation {
  return {
    operationId:
      globalThis.crypto?.randomUUID?.() ??
      `suggested-${Date.now()}-${requestVersion}-${++draftSuggestedPluginOperationSequence}`,
    abort: new AbortController(),
  };
}

function toPluginMutationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ConversationDraftSuggestedPromptsContainer({
  className,
  proactive = false,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  onOpenAutomations,
  isDesktop = false,
}: Props) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const isOfficeMode = useIsOfficeMode();
  const { update } = useSettings();
  const onboardingRecordService = useOnboardingRecordService();
  const recommendationPaneId = useId();
  const recommendationMode = isOfficeMode ? "office" : "coding";
  const recommendationRevision = useSyncExternalStore(
    subscribeRecommendedPrompts,
    getRecommendedPromptsRevision,
  );
  useEffect(() => {
    if (!proactive) return;
    registerRecommendedPromptPane(recommendationPaneId, recommendationMode);
    return () => unregisterRecommendedPromptPane(recommendationPaneId);
  }, [proactive, recommendationMode, recommendationPaneId]);
  const recommendedItems = useMemo(
    () => getRecommendedPromptsForPane(recommendationPaneId, recommendationMode),
    [recommendationMode, recommendationPaneId, recommendationRevision],
  );
  const [closing, setClosing] = useState(false);
  const closeRecommendations = async () => {
    setClosing(true);
    try {
      // 关闭按钮与引导、设置页共用持久化设置，避免另一份本地开关重新显示推荐。
      await update({ proactiveSuggestionsEnabled: false });
      // 手动修改反向回写 record，换号同步时不会把已关闭的推荐复活；失败不阻塞关闭流程。
      await onboardingRecordService
        ?.updateRecordPreferences({ proactiveSuggestionsEnabled: false })
        .catch((cause: unknown) => {
          logger.warn("[v4-suggested-prompts] 回写引导记录失败", { error: String(cause) });
        });
    } catch (error) {
      logger.warn("[v4-suggested-prompts] 关闭推荐失败", { error: String(error) });
      toast(intl.formatMessage({ id: "chat.officeSuggestions.closeError" }));
    } finally {
      setClosing(false);
    }
  };
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
  );
  // Plugin RPC 是异步的；草稿、Popover 和 chip 都只允许最后一次点击收尾。
  const requestVersionRef = useRef(0);
  const activeOperationRef = useRef<DraftSuggestedPluginOperation | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const allItems = useDraftSuggestedPromptItems({
    clientScenesService: resolution.services.clientScenesService,
    rpcReady: resolution.rpcReady,
    workspaceKey,
  });
  const items = useMemo(
    () =>
      (proactive ? recommendedItems : allItems).filter(
        (item) =>
          !item.actions?.some(
            (action) =>
              action === DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS ||
              action === DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS_OFFPEAK,
          ) || Boolean(onOpenAutomations),
      ),
    [allItems, onOpenAutomations, proactive, recommendedItems],
  );
  const {
    clearPluginActionPopover,
    pluginActionPopover,
    showPluginActionPopover,
    showPluginActionResultPopover,
  } = useDraftSuggestedPluginActionPopover();
  const clearOperationFeedback = useCallback(
    (operationId?: string) => {
      clearPluginActionPopover(operationId);
    },
    [clearPluginActionPopover],
  );
  const waitForComposerTextInsertApplied = useComposerTextInsertApplied(
    workspacePath,
    workspaceIdentity,
  );

  const targetParams = useCallback(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(resolution.remoteSessionId ? { remoteSessionId: resolution.remoteSessionId } : {}),
    }),
    [resolution.remoteSessionId, workspaceIdentity, workspacePath],
  );

  const cancelOperation = useCallback(
    (operation: DraftSuggestedPluginOperation): Promise<void> => {
      if (operation.cancellation) return operation.cancellation;
      operation.abort.abort();
      operation.cancellation = (async () => {
        try {
          await resolution.services.pluginManagementService.cancelPluginOperation({
            operationId: operation.operationId,
          });
        } catch (error) {
          logger.warn("[v4-suggested-prompts] 取消旧插件操作失败，继续丢弃其迟到结果", {
            operationId: operation.operationId,
            error: error instanceof Error ? error.message : String(error),
            workspaceKey,
          });
        } finally {
          await operation.pending?.catch(() => undefined);
          if (activeOperationRef.current === operation) {
            activeOperationRef.current = null;
          }
        }
      })();
      return operation.cancellation;
    },
    [resolution.services.pluginManagementService, workspaceKey],
  );

  useEffect(() => {
    return () => {
      // workspace/attachment 切换后立即移除旧反馈，远端迟到结果继续由版本与 abort 双重拦截。
      requestVersionRef.current += 1;
      clearOperationFeedback();
      const active = activeOperationRef.current;
      if (active) void cancelOperation(active);
    };
  }, [cancelOperation, clearOperationFeedback, resolution.remoteSessionId, workspaceKey]);

  const prependResolvedPlugin = useCallback(
    (plugin: { stableId: string; label: string }, requestVersion: number, icon?: string) => {
      if (requestVersion !== requestVersionRef.current) return null;
      // 推荐流程的状态与展示图标都由目标 Host 的同一次可信解析返回；当前不存在
      // workspace 级 Plugin，再读取 referenceCatalog 会重复校验并引入额外 RPC。
      const mention = buildDraftSuggestedPluginMention(plugin, icon);
      return useZCodeSessionStore
        .getState()
        .requestComposerTextInsert(
          workspacePath,
          mention.markdown,
          workspaceIdentity,
          mention,
          "prepend-if-missing",
        );
    },
    [workspaceIdentity, workspacePath],
  );

  const replacePlainPrompt = useCallback(
    (prompt: string, requestVersion: number, expectedRevision?: number) => {
      if (
        requestVersion !== requestVersionRef.current ||
        (expectedRevision !== undefined &&
          getComposerDraftRevision(workspacePath, workspaceIdentity) !== expectedRevision)
      ) {
        return null;
      }
      return useZCodeSessionStore
        .getState()
        .requestComposerTextInsert(workspacePath, prompt, workspaceIdentity);
    },
    [workspaceIdentity, workspacePath],
  );

  const replaceWithResolvedPluginAndPrompt = useCallback(
    (
      plugin: { stableId: string; label: string },
      prompt: string,
      requestVersion: number,
      expectedRevision: number,
      icon?: string,
    ) => {
      if (
        requestVersion !== requestVersionRef.current ||
        getComposerDraftRevision(workspacePath, workspaceIdentity) !== expectedRevision
      ) {
        return null;
      }
      if (prompt.includes("](plugin://")) {
        // 正文已有插件引用时交给 Composer 解析全部内联提及。目标插件已在正文中就保留
        // 原位置，否则只补一次前置引用；单个 mention 的旧路径会让其余引用退化为裸文本。
        const hasTarget = prompt.includes(`(plugin://${plugin.stableId})`);
        const text = hasTarget
          ? prompt
          : `${buildDraftSuggestedPluginMention(plugin, icon).markdown} ${prompt}`;
        return useZCodeSessionStore
          .getState()
          .requestComposerTextInsert(workspacePath, text, workspaceIdentity);
      }
      const mention = buildDraftSuggestedPluginMention(plugin, icon);
      const text = prompt.trim() ? `${mention.markdown} ${prompt.trim()}` : mention.markdown;
      return useZCodeSessionStore
        .getState()
        .requestComposerTextInsert(workspacePath, text, workspaceIdentity, mention);
    },
    [workspaceIdentity, workspacePath],
  );

  const revalidateAndPrependPlugin = useCallback(
    async (current: DraftSuggestedPluginFlow, requestVersion: number) => {
      await invalidateDeferredDraftSessionForSkillChange({
        zcodeSessionService: resolution.services.zcodeSessionService,
        workspacePath,
        workspaceIdentity,
        reason: "suggested-prompt-plugin-change",
      });
      if (requestVersion !== requestVersionRef.current) return null;
      const resolved =
        await resolution.services.pluginManagementService.resolveSuggestedPluginReference({
          ...targetParams(),
          clientMode: "desktop-continuous" as const,
          deliveryKind: "desktop-continuous" as const,
          stableId: current.plugin.stableId,
          operationId: current.operationId,
        });
      if (requestVersion !== requestVersionRef.current) return null;
      if (resolveDraftSuggestedPluginFlowStage(resolved) !== "checking") return null;
      return prependResolvedPlugin(current.plugin, requestVersion, resolved.icon);
    },
    [
      prependResolvedPlugin,
      resolution.services.pluginManagementService,
      resolution.services.zcodeSessionService,
      targetParams,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const finishMutation = useCallback(
    (flow: DraftSuggestedPluginFlow, kind: PluginMutationKind, succeeded: boolean) => {
      const active = activeOperationRef.current;
      if (active?.operationId === flow.operationId) activeOperationRef.current = null;
      // 成功态不能固定使用 installSucceeded，否则仅启用已安装插件时误显示“安装成功”。
      const messageId = `chat.draft.suggestedPrompt.pluginFlow.${kind}${
        succeeded ? "Succeeded" : "Failed"
      }`;
      showPluginActionResultPopover(flow, messageId, succeeded);
    },
    [showPluginActionResultPopover],
  );

  const showMutationConfirmation = useCallback(
    (
      flow: DraftSuggestedPluginFlow,
      operation: DraftSuggestedPluginOperation,
      requestVersion: number,
      kind: PluginMutationKind,
      onAction: () => void,
    ) => {
      showPluginActionPopover(
        flow,
        `chat.draft.suggestedPrompt.pluginFlow.${kind}Confirmation`,
        "confirmation",
        {
          label: intl.formatMessage({
            id: "chat.draft.suggestedPrompt.pluginFlow.confirm",
          }),
          onAction,
          onDismiss: () => {
            if (
              requestVersion !== requestVersionRef.current ||
              activeOperationRef.current !== operation
            ) {
              return;
            }
            // 确认态曾依赖固定倒计时退出，既会打断仍在阅读的用户，也无法表达明确取消意图。
            // 现在仅由 Popover 外部主指针点击关闭，并取消同一 operation 以继续拦截迟到结果。
            clearOperationFeedback(operation.operationId);
            void cancelOperation(operation);
          },
        },
      );
    },
    [cancelOperation, clearOperationFeedback, intl, showPluginActionPopover],
  );

  const handleMutation = useCallback(
    async function runPluginMutation(
      flow: DraftSuggestedPluginFlow,
      requestVersion: number,
      kind: PluginMutationKind,
    ) {
      const operation = activeOperationRef.current;
      if (
        !operation ||
        operation.operationId !== flow.operationId ||
        requestVersion !== requestVersionRef.current ||
        (kind === "install" &&
          (!flow.result?.pluginName ||
            flow.result.marketplace !== ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID ||
            flow.result.sourceTrust !== "official"))
      ) {
        return;
      }
      showPluginActionPopover(
        flow,
        kind === "install"
          ? "chat.draft.suggestedPrompt.pluginFlow.installing"
          : "chat.draft.suggestedPrompt.pluginFlow.enabling",
        "progress",
      );
      let installTimedOut = false;
      let mutationCompleted = false;
      const restoreInstallConfirmation = (errorMessage: string) => {
        // 安装失败结果态会把操作入口一起收走；恢复同一 PopoverContent 并换新 operation，
        // 既允许立即重试，也防止超时或失败的旧 operation 迟到覆盖新状态。
        operation.abort.abort();
        const retryOperation = createDraftSuggestedPluginOperation(requestVersion);
        const retryFlow: DraftSuggestedPluginFlow = {
          ...flow,
          operationId: retryOperation.operationId,
        };
        activeOperationRef.current = retryOperation;
        logger.warn("[v4-suggested-prompts] 推荐插件安装失败，恢复确认态以便重试", {
          error: errorMessage,
          operationId: flow.operationId,
          pluginId: flow.plugin.stableId,
          workspaceKey,
        });
        toast(
          intl.formatMessage(
            { id: "chat.draft.suggestedPrompt.pluginFlow.installFailureToast" },
            { pluginLabel: flow.plugin.label, error: errorMessage },
          ),
          { variant: "warning" },
        );
        showMutationConfirmation(
          retryFlow,
          retryOperation,
          requestVersion,
          "install",
          () => void runPluginMutation(retryFlow, requestVersion, "install"),
        );
      };
      try {
        if (kind === "install") {
          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
          const installRequest = resolution.services.pluginManagementService.installPlugin({
            ...targetParams(),
            pluginName: flow.result!.pluginName!,
            marketplace: flow.result!.marketplace!,
            scope: "user",
            operationId: flow.operationId,
          });
          const timedInstallRequest = installRequest.finally(() => {
            if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
          });
          const timeoutRequest = new Promise<never>((_, reject) => {
            // 安装超时后必须主动取消同一 operation；仅结束 UI 等待会允许远端迟到成功继续污染草稿。
            timeoutHandle = setTimeout(() => {
              installTimedOut = true;
              void cancelOperation(operation);
              reject(
                new Error(
                  intl.formatMessage({
                    id: "chat.draft.suggestedPrompt.pluginFlow.installTimedOut",
                  }),
                ),
              );
            }, INSTALL_OPERATION_TIMEOUT_MS);
          });
          const result = await trackDraftSuggestedPluginOperation(
            operation,
            Promise.race([timedInstallRequest, timeoutRequest]),
          );
          const errorDiagnostic = result.diagnostics.find(
            (diagnostic) => diagnostic.severity === "error",
          );
          if (errorDiagnostic || result.installedPlugins.length === 0) {
            restoreInstallConfirmation(
              errorDiagnostic?.message ??
                intl.formatMessage({
                  id: "chat.draft.suggestedPrompt.pluginFlow.installReturnedEmpty",
                }),
            );
            return;
          }
        } else {
          await trackDraftSuggestedPluginOperation(
            operation,
            resolution.services.pluginManagementService.setPluginEnabled({
              ...targetParams(),
              pluginId: flow.plugin.stableId,
              enabled: true,
              operationId: flow.operationId,
            }),
          );
        }
        mutationCompleted = true;
        if (operation.abort.signal.aborted || requestVersion !== requestVersionRef.current) return;
        const composerRequestId = await trackDraftSuggestedPluginOperation(
          operation,
          revalidateAndPrependPlugin(flow, requestVersion),
        );
        if (operation.abort.signal.aborted || requestVersion !== requestVersionRef.current) return;
        if (composerRequestId === null) {
          finishMutation(flow, kind, false);
          return;
        }
        const applied = await trackDraftSuggestedPluginOperation(
          operation,
          waitForComposerTextInsertApplied(composerRequestId, operation.abort.signal),
        );
        if (operation.abort.signal.aborted || requestVersion !== requestVersionRef.current) return;
        finishMutation(flow, kind, applied);
      } catch (error) {
        if (
          (operation.abort.signal.aborted && !installTimedOut) ||
          requestVersion !== requestVersionRef.current
        )
          return;
        if (kind === "install" && !mutationCompleted) {
          restoreInstallConfirmation(toPluginMutationErrorMessage(error));
          return;
        }
        logger.warn(`[v4-suggested-prompts] 推荐插件${kind === "install" ? "安装" : "启用"}失败`, {
          error: toPluginMutationErrorMessage(error),
          operationId: flow.operationId,
          pluginId: flow.plugin.stableId,
          workspaceKey,
        });
        finishMutation(flow, kind, false);
      }
    },
    [
      cancelOperation,
      finishMutation,
      intl,
      revalidateAndPrependPlugin,
      resolution.services.pluginManagementService,
      showMutationConfirmation,
      showPluginActionPopover,
      targetParams,
      waitForComposerTextInsertApplied,
      workspaceKey,
    ],
  );

  const handleSelect = useCallback(
    async (item: DraftSuggestedPromptItem) => {
      const requestVersion = requestVersionRef.current + 1;
      requestVersionRef.current = requestVersion;
      const templateName = resolveDraftSuggestedPromptText(item.label, locale);
      const prompt = resolveDraftSuggestedPromptText(item.prompt, locale);
      if (isDesktop) {
        // 埋点是旁路观测，必须早于导航或异步插件解析，且不能阻塞既有交互。
        void reportPromptTemplateClick(platform, {
          templateId: item.id,
          templateName,
          templatePrompt: prompt,
        });
      }
      if (
        onOpenAutomations &&
        item.actions?.includes(DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS_OFFPEAK)
      ) {
        onOpenAutomations("idle");
        return;
      }
      if (
        onOpenAutomations &&
        item.actions?.includes(DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS)
      ) {
        onOpenAutomations();
        return;
      }
      const plugin = item.plugin
        ? {
            stableId: item.plugin.stableId,
            label: resolveDraftSuggestedPromptText(item.plugin.label, locale),
          }
        : undefined;

      // 无 Plugin 的推荐项没有远端校验，继续立即替换普通草稿；Plugin-backed 推荐项必须等
      // 可信解析后一次性决定写入纯 prompt 还是 Plugin + prompt，避免 Composer 两阶段更新。
      if (!plugin || !resolution.rpcReady) {
        replacePlainPrompt(prompt, requestVersion);
      }

      const previous = activeOperationRef.current;
      if (previous) {
        // 手动切换推荐项属于预期接管：关闭旧反馈，但不显示取消或中断提示。
        clearOperationFeedback(previous.operationId);
        setCancelling(true);
        await cancelOperation(previous);
        if (requestVersion !== requestVersionRef.current) return;
        setCancelling(false);
      }
      if (!plugin || !resolution.rpcReady) return;
      // 在旧 operation 取消收敛后再取基线：旧 operation 可能刚把自己的普通 prompt
      // 交给 Composer 消费；它属于本次推荐流程的程序性写入，不应让新推荐项被误判为用户编辑。
      const draftRevision = getComposerDraftRevision(workspacePath, workspaceIdentity);

      const operation = createDraftSuggestedPluginOperation(requestVersion);
      activeOperationRef.current = operation;
      const checkingFlow: DraftSuggestedPluginFlow = {
        anchorItemId: item.id,
        operationId: operation.operationId,
        plugin,
        stage: "unavailable",
      };
      // missing 的可信解析需要等待官方 Marketplace 刷新，旧流程直到请求完成才
      // 打开确认 Popover，网络等待期间看起来像点击卡住。先订阅同一 operation 的本地检查结果，
      // 只更新现有唯一 Popover 的 phase，后续确认/操作/结果继续复用同一挂载点。
      const progressSubscription =
        resolution.services.pluginManagementService.onDynamicPluginOperationProgress(
          operation.operationId,
        )((event) => {
          if (
            event.state !== "refreshing" ||
            operation.abort.signal.aborted ||
            activeOperationRef.current !== operation ||
            requestVersion !== requestVersionRef.current ||
            getComposerDraftRevision(workspacePath, workspaceIdentity) !== draftRevision
          ) {
            return;
          }
          showPluginActionPopover(
            checkingFlow,
            "chat.draft.suggestedPrompt.pluginFlow.checking",
            "progress",
          );
        });
      try {
        const result = await trackDraftSuggestedPluginOperation(
          operation,
          resolution.services.pluginManagementService.resolveSuggestedPluginReference({
            ...targetParams(),
            clientMode: "desktop-continuous" as const,
            deliveryKind: "desktop-continuous" as const,
            stableId: plugin.stableId,
            operationId: operation.operationId,
          }),
        );
        if (operation.abort.signal.aborted || requestVersion !== requestVersionRef.current) return;
        if (getComposerDraftRevision(workspacePath, workspaceIdentity) !== draftRevision) {
          clearOperationFeedback(operation.operationId);
          activeOperationRef.current = null;
          return;
        }
        const flow: DraftSuggestedPluginFlow = {
          anchorItemId: item.id,
          operationId: operation.operationId,
          plugin,
          result,
          stage: resolveDraftSuggestedPluginFlowStage(result),
        };
        if (flow.stage === "checking") {
          replaceWithResolvedPluginAndPrompt(
            flow.plugin,
            prompt,
            requestVersion,
            draftRevision,
            result.icon,
          );
          if (operation.abort.signal.aborted || requestVersion !== requestVersionRef.current)
            return;
          activeOperationRef.current = null;
          clearOperationFeedback(flow.operationId);
          return;
        }
        if (flow.stage === "missing" || flow.stage === "disabled") {
          // disabled 无需刷新 Marketplace，不一定有 Agent 进度通知；在写入纯 prompt 前也先让
          // 同一个 Popover 进入 checking，随后等待 Composer 落地并原地切换确认态。
          showPluginActionPopover(
            flow,
            "chat.draft.suggestedPrompt.pluginFlow.checking",
            "progress",
          );
          const composerRequestId = replacePlainPrompt(prompt, requestVersion, draftRevision);
          if (composerRequestId === null) {
            clearOperationFeedback(flow.operationId);
            activeOperationRef.current = null;
            return;
          }
          // 确认 Popover 先于 Composer 消费纯 prompt 打开时，输入区随后增高会让
          // 推荐项锚点整体移动，浮层因而先按旧坐标出现再跳位。安装与开启都等插入落地后再测量锚点。
          const applied = await trackDraftSuggestedPluginOperation(
            operation,
            waitForComposerTextInsertApplied(composerRequestId, operation.abort.signal),
          );
          if (operation.abort.signal.aborted || requestVersion !== requestVersionRef.current)
            return;
          if (!applied) {
            clearOperationFeedback(flow.operationId);
            activeOperationRef.current = null;
            return;
          }
          const kind: PluginMutationKind = flow.stage === "missing" ? "install" : "enable";
          showMutationConfirmation(
            flow,
            operation,
            requestVersion,
            kind,
            () => void handleMutation(flow, requestVersion, kind),
          );
          return;
        }
        replacePlainPrompt(prompt, requestVersion, draftRevision);
        clearOperationFeedback(flow.operationId);
        activeOperationRef.current = null;
      } catch (error) {
        if (operation.abort.signal.aborted || requestVersion !== requestVersionRef.current) return;
        logger.warn("[v4-suggested-prompts] 推荐插件可信解析失败", {
          error: error instanceof Error ? error.message : String(error),
          pluginId: plugin.stableId,
          workspaceKey,
        });
        replacePlainPrompt(prompt, requestVersion, draftRevision);
        clearOperationFeedback(operation.operationId);
        activeOperationRef.current = null;
      } finally {
        progressSubscription.dispose();
      }
    },
    [
      cancelOperation,
      clearOperationFeedback,
      locale,
      onOpenAutomations,
      platform,
      replacePlainPrompt,
      replaceWithResolvedPluginAndPrompt,
      resolution.rpcReady,
      resolution.services.pluginManagementService,
      handleMutation,
      isDesktop,
      showMutationConfirmation,
      showPluginActionPopover,
      targetParams,
      waitForComposerTextInsertApplied,
      workspaceIdentity,
      workspaceKey,
      workspacePath,
    ],
  );

  return (
    <div data-v4-draft-suggested-prompts-slot="true" className={cn(!proactive && "h-8", className)}>
      <ConversationDraftSuggestedPrompts
        // 绝对定位让推荐区脱离 Composer 的正常结构，调试和间距语义都不直观。
        // 旧场景推荐保留固定槽位；主动推荐列表必须由内容撑高，否则多行会溢出并覆盖下方内容。
        items={items}
        layout={proactive ? "list" : "chips"}
        onSelect={handleSelect}
        onRefresh={proactive ? () => advanceRecommendedPromptPane(recommendationPaneId) : undefined}
        onClose={proactive ? closeRecommendations : undefined}
        disabled={cancelling || closing}
        refreshDisabled={Boolean(pluginActionPopover)}
        pluginActionPopover={pluginActionPopover}
      />
    </div>
  );
}
