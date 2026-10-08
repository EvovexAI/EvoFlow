import { Plus, X } from "lucide-react";
import type { ZCodeSavedWorkflowArgType } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  SavedWorkflowArgRow,
  SavedWorkflowArgRowError,
} from "@/settings/saved-workflows/savedWorkflowArgsForm.js";

const ARG_TYPES: readonly ZCodeSavedWorkflowArgType[] = ["string", "number", "boolean", "json"];

/** 详情页「参数」声明表：可增删行，默认值按类型出控件。 */
export function SavedWorkflowArgsTable({
  rows,
  errors,
  onChange,
  onAdd,
  onRemove,
}: {
  rows: readonly SavedWorkflowArgRow[];
  errors: Record<string, SavedWorkflowArgRowError>;
  onChange: (key: string, patch: Partial<SavedWorkflowArgRow>) => void;
  onAdd: () => void;
  onRemove: (key: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const columns = "grid-cols-[minmax(0,1.4fr)_112px_64px_minmax(0,1fr)_minmax(0,1.6fr)_28px]";
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div
        className={cn(
          "grid items-center gap-3 bg-surface px-3 py-1.5 text-ui-sm text-foreground-subtle",
          columns,
        )}
      >
        <span>{intl.formatMessage({ id: "workflows.hub.detail.args.name" })}</span>
        <span>{intl.formatMessage({ id: "workflows.hub.detail.args.type" })}</span>
        <span>{intl.formatMessage({ id: "workflows.hub.detail.args.required" })}</span>
        <span>{intl.formatMessage({ id: "workflows.hub.detail.args.default" })}</span>
        <span>{intl.formatMessage({ id: "workflows.hub.detail.args.description" })}</span>
        <span aria-hidden="true" />
      </div>
      {rows.map((row) => {
        const error = errors[row.key];
        return (
          <div
            key={row.key}
            className="border-t border-border px-3 py-2"
            data-workflow-arg-row={row.name}
          >
            <div className={cn("grid items-center gap-3", columns)}>
              <Input
                aria-label={intl.formatMessage({ id: "workflows.hub.detail.args.name" })}
                className={cn(
                  "h-7 font-mono",
                  error === "empty_name" || error === "duplicate_name" ? "border-destructive" : "",
                )}
                value={row.name}
                onChange={(event) => onChange(row.key, { name: event.target.value })}
              />
              <Select
                value={row.type}
                onValueChange={(value) =>
                  onChange(row.key, { type: value as ZCodeSavedWorkflowArgType })
                }
              >
                <SelectTrigger size="sm" className="h-7 w-full font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ARG_TYPES.map((type) => (
                    <SelectItem key={type} value={type} className="font-mono">
                      {type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Switch
                aria-label={intl.formatMessage({ id: "workflows.hub.detail.args.required" })}
                checked={row.required}
                onCheckedChange={(checked) => onChange(row.key, { required: checked })}
              />
              {row.type === "boolean" ? (
                <Select
                  value={row.defaultText === "" ? "none" : row.defaultText}
                  onValueChange={(value) =>
                    onChange(row.key, { defaultText: value === "none" ? "" : value })
                  }
                >
                  <SelectTrigger size="sm" className="h-7 w-full font-mono">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">—</SelectItem>
                    <SelectItem value="true" className="font-mono">
                      true
                    </SelectItem>
                    <SelectItem value="false" className="font-mono">
                      false
                    </SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  aria-label={intl.formatMessage({ id: "workflows.hub.detail.args.default" })}
                  className={cn(
                    "h-7 font-mono",
                    error === "invalid_default" && "border-destructive",
                  )}
                  value={row.defaultText}
                  onChange={(event) => onChange(row.key, { defaultText: event.target.value })}
                />
              )}
              <Input
                aria-label={intl.formatMessage({ id: "workflows.hub.detail.args.description" })}
                className="h-7"
                value={row.description}
                onChange={(event) => onChange(row.key, { description: event.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={intl.formatMessage({ id: "workflows.hub.detail.args.remove" })}
                onClick={() => onRemove(row.key)}
              >
                <X className="size-3.5" aria-hidden="true" />
              </Button>
            </div>
            {error ? (
              <p className="mt-1 text-ui-sm text-destructive">
                {intl.formatMessage({ id: `workflows.hub.detail.args.error.${error}` })}
              </p>
            ) : null}
          </div>
        );
      })}
      <div className="border-t border-border px-2 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-icon="inline-start"
          className="text-foreground-subtle"
          onClick={onAdd}
        >
          <Plus className="size-3" aria-hidden="true" />
          {intl.formatMessage({ id: "workflows.hub.detail.args.add" })}
        </Button>
      </div>
    </div>
  );
}
