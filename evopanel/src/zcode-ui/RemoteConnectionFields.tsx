/* eslint-disable max-lines -- 远程连接字段较多，SSH/WSL/Docker 分支暂集中在单文件维护。 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DockerContainerInfo,
  RemoteAssetInstallMode,
  RemoteTarget,
  RemoteWorkspaceSessionEntry,
  SSHConfigAliasOption,
  WSLDistro,
} from "@zcode/shared";
import { AlertTriangleIcon, CheckIcon, ChevronDownIcon, LoaderIcon, Plus } from "lucide-react";
import {
  TID_DOCKER_CONTAINER_INPUT,
  TID_DOCKER_CONTAINER_SELECT,
  TID_SSH_CONFIG_ALIAS_SELECT,
  TID_SSH_AUTH_PASSWORD,
  TID_SSH_AUTH_PRIVATE_KEY,
  TID_SSH_HOST_INPUT,
  TID_SSH_PASSWORD_INPUT,
  TID_SSH_PORT_INPUT,
  TID_SSH_PRIVATE_KEY_INPUT,
  TID_SSH_USERNAME_INPUT,
  TID_WSL_DISTRO_SELECT,
  TID_WSL_USER_INPUT,
  isValidWslUser,
} from "@zcode/shared";
import type { SSHAuthMethod } from "@/hooks/useRemoteConnectionForm.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { RemoteConnectionHistoryInput } from "@/remote-connection/RemoteConnectionHistoryInput.js";
import { buildSshConnectionHistorySuggestions } from "@/remote-connection/sshHistorySuggestions.js";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const DEFAULT_WSL_DISTRO_VALUE = "__default_wsl_distro__";
const NO_SSH_CONFIG_ALIAS_VALUE = "__ssh_config_alias_none__";

function formatSshConfigAliasSummary(aliasOption: SSHConfigAliasOption): string {
  const host = aliasOption.host?.trim() || aliasOption.alias;
  const username = aliasOption.username?.trim();
  const withUser = username ? `${username}@${host}` : host;
  return aliasOption.port != null ? `${withUser}:${aliasOption.port}` : withUser;
}

export function RemoteConnectionFields({
  kind,
  host,
  port,
  username,
  sshAuthMethod,
  assetInstallMode,
  password,
  privateKeyPath,
  privateKeyPassphrase,
  wslDistro,
  wslUser = "",
  wslDistros,
  dockerContainer,
  manualDockerContainer,
  dockerContainers,
  dockerAvailable,
  sshConfigAliases,
  sshConfigAliasesLoading,
  sshConfigAliasesError,
  selectedSshConfigAlias,
  runtimeOptionsLoading,
  remoteWorkspaceSessions = [],
  refreshDockerContainers,
  applySshConfigAlias,
  clearSelectedSshConfigAlias,
  setHost,
  setPort,
  setUsername,
  setSshAuthMethod,
  setAssetInstallMode,
  setPassword,
  setPrivateKeyPath,
  setPrivateKeyPassphrase,
  setWslDistro,
  setWslUser,
  setDockerContainer,
  setManualDockerContainer,
}: {
  kind: RemoteTarget["kind"];
  host: string;
  port: string;
  username: string;
  sshAuthMethod: SSHAuthMethod;
  assetInstallMode: RemoteAssetInstallMode;
  password: string;
  privateKeyPath: string;
  privateKeyPassphrase: string;
  wslDistro: string;
  wslUser?: string;
  wslDistros: WSLDistro[];
  dockerContainer: string;
  manualDockerContainer: string;
  dockerContainers: DockerContainerInfo[];
  dockerAvailable: boolean | null;
  sshConfigAliases: SSHConfigAliasOption[];
  sshConfigAliasesLoading: boolean;
  sshConfigAliasesError: string;
  selectedSshConfigAlias: string | null;
  runtimeOptionsLoading: boolean;
  remoteWorkspaceSessions?: RemoteWorkspaceSessionEntry[];
  refreshDockerContainers?: () => void;
  applySshConfigAlias: (value: SSHConfigAliasOption) => void;
  clearSelectedSshConfigAlias: () => void;
  setHost: (value: string) => void;
  setPort: (value: string) => void;
  setUsername: (value: string) => void;
  setSshAuthMethod: (value: SSHAuthMethod) => void;
  setAssetInstallMode: (value: RemoteAssetInstallMode) => void;
  setPassword: (value: string) => void;
  setPrivateKeyPath: (value: string) => void;
  setPrivateKeyPassphrase: (value: string) => void;
  setWslDistro: (value: string) => void;
  setWslUser?: (value: string) => void;
  setDockerContainer: (value: string) => void;
  setManualDockerContainer: (value: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [sshAliasPopoverOpen, setSshAliasPopoverOpen] = useState(false);
  const [dockerContainerPopoverOpen, setDockerContainerPopoverOpen] = useState(false);
  const sshAliasListRef = useRef<HTMLDivElement | null>(null);
  const sshHistorySuggestions = buildSshConnectionHistorySuggestions(remoteWorkspaceSessions);
  const selectedSshAliasOption =
    selectedSshConfigAlias == null
      ? null
      : (sshConfigAliases.find((option) => option.alias === selectedSshConfigAlias) ?? null);
  const sshAliasTriggerLabel = sshConfigAliasesLoading
    ? intl.formatMessage({ id: "common.loading" })
    : (selectedSshAliasOption?.alias ??
      (sshConfigAliases.length === 0
        ? intl.formatMessage({ id: "ssh.configAliasEmpty" })
        : intl.formatMessage({ id: "ssh.configAliasPlaceholder" })));
  const handleSshAliasListWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const listElement = event.currentTarget;
    if (listElement.scrollHeight <= listElement.clientHeight) {
      return;
    }

    // Popover 嵌在 Dialog 中时，外层滚动锁会吞掉默认滚轮行为，
    // 导致 alias CommandList 只能拖滚动条、不能直接滚轮滚动。
    // 这里显式驱动列表自身 scrollTop，确保鼠标滚轮和触控板都能滚动候选项。
    listElement.scrollTop += event.deltaY;
    event.preventDefault();
    event.stopPropagation();
  }, []);
  const dockerContainerEmptyText =
    dockerAvailable === false
      ? intl.formatMessage({ id: "docker.unavailable" })
      : intl.formatMessage({ id: "docker.noContainers" });
  const dockerContainerTriggerLabel =
    dockerContainer.trim() ||
    (runtimeOptionsLoading
      ? intl.formatMessage({ id: "docker.loading" })
      : dockerContainers.length === 0
        ? dockerContainerEmptyText
        : intl.formatMessage({ id: "docker.selectContainer" }));
  const dockerContainerTriggerIsPlaceholder =
    !dockerContainer.trim() && dockerContainers.length === 0;
  const manualDockerContainerIsEmpty = manualDockerContainer.trim().length === 0;
  const wslUserIsRoot = wslUser.trim().toLowerCase() === "root";
  const wslUserIsInvalid = wslUser.trim().length > 0 && !isValidWslUser(wslUser);
  const handleDockerContainerPopoverOpenChange = useCallback(
    (nextOpen: boolean) => {
      setDockerContainerPopoverOpen(nextOpen);
      if (nextOpen) {
        refreshDockerContainers?.();
      }
    },
    [refreshDockerContainers],
  );

  useEffect(() => {
    if (kind !== "ssh" && sshAliasPopoverOpen) {
      setSshAliasPopoverOpen(false);
    }
  }, [kind, sshAliasPopoverOpen]);

  useEffect(() => {
    if (kind !== "docker" && dockerContainerPopoverOpen) {
      setDockerContainerPopoverOpen(false);
    }
  }, [dockerContainerPopoverOpen, kind]);

  useEffect(() => {
    if (!sshAliasPopoverOpen) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const selectedAliasItem = sshAliasListRef.current?.querySelector<HTMLElement>(
        '[data-ssh-config-alias-selected="true"]',
      );
      selectedAliasItem?.scrollIntoView({ block: "nearest" });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [sshAliasPopoverOpen, selectedSshConfigAlias, sshConfigAliases.length]);

  switch (kind) {
    case "ssh":
      return (
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="mb-1 block text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "ssh.configAlias" })}
            </label>
            <Popover open={sshAliasPopoverOpen} onOpenChange={setSshAliasPopoverOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  disabled={sshConfigAliasesLoading || sshConfigAliases.length === 0}
                  data-testid={TID_SSH_CONFIG_ALIAS_SELECT}
                  className="h-9 w-full max-w-80 justify-between rounded-lg border-input-border bg-input px-3 text-ui-base font-normal hover:border-input-border-hover hover:bg-input aria-expanded:border-input-border-focused aria-expanded:bg-input-focused"
                >
                  <span className="min-w-0 truncate text-left">{sshAliasTriggerLabel}</span>
                  <ChevronDownIcon className="size-3.5 text-foreground-subtle" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" sideOffset={6} className="w-80 gap-0 bg-menu p-0">
                <Command className="bg-transparent p-0 text-foreground">
                  <CommandInput
                    placeholder={intl.formatMessage({
                      id: "ssh.configAliasSearchPlaceholder",
                    })}
                    className="h-8"
                  />
                  <CommandList
                    ref={sshAliasListRef}
                    className="max-h-60 overscroll-contain"
                    onWheel={handleSshAliasListWheel}
                  >
                    <CommandEmpty className="px-4 py-5 text-foreground-subtle">
                      {intl.formatMessage({ id: "ssh.configAliasEmpty" })}
                    </CommandEmpty>
                    <CommandGroup className="p-1">
                      <CommandItem
                        value={NO_SSH_CONFIG_ALIAS_VALUE}
                        data-checked={selectedSshConfigAlias == null ? "true" : undefined}
                        data-ssh-config-alias-selected={
                          selectedSshConfigAlias == null ? "true" : undefined
                        }
                        className="min-h-8 cursor-pointer px-2 text-ui-base"
                        onSelect={() => {
                          clearSelectedSshConfigAlias();
                          setSshAliasPopoverOpen(false);
                        }}
                      >
                        <span className="truncate">
                          {intl.formatMessage({ id: "ssh.configAliasPlaceholder" })}
                        </span>
                      </CommandItem>
                      {sshConfigAliases.map((aliasOption) => (
                        <CommandItem
                          key={aliasOption.alias}
                          value={`${aliasOption.alias} ${formatSshConfigAliasSummary(aliasOption)}`}
                          data-checked={
                            selectedSshConfigAlias === aliasOption.alias ? "true" : undefined
                          }
                          data-ssh-config-alias-selected={
                            selectedSshConfigAlias === aliasOption.alias ? "true" : undefined
                          }
                          className="min-h-8 cursor-pointer px-2 text-ui-base"
                          onSelect={() => {
                            applySshConfigAlias(aliasOption);
                            setSshAliasPopoverOpen(false);
                          }}
                        >
                          <span className="flex min-w-0 flex-1 flex-col text-left">
                            <span className="truncate">{aliasOption.alias}</span>
                            <span className="truncate text-ui-base text-foreground-subtle">
                              {formatSshConfigAliasSummary(aliasOption)}
                            </span>
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <p
              className={cn(
                "text-ui-base",
                sshConfigAliasesError ? "text-warning" : "text-foreground-subtle",
              )}
            >
              {sshConfigAliasesLoading
                ? intl.formatMessage({ id: "common.loading" })
                : sshConfigAliasesError
                  ? intl.formatMessage({ id: "ssh.configAliasLoadFailed" })
                  : sshConfigAliases.length === 0
                    ? intl.formatMessage({ id: "ssh.configAliasEmpty" })
                    : intl.formatMessage({ id: "ssh.configAliasDescription" })}
            </p>
          </div>

          {/* Electron / Chromium 的原生 autocomplete 在 SSH 向导里不稳定，
              而且默认值（如 localhost / 22）会把历史候选提前过滤掉。
              这里改成用应用自身持久化的远程连接历史做显式候选，focus 时先展示完整历史；密码仍然不参与历史回填。 */}
          {/* 建议列表之前直接跟着全宽输入框展开，在大对话框里会变成长条。
              这里把宽度限制在字段语义范围内，只收窄建议列表，不改变原输入框布局。 */}
          {/* 示例值直接作为 placeholder 会被误认为已有默认值。
              这里改成“输入提示 + 示例”，让用户知道仍需手动填写必填字段。 */}
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_6.5rem]">
            <RemoteConnectionHistoryInput
              className="h-9 text-ui-base"
              label={intl.formatMessage({ id: "ssh.host" })}
              value={host}
              onChange={setHost}
              placeholder={intl.formatMessage({ id: "ssh.hostPlaceholder" })}
              suggestions={sshHistorySuggestions.hosts}
              emptyText={intl.formatMessage({ id: "remote.history.empty" })}
              suggestionWidth="min(30ch, calc(100vw - 2rem))"
              autoCapitalize="none"
              spellCheck={false}
              data-testid={TID_SSH_HOST_INPUT}
            />
            <RemoteConnectionHistoryInput
              className="h-9 text-ui-base"
              label={intl.formatMessage({ id: "ssh.port" })}
              value={port}
              onChange={setPort}
              placeholder="22"
              suggestions={sshHistorySuggestions.ports}
              emptyText={intl.formatMessage({ id: "remote.history.empty" })}
              suggestionWidth="min(8ch, calc(100vw - 2rem))"
              inputMode="numeric"
              data-testid={TID_SSH_PORT_INPUT}
            />
          </div>

          {/* 认证方式之前复用了端口的 6.5rem 窄列，两个选项扣除 padding 后会把中英文文案挤到换行或溢出。
              这里单独给认证方式保留 12rem，并禁止选项文字换行。 */}
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-end">
            <RemoteConnectionHistoryInput
              className="h-9 text-ui-base"
              label={intl.formatMessage({ id: "ssh.username" })}
              value={username}
              onChange={setUsername}
              placeholder={intl.formatMessage({ id: "ssh.usernamePlaceholder" })}
              suggestions={sshHistorySuggestions.usernames}
              emptyText={intl.formatMessage({ id: "remote.history.empty" })}
              suggestionWidth="min(30ch, calc(100vw - 2rem))"
              autoCapitalize="none"
              spellCheck={false}
              data-testid={TID_SSH_USERNAME_INPUT}
            />

            <div>
              <label className="mb-1 block text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "ssh.authMethod" })}
              </label>
              <div className="inline-flex w-full items-center rounded-lg border border-input-border bg-input p-[3px]">
                {(["password", "privateKey"] as const).map((value) => {
                  const selected = sshAuthMethod === value;

                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setSshAuthMethod(value)}
                      data-testid={
                        value === "password" ? TID_SSH_AUTH_PASSWORD : TID_SSH_AUTH_PRIVATE_KEY
                      }
                      className={cn(
                        "inline-flex h-7 flex-1 items-center justify-center rounded-md px-3 text-ui-base font-medium whitespace-nowrap transition-colors",
                        selected
                          ? "bg-background text-foreground"
                          : "text-foreground-subtle hover:text-foreground",
                      )}
                    >
                      {intl.formatMessage({ id: `ssh.auth.${value}` })}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {sshAuthMethod === "password" ? (
            <div>
              <label className="mb-1 block text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "ssh.password" })}
              </label>
              <Input
                size="lg"
                className="h-9 text-ui-base"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={intl.formatMessage({
                  id: "ssh.passwordPlaceholder",
                })}
                name="remote-ssh-password"
                autoComplete="off"
                data-testid={TID_SSH_PASSWORD_INPUT}
              />
            </div>
          ) : (
            <div>
              <label className="mb-1 block text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "ssh.privateKey" })}
              </label>
              <div className="relative mb-3">
                <RemoteConnectionHistoryInput
                  className="h-9 pr-10 text-ui-base"
                  value={privateKeyPath}
                  onChange={setPrivateKeyPath}
                  placeholder={intl.formatMessage({
                    id: "ssh.privateKeyPlaceholder",
                  })}
                  suggestions={sshHistorySuggestions.privateKeyPaths}
                  emptyText={intl.formatMessage({
                    id: "remote.history.empty",
                  })}
                  autoCapitalize="none"
                  spellCheck={false}
                  data-testid={TID_SSH_PRIVATE_KEY_INPUT}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  className="absolute top-1/2 right-0.5 -translate-y-1/2"
                  title={intl.formatMessage({ id: "ssh.privateKeySelect" })}
                  onClick={() => {
                    void (async () => {
                      const selectedPath = await platform.selectFile();
                      if (selectedPath) {
                        setPrivateKeyPath(selectedPath);
                      }
                    })();
                  }}
                >
                  <Plus className="size-4" />
                </Button>
              </div>
              <label className="mb-1 block text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "ssh.privateKeyPassphrase" })}
              </label>
              <Input
                size="lg"
                className="h-9 text-ui-base"
                type="password"
                value={privateKeyPassphrase}
                onChange={(e) => setPrivateKeyPassphrase(e.target.value)}
                placeholder={intl.formatMessage({
                  id: "ssh.privateKeyPassphrasePlaceholder",
                })}
                name="remote-ssh-private-key-passphrase"
                autoComplete="off"
              />
            </div>
          )}

          <div>
            <label className="mb-1 block text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "ssh.assetInstallMode" })}
            </label>
            <div className="inline-flex w-full max-w-md flex-col items-stretch rounded-lg border border-input-border bg-input p-[3px] sm:w-fit sm:flex-row sm:items-center">
              {(["local-download-upload", "remote-download"] as const).map((value) => {
                const selected = assetInstallMode === value;

                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setAssetInstallMode(value)}
                    className={cn(
                      "inline-flex min-h-7 min-w-0 flex-1 items-center justify-center rounded-md px-3 py-1 text-center text-ui-base font-medium transition-colors sm:flex-none",
                      selected
                        ? "bg-background text-foreground"
                        : "text-foreground-subtle hover:text-foreground",
                    )}
                  >
                    <span className="min-w-0 break-words">
                      {intl.formatMessage({
                        id: `ssh.assetInstallMode.${value}`,
                      })}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "ssh.assetInstallModeDescription" })}
            </p>
          </div>
        </div>
      );
    case "wsl":
      return (
        <div className="space-y-3">
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "wsl.description" })}
          </p>
          <div>
            <label className="mb-1 block text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "wsl.distro" })}
            </label>
            {wslDistros.length > 0 ? (
              <Select
                value={wslDistro || DEFAULT_WSL_DISTRO_VALUE}
                onValueChange={(value) => {
                  setWslDistro(value === DEFAULT_WSL_DISTRO_VALUE ? "" : value);
                }}
              >
                <SelectTrigger size="lg" className="h-9 w-full" data-testid={TID_WSL_DISTRO_SELECT}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start">
                  <SelectItem value={DEFAULT_WSL_DISTRO_VALUE}>
                    {intl.formatMessage({ id: "wsl.defaultDistro" })}
                  </SelectItem>
                  {wslDistros.map((distro) => (
                    <SelectItem key={distro.name} value={distro.name}>
                      {distro.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                size="lg"
                className="h-9 text-ui-base"
                value={wslDistro}
                onChange={(e) => setWslDistro(e.target.value)}
                placeholder={intl.formatMessage({ id: "wsl.defaultDistro" })}
              />
            )}
          </div>
          <p className="text-ui-base text-foreground-subtle">
            {runtimeOptionsLoading
              ? intl.formatMessage({ id: "wsl.loading" })
              : wslDistros.length > 0
                ? intl.formatMessage(
                    { id: "wsl.detectedCount" },
                    {
                      count: String(wslDistros.length),
                    },
                  )
                : intl.formatMessage({ id: "wsl.noDistros" })}
          </p>
          <div>
            <label className="mb-1 block text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "wsl.user" })}
            </label>
            <Input
              size="lg"
              className="h-9 text-ui-base"
              value={wslUser}
              onChange={(event) => setWslUser?.(event.target.value)}
              placeholder={intl.formatMessage({ id: "wsl.defaultUser" })}
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={wslUserIsInvalid}
              data-testid={TID_WSL_USER_INPUT}
            />
            <p
              className={cn(
                "mt-1 text-ui-base",
                wslUserIsInvalid ? "text-destructive" : "text-foreground-subtle",
              )}
            >
              {intl.formatMessage({
                id: wslUserIsInvalid ? "wsl.validation.invalidUser" : "wsl.userDescription",
              })}
            </p>
          </div>
          {wslUserIsRoot ? (
            <div className="flex items-start gap-2 rounded-lg border border-warning bg-warning px-3 py-2 text-ui-base text-warning-foreground">
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
              <span>{intl.formatMessage({ id: "wsl.rootWarning" })}</span>
            </div>
          ) : null}
        </div>
      );
    case "docker":
      return (
        <div className="space-y-3">
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "docker.description" })}
          </p>
          <div>
            <label className="mb-1 block text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "docker.selectContainer" })}
            </label>
            <Popover
              open={dockerContainerPopoverOpen}
              onOpenChange={handleDockerContainerPopoverOpenChange}
            >
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  data-testid={TID_DOCKER_CONTAINER_SELECT}
                  className="h-9 w-full justify-between rounded-lg border-input-border bg-input px-3 text-ui-base font-normal hover:border-input-border-hover hover:bg-input aria-expanded:border-input-border-focused aria-expanded:bg-input-focused"
                >
                  <span
                    className={cn(
                      "min-w-0 truncate text-left",
                      dockerContainerTriggerIsPlaceholder
                        ? "text-foreground-subtlest"
                        : "text-foreground",
                    )}
                  >
                    {dockerContainerTriggerLabel}
                  </span>
                  {runtimeOptionsLoading ? (
                    <LoaderIcon className="size-3.5 shrink-0 animate-spin text-foreground-subtle" />
                  ) : (
                    <ChevronDownIcon className="size-3.5 shrink-0 text-foreground-subtle" />
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                sideOffset={6}
                className="max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-menu p-1 shadow-lg"
                style={{ width: "var(--radix-popover-trigger-width)" }}
              >
                <Command className="rounded-lg bg-transparent p-0 text-foreground">
                  <CommandList className="max-h-56 scroll-py-1">
                    {runtimeOptionsLoading ? (
                      <div className="flex min-h-8 items-center gap-2 rounded-lg px-3 py-1.5 text-ui-base text-foreground-subtle">
                        <LoaderIcon className="size-3.5 shrink-0 animate-spin" />
                        <span className="truncate">
                          {intl.formatMessage({ id: "docker.loading" })}
                        </span>
                      </div>
                    ) : null}
                    {dockerContainers.length === 0 && !runtimeOptionsLoading ? (
                      <CommandEmpty className="px-3 py-5 text-ui-base text-foreground-subtle">
                        {dockerContainerEmptyText}
                      </CommandEmpty>
                    ) : (
                      dockerContainers.map((container) => {
                        const selected = container.name === dockerContainer;

                        return (
                          <CommandItem
                            key={container.id}
                            value={container.name}
                            className="min-h-8 cursor-pointer rounded-lg px-3 py-1.5 text-ui-base text-foreground data-selected:bg-menu-hover data-selected:text-foreground"
                            onSelect={() => {
                              setDockerContainer(container.name);
                              setDockerContainerPopoverOpen(false);
                            }}
                          >
                            <span className="min-w-0 flex-1 truncate">{container.name}</span>
                            <CheckIcon
                              className={cn(
                                "size-4 shrink-0 text-foreground-subtle",
                                selected ? "opacity-100" : "opacity-0",
                              )}
                            />
                          </CommandItem>
                        );
                      })
                    )}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
          <div>
            <label className="mb-1 block text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "docker.container" })}
            </label>
            <Input
              size="lg"
              className="h-9 text-ui-base"
              value={manualDockerContainer}
              onChange={(event) => setManualDockerContainer(event.target.value)}
              placeholder={intl.formatMessage({ id: "docker.containerPlaceholder" })}
              data-testid={TID_DOCKER_CONTAINER_INPUT}
            />
            {manualDockerContainerIsEmpty ? (
              <p className="mt-1 text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "docker.manualContainerHint" })}
              </p>
            ) : null}
          </div>
        </div>
      );
  }
}
