/* eslint-disable max-lines -- 模型供应商卡片仍在迁移期集中维护多个紧耦合区块，后续拆分时再移除。 */
import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  type ReactNode,
} from "react";
import type {
  ProviderSettingsFormProvider,
  ProviderSettingsFormModel,
} from "@/lib/providerSettingsFormTypes.js";
import type { ModelConnectivityResult } from "@zcode/shared";
import type { ProviderApiType } from "@zcode/provider";
import {
  TID_MODEL_PROVIDER_ADD_MODEL_BUTTON,
  TID_MODEL_PROVIDER_BASE_URL_INPUT,
  TID_MODEL_PROVIDER_MODEL_DELETE_BUTTON,
  TID_MODEL_PROVIDER_MODEL_INPUT,
  TID_MODEL_PROVIDER_NAME_EDIT_BUTTON,
  TID_MODEL_PROVIDER_NAME_INPUT,
  testId,
} from "@zcode/shared";
import { InfoIcon, LockKeyholeIcon, Plus, Pencil, Trash2, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import { ApiKeyInput } from "./ApiKeyInput.js";
import { ModelRowInput } from "./ProviderFormControls.js";
import { PresetProviderApiKeyBanner } from "./PresetProviderApiKeyBanner.js";
import { type ProviderModelDraftValues } from "@/settings/model-provider-section/ProviderModelMetadata.js";
import { ProviderModelMetadataDialog } from "@/settings/model-provider-section/ProviderModelMetadataDialog.js";
import {
  ProviderApiFormatSelect,
  resolveProviderConnectionApiFormatDisplayLabel,
} from "@/settings/model-provider-section/ProviderApiFormatSelect.js";
import { SortableProviderModelList } from "@/settings/model-provider-section/SortableProviderModelList.js";
import { useProviderModelDraft } from "@/settings/model-provider-section/useProviderModelDraft.js";
import { ProviderLogo } from "@/settings/model-provider-section/ProviderLogo.js";
import type { ProviderConfigObject } from "@zcode/provider";

export { formatModelContextWindowLabel } from "@/lib/tokenNumberFormat.js";
export {
  resolveProviderConnectionApiFormatDisplayLabel,
  resolveProviderConnectionApiFormatOptions,
} from "@/settings/model-provider-section/ProviderApiFormatSelect.js";

function shouldShowProviderApiFormat(
  _provider: Pick<ProviderSettingsFormProvider, "providerId">,
): boolean {
  return true;
}

export function ProviderCardHeader({
  providerName,
  logo,
  editingName,
  nameValue,
  nameInputRef,
  nameEditable = true,
  onNameChange,
  onNameBlur,
  onNameKeyDown,
  onNameCompositionEnd,
  onNameCompositionStart,
  onStartEditName,
  onDelete,
  actionsVisible = true,
  providerToggle,
}: {
  providerName: string;
  logo?: ProviderConfigObject["logo"];
  editingName: boolean;
  nameValue: string;
  nameInputRef: RefObject<HTMLInputElement | null>;
  nameEditable?: boolean;
  onNameChange: (value: string) => void;
  onNameBlur: () => void;
  onNameKeyDown: (event: ReactKeyboardEvent) => void;
  onNameCompositionEnd?: () => void;
  onNameCompositionStart?: () => void;
  onStartEditName: () => void;
  onDelete?: () => void;
  actionsVisible?: boolean;
  providerToggle?: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const renameRequestedRef = useRef(false);
  const secondaryActionsVisible = actionsVisible && (nameEditable || Boolean(onDelete));

  return (
    <div className="flex items-center justify-between gap-3" data-testid="model-provider-header">
      <div className="flex min-w-0 items-center gap-2">
        <ProviderLogo logo={logo} className="size-5" />
        {editingName ? (
          <Input
            {...TECHNICAL_INPUT_ATTRIBUTES}
            ref={nameInputRef}
            data-testid={TID_MODEL_PROVIDER_NAME_INPUT}
            type="text"
            size="lg"
            className="w-auto min-w-0 text-ui-lg font-semibold"
            value={nameValue}
            onChange={(event) => onNameChange(event.target.value)}
            onCompositionEnd={onNameCompositionEnd}
            onCompositionStart={onNameCompositionStart}
            onBlur={onNameBlur}
            onKeyDown={onNameKeyDown}
          />
        ) : (
          <>
            <div className="min-w-0 truncate text-ui-lg font-semibold text-foreground">
              {providerName}
            </div>
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {providerToggle}
        {secondaryActionsVisible ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                data-testid="model-provider-actions-button"
                aria-label={intl.formatMessage({ id: "common.more" })}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(event) => {
                // 重命名后的焦点交给输入框，不能被菜单关闭时重新抢回触发按钮。
                if (renameRequestedRef.current) {
                  event.preventDefault();
                  renameRequestedRef.current = false;
                }
              }}
            >
              {nameEditable ? (
                <DropdownMenuItem
                  data-testid={TID_MODEL_PROVIDER_NAME_EDIT_BUTTON}
                  onSelect={() => {
                    renameRequestedRef.current = true;
                    onStartEditName();
                  }}
                >
                  <Pencil className="size-3.5" />
                  {intl.formatMessage({ id: "settings.modelProvider.renameProvider" })}
                </DropdownMenuItem>
              ) : null}
              {nameEditable && onDelete ? <DropdownMenuSeparator /> : null}
              {onDelete ? (
                <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                  <Trash2 className="size-3.5" />
                  {intl.formatMessage({ id: "common.delete" })}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}

export function ProviderConnectionSection({
  provider,
  readOnly,
  apiFormat,
  baseUrlValue,
  onApiFormatChange,
  onBaseUrlChange,
  onBaseUrlBlur,
  onBaseUrlKeyDown,
  onBaseUrlCompositionStart,
  onBaseUrlCompositionEnd,
}: {
  provider: ProviderSettingsFormProvider;
  readOnly?: boolean;
  apiFormat: ProviderApiType;
  baseUrlValue: string;
  onApiFormatChange: (value: ProviderApiType) => void;
  onBaseUrlChange: (value: string) => void;
  onBaseUrlBlur: () => void;
  onBaseUrlKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onBaseUrlCompositionStart?: () => void;
  onBaseUrlCompositionEnd?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const showApiFormat = shouldShowProviderApiFormat(provider);
  const readOnlyBaseUrl = provider.config.api?.baseUrl ?? "";
  const resolvedApiFormat = provider.config.api?.type ?? "anthropic-messages";

  const renderReadOnlyField = (label: string, value: string) => (
    <div>
      <label className="mb-1 block text-ui-base text-foreground-subtle">{label}</label>
      <div className="flex min-h-8 items-center gap-2 rounded-lg border border-input-border bg-input px-3 py-1.5 text-ui-base text-foreground">
        <span className="min-w-0 flex-1 break-all">{value || "-"}</span>
        <span
          role="img"
          aria-label={intl.formatMessage(
            { id: "settings.modelProvider.readOnlyField" },
            { field: label },
          )}
          className="shrink-0 text-foreground-subtle"
        >
          <LockKeyholeIcon className="size-3.5" aria-hidden="true" />
        </span>
      </div>
    </div>
  );

  if (readOnly) {
    return (
      <>
        {renderReadOnlyField(
          intl.formatMessage({ id: "settings.modelProvider.baseUrl" }),
          readOnlyBaseUrl,
        )}
        {showApiFormat
          ? renderReadOnlyField(
              intl.formatMessage({ id: "settings.modelProvider.apiFormat" }),
              resolveProviderConnectionApiFormatDisplayLabel(intl, resolvedApiFormat),
            )
          : null}
      </>
    );
  }

  return (
    <>
      <div>
        <label className="mb-1 block text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.baseUrl" })}
        </label>
        <Input
          {...TECHNICAL_INPUT_ATTRIBUTES}
          type="text"
          size="lg"
          data-testid={TID_MODEL_PROVIDER_BASE_URL_INPUT}
          value={baseUrlValue}
          placeholder={intl.formatMessage({
            id: "settings.modelProvider.baseUrlPlaceholder",
          })}
          onChange={(event) => onBaseUrlChange(event.target.value)}
          onBlur={onBaseUrlBlur}
          onKeyDown={onBaseUrlKeyDown}
          onCompositionStart={onBaseUrlCompositionStart}
          onCompositionEnd={onBaseUrlCompositionEnd}
        />
      </div>
      {showApiFormat ? (
        <div>
          <label className="mb-1 block text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.modelProvider.apiFormat" })}
          </label>
          <ProviderApiFormatSelect value={apiFormat} onChange={onApiFormatChange} />
        </div>
      ) : null}
    </>
  );
}

export function ProviderApiKeySection({
  apiKeyValue,
  apiKeyVisible,
  readOnly,
  presetApiKeyUrl,
  onOpenPresetApiKey,
  onApiKeyChange,
  onApiKeyBlur,
  onApiKeyKeyDown,
  onApiKeyCompositionStart,
  onApiKeyCompositionEnd,
  onToggleApiKeyVisibility,
}: {
  apiKeyValue: string;
  apiKeyVisible: boolean;
  readOnly?: boolean;
  presetApiKeyUrl?: string;
  onOpenPresetApiKey?: () => void;
  onApiKeyChange: (value: string) => void;
  onApiKeyBlur: () => void;
  onApiKeyKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onApiKeyCompositionStart?: () => void;
  onApiKeyCompositionEnd?: () => void;
  onToggleApiKeyVisibility: () => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <label className="block text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.apiKey" })}
        </label>
        {presetApiKeyUrl && onOpenPresetApiKey ? (
          <PresetProviderApiKeyBanner onOpenApiKey={onOpenPresetApiKey} />
        ) : null}
      </div>
      <ApiKeyInput
        value={apiKeyValue}
        visible={apiKeyVisible}
        readOnly={readOnly}
        onChange={onApiKeyChange}
        onBlur={onApiKeyBlur}
        onKeyDown={onApiKeyKeyDown}
        onCompositionStart={onApiKeyCompositionStart}
        onCompositionEnd={onApiKeyCompositionEnd}
        onToggleVisibility={onToggleApiKeyVisibility}
      />
    </div>
  );
}

