/* eslint-disable max-lines -- Hook 表单集中维护 runner 类型、Scope 与高级兼容字段。 */
import { useCallback, useState, type ReactNode } from "react";
import { ChevronRight, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import type { Hook, HookConfig, HookEvent, HookType } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";
import { PluginScopeMenu, getPluginWorkspaceKey } from "@/settings/PluginScopeMenu.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

interface HookFormProps {
  hook?: Hook;
  workspaceAvailable?: boolean;
  defaultStorageLevel?: "user" | "project";
  onSave: (config: HookConfig) => void;
  onCancel: () => void;
  onDelete?: (hook: Hook) => void;
  isEditing?: boolean;
  workspaceTabs?: WorkspaceTabState[];
  selectedScopeKey?: string;
  onScopeKeyChange?: (scopeKey: string) => void;
}

const HOOK_EVENTS: HookEvent[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
];

function formatCustomJson(custom?: Record<string, unknown>): string {
  return custom && Object.keys(custom).length > 0 ? JSON.stringify(custom, null, 2) : "";
}

function HookScopeMenu({
  disabled,
  scopeKey,
  workspaceTabs,
  onChange,
}: {
  disabled: boolean;
  scopeKey: string;
  workspaceTabs: WorkspaceTabState[];
  onChange: (scopeKey: string) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <label className="flex min-w-0 flex-wrap items-center justify-end gap-2">
      <span className="shrink-0 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.scope.label" })}
      </span>
      <PluginScopeMenu
        align="end"
        disabled={disabled}
        selectedScopeKey={scopeKey}
        workspaceTabs={workspaceTabs}
        onScopeKeyChange={onChange}
      />
    </label>
  );
}

