import {
  TID_WORKFLOW_DETAIL_DESCRIPTION,
  TID_WORKFLOW_DETAIL_WHEN_TO_USE,
  TID_WORKFLOW_META_DISCARD,
  TID_WORKFLOW_META_SAVE,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import type {
  SavedWorkflowArgRow,
  SavedWorkflowArgRowError,
} from "@/settings/saved-workflows/savedWorkflowArgsForm.js";
import { SavedWorkflowArgsTable } from "@/settings/saved-workflows/SavedWorkflowArgsTable.js";

export interface SavedWorkflowMetaDraft {
  description: string;
  whenToUse: string;
  rows: SavedWorkflowArgRow[];
}

interface SavedWorkflowMetaFormProps {
  draft: SavedWorkflowMetaDraft;
  rowErrors: Record<string, SavedWorkflowArgRowError>;
  descriptionError: boolean;
  dirty: boolean;
  saving: boolean;
  onDescriptionChange: (value: string) => void;
  onWhenToUseChange: (value: string) => void;
  onRowChange: (key: string, patch: Partial<SavedWorkflowArgRow>) => void;
  onRowAdd: () => void;
  onRowRemove: (key: string) => void;
  onDiscard: () => void;
  onSave: () => void;
}

/**
 * 详情页「基本信息」表单：说明 / 何时使用 / 参数表
 * 行内可编，脏了才浮出「放弃 / 保存」。状态由 SavedWorkflowDetailView 持有，这里只渲染。
 */
export function SavedWorkflowMetaForm({
  draft,
  rowErrors,
  descriptionError,
  dirty,
  saving,
  onDescriptionChange,
  onWhenToUseChange,
  onRowChange,
  onRowAdd,
  onRowRemove,
  onDiscard,
  onSave,
}: SavedWorkflowMetaFormProps) {
  const { intl } = useZCodeIntl();
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-ui-base font-medium leading-5 text-foreground-subtle">
        {intl.formatMessage({ id: "workflows.hub.detail.basics" })}
      </h2>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="workflow-meta-description" className="text-ui-base font-medium">
          {intl.formatMessage({ id: "workflows.hub.detail.description" })}
        </label>
        <SettingsFormTextarea
          id="workflow-meta-description"
          data-testid={TID_WORKFLOW_DETAIL_DESCRIPTION}
          rows={2}
          value={draft.description}
          aria-invalid={descriptionError}
          className={cn(descriptionError && "border-destructive")}
          onChange={(event) => onDescriptionChange(event.target.value)}
        />
        {descriptionError ? (
          <p className="text-ui-sm text-destructive">
            {intl.formatMessage({ id: "workflows.hub.detail.meta.descriptionRequired" })}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="workflow-meta-when" className="text-ui-base font-medium">
          {intl.formatMessage({ id: "workflows.hub.detail.whenToUse" })}
        </label>
        <SettingsFormTextarea
          id="workflow-meta-when"
          data-testid={TID_WORKFLOW_DETAIL_WHEN_TO_USE}
          rows={2}
          value={draft.whenToUse}
          onChange={(event) => onWhenToUseChange(event.target.value)}
        />
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "workflows.hub.detail.whenToUse.help" })}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-ui-base font-medium">
          {intl.formatMessage({ id: "workflows.hub.detail.args" })}
        </span>
        <SavedWorkflowArgsTable
          rows={draft.rows}
          errors={rowErrors}
          onChange={onRowChange}
          onAdd={onRowAdd}
          onRemove={onRowRemove}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "workflows.hub.detail.meta.note" })}
        </p>
        {dirty ? (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="lg"
              data-testid={TID_WORKFLOW_META_DISCARD}
              disabled={saving}
              onClick={onDiscard}
            >
              {intl.formatMessage({ id: "workflows.hub.detail.meta.discard" })}
            </Button>
            <Button
              type="button"
              size="lg"
              data-testid={TID_WORKFLOW_META_SAVE}
              disabled={saving}
              onClick={onSave}
            >
              {saving ? <Spinner className="size-3.5" /> : null}
              {intl.formatMessage({ id: "workflows.hub.detail.meta.save" })}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
