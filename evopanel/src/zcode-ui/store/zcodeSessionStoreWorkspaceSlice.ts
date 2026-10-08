import type { SessionCreateSource } from "@zcode/shared";
/* eslint-disable max-lines -- workspace 级状态动作集中在同一 slice，先保持收口便于维护。 */
import {
  buildNativeSupplierKey,
  normalizeAgentProviderToZCodeAgent,
  type ZCodeConfigOption,
  type ModelSelectionResolution,
  type ZCodeProvider,
  type ZCodeSlashCommand,
  type ZCodeTaskMeta,
  type ZCodeTaskRuntimeStatus,
  type ZCodeWorkspaceInitStatus,
} from "@zcode/shared";
import { areConfigOptionsEquivalent } from "@/lib/configOptionsEquality.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import { pushNavEntry } from "@/lib/taskNavigationHistory.js";
import { resolveTaskRestorePreloadConfigOptions } from "@/lib/taskModelRecovery.js";
import type {
  ZCodeSessionStoreState,
  ConfigOptionsStatus,
  ComposerMentionPrefill,
  GroupedDraftTaskState,
  GroupedDraftTaskPlacement,
  ModelSwitchStage,
  WorkspaceZCodeUIState,
} from "@/store/zcodeSessionStoreTypes.js";
import {
  getTaskMeta,
  getWorkspaceState,
  getWorkspaceInitState,
  updateWorkspaceState,
} from "@/store/zcodeSessionStoreSelectors.js";

type SetFn = (
  partial:
    | ZCodeSessionStoreState
    | Partial<ZCodeSessionStoreState>
    | ((state: ZCodeSessionStoreState) => ZCodeSessionStoreState | Partial<ZCodeSessionStoreState>),
) => void;

let groupedDraftSequence = 0;

function createGroupedDraftId(createdAt: number): string {
  groupedDraftSequence += 1;
  return `grouped-draft-${createdAt}-${groupedDraftSequence}`;
}

function normalizeThoughtLevelConfigOption(option: ZCodeConfigOption): ZCodeConfigOption {
  if (
    option.type !== "select" ||
    (option.id !== "thought_level" && option.category !== "thought_level")
  ) {
    return option;
  }
  const currentValue = typeof option.currentValue === "string" ? option.currentValue : "";
  if (option.options?.some((entry) => entry.value === currentValue)) {
    return option;
  }
  const fallbackValue = option.options?.[0]?.value;
  if (!fallbackValue) {
    return option;
  }
  // 模型切换竞态里 thought_level 可能短暂为空；store 统一归一，避免工具栏 Select 进入空选中态。
  return { ...option, currentValue: fallbackValue };
}

function normalizeConfigOptions(options: ZCodeConfigOption[]): ZCodeConfigOption[] {
  return options.map(normalizeThoughtLevelConfigOption);
}

function cloneConfigOptions(options: readonly ZCodeConfigOption[]): ZCodeConfigOption[] {
  return options.map((option) => ({
    ...option,
    options: option.options?.map((entry) => ({ ...entry })),
  }));
}

function isSameGroupedDraftPlacement(
  left: GroupedDraftTaskPlacement,
  right: GroupedDraftTaskPlacement,
): boolean {
  if (left.type !== right.type) {
    return false;
  }
  if (left.type === "top") {
    return true;
  }
  return right.type === "group" && left.groupId === right.groupId;
}

function isModeConfigOption(option: ZCodeConfigOption): boolean {
  return option.category === "mode" && option.type === "select";
}

function createFallbackModeOption(params: {
  currentModeId: string;
  options?: NonNullable<ZCodeConfigOption["options"]>;
}): ZCodeConfigOption {
  const options = params.options?.length
    ? params.options
    : [{ value: params.currentModeId, name: params.currentModeId }];
  return {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: params.currentModeId,
    options,
  };
}

function replaceModeConfigOption(
  currentOptions: ZCodeConfigOption[] | null,
  nextModeOption: ZCodeConfigOption | null,
): ZCodeConfigOption[] | null {
  const options = currentOptions ?? [];
  const modeIndex = options.findIndex(isModeConfigOption);
  if (modeIndex === -1) {
    if (!nextModeOption) {
      return currentOptions;
    }
    return normalizeConfigOptions([...options, nextModeOption]);
  }

  if (!nextModeOption) {
    return normalizeConfigOptions([
      ...options.slice(0, modeIndex),
      ...options.slice(modeIndex + 1),
    ]);
  }

  return normalizeConfigOptions([
    ...options.slice(0, modeIndex),
    nextModeOption,
    ...options.slice(modeIndex + 1),
  ]);
}

