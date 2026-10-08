import { useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import { type CommandAgentSource, type CommandConfig, type UserCommand } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";
import { PluginScopeMenu } from "@/settings/PluginScopeMenu.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

const NAME_REGEX = /^[a-zA-Z0-9_-]+$/;
const MIN_NAME_LENGTH = 1;
const MAX_NAME_LENGTH = 50;

function CommandFormFieldLabel({ children }: { children: string }) {
  return (
    <label className="mb-1 block text-ui-base font-medium text-foreground-subtle">{children}</label>
  );
}

function CommandScopeMenu({
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
  const scopeLabel = intl.formatMessage({ id: "settings.scope.label" });

  return (
    <label className="flex min-w-0 flex-wrap items-center justify-end gap-2">
      <span className="shrink-0 text-ui-base text-foreground-subtle">{scopeLabel}</span>
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

interface CommandFormProps {
  initial?: UserCommand;
  agentSource?: CommandAgentSource;
  scopeKey: string;
  workspaceTabs: WorkspaceTabState[];
  onScopeKeyChange: (scopeKey: string) => void;
  onSave: (config: CommandConfig, scopeKey: string) => Promise<void>;
  onCancel: () => void;
  onDelete?: (command: UserCommand) => void;
  saving: boolean;
}

export function CommandForm({
  initial,
  scopeKey,
  workspaceTabs,
  onScopeKeyChange,
  onSave,
  onCancel,
  onDelete,
  saving,
}: CommandFormProps) {
  const { intl } = useZCodeIntl();
  const supportsArgumentHint = true;
  const initialName = initial?.name?.replace(/^\//, "") ?? "";
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initial?.description ?? "");
  const [argumentHint, setArgumentHint] = useState(initial?.argumentHint ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [nameError, setNameError] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const trimmedName = name.trim();
  const canSave = Boolean(
    prompt.trim() &&
    (initial ||
      (trimmedName.length >= MIN_NAME_LENGTH &&
        trimmedName.length <= MAX_NAME_LENGTH &&
        NAME_REGEX.test(trimmedName))),
  );

  const validate = (): boolean => {
    let valid = true;
    const trimmedName = name.trim();
    const nameRegex = NAME_REGEX;
    // 命令表单字段曾直接硬编码英文，导致中文界面下校验错误仍显示英文。
    if (initial) {
      setNameError(null);
    } else if (trimmedName.length < MIN_NAME_LENGTH || trimmedName.length > MAX_NAME_LENGTH) {
      setNameError(
        intl.formatMessage(
          { id: "settings.commands.form.validation.nameLength" },
          {
            min: String(MIN_NAME_LENGTH),
            max: String(MAX_NAME_LENGTH),
          },
        ),
      );
      valid = false;
    } else if (!nameRegex.test(trimmedName)) {
      setNameError(
        intl.formatMessage({
          id: "settings.commands.form.validation.nameCharacters",
        }),
      );
      valid = false;
    } else {
      setNameError(null);
    }
    if (!prompt.trim()) {
      setPromptError(
        intl.formatMessage({
          id: "settings.commands.form.validation.promptRequired",
        }),
      );
      valid = false;
    } else {
      setPromptError(null);
    }
    return valid;
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!validate()) {
      return;
    }
    const config: CommandConfig = {
      name: name.trim(),
      prompt: prompt.trim(),
      description: description.trim() || undefined,
      argumentHint: supportsArgumentHint ? argumentHint.trim() || undefined : undefined,
    };
    await onSave(config, scopeKey);
  };
  const scopeSelect = (
    <CommandScopeMenu
      disabled={Boolean(initial)}
      scopeKey={scopeKey}
      workspaceTabs={workspaceTabs}
      onChange={onScopeKeyChange}
    />
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="w-full min-w-0 space-y-1.5 md:w-48">
          <CommandFormFieldLabel>
            {intl.formatMessage({ id: "settings.commands.form.name.label" })}
          </CommandFormFieldLabel>
          <Input
            type="text"
            size="lg"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={intl.formatMessage({
              id: "settings.commands.form.name.placeholder",
            })}
            disabled={!!initial}
          />
        </div>
        <div>{scopeSelect}</div>
      </div>
      {nameError ? <p className="-mt-1 text-ui-base text-destructive">{nameError}</p> : null}

      <div className="space-y-1.5">
        <CommandFormFieldLabel>
          {intl.formatMessage({
            id: "settings.commands.form.description.label",
          })}
        </CommandFormFieldLabel>
        <Input
          type="text"
          size="lg"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={intl.formatMessage({
            id: "settings.commands.form.description.placeholder",
          })}
        />
      </div>

      {supportsArgumentHint ? (
        <div className="space-y-1.5">
          <CommandFormFieldLabel>
            {intl.formatMessage({
              id: "settings.commands.form.argumentHint.label",
            })}
          </CommandFormFieldLabel>
          <Input
            type="text"
            size="lg"
            value={argumentHint}
            onChange={(event) => setArgumentHint(event.target.value)}
            placeholder={intl.formatMessage({
              id: "settings.commands.form.argumentHint.placeholder",
            })}
          />
        </div>
      ) : null}

      <div className="space-y-1.5">
        <CommandFormFieldLabel>
          {intl.formatMessage({ id: "settings.commands.form.prompt.label" })}
        </CommandFormFieldLabel>
        <SettingsFormTextarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={5}
          className="min-h-28 text-ui-base"
          placeholder={intl.formatMessage({
            id: "settings.commands.form.prompt.placeholder",
          })}
        />
        {promptError ? <p className="text-ui-base text-destructive">{promptError}</p> : null}
      </div>

      <SettingsFormActions
        leadingAction={
          initial && onDelete ? (
            <Button
              type="button"
              variant="link"
              size="lg"
              className="px-0 text-destructive hover:text-destructive"
              onClick={() => onDelete(initial)}
              disabled={saving}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {intl.formatMessage({ id: "common.delete" })}
            </Button>
          ) : undefined
        }
      >
        <Button type="submit" variant="default" size="lg" disabled={!canSave || saving}>
          {saving
            ? intl.formatMessage({ id: "common.saving" })
            : intl.formatMessage({ id: "common.save" })}
        </Button>
        <Button type="button" variant="ghost" size="lg" onClick={onCancel} disabled={saving}>
          {intl.formatMessage({ id: "common.cancel" })}
        </Button>
      </SettingsFormActions>
    </form>
  );
}
