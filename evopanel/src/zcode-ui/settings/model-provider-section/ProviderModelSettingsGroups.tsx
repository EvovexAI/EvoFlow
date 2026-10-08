import type { ReactNode } from "react";
import type { ModelConfigObject } from "@zcode/provider";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ProviderModelDraftValues } from "@/settings/model-provider-section/ProviderModelMetadata.js";
import { JsonSlotEditor } from "@/settings/model-provider-section/ProviderModelMetadataFields.js";
import { ProviderModelReasoningLevelEditor } from "@/settings/model-provider-section/ProviderModelReasoningLevelEditor.js";
import { ModelConfigHelp } from "@/settings/model-provider-section/ModelConfigHelp.js";

export function ModelSettingsGroup({
  group,
  children,
}: {
  group: "basic" | "tokens" | "modalities" | "capabilities" | "reasoning" | "advanced";
  children: ReactNode;
}) {
  return (
    <section className="space-y-4" data-model-settings-group={group}>
      {children}
    </section>
  );
}

export function ProviderModelReasoningSettings({
  draft,
  personalConfig,
  inheritedConfig,
  overrideFields,
  onDraftChange,
}: {
  draft: ProviderModelDraftValues;
  personalConfig?: ModelConfigObject;
  inheritedConfig?: ModelConfigObject;
  overrideFields?: ReadonlySet<string>;
  onDraftChange: (patch: Partial<ProviderModelDraftValues>) => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <ModelSettingsGroup group="reasoning">
      <div className="space-y-1">
        <div className="block text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.reasoningLevelsOrdered" })}
          <ModelConfigHelp field="reasoningLevelsOrdered" />
        </div>
        <ProviderModelReasoningLevelEditor
          values={draft.reasoningLevelValuesValue}
          overridden={
            overrideFields
              ? overrideFields.has("reasoningLevelValuesValue")
              : personalConfig?.optionSpecs?.reasoningLevel?.values !== undefined
          }
          addLabel={intl.formatMessage({ id: "settings.modelProvider.reasoningLevelAdd" })}
          deleteLabel={intl.formatMessage({
            id: "settings.modelProvider.reasoningLevelDelete",
          })}
          onChange={(reasoningLevelValuesValue) => onDraftChange({ reasoningLevelValuesValue })}
        />
      </div>
      <div data-model-reasoning-level-map-editor="true">
        <JsonSlotEditor
          label={intl.formatMessage({ id: "settings.modelProvider.reasoningLevelMapping" })}
          labelHelp={<ModelConfigHelp field="reasoningLevelMapping" />}
          value={draft.reasoningLevelMapValue}
          effectiveValue={
            draft.useRecommendedConfigValue === false
              ? undefined
              : (inheritedConfig?.optionSpecs?.reasoningLevel?.map ?? undefined)
          }
          overridden={
            overrideFields
              ? overrideFields.has("reasoningLevelMapValue")
              : personalConfig?.optionSpecs?.reasoningLevel?.map !== undefined
          }
          onChange={(reasoningLevelMapValue) => onDraftChange({ reasoningLevelMapValue })}
        />
      </div>
    </ModelSettingsGroup>
  );
}
