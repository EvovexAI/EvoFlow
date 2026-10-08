/* oxlint-disable eslint(max-lines) -- provider 卡片同时承载名称、连接、鉴权、模型和映射编辑；本阶段先维持单组件，后续再按表单域拆分。 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  getProviderFormApiKey,
  getProviderFormLabel,
  type ProviderSettingsFormProvider,
  type ProviderSettingsFormModel,
} from "@/lib/providerSettingsFormTypes.js";
import type { ModelConnectivityResult } from "@zcode/shared";
import {
  isApiKeyAccess,
  type ProviderApiType,
  type SavePersonalModelDraftInput,
} from "@zcode/provider";
import { logger } from "@/logger.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Switch } from "@/components/ui/switch.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import { resolvePendingProviderDraftSave, type ProviderDraftValues } from "./ProviderDraftSave.js";
import {
  ProviderApiKeySection,
  ProviderCardHeader,
  ProviderConnectionSection,
  ProviderModelsSection,
} from "./ProviderCardSections.js";
import { resolveModelProviderDisplayName } from "./constants.js";
import { useProviderDetailFeedback } from "./ProviderDetailFeedback.js";
import { useIdleTrigger } from "./useIdleTrigger.js";
import { useOptimisticReorder } from "./useOptimisticReorder.js";

type ProviderNameEditKeyAction = "commit" | "cancel";
type ProviderDraftCleanupAction = "commit" | "skip-delete";
interface ProviderSaveNotificationTarget {
  modelId?: string;
  operation?: "delete";
  /** 显式弹窗在原草稿中重试，不让外部通知另起一次脱离编辑事务的保存。 */
  draftOwnsRetry?: boolean;
}

function shouldApplyProviderSaveCompletion(
  currentRevision: number,
  completedRevision: number,
): boolean {
  return currentRevision === completedRevision;
}