function createEmptyModel(): ProviderSettingsFormModel {
  return {
    kind: "candidate",
    modelId: "",
    builtin: false,
    personalConfig: {},
    // 空 ID 尚未解析模型配置，硬编码档位会被误认为智能推荐。
    config: {
      properties: { supportsToolCall: true },
    },
    hasPersonalConfig: false,
    executable: false,
    selectable: false,
  };
}

export function ProviderModelsSection({
  providerId,
  providerName,
  providerEnabled = true,
  providerAccess,
  models,
  onTestModel,
  onModelCommit,
  onModelEnabledChange,
  onDeleteModel,
  onAddModel,
  onReorderModelIds,
  settingsRevision = 0,
}: {
  providerId: string;
  providerName?: string;
  providerEnabled?: boolean;
  providerAccess?: ProviderConfigObject["access"];
  models: ProviderSettingsFormModel[];
  onTestModel?: (model: string) => Promise<ModelConnectivityResult>;
  onModelCommit: (
    originalModelId: string,
    model: ProviderSettingsFormModel,
    basedOnRevision: number,
  ) => void | Promise<void>;
  onDeleteModel: (modelId: string) => void;
  onModelEnabledChange?: (modelId: string, enabled: boolean) => void | Promise<void>;
  onAddModel: (model: ProviderSettingsFormModel) => void | Promise<void>;
  onReorderModelIds?: (modelIds: string[]) => void;
  settingsRevision?: number;
}) {
  const { intl } = useZCodeIntl();
  const { providerSettingsService } = useServices();
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addSaving, setAddSaving] = useState(false);
  const addSavingRef = useRef(false);
  const [addCommitError, setAddCommitError] = useState<string | null>(null);
  const [addModel] = useState(createEmptyModel);
  const [addDraftErrorField, setAddDraftErrorField] = useState<
    | "id"
    | "contextWindow"
    | "maxOutputTokens"
    | "inputFormat"
    | "reasoningLevelValues"
    | "reasoningLevelMap"
    | null
  >(null);
  const resolveAddModelConfig = useCallback(
    (modelId: string) => providerSettingsService.resolveModelConfig({ providerId, modelId }),
    [providerId, providerSettingsService],
  );
  const editor = useProviderModelDraft({
    model: addModel,
    open: addDialogOpen,
    scopeKey: providerId,
    resolve: resolveAddModelConfig,
  });
  const { draft: addDraft } = editor;

  const openAddDialog = useCallback(() => {
    editor.reset(createEmptyModel());
    setAddDraftErrorField(null);
    setAddCommitError(null);
    setAddDialogOpen(true);
  }, [editor.reset]);

  const updateAddDraft = (patch: Partial<ProviderModelDraftValues>) => {
    editor.change(patch);
    setAddDraftErrorField(null);
  };

  const cancelAddDialog = () => {
    setAddDialogOpen(false);
    editor.reset(createEmptyModel());
    setAddDraftErrorField(null);
    editor.cancel();
  };

  const handleAddDialogOpenChange = useCallback(
    (open: boolean) => {
      // 保存中的关闭/再打开会让旧请求结束掉新草稿，等待本次提交完成再结束编辑。
      if (addSavingRef.current) return;
      if (!open) {
        cancelAddDialog();
        return;
      }
      setAddDialogOpen(true);
    },
    [cancelAddDialog],
  );

  const commitAddDraft = useCallback(async (): Promise<boolean> => {
    if (addSavingRef.current) return false;
    addSavingRef.current = true;
    setAddSaving(true);
    setAddCommitError(null);
    try {
      const result = await editor.commit();
      if (result.status === "invalid") {
        setAddDraftErrorField(result.field);
        return false;
      }
      // 过去只发起异步添加就关闭弹窗，失败后输入也丢了；以实际保存完成作为结束边界。
      await onAddModel(result.model);
      setAddDialogOpen(false);
      editor.reset(createEmptyModel());
      return true;
    } catch (error) {
      setAddCommitError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      addSavingRef.current = false;
      setAddSaving(false);
    }
  }, [editor, onAddModel]);
  const addDraftErrorMessage = addDraftErrorField
    ? intl.formatMessage({
        id: `settings.modelProvider.modelMetadata.invalid.${addDraftErrorField}`,
      })
    : null;

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <span className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.models" })}
        </span>
        <Button
          type="button"
          variant="secondary"
          size="default"
          className="rounded-lg"
          data-testid={TID_MODEL_PROVIDER_ADD_MODEL_BUTTON}
          onClick={openAddDialog}
        >
          <Plus data-icon="inline-start" aria-hidden="true" />
          {intl.formatMessage({ id: "settings.modelProvider.addModel" })}
        </Button>
      </div>
      {models.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-input-border bg-input">
          <SortableProviderModelList
            modelIds={models.map((model) => model.modelId)}
            sortableModelIds={models.map((model) => model.modelId)}
            onReorder={onReorderModelIds}
            renderModel={(_modelId, index) => {
              const model = models[index]!;
              const inputFormat = model.config.properties?.inputFormat;
              const outputFormat = model.config.properties?.outputFormat;
              const completeProperties =
                model.config.properties?.contextWindow != null &&
                inputFormat?.supportsText != null &&
                inputFormat.supportsImage != null &&
                inputFormat.supportsVideo != null &&
                inputFormat.supportsAudio != null &&
                inputFormat.supportsPdf != null &&
                outputFormat?.supportsText != null;
              return (
                <>
                  <ModelRowInput
                    key={`${providerId}/${model.modelId}`}
                    providerId={providerId}
                    providerName={providerName}
                    providerEnabled={providerEnabled}
                    providerAccess={providerAccess}
                    inputTestId={testId(TID_MODEL_PROVIDER_MODEL_INPUT, String(index))}
                    deleteTestId={testId(TID_MODEL_PROVIDER_MODEL_DELETE_BUTTON, String(index))}
                    model={model}
                    onCommit={(value, basedOnRevision) =>
                      onModelCommit(model.modelId, value, basedOnRevision)
                    }
                    onResolveDraft={(nextModelId, personalConfig) =>
                      providerSettingsService.resolveModelConfig({
                        providerId,
                        originalModelId: model.modelId,
                        modelId: nextModelId,
                        personalConfig: structuredClone(personalConfig),
                      })
                    }
                    settingsRevision={settingsRevision}
                    onDelete={!model.builtin ? () => onDeleteModel(model.modelId) : undefined}
                    onEnabledChange={(enabled) => {
                      void Promise.resolve(onModelEnabledChange?.(model.modelId, enabled)).catch(
                        () => undefined,
                      );
                    }}
                    onTest={onTestModel}
                  />
                  {!completeProperties && (
                    <div className="px-3 pb-2 text-ui-sm text-destructive">
                      {model.issues?.[0]?.message ??
                        intl.formatMessage({ id: "settings.modelProvider.modelConfigIncomplete" })}
                    </div>
                  )}
                </>
              );
            }}
          />
        </div>
      ) : (
        <div className="mt-1 flex h-12 items-center justify-start gap-2 rounded-lg border border-dashed border-border px-4 text-left text-ui-base text-foreground-subtle">
          <InfoIcon className="size-4 shrink-0" aria-hidden="true" />
          {intl.formatMessage({ id: "settings.modelProvider.modelsEmpty" })}
        </div>
      )}
      <>
        <ProviderModelMetadataDialog
          onRestore={() => {
            setAddDraftErrorField(null);
            setAddCommitError(null);
            void editor
              .restore()
              .catch((error) =>
                setAddCommitError(error instanceof Error ? error.message : String(error)),
              );
          }}
          mode="add"
          open={addDialogOpen}
          draft={addDraft}
          draftErrorMessage={addCommitError ?? addDraftErrorMessage}
          draftErrorField={addDraftErrorField}
          inheritedConfig={editor.inheritedConfig}
          overrideFields={editor.overrides}
          onOpenChange={handleAddDialogOpenChange}
          onDraftChange={updateAddDraft}
          onCommit={commitAddDraft}
          saving={addSaving}
          modelConfigResolutionPending={editor.pending}
          modelDefaultsLoaded={editor.defaultsLoaded}
          onModelIdBlur={() => {
            void editor.flush().catch(() => undefined);
          }}
        />
      </>
    </div>
  );
}