export function HookForm({
  hook,
  workspaceAvailable = false,
  defaultStorageLevel = "user",
  onSave,
  onCancel,
  onDelete,
  isEditing = false,
  workspaceTabs = [],
  selectedScopeKey,
  onScopeKeyChange,
}: HookFormProps) {
  const { intl } = useZCodeIntl();
  const initialStorageLevel = hook?.location?.scope === "project" ? "project" : "user";
  const [storageLevel, setStorageLevel] = useState<"user" | "project">(
    workspaceAvailable ? (hook ? initialStorageLevel : defaultStorageLevel) : "user",
  );
  const initialWorkspaceKey = workspaceTabs[0] ? getPluginWorkspaceKey(workspaceTabs[0]) : "user";
  const scopeKey = selectedScopeKey ?? (storageLevel === "project" ? initialWorkspaceKey : "user");
  const [event, setEvent] = useState<HookEvent>(hook?.event ?? "PreToolUse");
  const [type, setType] = useState<HookType>(hook?.type ?? "process");
  const [matcher, setMatcher] = useState(hook?.matcher ?? "");
  const [command, setCommand] = useState(hook?.command ?? "");
  const [args, setArgs] = useState((hook?.args ?? []).join("\n"));
  const [asyncCommand, setAsyncCommand] = useState(hook?.async ?? false);
  const [shell, setShell] = useState(typeof hook?.shell === "string" ? hook.shell : "");
  const [statusMessage, setStatusMessage] = useState(hook?.statusMessage ?? "");
  const [timeout, setTimeout] = useState(String(hook?.timeout ?? 60));
  const [customJson, setCustomJson] = useState(formatCustomJson(hook?.custom));
  const [customError, setCustomError] = useState<string | null>(null);
  const customJsonValid = (() => {
    if (!customJson.trim()) return true;
    try {
      const parsed = JSON.parse(customJson) as unknown;
      return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
    } catch {
      return false;
    }
  })();
  const canSave = Boolean(command.trim() && customJsonValid);

  const handleSave = useCallback(() => {
    if (!command.trim()) return;

    let custom: Record<string, unknown> | undefined;
    if (customJson.trim()) {
      try {
        const parsed = JSON.parse(customJson) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setCustomError(intl.formatMessage({ id: "settings.hooks.customJsonObjectError" }));
          return;
        }
        custom = parsed as Record<string, unknown>;
      } catch {
        setCustomError(intl.formatMessage({ id: "settings.hooks.customJsonParseError" }));
        return;
      }
    }

    setCustomError(null);
    onSave({
      event,
      matcher: matcher.trim() || undefined,
      type,
      command: command.trim(),
      ...(type === "process"
        ? {
            args: args
              .split("\n")
              .map((arg) => arg.trim())
              .filter(Boolean),
          }
        : {
            async: asyncCommand,
            shell: shell.trim() || (hook?.shell === true ? true : undefined),
          }),
      statusMessage: statusMessage.trim() || undefined,
      timeout: Number.parseInt(timeout, 10) || 60,
      enabled: hook?.enabled ?? true,
      custom,
      storageLevel,
    });
  }, [
    args,
    asyncCommand,
    command,
    customJson,
    event,
    hook?.enabled,
    intl,
    matcher,
    onSave,
    shell,
    statusMessage,
    storageLevel,
    timeout,
    type,
  ]);

  return (
    <div className="space-y-4" data-testid="hooks-form">
      <div className="space-y-1">
        <h3 className="text-ui-xl font-semibold text-foreground">
          {intl.formatMessage({
            id: isEditing ? "settings.hooks.edit" : "settings.hooks.add",
          })}
        </h3>
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.hooks.description" })}
        </p>
      </div>

      <div className="space-y-3 rounded-xl border border-border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid w-full min-w-0 gap-3 sm:grid-cols-2 md:w-auto">
            <Field label={intl.formatMessage({ id: "settings.hooks.event" })} htmlFor="hook-event">
              <Select value={event} onValueChange={(value) => setEvent(value as HookEvent)}>
                <SelectTrigger id="hook-event" size="lg" className="w-full md:w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOOK_EVENTS.map((hookEvent) => (
                    <SelectItem key={hookEvent} value={hookEvent}>
                      {hookEvent}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={intl.formatMessage({ id: "settings.hooks.type" })} htmlFor="hook-runner">
              <Select value={type} onValueChange={(value) => setType(value as HookType)}>
                <SelectTrigger id="hook-runner" size="lg" className="w-full md:w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["process", "command"] as const).map((hookType) => (
                    <SelectItem key={hookType} value={hookType}>
                      {intl.formatMessage({
                        id: `settings.hooks.type.${hookType}`,
                      })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <HookScopeMenu
            disabled={Boolean(hook)}
            scopeKey={scopeKey}
            workspaceTabs={workspaceAvailable ? workspaceTabs : []}
            onChange={(nextScopeKey) => {
              setStorageLevel(nextScopeKey === "user" ? "user" : "project");
              onScopeKeyChange?.(nextScopeKey);
            }}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={intl.formatMessage({ id: "settings.hooks.matcher" })} htmlFor="matcher">
            <Input
              id="matcher"
              size="lg"
              value={matcher}
              onChange={(event) => setMatcher(event.target.value)}
              placeholder={intl.formatMessage({
                id: "settings.hooks.matcherPlaceholder",
              })}
            />
            <p className="text-ui-base text-foreground-subtlest">
              {intl.formatMessage({ id: "settings.hooks.matcherHint" })}
            </p>
          </Field>

          <Field label={intl.formatMessage({ id: "settings.hooks.command" })} htmlFor="command">
            <Input
              id="command"
              size="lg"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder={intl.formatMessage({
                id: "settings.hooks.commandPlaceholder",
              })}
              className="font-mono"
            />
          </Field>
        </div>

        {type === "process" ? (
          <Field label={intl.formatMessage({ id: "settings.hooks.args" })} htmlFor="args">
            <SettingsFormTextarea
              id="args"
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              placeholder={intl.formatMessage({
                id: "settings.hooks.argsPlaceholder",
              })}
              rows={4}
              className="resize-y font-mono"
            />
            <p className="text-ui-base text-foreground-subtlest">
              {intl.formatMessage({ id: "settings.hooks.argsHint" })}
            </p>
          </Field>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label={intl.formatMessage({ id: "settings.hooks.shell" })} htmlFor="hook-shell">
              <Input
                id="hook-shell"
                size="lg"
                value={shell}
                onChange={(event) => setShell(event.target.value)}
                placeholder={intl.formatMessage({
                  id: "settings.hooks.shellPlaceholder",
                })}
                className="font-mono"
              />
            </Field>
            <div className="flex items-end justify-between gap-4 pb-1">
              <Label htmlFor="hook-async-command">
                {intl.formatMessage({ id: "settings.hooks.async" })}
              </Label>
              <Switch
                id="hook-async-command"
                checked={asyncCommand}
                onCheckedChange={setAsyncCommand}
              />
            </div>
          </div>
        )}

        <details className="group/advanced border-t border-border pt-3">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-ui-base font-medium text-foreground-subtle">
            <ChevronRight
              className="size-3.5 transition-transform group-open/advanced:rotate-90"
              aria-hidden="true"
            />
            {intl.formatMessage({ id: "settings.hooks.advanced" })}
          </summary>
          <div className="mt-3 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={intl.formatMessage({ id: "settings.hooks.timeout" })} htmlFor="timeout">
                <Input
                  id="timeout"
                  size="lg"
                  type="number"
                  min={1}
                  value={timeout}
                  onChange={(event) => setTimeout(event.target.value)}
                  className="w-28"
                />
                <p className="text-ui-base text-foreground-subtlest">
                  {intl.formatMessage({ id: "settings.hooks.timeoutHint" })}
                </p>
              </Field>

              <Field
                label={intl.formatMessage({
                  id: "settings.hooks.statusMessage",
                })}
                htmlFor="hook-status-message"
              >
                <Input
                  id="hook-status-message"
                  size="lg"
                  value={statusMessage}
                  onChange={(event) => setStatusMessage(event.target.value)}
                  placeholder={intl.formatMessage({
                    id: "settings.hooks.statusMessagePlaceholder",
                  })}
                />
              </Field>
            </div>

            <Field
              label={intl.formatMessage({ id: "settings.hooks.customJson" })}
              htmlFor="hook-custom-json"
            >
              <SettingsFormTextarea
                id="hook-custom-json"
                value={customJson}
                onChange={(event) => setCustomJson(event.target.value)}
                rows={5}
                className="resize-y font-mono text-ui-base"
                placeholder={'{\n  "customKey": "value"\n}'}
              />
              {customError ? <p className="text-ui-base text-destructive">{customError}</p> : null}
            </Field>
          </div>
        </details>

        <SettingsFormActions
          leadingAction={
            hook && onDelete ? (
              <Button
                type="button"
                variant="link"
                size="lg"
                className="px-0 text-destructive hover:text-destructive"
                onClick={() => onDelete(hook)}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                {intl.formatMessage({ id: "common.delete" })}
              </Button>
            ) : undefined
          }
        >
          <Button size="lg" onClick={handleSave} disabled={!canSave}>
            {intl.formatMessage({ id: "common.save" })}
          </Button>
          <Button variant="ghost" size="lg" onClick={onCancel}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
        </SettingsFormActions>
      </div>
    </div>
  );
}

function Field({
  children,
  htmlFor,
  label,
}: {
  children: ReactNode;
  htmlFor?: string;
  label: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={htmlFor} className="text-foreground-subtle">
        {label}
      </Label>
      {children}
    </div>
  );
}