function resolveProviderDraftCleanupAction({
  deleteRequested,
}: {
  deleteRequested: boolean;
}): ProviderDraftCleanupAction {
  return deleteRequested ? "skip-delete" : "commit";
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function runProviderDeleteWithDraftCleanupGuard({
  deleteRequestedRef,
  onDelete,
}: {
  deleteRequestedRef: { current: boolean };
  onDelete?: () => void | Promise<void>;
}) {
  if (!onDelete) {
    return;
  }

  deleteRequestedRef.current = true;
  try {
    const result = onDelete();
    if (isPromiseLike(result)) {
      void Promise.resolve(result)
        .catch(() => undefined)
        .finally(() => {
          deleteRequestedRef.current = false;
        });
      return;
    }
  } catch (error) {
    deleteRequestedRef.current = false;
    throw error;
  }

  deleteRequestedRef.current = false;
}

function resolveProviderNameEditKeyAction(event: {
  key: string;
  compositionActive?: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
}): ProviderNameEditKeyAction | null {
  // 中文输入法用 Enter 确认候选时仍处于 composition 阶段。
  // 部分平台的 keydown 标志会先恢复 false，因此同时读取本地 composition 状态，
  // 避免提前 blur 打断候选提交，导致拼音原始按键被留在名称里。
  if (isImeComposingKeyEvent(event)) {
    return null;
  }

  if (event.key === "Enter") {
    return "commit";
  }

  if (event.key === "Escape") {
    return "cancel";
  }

  return null;
}

function resolveVisibleProviderModelsForEdit(
  provider: ProviderSettingsFormProvider,
): ProviderSettingsFormModel[] {
  return provider.models.map((model) => structuredClone(model));
}

function projectModelsToOrder(
  models: readonly ProviderSettingsFormModel[],
  modelIds: readonly string[],
): ProviderSettingsFormModel[] {
  const byId = new Map(models.map((model) => [model.modelId, model]));
  const ordered = modelIds.flatMap((modelId) => {
    const model = byId.get(modelId);
    return model ? [model] : [];
  });
  const orderedIds = new Set(ordered.map((model) => model.modelId));
  return [...ordered, ...models.filter((model) => !orderedIds.has(model.modelId))];
}

export function InlineEditableProviderCard({
  provider,
  onSave,
  onAddPersonalModel,
  onSavePersonalModelDraft,
  onSetPersonalModelEnabled,
  onDeletePersonalModel,
  onDelete,
  onTestModel,
  onReorderModelIds,
  readOnlyEndpoints,
  presetApiKeyUrl,
  onOpenPresetApiKey,
  statusSection,
  nameEditable,
  headerVisible = true,
  headerActionsVisible,
  settingsRevision,
}: {
  provider: ProviderSettingsFormProvider;
  onSave: (config: ProviderSettingsFormProvider) => void | Promise<void>;
  onAddPersonalModel?: (
    providerId: string,
    modelId: string,
    config: ProviderSettingsFormModel["personalConfig"],
    useRecommendedConfig?: boolean,
  ) => Promise<unknown>;
  onSavePersonalModelDraft?: (input: SavePersonalModelDraftInput) => Promise<unknown>;
  onSetPersonalModelEnabled?: (
    providerId: string,
    modelId: string,
    enabled: boolean,
  ) => Promise<unknown>;
  onDeletePersonalModel?: (providerId: string, modelId: string) => Promise<unknown>;
  onDelete?: () => void | Promise<void>;
  onTestModel?: (providerId: string, modelId: string) => Promise<ModelConnectivityResult>;
  onReorderModelIds?: (modelIds: string[]) => Promise<void>;
  readOnlyEndpoints?: boolean;
  presetApiKeyUrl?: string;
  onOpenPresetApiKey?: () => void;
  statusSection?: ReactNode;
  nameEditable?: boolean;
  headerVisible?: boolean;
  headerActionsVisible?: boolean;
  settingsRevision?: number;
}) {
  const { intl } = useZCodeIntl();
  const { dismissFeedback, showFeedback } = useProviderDetailFeedback();
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(getProviderFormLabel(provider));
  const [apiFormat, setApiFormat] = useState<ProviderApiType>(
    provider.config.api?.type ?? "anthropic-messages",
  );
  const [baseUrlValue, setBaseUrlValue] = useState(provider.config.api?.baseUrl ?? "");
  const [apiKeyValue, setApiKeyValue] = useState(getProviderFormApiKey(provider));
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [savingEnabled, setSavingEnabled] = useState(false);
  const authoritativeModels = useMemo(
    () => resolveVisibleProviderModelsForEdit(provider),
    [provider],
  );
  const authoritativeModelIds = useMemo(
    () => authoritativeModels.map((model) => model.modelId),
    [authoritativeModels],
  );
  const reorderModelIdsTargetRef = useRef(onReorderModelIds);
  reorderModelIdsTargetRef.current = onReorderModelIds;
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const nameCompositionActiveRef = useRef(false);
  const nameEditProviderIdRef = useRef<string | null>(null);
  const technicalInputCompositionActiveRef = useRef(false);
  const deleteRequestedRef = useRef(false);
  const selfSaveRequestedRef = useRef(false);
  const providerIdRef = useRef(provider.providerId);
  const dirtyProviderFieldsRef = useRef(new Set<keyof ProviderDraftValues>());
  const draftRevisionRef = useRef(0);
  const lastSubmittedDraftSignatureRef = useRef<string | null>(null);
  const providerDisplayName = resolveModelProviderDisplayName(provider);
  const saveNotificationRef = useRef({
    providerId: provider.providerId,
    providerDisplayName,
    formatMessage: intl.formatMessage,
    dismissFeedback,
    showFeedback,
  });
  saveNotificationRef.current = {
    providerId: provider.providerId,
    providerDisplayName,
    formatMessage: intl.formatMessage,
    dismissFeedback,
    showFeedback,
  };
  const draftRef = useRef<ProviderDraftValues>({
    nameValue: getProviderFormLabel(provider),
    apiFormat: provider.config.api?.type ?? "anthropic-messages",
    baseUrlValue: provider.config.api?.baseUrl ?? "",
    apiKeyValue: getProviderFormApiKey(provider),
  });

  useEffect(() => {
    const resolvedApiFormat = provider.config.api?.type ?? "anthropic-messages";
    const resolvedBaseUrl = provider.config.api?.baseUrl ?? "";
    const resolvedApiKey = getProviderFormApiKey(provider);
    const resolvedLabel = getProviderFormLabel(provider);
    if (providerIdRef.current !== provider.providerId) {
      providerIdRef.current = provider.providerId;
      nameEditProviderIdRef.current = null;
      nameCompositionActiveRef.current = false;
      setEditingName(false);
      draftRevisionRef.current += 1;
      dirtyProviderFieldsRef.current.clear();
      lastSubmittedDraftSignatureRef.current = null;
    }
    const syncField = <TKey extends keyof ProviderDraftValues>(
      key: TKey,
      value: ProviderDraftValues[TKey],
      apply: (next: ProviderDraftValues[TKey]) => void,
    ) => {
      if (dirtyProviderFieldsRef.current.has(key) && draftRef.current[key] !== value) return;
      dirtyProviderFieldsRef.current.delete(key);
      draftRef.current[key] = value;
      apply(value);
    };
    syncField("nameValue", resolvedLabel, setNameValue);
    syncField("apiFormat", resolvedApiFormat, setApiFormat);
    syncField("baseUrlValue", resolvedBaseUrl, setBaseUrlValue);
    syncField("apiKeyValue", resolvedApiKey, setApiKeyValue);
  }, [provider]);

  const markDraftDirty = useCallback((field: keyof ProviderDraftValues) => {
    dirtyProviderFieldsRef.current.add(field);
    selfSaveRequestedRef.current = false;
    draftRevisionRef.current += 1;
    saveNotificationRef.current.dismissFeedback(`provider-save:${providerIdRef.current}`);
  }, []);

  const runSaveOperation = useCallback(
    async (operation: () => Promise<void>, target: ProviderSaveNotificationTarget = {}) => {
      selfSaveRequestedRef.current = true;
      const revision = draftRevisionRef.current + 1;
      draftRevisionRef.current = revision;
      const notification = saveNotificationRef.current;
      const dedupeKey = target.modelId
        ? `model-save:${notification.providerId}:${target.modelId}`
        : `provider-save:${notification.providerId}`;
      const messageValues = {
        provider: notification.providerDisplayName,
        model: target.modelId ?? "",
      };
      const messageIds = target.modelId
        ? target.operation === "delete"
          ? {
              pending: "settings.modelProvider.modelDeleting",
              success: "settings.modelProvider.modelDeleteSuccess",
              failure: "settings.modelProvider.modelDeleteFailure",
            }
          : {
              pending: "settings.modelProvider.modelSaving",
              success: "settings.modelProvider.modelSaveSuccess",
              failure: "settings.modelProvider.modelSaveFailure",
            }
        : {
            pending: "settings.modelProvider.providerSaving",
            success: "settings.modelProvider.providerSaveSuccess",
            failure: "settings.modelProvider.providerSaveFailure",
          };
      notification.showFeedback({
        key: dedupeKey,
        message: notification.formatMessage(
          {
            id: messageIds.pending,
          },
          messageValues,
        ),
        state: "pending",
        durationMs: 0,
      });
      try {
        await operation();
        if (!shouldApplyProviderSaveCompletion(draftRevisionRef.current, revision)) return;
        notification.showFeedback({
          key: dedupeKey,
          message: notification.formatMessage(
            {
              id: messageIds.success,
            },
            messageValues,
          ),
          state: "success",
        });
      } catch (error) {
        selfSaveRequestedRef.current = false;
        if (shouldApplyProviderSaveCompletion(draftRevisionRef.current, revision)) {
          notification.showFeedback({
            key: dedupeKey,
            message: notification.formatMessage(
              {
                id: messageIds.failure,
              },
              {
                ...messageValues,
                error: error instanceof Error ? error.message : String(error),
              },
            ),
            state: "failure",
            durationMs: 8_000,
            ...(target.draftOwnsRetry
              ? {}
              : {
                  actionLabel: notification.formatMessage({ id: "common.retry" }),
                  onAction: () => {
                    void runSaveOperation(operation, target).catch(() => undefined);
                  },
                }),
            dismissible: true,
            dismissLabel: notification.formatMessage({ id: "common.close" }),
          });
        }
        throw error;
      }
    },
    // runSaveOperation 参与卸载保存 effect 的依赖链。intl/provider 随渲染换引用时，
    // 回调也换引用会先执行旧 effect cleanup，进而再次保存并形成循环；通知身份通过 ref 读取。
    [],
  );

  const persistModelOrder = useCallback(
    async (modelIds: readonly string[]) => {
      const target = reorderModelIdsTargetRef.current;
      if (!target) throw new Error("当前设置入口未装配 Model 调序能力");
      await runSaveOperation(async () => {
        await target([...modelIds]);
      });
    },
    [provider.providerId, runSaveOperation],
  );
  const optimisticModelOrder = useOptimisticReorder({
    authoritativeIds: authoritativeModelIds,
    persist: persistModelOrder,
  });

  // 成员与配置只有 Host View 一份事实。旧本地副本在异步成功/失败时会覆盖新 View，
  // 甚至短暂移除正在编辑的模型。只保留拖拽顺序这一份明确的 pending intent。
  const models = useMemo(
    () => projectModelsToOrder(authoritativeModels, optimisticModelOrder.renderedIds),
    [authoritativeModels, optimisticModelOrder.renderedIds],
  );

  const saveProviderWithCleanupGuard = useCallback(
    async (nextProvider: ProviderSettingsFormProvider, onFailure?: () => void): Promise<void> => {
      const operation = async () => {
        await onSave(nextProvider);
      };
      await runSaveOperation(operation).catch((error) => {
        logger.warn("[ModelProviderSection] 自动保存 Provider 草稿失败", {
          providerId: provider.providerId,
          error,
        });
        onFailure?.();
        throw error;
      });
    },
    [onSave, provider.providerId, runSaveOperation],
  );

  const cancelIdleDraftSaveRef = useRef<() => void>(() => undefined);

  const commitPendingDraft = useCallback(
    async (reason: string, nameConfirmed = false): Promise<void> => {
      cancelIdleDraftSaveRef.current();
      const nextProvider = resolvePendingProviderDraftSave({
        provider,
        draft: draftRef.current,
        readOnlyEndpoints,
        nameConfirmed,
        now: Date.now,
      });
      if (!nextProvider) {
        return;
      }
      const signature = JSON.stringify({
        ...draftRef.current,
        nameValue: nameConfirmed ? draftRef.current.nameValue : getProviderFormLabel(provider),
      });
      if (lastSubmittedDraftSignatureRef.current === signature) return;
      lastSubmittedDraftSignatureRef.current = signature;

      // Linux 下点击左侧供应商切换时，输入框 blur 与 Popover 关闭顺序不稳定，
      // 连接草稿可能在组件卸载前还没走到 blur 保存。这里在切换/卸载前兜底提交，
      // 避免“新供应商接口地址一切走就恢复为空”。
      logger.info("[ModelProviderSection] 切换前保存未提交的供应商草稿", {
        providerId: provider.providerId,
        reason,
      });
      await saveProviderWithCleanupGuard(nextProvider, () => {
        if (lastSubmittedDraftSignatureRef.current === signature) {
          lastSubmittedDraftSignatureRef.current = null;
        }
      });
    },
    [provider, readOnlyEndpoints, saveProviderWithCleanupGuard],
  );

  const idleDraftSave = useIdleTrigger(() => {
    void commitPendingDraft("idle").catch(() => undefined);
  });
  cancelIdleDraftSaveRef.current = idleDraftSave.cancel;
  const scheduleIdleDraftSave = idleDraftSave.schedule;
  const cancelIdleDraftSave = idleDraftSave.cancel;

  const handleProviderEnabledChange = async (enabled: boolean) => {
    if (savingEnabled) return;
    cancelIdleDraftSave();
    setSavingEnabled(true);
    // 同一次保存带上尚未提交的连接草稿，避免开关保存把刚输入的 Key 覆盖回旧值。
    const draft =
      resolvePendingProviderDraftSave({
        provider,
        draft: draftRef.current,
        readOnlyEndpoints,
        now: Date.now,
      }) ?? provider;
    try {
      await saveProviderWithCleanupGuard({ ...draft, enabledUpdate: enabled });
    } catch {
      // 统一保存入口已记录错误及可重试反馈；不乐观覆盖权威 enabled。
    } finally {
      setSavingEnabled(false);
    }
  };

  useEffect(() => {
    return () => {
      cancelIdleDraftSave();
      const cleanupAction = resolveProviderDraftCleanupAction({
        deleteRequested: deleteRequestedRef.current,
      });
      if (cleanupAction === "skip-delete") {
        // 确认删除会触发详情卡片卸载；如果 cleanup 继续补保存草稿，
        // 被删除的 provider 会在 delete 后又被 save 重新创建。
        logger.info("[ModelProviderSection] 删除中的供应商跳过 cleanup 草稿保存", {
          providerId: provider.providerId,
        });
        return;
      }
      if (selfSaveRequestedRef.current) {
        selfSaveRequestedRef.current = false;
        // 模型编辑会先保存新的有效模型列表，随后父层乐观更新会触发本组件 cleanup。
        // 此时如果再用旧草稿补保存，会覆盖刚提交的模型列表。
        logger.info("[ModelProviderSection] 内部保存触发的刷新跳过 cleanup 草稿保存", {
          providerId: provider.providerId,
        });
        return;
      }
      void commitPendingDraft("cleanup").catch(() => undefined);
    };
  }, [cancelIdleDraftSave, commitPendingDraft, provider.providerId]);

  const handleNameValueChange = useCallback(
    (value: string) => {
      markDraftDirty("nameValue");
      draftRef.current.nameValue = value;
      setNameValue(value);
    },
    [markDraftDirty],
  );

  const handleBaseUrlValueChange = useCallback(
    (value: string) => {
      markDraftDirty("baseUrlValue");
      draftRef.current.baseUrlValue = value;
      setBaseUrlValue(value);
      scheduleIdleDraftSave();
    },
    [markDraftDirty, scheduleIdleDraftSave],
  );

  const handleApiKeyValueChange = useCallback(
    (value: string) => {
      markDraftDirty("apiKeyValue");
      draftRef.current.apiKeyValue = value;
      setApiKeyValue(value);
      scheduleIdleDraftSave();
    },
    [markDraftDirty, scheduleIdleDraftSave],
  );

  const handleNameBlur = useCallback(() => {
    // Esc/切换供应商先取消编辑意图，随后发生的 blur 不得补发保存。
    if (nameEditProviderIdRef.current !== provider.providerId) return;
    nameEditProviderIdRef.current = null;
    setEditingName(false);
    const trimmed = draftRef.current.nameValue.trim();
    const currentLabel = getProviderFormLabel(provider);
    if (trimmed && trimmed !== currentLabel) {
      void commitPendingDraft("name-blur", true).catch(() => undefined);
    } else {
      draftRef.current.nameValue = currentLabel;
      setNameValue(currentLabel);
      dirtyProviderFieldsRef.current.delete("nameValue");
    }
  }, [commitPendingDraft, provider]);

  const handleNameKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const action = resolveProviderNameEditKeyAction({
        key: event.key,
        compositionActive: nameCompositionActiveRef.current,
        nativeEvent: event.nativeEvent,
      });
      if (action === "commit") {
        event.preventDefault();
        (event.target as HTMLInputElement).blur();
      } else if (action === "cancel") {
        event.preventDefault();
        nameEditProviderIdRef.current = null;
        nameCompositionActiveRef.current = false;
        const label = getProviderFormLabel(provider);
        draftRef.current.nameValue = label;
        dirtyProviderFieldsRef.current.delete("nameValue");
        setNameValue(label);
        setEditingName(false);
      }
    },
    [provider],
  );

  const handleStartEditName = useCallback(() => {
    nameEditProviderIdRef.current = provider.providerId;
    nameCompositionActiveRef.current = false;
    setEditingName(true);
    requestAnimationFrame(() => nameInputRef.current?.focus());
  }, [provider.providerId]);

  const saveConnection = useCallback(
    () => void commitPendingDraft("connection-blur").catch(() => undefined),
    [commitPendingDraft],
  );

  const handleApiFormatChange = useCallback(
    (value: ProviderApiType) => {
      markDraftDirty("apiFormat");
      draftRef.current.apiFormat = value;
      setApiFormat(value);
      void commitPendingDraft("api-format-change").catch(() => undefined);
    },
    [commitPendingDraft, markDraftDirty],
  );

  const handleApiKeyBlur = useCallback(() => {
    void commitPendingDraft("api-key-blur").catch(() => undefined);
  }, [commitPendingDraft]);

  const handleTextCommitKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") {
      return;
    }
    // 候选确认的 Enter 不能被当作表单提交。本地 ref 覆盖
    // Electron/macOS 上 nativeEvent.isComposing 过早变回 false 的时序。
    if (
      isImeComposingKeyEvent({
        compositionActive: technicalInputCompositionActiveRef.current,
        nativeEvent: event.nativeEvent,
      })
    ) {
      return;
    }
    event.currentTarget.blur();
  }, []);
  const handleTechnicalInputCompositionStart = useCallback(() => {
    technicalInputCompositionActiveRef.current = true;
  }, []);
  const handleTechnicalInputCompositionEnd = useCallback(() => {
    technicalInputCompositionActiveRef.current = false;
  }, []);

  const handleTestModel = useCallback(
    async (model: string): Promise<ModelConnectivityResult> => {
      if (!onTestModel) {
        return Promise.resolve({
          success: false,
          error: { message: "Model connectivity test is unavailable" },
        });
      }

      // 连接测试曾把 Renderer 模型快照交给外层重新保存，绕过了模型草稿的
      // revision 边界。现在只 flush 本卡片唯一的 Provider 草稿；Service 会等待同一 Provider
      // 操作队列和 Registry 刷新完成，再按正式 providerId/modelId 创建 Model。
      await commitPendingDraft("connectivity-test");
      return onTestModel(provider.providerId, model);
    },
    [commitPendingDraft, onTestModel, provider.providerId],
  );

  const handleModelCommit = useCallback(
    async (
      originalModelId: string,
      nextModel: ProviderSettingsFormModel,
      basedOnRevision: number,
    ): Promise<void> => {
      const trimmed = nextModel.modelId.trim();
      const index = models.findIndex((model) => model.modelId === originalModelId);
      const currentModel = models[index];
      if (!currentModel || !trimmed || !onSavePersonalModelDraft) {
        throw new Error("当前设置入口未装配原子 Model Draft 保存能力");
      }
      const next = [...models];
      next[index] = { ...nextModel, modelId: trimmed, hasPersonalConfig: true };
      if (JSON.stringify(next) === JSON.stringify(models)) {
        return;
      }
      await runSaveOperation(
        async () => {
          await onSavePersonalModelDraft({
            providerId: provider.providerId,
            originalModelId: currentModel.modelId,
            nextModelId: trimmed,
            personalConfig: structuredClone(nextModel.personalConfig),
            ...(nextModel.useRecommendedConfig === undefined
              ? {}
              : { useRecommendedConfig: nextModel.useRecommendedConfig }),
            basedOnRevision,
          });
        },
        { modelId: trimmed, draftOwnsRetry: true },
      );
    },
    [models, onSavePersonalModelDraft, provider.providerId, runSaveOperation],
  );

  const handleDeleteModel = useCallback(
    (modelId: string) => {
      const index = models.findIndex((model) => model.modelId === modelId);
      const model = models[index];
      if (!model) {
        return;
      }
      if (!model.builtin) {
        void runSaveOperation(
          async () => {
            if (!onDeletePersonalModel)
              throw new Error("当前设置入口未装配 Personal Model 删除能力");
            await onDeletePersonalModel(provider.providerId, model.modelId);
          },
          { modelId: model.modelId, operation: "delete" },
        ).catch((error) => {
          logger.warn("[ModelProviderSection] 删除 Personal Model 失败", {
            providerId: provider.providerId,
            modelId: model.modelId,
            error,
          });
        });
        return;
      }
    },
    [models, onDeletePersonalModel, provider.providerId, runSaveOperation],
  );

  const handleModelEnabledChange = useCallback(
    async (modelId: string, enabled: boolean) => {
      if (!onSetPersonalModelEnabled) throw new Error("当前设置入口未装配 Model 启停能力");
      await runSaveOperation(
        () =>
          onSetPersonalModelEnabled(provider.providerId, modelId, enabled).then(() => undefined),
        { modelId },
      );
    },
    [onSetPersonalModelEnabled, provider.providerId, runSaveOperation],
  );

  const handleAddModel = useCallback(
    async (model: ProviderSettingsFormModel) => {
      if (!onAddPersonalModel) throw new Error("当前设置入口未装配 Personal Model 添加能力");
      const added = { ...model, modelId: model.modelId.trim(), hasPersonalConfig: true };
      if (!added.modelId) return;
      await runSaveOperation(
        async () => {
          await onAddPersonalModel(
            provider.providerId,
            added.modelId,
            structuredClone(added.personalConfig),
            added.useRecommendedConfig,
          );
        },
        { modelId: added.modelId, draftOwnsRetry: true },
      );
    },
    [onAddPersonalModel, provider.providerId, runSaveOperation],
  );

  const handleReorderModelIds = useCallback(
    (modelIds: string[]) => {
      if (!onReorderModelIds) return;
      void optimisticModelOrder.commit(modelIds).catch((error) => {
        logger.warn("[ModelProviderSection] 保存 Personal Model 顺序失败", {
          providerId: provider.providerId,
          error,
        });
      });
    },
    [onReorderModelIds, optimisticModelOrder, provider.providerId],
  );

  const handleDeleteProvider = useCallback(() => {
    runProviderDeleteWithDraftCleanupGuard({
      deleteRequestedRef,
      onDelete,
    });
  }, [onDelete]);

  const headerProviderName = providerDisplayName;
  const isAccountProvider = provider.config.access?.type === "zhipu-account";
  const isApiKeyProvider = isApiKeyAccess(provider.config.access);
  const effectiveHeaderVisible = headerVisible && statusSection === undefined;

  return (
    <div className="space-y-3">
      {effectiveHeaderVisible ? (
        <ProviderCardHeader
          providerName={headerProviderName}
          logo={provider.config.logo}
          editingName={editingName}
          nameValue={nameValue}
          nameInputRef={nameInputRef}
          nameEditable={nameEditable}
          onNameChange={handleNameValueChange}
          onNameBlur={handleNameBlur}
          onNameKeyDown={handleNameKeyDown}
          onNameCompositionStart={() => {
            nameCompositionActiveRef.current = true;
          }}
          onNameCompositionEnd={() => {
            nameCompositionActiveRef.current = false;
          }}
          onStartEditName={handleStartEditName}
          onDelete={onDelete ? handleDeleteProvider : undefined}
          actionsVisible={headerActionsVisible}
          providerToggle={
            isAccountProvider ? undefined : (
              <ControlHintTooltip
                standalone
                title={intl.formatMessage({
                  id: provider.enabled
                    ? "settings.modelProvider.disableProvider"
                    : "settings.modelProvider.enableProvider",
                })}
              >
                {/* Tooltip 的 data-state 不能覆盖 Switch 的 checked 状态，否则轨道样式会消失。 */}
                <span className="inline-flex">
                  <Switch
                    // 共享开关左右各扩展 12px，会覆盖相邻菜单；本标题栏仅保留 4px 横向热区。
                    className="after:-inset-x-1"
                    data-testid="model-provider-enabled-switch"
                    aria-label={intl.formatMessage({
                      id: provider.enabled
                        ? "settings.modelProvider.disableProvider"
                        : "settings.modelProvider.enableProvider",
                    })}
                    checked={provider.enabled}
                    disabled={savingEnabled}
                    onCheckedChange={(enabled) => {
                      void handleProviderEnabledChange(enabled);
                    }}
                  />
                </span>
              </ControlHintTooltip>
            )
          }
        />
      ) : null}

      {statusSection}

      <div className="space-y-3">
        {isAccountProvider ? null : (
          <ProviderConnectionSection
            provider={provider}
            readOnly={readOnlyEndpoints}
            apiFormat={apiFormat}
            baseUrlValue={baseUrlValue}
            onApiFormatChange={handleApiFormatChange}
            onBaseUrlChange={handleBaseUrlValueChange}
            onBaseUrlBlur={saveConnection}
            onBaseUrlKeyDown={handleTextCommitKeyDown}
            onBaseUrlCompositionStart={handleTechnicalInputCompositionStart}
            onBaseUrlCompositionEnd={handleTechnicalInputCompositionEnd}
          />
        )}

        {isApiKeyProvider ? (
          <ProviderApiKeySection
            apiKeyValue={apiKeyValue}
            apiKeyVisible={apiKeyVisible}
            presetApiKeyUrl={presetApiKeyUrl}
            onOpenPresetApiKey={onOpenPresetApiKey}
            onApiKeyChange={handleApiKeyValueChange}
            onApiKeyBlur={handleApiKeyBlur}
            onApiKeyKeyDown={handleTextCommitKeyDown}
            onApiKeyCompositionStart={handleTechnicalInputCompositionStart}
            onApiKeyCompositionEnd={handleTechnicalInputCompositionEnd}
            onToggleApiKeyVisibility={() => setApiKeyVisible((value) => !value)}
          />
        ) : null}

        <ProviderModelsSection
          // 不同 Provider 可以有同名模型；不能复用上一供应商的打开中草稿和版本。
          key={provider.providerId}
          providerId={provider.providerId}
          providerName={getProviderFormLabel(provider)}
          providerEnabled={provider.enabled}
          providerAccess={provider.config.access}
          models={models}
          onTestModel={onTestModel ? handleTestModel : undefined}
          onModelCommit={handleModelCommit}
          onModelEnabledChange={handleModelEnabledChange}
          onDeleteModel={handleDeleteModel}
          onAddModel={handleAddModel}
          onReorderModelIds={onReorderModelIds ? handleReorderModelIds : undefined}
          settingsRevision={settingsRevision ?? 0}
        />
      </div>
    </div>
  );
}