function updateCurrentModeConfigOption(
  currentOptions: ZCodeConfigOption[] | null,
  modeId: string | null,
): ZCodeConfigOption[] | null {
  const options = currentOptions ?? [];
  const existingModeOption = options.find(isModeConfigOption);
  if (!modeId) {
    if (!existingModeOption) {
      return currentOptions;
    }
    if ((existingModeOption.options?.length ?? 0) === 0) {
      return replaceModeConfigOption(currentOptions, null);
    }
    return replaceModeConfigOption(currentOptions, {
      ...existingModeOption,
      currentValue: "",
    });
  }

  if (!existingModeOption) {
    return replaceModeConfigOption(
      currentOptions,
      createFallbackModeOption({ currentModeId: modeId }),
    );
  }

  return replaceModeConfigOption(currentOptions, {
    ...existingModeOption,
    currentValue: modeId,
  });
}

function updateActiveTaskConfigOptions(
  current: WorkspaceZCodeUIState,
  updater: (options: ZCodeConfigOption[] | null) => ZCodeConfigOption[] | null,
): Pick<WorkspaceZCodeUIState, "taskConfigOptionsByTaskId"> | null {
  const activeTaskId = current.activeTaskId;
  if (!activeTaskId) {
    return null;
  }

  const currentTaskOptions = current.taskConfigOptionsByTaskId[activeTaskId];
  if (!currentTaskOptions) {
    return null;
  }

  const nextTaskOptions = updater(currentTaskOptions);
  if (nextTaskOptions === currentTaskOptions || !nextTaskOptions) {
    return null;
  }

  return {
    taskConfigOptionsByTaskId: {
      ...current.taskConfigOptionsByTaskId,
      [activeTaskId]: nextTaskOptions,
    },
  };
}

function resolveActiveTaskConfigOptionsOnSwitch(
  current: WorkspaceZCodeUIState,
  taskId: string,
): { configOptions: ZCodeConfigOption[]; status: ConfigOptionsStatus } | null {
  const cachedTaskConfigOptions = current.taskConfigOptionsByTaskId[taskId];
  if (cachedTaskConfigOptions) {
    return {
      configOptions: cachedTaskConfigOptions,
      status: current.taskConfigOptionsStatusByTaskId[taskId] ?? "ready",
    };
  }

  const taskMeta = getTaskMeta(current, taskId);
  // 切到历史 task 时，工具栏模型和 context 用量来自不同状态桶。
  // 没有 task 级 settings 缓存时先用 task meta 预热模型，并进入 loading 等待运行态 settings 回填，
  // 避免继续展示上一条任务的模型（例如 glm-0531[1m]）配上当前任务的 contextWindow。
  const preloadedOptions = normalizeConfigOptions(
    resolveTaskRestorePreloadConfigOptions({
      taskMeta: {
        provider: taskMeta?.provider ?? current.selectedProvider,
        model: taskMeta?.model,
        mode: taskMeta?.mode,
        thoughtLevel: taskMeta?.thoughtLevel,
      },
    }),
  );
  if (preloadedOptions.length === 0) {
    return null;
  }

  return {
    configOptions: preloadedOptions,
    status: "loading",
  };
}

