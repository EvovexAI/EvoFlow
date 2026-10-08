import { Eye, EyeOff, RotateCcw, Save, Trash2 } from "lucide-react";
import { useState } from "react";
import type { ZCodePluginInfo, ZCodePluginScope, ZCodePluginUserConfigOption } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsScopeBadge } from "@/settings/SettingsScopeBadge.js";

interface PluginConfigControlsProps {
  getValue: (
    plugin: ZCodePluginInfo,
    key: string,
    option: ZCodePluginUserConfigOption,
  ) => string | number | boolean;
  isOptionClearPending?: (pluginId: string, key: string) => boolean;
  onClearOption?: (pluginId: string, key: string, clear: boolean) => void;
  onSave: (plugin: ZCodePluginInfo) => void;
  onSetDraft: (pluginId: string, key: string, value: string | number | boolean) => void;
  operationId: string | null;
  plugin: ZCodePluginInfo;
  scope: ZCodePluginScope;
}

export function PluginConfigControls({
  getValue,
  isOptionClearPending,
  onClearOption,
  onSave,
  onSetDraft,
  operationId,
  plugin,
  scope,
}: PluginConfigControlsProps) {
  const { intl } = useZCodeIntl();
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, boolean>>({});
  const entries = Object.entries(plugin.userConfig ?? {});
  if (entries.length === 0) return null;

  const isSaving = operationId === `plugin:configure:${plugin.id}`;
  return (
    <div
      className="mt-3 border-t border-border pt-3"
      data-testid="plugin-store-config"
      data-plugin-id={plugin.id}
    >
      <div className="mb-2 text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "settings.plugins.config.title" })}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {entries.map(([key, option]) => {
          const label = option.title ?? key;
          const value = getValue(plugin, key, option);
          const clearPending = isOptionClearPending?.(plugin.id, key) ?? false;
          const canClearOption =
            onClearOption !== undefined &&
            (plugin.optionSources?.[key] === scope || clearPending) &&
            (option.sensitive === true || scope === "workspace");
          const clearLabel = option.sensitive
            ? intl.formatMessage({
                id: clearPending
                  ? "settings.plugins.config.undoClearSecret"
                  : "settings.plugins.config.clearSecret",
              })
            : intl.formatMessage({
                id: clearPending
                  ? "settings.plugins.config.undoRestoreOption"
                  : "settings.plugins.config.restoreOption",
              });
          const clearButton = canClearOption ? (
            <Button
              type="button"
              data-testid="plugin-store-config-clear"
              data-plugin-id={plugin.id}
              data-config-key={key}
              variant={clearPending ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label={clearLabel}
              aria-pressed={clearPending}
              title={clearLabel}
              disabled={isSaving}
              onClick={() => onClearOption?.(plugin.id, key, !clearPending)}
            >
              {clearPending ? (
                <RotateCcw className="size-3.5" aria-hidden="true" />
              ) : (
                <Trash2 className="size-3.5" aria-hidden="true" />
              )}
            </Button>
          ) : null;
          return (
            <label key={key} className="min-w-0 text-ui-base text-foreground">
              <span className="mb-1 flex items-center gap-1 text-foreground-subtle">
                <span className="truncate">{label}</span>
                {option.required ? (
                  <span className="text-warning">
                    {intl.formatMessage({
                      id: "settings.plugins.config.required",
                    })}
                  </span>
                ) : null}
                <SettingsScopeBadge scope={plugin.optionSources?.[key] ?? "default"} />
              </span>
              {option.sensitive ? (
                <div className="flex items-center gap-1">
                  <Input
                    type={revealedSecrets[key] ? "text" : "password"}
                    data-testid="plugin-store-config-input"
                    data-config-key={key}
                    size="sm"
                    className="h-8 min-w-0 flex-1 rounded-lg"
                    value={String(value)}
                    disabled={isSaving}
                    onChange={(event) => onSetDraft(plugin.id, key, event.target.value)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={intl.formatMessage({
                      id: revealedSecrets[key]
                        ? "settings.plugins.config.hideSecret"
                        : "settings.plugins.config.showSecret",
                    })}
                    title={intl.formatMessage({
                      id: revealedSecrets[key]
                        ? "settings.plugins.config.hideSecret"
                        : "settings.plugins.config.showSecret",
                    })}
                    disabled={isSaving}
                    onClick={() =>
                      setRevealedSecrets((current) => ({
                        ...current,
                        [key]: !current[key],
                      }))
                    }
                  >
                    {revealedSecrets[key] ? (
                      <EyeOff className="size-3.5" aria-hidden="true" />
                    ) : (
                      <Eye className="size-3.5" aria-hidden="true" />
                    )}
                  </Button>
                  {clearButton}
                </div>
              ) : option.type === "boolean" ? (
                <div className="flex h-8 items-center">
                  <Switch
                    data-testid="plugin-store-config-input"
                    data-config-key={key}
                    checked={Boolean(value)}
                    disabled={isSaving}
                    onCheckedChange={(checked) => onSetDraft(plugin.id, key, checked)}
                  />
                  {clearButton}
                </div>
              ) : (
                <div className="flex items-center gap-1">
                  <Input
                    type={option.type === "number" ? "number" : "text"}
                    data-testid="plugin-store-config-input"
                    data-config-key={key}
                    size="sm"
                    className="h-8 min-w-0 flex-1 rounded-lg"
                    value={String(value)}
                    disabled={isSaving}
                    onChange={(event) => onSetDraft(plugin.id, key, event.target.value)}
                  />
                  {clearButton}
                </div>
              )}
            </label>
          );
        })}
      </div>
      {entries.length > 0 ? (
        <div className="mt-2 flex justify-end">
          <Button
            type="button"
            data-testid="plugin-store-config-save"
            data-plugin-id={plugin.id}
            variant="outline"
            size="lg"
            disabled={isSaving}
            onClick={() => onSave(plugin)}
          >
            <Save className="size-3.5" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.plugins.config.save" })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
