import { applyComposerPermissionGrant } from "@/v4/composer/composerPermissionGrant.js";
/* eslint-disable max-lines -- Composer 草稿 owner 同时收口选择、正文与提交生命周期，保持单一状态边界。 */
// Composer 的模式/模型选择与正文使用同一 scope 草稿；Session 只提供一次初始化种子。
// 菜单点击立即保存 Renderer 意图，Prewarm 与 Submission 只消费它，不反向覆盖。
//
// Workspace presentation 水合只提供 mode 与 slash commands；模型候选、能力和首选值
// 统一来自目标 Host ModelSelectionView。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ZCODE_AGENT_PROVIDER, resolveExecutionState } from "@zcode/shared";
import { applyComposerPlanTransition } from "@/v4/composer/composerPlanTransition.js";
import type {
  ZCodeConfigOption,
  ModelSelection,
  ZCodeProvider,
  ZCodeSlashCommand,
} from "@zcode/shared";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import type { IModelSelectionService } from "@zcode/services";
import { completeNewModelSelection } from "@zcode/provider";
import {
  useModelSelectionServiceView,
  type ModelSelectionRead,
} from "@/hooks/useModelSelectionView.js";
import { submissionModeSchema } from "@zcode/shared/zcode-protocol-v4";
import { prepareWorkspaceWithZCodeSessionService } from "@/hooks/useWorkspacePrepare.js";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { initializeNewTaskDraft } from "@/v4/composer/newTaskDraft.js";
import {
  clearV4ComposerDraft,
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";
import { resolveAppFollowupMode } from "@/v4/composer/followupModeSettings.js";
import { logger } from "@/logger.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

/** 目录水合单飞（per workspaceKey）：draft、已有 session 和严格模式双挂载共享一次 RPC。 */
const workspaceCatalogHydrationFlights = new Map<string, Promise<void>>();

function applyDraftModelSelection(
  current: Partial<SessionConfigState>,
  model: ModelSelection,
): Partial<SessionConfigState> {
  const next = {
    ...current,
    modelSelection: {
      providerId: model.providerId,
      modelId: model.modelId,
      ...(model.options ? { options: { ...model.options } } : {}),
    },
    provider: model.providerId,
    model: model.modelId,
  };
  // thought 是模型的附属配置。切模型后保留源 thought 会让首发前配置屏障
  // 在目标模型已切成功后把它当成“同模型显式切 thought”再次写入，必须先清除。
  delete next.thought;
  return next;
}

function shouldHydrateWorkspaceCatalog(params: {
  configOptions: readonly ZCodeConfigOption[];
  sessionId: string | null;
  slashCommands: readonly ZCodeSlashCommand[];
}): boolean {
  const hasModePresentation = params.configOptions.some(
    (option) => option.category === "mode" && option.type === "select",
  );
  // slashCommands 属于 workspace identity，不会随已有 session projection 恢复。
  // 因此已有 session 只要目录为空也必须独立水合；mode 目录也不再借模型目录间接提供。
  return params.slashCommands.length === 0 || !hasModePresentation;
}

interface DraftConfigControl {
  modelSelectionRead: ModelSelectionRead;
  /** Renderer 下一次提交的配置；Session 只在 scope 首次初始化时提供种子。 */
  draftConfig: Partial<SessionConfigState>;
  /** 草稿已选 config（partial）；createSession 时经 buildDraftCreateConfigPayload 携带。 */
  draftConfigRef: React.RefObject<Partial<SessionConfigState>>;
  /** 当前草稿生命周期冻结的初始化 config；只供 prewarm/createSession 建立时使用。 */
  resolveInitialDraftConfig: () => Partial<SessionConfigState> | undefined;
  composerDraft: V4ComposerDraft;
  updateComposerContent: (
    content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">,
  ) => void;
  replaceComposerDraft: (draft: Omit<V4ComposerDraft, "updatedAt">) => void;
  /** 新任务被接纳后，把当前完整 Root Draft 原子式转移到真实 Session scope。 */
  promoteComposerDraft: (createdSessionId: string) => void;
  /** 在提交前捕获原意图；只在权威 accepted 后调用返回函数。 */
  captureAcceptedModelSelection: (
    selection: ModelSelection,
    expectedSelection?: ModelSelection,
  ) => () => void;
  handleDraftSelectModel: (modelProvider: string, model: string) => void;
  handleDraftSelectThought: (thought: string) => void;
  handleDraftSwitchMode: (mode: string) => void;
}

export function useDraftConfigControl(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  provider?: ZCodeProvider;
  /** 会话切换读取对应 scope；已有空选择也必须保留。 */
  sessionId: string | null;
  /** 仅匹配当前 Session 的首份投影可用作初始化；null 表示还没恢复完成。 */
  sessionConfig?: Partial<SessionConfigState> | null;
  /** provider registry 已通过 renderer readiness 门禁后才允许拉起 Agent。 */
  agentStartupAllowed?: boolean;
  modelSelectionService: IModelSelectionService | null;
}): DraftConfigControl {
  const {
    workspacePath,
    workspaceIdentity,
    provider,
    sessionId,
    sessionConfig,
    agentStartupAllowed = true,
    modelSelectionService,
  } = params;
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  const zcodeSessionService = useZCodeSessionService(workspacePath, null, workspaceIdentity);
  const { settings: sharedSettings } = useSettings();
  const appFollowupMode = resolveAppFollowupMode(sharedSettings);
  const scopeId = sessionId ?? V4_DRAFT_SCOPE_ROOT;
  const scopeKey = JSON.stringify([workspaceKey, scopeId]);
  const loadedScope = useMemo(
    () => ({
      scopeKey,
      draft: readV4ComposerDraft(workspacePath, workspaceIdentity, scopeId) ?? {
        text: "",
        updatedAt: 0,
      },
    }),
    [scopeKey],
  );
  const [storedState, setStoredState] = useState(loadedScope);
  let currentState = storedState.scopeKey === scopeKey ? storedState : loadedScope;
  let draft = currentState.draft;
  const modelSelectionRead = useModelSelectionServiceView(
    modelSelectionService,
    true,
    "remote-waiting",
    {
      selection: draft.modelSelection ?? null,
    },
  );
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  const initializeAsNewTask = sessionId === null || draft.initializeFromNewTask === true;
  if (!draft.mode && (initializeAsNewTask ? modelSelectionView !== null : sessionConfig != null)) {
    const mode = submissionModeSchema.safeParse(sessionConfig?.mode);
    // Recent 是初始化原意图，不先按旧 Provider 是否仍在候选中删掉；下一次输入读取
    // 由同一解析入口对应当前账号，或暂时留空。否则冷启动会绕过统一账号对应规则。
    // mode 是已初始化标记：历史恢复给出的空选择也是确定结果，后续 Snapshot 不得填满。
    draft =
      initializeAsNewTask && modelSelectionView
        ? initializeNewTaskDraft(draft, workspacePath, workspaceIdentity, modelSelectionView)
        : {
            ...draft,
            mode: mode.success && mode.data !== "plan" ? mode.data : "build",
            planEnabled: resolveExecutionState(sessionConfig ?? {}).planEnabled,
            modelSelection: sessionConfig?.modelSelection,
          };
  }
  if (sessionConfig) {
    draft = applyComposerPlanTransition(draft, sessionConfig.planTransition);
    draft = applyComposerPermissionGrant(draft, sessionConfig.permissionGrant);
  }
  if (draft !== currentState.draft) currentState = { ...currentState, draft };
  if (currentState !== storedState) setStoredState(currentState);
  const stateRef = useRef(currentState);
  stateRef.current = currentState;
  // 原因：按 revision 清草稿会把短暂不可用永久写成空选择。这里只派生当前结果，
  // 正文/模式自动保存继续保存 draft 中的原意图；读取未就绪时保留展示，提交由 View 门禁阻断。
  const effectiveSelection = modelSelectionView
    ? (modelSelectionView.effectiveSelection ?? undefined)
    : draft.modelSelection;
  const draftConfig = useMemo<Partial<SessionConfigState>>(
    () => ({
      mode: draft.mode,
      planEnabled: draft.planEnabled ?? false,
      modelSelection: effectiveSelection,
      provider: effectiveSelection?.providerId ?? "",
      model: effectiveSelection?.modelId ?? "",
      thought: effectiveSelection?.options?.reasoningLevel ?? "",
    }),
    [draft.mode, draft.planEnabled, effectiveSelection],
  );
  const draftConfigRef = useRef(draftConfig);
  draftConfigRef.current = draftConfig;
  const lastPersistedDraftRef = useRef<V4ComposerDraft | null>(null);
  useEffect(() => {
    if (
      (draft.mode || draft.initializeFromNewTask) &&
      draft !== lastPersistedDraftRef.current &&
      stateRef.current.draft === draft &&
      stateRef.current.scopeKey === scopeKey
    ) {
      persistV4ComposerDraft(workspacePath, workspaceIdentity, scopeId, draft);
      lastPersistedDraftRef.current = draft;
    }
  }, [draft, scopeKey]);
  const updateComposerDraft = useCallback(
    (update: (current: V4ComposerDraft) => V4ComposerDraft) => {
      // 旧 scope 的延迟编辑器回调不能写入刚切换到的会话。
      if (stateRef.current.scopeKey !== scopeKey) return;
      const previous = stateRef.current.draft;
      const next = update(previous);
      const nextState = { ...stateRef.current, draft: next };
      stateRef.current = nextState;
      const selection =
        next.modelSelection === previous.modelSelection
          ? draftConfigRef.current.modelSelection
          : next.modelSelection;
      draftConfigRef.current = {
        mode: next.mode,
        planEnabled: next.planEnabled ?? false,
        modelSelection: selection,
        provider: selection?.providerId ?? "",
        model: selection?.modelId ?? "",
        thought: selection?.options?.reasoningLevel ?? "",
      };
      setStoredState(nextState);
      persistV4ComposerDraft(workspacePath, workspaceIdentity, scopeId, next);
      lastPersistedDraftRef.current = next;
    },
    [scopeKey, workspacePath, workspaceIdentity, scopeId],
  );
  const updateDraftConfig = useCallback(
    (update: (current: Partial<SessionConfigState>) => Partial<SessionConfigState>) => {
      const next = update(draftConfigRef.current);
      const mode = submissionModeSchema.safeParse(next.mode);
      updateComposerDraft((current) => ({
        ...current,
        mode: mode.success ? mode.data : current.mode,
        modelSelection: next.modelSelection,
        // 用户已经显式改选，不能再由导入时等待的默认初始化覆盖。
        ...(current.initializeFromNewTask
          ? { mode: mode.success ? mode.data : "build", initializeFromNewTask: undefined }
          : {}),
      }));
    },
    [updateComposerDraft],
  );
  const captureAcceptedModelSelection = useCallback(
    (selection: ModelSelection, expectedSelection: ModelSelection = selection): (() => void) => {
      const original = stateRef.current.draft.modelSelection;
      const effective = draftConfigRef.current.modelSelection;
      // 对象键顺序不是选择身份；协议重建同一选择时不能因此丢掉 accepted 写回。
      if (
        effective?.providerId !== expectedSelection.providerId ||
        effective.modelId !== expectedSelection.modelId ||
        effective.options?.reasoningLevel !== expectedSelection.options?.reasoningLevel
      )
        return () => {};
      return () => {
        // 自动对应只在本次提交被接纳后固定；旧 ACK 不得覆盖期间的新意图或新 scope。
        if (
          stateRef.current.scopeKey !== scopeKey ||
          stateRef.current.draft.modelSelection !== original
        )
          return;
        updateComposerDraft((current) => ({ ...current, modelSelection: selection }));
      };
    },
    [scopeKey, updateComposerDraft],
  );
  const resolveInitialDraftConfig = useCallback((): Partial<SessionConfigState> | undefined => {
    if (!draftConfigRef.current.mode) return undefined;
    const config = { ...draftConfigRef.current };
    if (appFollowupMode) {
      config.followupMode = appFollowupMode;
    }
    return config;
  }, [appFollowupMode]);

  const updateComposerContent = useCallback(
    (content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">) => {
      updateComposerDraft((current) => ({
        ...current,
        editorStateJson: undefined,
        mention: undefined,
        ...content,
      }));
    },
    [updateComposerDraft],
  );
  const replaceComposerDraft = useCallback(
    (replacement: Omit<V4ComposerDraft, "updatedAt">) => {
      // 撤回编辑替换正文/配置，但不能忘记已经消费的授权，否则旧快照会再次覆盖新选择。
      updateComposerDraft((current) => ({
        ...replacement,
        lastPermissionGrantId: current.lastPermissionGrantId,
        updatedAt: Date.now(),
      }));
    },
    [updateComposerDraft],
  );

  const promoteComposerDraft = useCallback(
    (createdSessionId: string) => {
      if (stateRef.current.scopeKey !== scopeKey || scopeId !== V4_DRAFT_SCOPE_ROOT) return;
      const targetSessionId = createdSessionId.trim();
      if (!targetSessionId) return;
      // 首发成功曾直接删除 Root scope，真实 Session 没有 Composer Draft，
      // 重挂载后又从 Snapshot 初始化。先写目标、再删来源，保留完整正文/模式/选择。
      const written = persistV4ComposerDraft(
        workspacePath,
        workspaceIdentity,
        targetSessionId,
        stateRef.current.draft,
      );
      if (!written) return;
      clearV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT);
    },
    [scopeId, scopeKey, workspaceIdentity, workspacePath],
  );

  // ── workspace 目录水合（见文件头说明）──
  // 目录已 ready（reload/广播/上次水合写过）则跳过；否则读取最小 workspace presentation。
  useEffect(() => {
    const isDraft = sessionId === null;
    const store = useZCodeSessionStore.getState();
    const workspaceState = store.getWorkspaceState(workspacePath, workspaceIdentity);
    if (!agentStartupAllowed) {
      // V4 目录水合曾在无模型时直接进入 RPC，虽然 Host 不会启动 CLI，
      // renderer 仍会把正常等待态记成 hydration error。readiness 未通过时保持 idle；
      // registry 就绪后依赖变化会自动重新进入本 effect。
      store.setConfigOptionsStatus(workspacePath, "idle", workspaceIdentity);
      return;
    }
    const configOptions = workspaceState.configOptions ?? [];
    const hasModePresentation = configOptions.some(
      (option) => option.category === "mode" && option.type === "select",
    );
    const hasSlashCommandCatalog = workspaceState.slashCommands.length > 0;
    const shouldHydrateCatalog = shouldHydrateWorkspaceCatalog({
      configOptions,
      sessionId,
      slashCommands: workspaceState.slashCommands,
    });
    logger.debug("[v4-workspace-catalog] hydration check", {
      catalogScope: isDraft ? "draft" : "known-session",
      hasModePresentation,
      hasSlashCommandCatalog,
      flightInProgress: workspaceCatalogHydrationFlights.has(workspaceKey),
      configOptionsStatus: workspaceState.configOptionsStatus,
      workspaceKey,
    });
    const existingFlight = workspaceCatalogHydrationFlights.get(workspaceKey);
    if (existingFlight) {
      return;
    }
    if (!shouldHydrateCatalog) {
      return;
    }

    store.setConfigOptionsStatus(workspacePath, "loading", workspaceIdentity);
    const flight = prepareWorkspaceWithZCodeSessionService({
      workspacePath,
      workspaceIdentity,
      provider: displayProvider,
      zcodeSessionService,
    })
      .then((prepareResult) => {
        const baseOptions = prepareResult.configOptions ?? [];
        logger.debug("[v4-workspace-catalog] hydration done", {
          catalogScope: isDraft ? "draft" : "known-session",
          optionCount: baseOptions.length,
          slashCommandCount: prepareResult.slashCommands?.length ?? 0,
          modeCurrentValue: String(
            baseOptions.find((option) => option.category === "mode" && option.type === "select")
              ?.currentValue ?? "",
          ),
          workspaceKey,
        });
        const latest = useZCodeSessionStore.getState();
        latest.setConfigOptions(workspacePath, baseOptions, workspaceIdentity);
        latest.setConfigOptionsStatus(workspacePath, "ready", workspaceIdentity);
        latest.setSlashCommands(
          workspacePath,
          prepareResult.slashCommands ?? [],
          workspaceIdentity,
        );
      })
      .catch((error) => {
        useZCodeSessionStore
          .getState()
          .setConfigOptionsStatus(workspacePath, "error", workspaceIdentity);
        logger.warn(`[v4-workspace-catalog] workspace 目录水合失败: ${String(error)}`);
      })
      .finally(() => {
        workspaceCatalogHydrationFlights.delete(workspaceKey);
      });
    workspaceCatalogHydrationFlights.set(workspaceKey, flight);
  }, [
    agentStartupAllowed,
    displayProvider,
    sessionId,
    workspaceIdentity,
    workspaceKey,
    workspacePath,
    zcodeSessionService,
  ]);

  const handleDraftSelectModel = useCallback(
    (modelProvider: string, model: string) => {
      const modelId = modelProvider ? `${modelProvider}/${model}` : model;
      const parsedSelection = parseModelPickerValue(modelId);
      // 用户点击模型只确定模型身份；Reasoning 没有默认值，保持为空并等待用户选择。
      const modelSelection = modelSelectionView
        ? (completeNewModelSelection(modelSelectionView, parsedSelection) ?? parsedSelection)
        : parsedSelection;
      logger.debug("[v4-draft-config] select model", {
        modelProvider,
        model,
        modelId,
        modelSelectionProviderId: modelSelection.providerId,
        modelSelectionModelId: modelSelection.modelId,
        workspacePath,
        workspaceIdentity: workspaceIdentity ?? null,
      });
      updateDraftConfig((current) => applyDraftModelSelection(current, modelSelection));
    },
    [modelSelectionView, updateDraftConfig, workspaceIdentity, workspacePath],
  );

  const handleDraftSelectThought = useCallback(
    (thought: string) => {
      updateDraftConfig((current) => {
        const providerId = current.modelSelection?.providerId ?? current.provider?.trim();
        const modelId = current.modelSelection?.modelId ?? current.model?.trim();
        if (!providerId || !modelId) return { ...current, thought };
        const reasoningLevel = thought.trim();
        return {
          ...current,
          modelSelection: {
            providerId,
            modelId,
            ...(reasoningLevel
              ? {
                  options: {
                    ...current.modelSelection?.options,
                    reasoningLevel,
                  },
                }
              : {}),
          },
          thought,
        };
      });
    },
    [updateDraftConfig],
  );

  const handleDraftSwitchMode = useCallback(
    (mode: string) => {
      if (mode === "plan" || mode === "plan-off") {
        updateComposerDraft((current) => ({
          ...current,
          mode: current.mode === "plan" ? "build" : (current.mode ?? "build"),
          planEnabled: mode === "plan",
          initializeFromNewTask: undefined,
        }));
        return;
      }
      // 模式与模型同属当前 scope；不再写全局偏好，避免别的任务反向覆盖。
      const parsed = submissionModeSchema.safeParse(mode);
      if (parsed.success)
        updateComposerDraft((current) => ({
          ...current,
          mode: parsed.data,
          initializeFromNewTask: undefined,
        }));
    },
    [updateComposerDraft],
  );

  return {
    modelSelectionRead,
    draftConfig,
    draftConfigRef,
    resolveInitialDraftConfig,
    composerDraft: draft,
    updateComposerContent,
    replaceComposerDraft,
    promoteComposerDraft,
    captureAcceptedModelSelection,
    handleDraftSelectModel,
    handleDraftSelectThought,
    handleDraftSwitchMode,
  };
}

/** createSession payload 的草稿 config 片段（无选择时返回空对象，不携带 config 键）。 */
export function buildDraftCreateConfigPayload(
  draftConfig: Partial<SessionConfigState>,
  appFollowupMode?: SessionConfigState["followupMode"] | null,
): { config?: Partial<SessionConfigState> } {
  const config: Partial<SessionConfigState> = { ...draftConfig };
  if (appFollowupMode) {
    config.followupMode = appFollowupMode;
  }
  return Object.keys(config).length > 0 ? { config } : {};
}