export function createWorkspaceSlice(set: SetFn) {
  return {
    setActiveTaskId: (workspacePath: string, id: string | null, workspaceIdentity?: string) => {
      set((state) => {
        const workspaceUpdate = updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const { [id ?? ""]: _ignoredUnreadTask, ...restTaskUnreadByTaskId } =
              current.taskUnreadByTaskId;
            const optimisticTask = id ? current.optimisticTaskListByTaskId[id] : undefined;
            const nextOptimisticTaskListByTaskId =
              id && typeof optimisticTask?.unreadAt === "number"
                ? {
                    ...current.optimisticTaskListByTaskId,
                    [id]: {
                      ...optimisticTask,
                      // 右键标记未读会把 unreadAt 同时写进 optimistic task；
                      // 之前重复打开当前 task 只清旧 unread map，列表合并又从 optimistic task
                      // 把蓝点写回来。打开 task 时必须在同一个 workspace 事务里清掉这份投影。
                      unreadAt: undefined,
                    },
                  }
                : current.optimisticTaskListByTaskId;
            const activeTaskId = id;
            const activeTaskConfig = activeTaskId
              ? resolveActiveTaskConfigOptionsOnSwitch(current, activeTaskId)
              : null;
            const nextState = {
              ...current,
              taskUnreadByTaskId: restTaskUnreadByTaskId,
              optimisticTaskListByTaskId: nextOptimisticTaskListByTaskId,
              activeTaskId: id,
              // grouped 的 New task 草稿行只是当前草稿态锚点。
              // 一旦用户选中真实 task，就代表离开这个临时实体，必须立刻清掉，避免侧栏留下不可操作的假行。
              groupedDraftTask: id ? null : current.groupedDraftTask,
            };
            return activeTaskId && activeTaskConfig
              ? {
                  ...nextState,
                  taskConfigOptionsByTaskId: {
                    ...current.taskConfigOptionsByTaskId,
                    [activeTaskId]: activeTaskConfig.configOptions,
                  },
                  taskConfigOptionsStatusByTaskId: {
                    ...current.taskConfigOptionsStatusByTaskId,
                    [activeTaskId]: activeTaskConfig.status,
                  },
                }
              : nextState;
          },
          workspaceIdentity,
        );

        const navUpdate = id
          ? {
              taskNavHistory: pushNavEntry(
                state.taskNavHistory,
                workspacePath,
                id,
                workspaceIdentity,
              ),
            }
          : {};

        return { ...workspaceUpdate, ...navUpdate };
      });
    },

    promoteGroupedDraftTask: (
      workspacePath: string,
      taskId: string,
      draft: GroupedDraftTaskState,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const optimisticTask: ZCodeTaskMeta = {
              taskId,
              traceId: `session-${taskId}` as ZCodeTaskMeta["traceId"],
              title: "",
              workspacePath,
              ...(workspaceIdentity ? { workspaceIdentity } : {}),
              createdAt: draft.createdAt,
              // 这是只用于填补 ACK 空档的 renderer 占位行，不是 session 真相。
              // updatedAt 用最低哨兵值，保证任何 sessions-index 权威 meta 都会在
              // mergeTaskWithOptimisticMeta 中获胜，避免本地时钟压住 mode/provider/status 等字段。
              updatedAt: 0,
              mode: "build",
              provider: current.selectedProvider,
            };
            // task 导航和 draft session 创建是不同状态转换。只有创建成功边界
            // 才能把发起命令时捕获的 grouped placement 绑定到新 task。ACK 返回期间用户
            // 可能已进入另一份草稿，因此只在 identity 仍匹配时清除当前草稿。
            // 过去这里先清除 draft row，却要等 sessions-index 才有真实 task meta，
            // create/send ACK 与权威投影之间会闪出空档。提升事务同时写最小乐观元数据，
            // 但不伪造 conversation 状态，后续仍由 desktop continuous / web replayable 权威投影收口。
            return {
              ...current,
              groupedDraftTask:
                current.groupedDraftTask?.draftId === draft.draftId
                  ? null
                  : current.groupedDraftTask,
              optimisticTaskListByTaskId: {
                ...current.optimisticTaskListByTaskId,
                // task_created 可能比 command ACK 更早到 renderer；若已有更完整的乐观元数据，
                // 不能被这个仅用于补空档的最小行反向降级。
                [taskId]: current.optimisticTaskListByTaskId[taskId] ?? optimisticTask,
              },
              promotedGroupedDraftTaskByTaskId: {
                ...current.promotedGroupedDraftTaskByTaskId,
                [taskId]: draft,
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    clearPromotedGroupedDraftTask: (
      workspacePath: string,
      taskId: string,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            if (!current.promotedGroupedDraftTaskByTaskId[taskId]) {
              return current;
            }
            // promoted placement 只负责草稿提升到 SQLite 排序收敛前的单次事务。
            // 落库后必须消费，避免用户后续手动拖动 task 时被旧 placement 再次拉回原 group。
            const { [taskId]: _consumedPromotedDraft, ...restPromotedGroupedDraftTaskByTaskId } =
              current.promotedGroupedDraftTaskByTaskId;
            return {
              ...current,
              promotedGroupedDraftTaskByTaskId: restPromotedGroupedDraftTaskByTaskId,
            };
          },
          workspaceIdentity,
        ),
      );
    },

    setDraftSessionId: (
      workspacePath: string,
      sessionId: string | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            if (current.draftSessionId === sessionId) {
              return current;
            }
            return { ...current, draftSessionId: sessionId };
          },
          workspaceIdentity,
        ),
      );
    },

    invalidateDraftRuntime: (workspacePath: string, workspaceIdentity?: string) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            // protocol-v4 的草稿预热会话只存在于 SessionPane 内，不能仅清空
            // legacy draftSessionId。递增版本让 pane 精确回收未提升的预热会话并重建能力快照。
            draftRuntimeInvalidationVersion: current.draftRuntimeInvalidationVersion + 1,
            draftSessionId: null,
          }),
          workspaceIdentity,
        ),
      );
    },

    requestComposerTextInsert: (
      workspacePath: string,
      text: string,
      workspaceIdentity?: string,
      mention?: ComposerMentionPrefill,
      mode?: "replace" | "prepend-if-missing",
    ) => {
      let nextRequestId = 0;
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const requestId = current.composerTextInsertVersion + 1;
            nextRequestId = requestId;
            return {
              ...current,
              composerTextInsertVersion: requestId,
              composerTextInsertRequest: {
                requestId,
                text,
                ...(mention ? { mention } : {}),
                ...(mode ? { mode } : {}),
              },
            };
          },
          workspaceIdentity,
        ),
      );
      return nextRequestId;
    },

    clearComposerTextInsertRequest: (
      workspacePath: string,
      requestId: number,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) =>
            current.composerTextInsertRequest?.requestId === requestId
              ? { ...current, composerTextInsertRequest: null }
              : current,
          workspaceIdentity,
        ),
      );
    },

    requestTimelineBottom: (workspacePath: string, taskId: string, workspaceIdentity?: string) => {
      let nextRequestId = 0;
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const requestId = current.timelineBottomRequestVersion + 1;
            nextRequestId = requestId;
            return {
              ...current,
              timelineBottomRequestVersion: requestId,
              timelineBottomRequest: { requestId, taskId },
            };
          },
          workspaceIdentity,
        ),
      );
      return nextRequestId;
    },

    clearTimelineBottomRequest: (
      workspacePath: string,
      requestId: number,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) =>
            current.timelineBottomRequest?.requestId === requestId
              ? { ...current, timelineBottomRequest: null }
              : current,
          workspaceIdentity,
        ),
      );
    },

    startDraft: (
      workspacePath: string,
      provider?: ZCodeProvider,
      workspaceIdentity?: string,
      options?: {
        groupedDraftPlacement?: GroupedDraftTaskPlacement;
        createSource?: SessionCreateSource;
      },
    ) => {
      const normalizedProvider = provider
        ? normalizeAgentProviderToZCodeAgent(provider)
        : undefined;

      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const nextSelectedProvider = normalizeAgentProviderToZCodeAgent(
              normalizedProvider ?? current.selectedProvider,
            );
            const shouldResetSupplierForDraftProvider =
              Boolean(normalizedProvider) && nextSelectedProvider !== current.selectedProvider;
            const shouldClearSlashCommands =
              current.activeTaskId !== null || shouldResetSupplierForDraftProvider;
            const shouldInheritActiveTaskConfig =
              current.activeTaskId !== null && !shouldResetSupplierForDraftProvider;
            const activeTaskIdForInheritance = shouldInheritActiveTaskConfig
              ? current.activeTaskId
              : null;
            const cachedActiveTaskConfigOptions = activeTaskIdForInheritance
              ? current.taskConfigOptionsByTaskId[activeTaskIdForInheritance]
              : null;
            const inheritedConfigOptions = activeTaskIdForInheritance
              ? cachedActiveTaskConfigOptions && cachedActiveTaskConfigOptions.length > 0
                ? cachedActiveTaskConfigOptions
                : // protocol-v4 当前任务的配置可能只完成了 workspace 投影，
                  // legacy task 缓存尚未写入或仍是首帧空数组。此时工具条已经显示
                  // current.configOptions，新草稿必须从当前投影继承，不能无种子预热。
                  current.configOptions
              : null;
            const inheritedDraftConfigOptions =
              inheritedConfigOptions && inheritedConfigOptions.length > 0
                ? cloneConfigOptions(inheritedConfigOptions)
                : null;
            const inheritedConfigOptionsStatus =
              current.activeTaskId && inheritedDraftConfigOptions
                ? (current.taskConfigOptionsStatusByTaskId[current.activeTaskId] ?? "ready")
                : current.configOptionsStatus;
            const nextGroupedDraftTask = (() => {
              const placement = options?.groupedDraftPlacement;
              if (!placement) {
                return null;
              }
              if (
                current.activeTaskId === null &&
                current.groupedDraftTask &&
                isSameGroupedDraftPlacement(current.groupedDraftTask.placement, placement)
              ) {
                return current.groupedDraftTask;
              }
              if (current.activeTaskId === null && current.groupedDraftTask) {
                // 同一个 grouped 草稿可以被不同 New task 入口重新定位。
                // 连续点击同入口要复用临时实体，但从全局入口切到 group 入口时，创建位置必须跟随最新入口。
                return {
                  ...current.groupedDraftTask,
                  workspacePath,
                  ...(workspaceIdentity ? { workspaceIdentity } : {}),
                  placement,
                };
              }
              const createdAt = Date.now();
              return {
                draftId: createGroupedDraftId(createdAt),
                workspacePath,
                ...(workspaceIdentity ? { workspaceIdentity } : {}),
                placement,
                createdAt,
              };
            })();
            return {
              ...current,
              activeTaskId: null,
              groupedDraftTask: nextGroupedDraftTask,
              draftCreateSource:
                options?.createSource ?? (options?.groupedDraftPlacement ? "group" : "session"),
              draftRuntime: { status: "idle", error: null },
              // 从已有 task 点 New Task 时，草稿输入框必须继承当前 task 的完整配置。
              // 否则后续 workspace prepare 会按 Team Plan / 默认模型重建草稿，把 deepseek 回弹成 GLM。
              ...(inheritedDraftConfigOptions
                ? {
                    configOptions: inheritedDraftConfigOptions,
                    configOptionsStatus: inheritedConfigOptionsStatus,
                    // 旧 deferred draft session 可能仍停在上一次默认模型。
                    // 继承 active task 后必须重新创建 draft session，避免旧 session 回包覆盖新草稿。
                    draftSessionId: null,
                  }
                : {}),
              draftError: null,
              modelSwitchRequestId: null,
              modelSwitchPending: false,
              modelSwitchStage: "idle",
              // Cmd/Ctrl+N 或任务列表"新建任务"之前只切了 store 状态，没有显式把焦点交还给输入框。
              // Electron 菜单和按钮点击会先拿走焦点，导致用户看到草稿已打开，但光标要过一拍才回来。
              // 这里在每次进入草稿态时递增版本号，让 ChatView 能在状态切换完成后主动 focus 到 Lexical 输入框。
              draftFocusVersion: current.draftFocusVersion + 1,
              optimisticMessages: [],
              // 新建任务态（taskId=null）现在也有自己的未发送草稿。
              // 这里切到草稿态时只重置“本次创建任务的瞬时状态”，不主动清空 null 作用域草稿，
              // 这样用户从 taskA/B/C 切回“新建任务”时，才能继续编辑刚才没发出去的内容。
              // 新建草稿如果继续沿用上一条会话的 slashCommands，输入 `/` 时会看到旧任务遗留的命令。
              // 但以前这里每次“新建任务”都无条件清空，草稿态重复点击会把命令列表清空且不会触发回填。
              // 仅在“从 task 切到 draft”或“provider 真正切换”时清空，避免同草稿态重复点击误伤。
              ...(shouldClearSlashCommands ? { slashCommands: [] } : {}),
              ...(normalizedProvider ? { selectedProvider: nextSelectedProvider } : {}),
              ...(shouldResetSupplierForDraftProvider
                ? {
                    // 某些“新建任务”入口会把当前 selectedProvider 透传回 startDraft。
                    // 如果 provider 实际没变化却强制重置 supplier，会出现“显示 custom 模型但 custom 选项被锁”的撕裂态。
                    // 这里只在 provider 真正切换时才回到 native，避免同 provider 新建草稿误伤现有 supplier 上下文。
                    selectedSupplierKey: buildNativeSupplierKey(nextSelectedProvider),
                    isGhostSupplier: false,
                    supplierMismatchReason: null,
                  }
                : {}),
            };
          },
          workspaceIdentity,
        ),
      );
    },

    clearGroupedDraftTask: (workspacePath: string, workspaceIdentity?: string) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) =>
            current.groupedDraftTask ? { ...current, groupedDraftTask: null } : current,
          workspaceIdentity,
        ),
      );
    },

    bindRuntimeProvider: (
      workspacePath: string,
      provider: ZCodeProvider,
      workspaceIdentity?: string,
    ) =>
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            selectedProvider: normalizeAgentProviderToZCodeAgent(provider),
          }),
          workspaceIdentity,
        ),
      ),

    setModelSelectionResolution: (
      workspacePath: string,
      resolution: Pick<
        ModelSelectionResolution,
        "selectedSupplierKey" | "isGhostSupplier" | "supplierMismatchReason"
      >,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            selectedSupplierKey: resolution.selectedSupplierKey,
            isGhostSupplier: resolution.isGhostSupplier,
            supplierMismatchReason: resolution.supplierMismatchReason,
          }),
          workspaceIdentity,
        ),
      );
    },

    setWorkspaceInitState: (
      workspacePath: string,
      status: ZCodeWorkspaceInitStatus,
      error?: string | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            workspaceInit: {
              ...getWorkspaceInitState(current),
              status,
              error: error ?? null,
            },
          }),
          workspaceIdentity,
        ),
      );
    },

    setWorkspaceInitAttempts: (
      workspacePath: string,
      attempts: number,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            workspaceInit: {
              ...getWorkspaceInitState(current),
              attempts,
            },
          }),
          workspaceIdentity,
        ),
      );
    },

    setTaskState: (
      workspacePath: string,
      status: ZCodeTaskRuntimeStatus,
      error?: string | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            draftRuntime: {
              status,
              error: error ?? null,
            },
          }),
          workspaceIdentity,
        ),
      );
    },

    setDraftError: (
      workspacePath: string,
      error: ZCodeUiError | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            // 草稿态首发失败时还没有 taskId，错误如果只留在组件内存里，
            // 切到别的页面再回来就看不到了。单独保存一份 workspace 级 draftError，
            // 保证"未建 task 的错误"也能在当前工作区里继续显示。
            draftError: error,
          }),
          workspaceIdentity,
        ),
      );
    },

    startModelSwitch: (
      workspacePath: string,
      requestId: string,
      stage: ModelSwitchStage = "settingModel",
      workspaceIdentity?: string,
      options?: { pending?: boolean },
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            modelSwitchRequestId: requestId,
            // 普通 session/setModel 已经先乐观更新 UI，只需要 requestId 防止旧回包覆盖新选择。
            // 只有 custom provider、runtime restart 等重路径才需要把 toolbar 置为 loading。
            modelSwitchPending: options?.pending ?? true,
            modelSwitchStage: stage,
          }),
          workspaceIdentity,
        ),
      );
    },

    updateModelSwitchStage: (
      workspacePath: string,
      requestId: string,
      stage: ModelSwitchStage,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            if (current.modelSwitchRequestId !== requestId) {
              return current;
            }

            return {
              ...current,
              modelSwitchStage: stage,
            };
          },
          workspaceIdentity,
        ),
      );
    },

    finishModelSwitch: (workspacePath: string, requestId: string, workspaceIdentity?: string) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            if (current.modelSwitchRequestId !== requestId) {
              return current;
            }

            return {
              ...current,
              modelSwitchRequestId: null,
              modelSwitchPending: false,
              modelSwitchStage: "idle",
            };
          },
          workspaceIdentity,
        ),
      );
    },

    setConfigOptions: (
      workspacePath: string,
      options: ZCodeConfigOption[],
      workspaceIdentity?: string,
    ) => {
      set((state) => {
        const current = getWorkspaceState(state, workspacePath, workspaceIdentity);
        const normalizedOptions = normalizeConfigOptions(options);
        const skipped = areConfigOptionsEquivalent(current.configOptions, normalizedOptions);
        if (skipped) {
          // 无 API key / 旧模型不可用时，工具栏 recovery effect 会多次提交同一份空模型配置。
          // 等价配置不应触发 workspace 级 store 通知，否则 ChatInputToolbar 会在 effect 中再次 setConfigOptions。
          return state;
        }

        return updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            // startDraft 先保存 active task 的预热种子，随后异步目录水合会走到这里。
            // 目录刷新不是草稿生命周期终点，不能清掉种子，否则 createSession 会回退全局默认模型。
            configOptions: normalizedOptions,
          }),
          workspaceIdentity,
        );
      });
    },

    setConfigOptionsStatus: (
      workspacePath: string,
      status: "idle" | "loading" | "ready" | "error",
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            configOptionsStatus: status,
          }),
          workspaceIdentity,
        ),
      );
    },

    setSlashCommands: (
      workspacePath: string,
      commands: ZCodeSlashCommand[],
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            slashCommands: commands,
          }),
          workspaceIdentity,
        ),
      );
    },

    setCurrentModeId: (
      workspacePath: string,
      modeId: string | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const nextConfigOptions = updateCurrentModeConfigOption(current.configOptions, modeId);
            const activeTaskPatch = updateActiveTaskConfigOptions(current, (options) =>
              updateCurrentModeConfigOption(options, modeId),
            );
            if (nextConfigOptions === current.configOptions && !activeTaskPatch) {
              return current;
            }
            return {
              ...current,
              configOptions: nextConfigOptions,
              // active task 运行态会忽略 workspace_config_options_update，
              // first-send/restore 又可能先写入只含 model 的 task 配置。
              // mode_update 是 session 事实源，必须同步补到 task 配置桶，否则发送后模式入口会消失。
              ...activeTaskPatch,
            };
          },
          workspaceIdentity,
        ),
      );
    },

    bumpTaskListVersion: (workspacePath: string, workspaceIdentity?: string) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            taskListVersion: current.taskListVersion + 1,
          }),
          workspaceIdentity,
        ),
      );
    },

    setTaskListCache: (
      workspacePath: string,
      tasks: ZCodeTaskMeta[],
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            taskListCache: tasks,
            // unread 的真实来源已经统一收敛到 task meta.unreadAt。
            // 这里不再把列表缓存重建成另一份“未读真相源”，避免 cache 刷新和局部 optimistic 更新互相打架。
            taskUnreadByTaskId: current.taskUnreadByTaskId,
          }),
          workspaceIdentity,
        ),
      );
    },

    setTaskUnreadIndicator: (
      workspacePath: string,
      taskId: string,
      hasUnread: boolean,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const optimisticTaskMeta = current.optimisticTaskListByTaskId[taskId];
            const cachedTaskMeta = current.taskListCache?.find((task) => task.taskId === taskId);
            const baseTaskMeta = optimisticTaskMeta ?? cachedTaskMeta;
            const currentHasUnread = current.taskUnreadByTaskId[taskId] === true;
            const currentUnreadAt = optimisticTaskMeta?.unreadAt ?? cachedTaskMeta?.unreadAt;

            if (hasUnread) {
              const nextUnreadAt = baseTaskMeta?.unreadAt ?? Date.now();
              if (currentHasUnread && currentUnreadAt === nextUnreadAt) {
                return current;
              }

              const nextOptimisticTaskListByTaskId = baseTaskMeta
                ? {
                    ...current.optimisticTaskListByTaskId,
                    [taskId]: {
                      ...baseTaskMeta,
                      unreadAt: nextUnreadAt,
                    },
                  }
                : current.optimisticTaskListByTaskId;

              return {
                ...current,
                optimisticTaskListByTaskId: nextOptimisticTaskListByTaskId,
                taskUnreadByTaskId: {
                  ...current.taskUnreadByTaskId,
                  [taskId]: true,
                },
              };
            }

            if (!currentHasUnread && currentUnreadAt === undefined) {
              // 权限确认后本地响应和 stream 响应都会清一次未读。
              // 已经是已读时直接复用 workspace state，避免任务列表和 ChatView 被无意义刷新。
              return current;
            }

            const { [taskId]: _removedTaskUnread, ...restTaskUnreadByTaskId } =
              current.taskUnreadByTaskId;
            const nextOptimisticTaskListByTaskId = baseTaskMeta
              ? {
                  ...current.optimisticTaskListByTaskId,
                  [taskId]: {
                    ...baseTaskMeta,
                    unreadAt: undefined,
                  },
                }
              : current.optimisticTaskListByTaskId;

            return {
              ...current,
              optimisticTaskListByTaskId: nextOptimisticTaskListByTaskId,
              taskUnreadByTaskId: restTaskUnreadByTaskId,
            };
          },
          workspaceIdentity,
        ),
      );
    },
  };
}
