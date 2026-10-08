/* eslint-disable max-lines -- 远程连接向导的多个步骤暂集中在同一文件，避免拆分时扩大 SSH/Docker/WSL 回归面。 */
import { useState } from "react";
import type {
  DockerContainerInfo,
  RemoteAssetInstallMode,
  RemoteTarget,
  RemoteWorkspaceSessionEntry,
  SSHConfigAliasOption,
  WSLDistro,
} from "@zcode/shared";
import { TID_REMOTE_KIND_DOCKER, TID_REMOTE_KIND_SSH, TID_REMOTE_KIND_WSL } from "@zcode/shared";
import type {
  IMcpSyncService,
  IPluginSyncService,
  IServiceAccessor,
  ISkillSyncService,
  IZCodeAgentService,
} from "@zcode/services";
import {
  AlertTriangleIcon,
  ChevronRightIcon,
  LoaderIcon,
  MonitorCogIcon,
  ServerIcon,
  TerminalIcon,
} from "lucide-react";
import { DirectoryBrowser } from "@/DirectoryBrowser.js";
import { RemoteConnectionFields } from "@/RemoteConnectionFields.js";
import type { SSHAuthMethod } from "@/hooks/useRemoteConnectionForm.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  RemoteSyncDialogs,
  RemoteSyncDropdownButton,
  shouldShowRemoteSyncActions,
} from "@/settings/RemoteSyncActions.js";
export { RemoteConnectionConnectingStep } from "@/remote-connection/RemoteConnectionConnectingStep.js";

function getKindIcon(kind: RemoteTarget["kind"]) {
  switch (kind) {
    case "ssh":
      return ServerIcon;
    case "docker":
      return MonitorCogIcon;
    case "wsl":
      return TerminalIcon;
  }
}

export function RemoteConnectionKindStep({
  kind,
  availableKinds,
  onKindChange,
  onCancel,
  onNext,
}: {
  kind: RemoteTarget["kind"];
  availableKinds: RemoteTarget["kind"][];
  onKindChange: (value: RemoteTarget["kind"]) => void;
  onCancel: () => void;
  onNext: () => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 h-full">
      <div className="flex-1 min-h-0 grid content-start gap-3 md:grid-cols-2">
        {availableKinds.map((value) => {
          const Icon = getKindIcon(value);
          const selected = kind === value;

          return (
            <button
              key={value}
              type="button"
              onClick={() => onKindChange(value)}
              data-testid={
                value === "ssh"
                  ? TID_REMOTE_KIND_SSH
                  : value === "wsl"
                    ? TID_REMOTE_KIND_WSL
                    : TID_REMOTE_KIND_DOCKER
              }
              className={cn(
                "flex min-h-32 flex-col items-start gap-4 rounded-2xl border p-4 text-left transition-colors",
                selected
                  ? "border-border-hover bg-selected"
                  : "border-border bg-card hover:border-border-hover hover:bg-surface",
              )}
            >
              <div
                className={cn(
                  "flex size-10 items-center justify-center rounded-xl border",
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background-alt text-foreground-subtle",
                )}
              >
                <Icon className="size-5" />
              </div>
              <div className="min-w-0 space-y-1">
                <p className="text-ui-lg font-medium text-foreground">
                  {intl.formatMessage({ id: `remote.kind.${value}` })}
                </p>
                <p className="text-ui-base leading-5 text-foreground-subtle">
                  {intl.formatMessage({
                    id: `remote.kind.${value}.wizardDescription`,
                  })}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex gap-3 justify-end">
        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="h-10 min-w-0 px-5"
          onClick={onCancel}
        >
          {intl.formatMessage({ id: "common.cancel" })}
        </Button>
        <Button type="button" size="lg" className="h-10 min-w-0 px-5" onClick={onNext}>
          {intl.formatMessage({ id: "common.next" })}
          <ChevronRightIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}

export function RemoteConnectionSettingsStep({
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
  currentRuntimeOptionsLoading,
  currentRuntimeOptionsError,
  remoteWorkspaceSessions = [],
  validationMessage,
  loading,
  onBack,
  onHostChange,
  onPortChange,
  onUsernameChange,
  onSshAuthMethodChange,
  onAssetInstallModeChange,
  onPasswordChange,
  onPrivateKeyPathChange,
  onPrivateKeyPassphraseChange,
  onWslDistroChange,
  onWslUserChange,
  onDockerContainerChange,
  onManualDockerContainerChange,
  onDockerContainersRefresh,
  onApplySshConfigAlias,
  onClearSelectedSshConfigAlias,
  onConnect,
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
  currentRuntimeOptionsLoading: boolean;
  currentRuntimeOptionsError: string;
  remoteWorkspaceSessions?: RemoteWorkspaceSessionEntry[];
  validationMessage: string;
  loading: boolean;
  onBack: () => void;
  onHostChange: (value: string) => void;
  onPortChange: (value: string) => void;
  onUsernameChange: (value: string) => void;
  onSshAuthMethodChange: (value: SSHAuthMethod) => void;
  onAssetInstallModeChange: (value: RemoteAssetInstallMode) => void;
  onPasswordChange: (value: string) => void;
  onPrivateKeyPathChange: (value: string) => void;
  onPrivateKeyPassphraseChange: (value: string) => void;
  onWslDistroChange: (value: string) => void;
  onWslUserChange?: (value: string) => void;
  onDockerContainerChange: (value: string) => void;
  onManualDockerContainerChange: (value: string) => void;
  onDockerContainersRefresh?: () => void;
  onApplySshConfigAlias: (value: SSHConfigAliasOption) => void;
  onClearSelectedSshConfigAlias: () => void;
  onConnect: () => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 h-full">
      <div
        data-testid="remote-connection-settings-scroll"
        // SSH 配置项增多时，表单内容以前没有自己的滚动边界，会继续绘制到下方按钮区域。
        // 这里把中间内容区限定为可滚动区域，让 footer 始终占据独立空间，不遮挡最后几项配置。
        className="flex-1 min-h-0 space-y-4 overflow-y-auto pr-1"
      >
        {currentRuntimeOptionsError ? (
          <div className="flex items-start gap-3 rounded-2xl border border-warning bg-warning px-4 py-3 text-ui-base text-warning-foreground">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
            <span>{intl.formatMessage({ id: "remote.optionsLoadFailed" })}</span>
          </div>
        ) : null}

        <RemoteConnectionFields
          kind={kind}
          host={host}
          port={port}
          username={username}
          sshAuthMethod={sshAuthMethod}
          assetInstallMode={assetInstallMode}
          password={password}
          privateKeyPath={privateKeyPath}
          privateKeyPassphrase={privateKeyPassphrase}
          wslDistro={wslDistro}
          wslUser={wslUser}
          wslDistros={wslDistros}
          dockerContainer={dockerContainer}
          manualDockerContainer={manualDockerContainer}
          dockerContainers={dockerContainers}
          dockerAvailable={dockerAvailable}
          sshConfigAliases={sshConfigAliases}
          sshConfigAliasesLoading={sshConfigAliasesLoading}
          sshConfigAliasesError={sshConfigAliasesError}
          selectedSshConfigAlias={selectedSshConfigAlias}
          runtimeOptionsLoading={currentRuntimeOptionsLoading}
          remoteWorkspaceSessions={remoteWorkspaceSessions}
          applySshConfigAlias={onApplySshConfigAlias}
          clearSelectedSshConfigAlias={onClearSelectedSshConfigAlias}
          setHost={onHostChange}
          setPort={onPortChange}
          setUsername={onUsernameChange}
          setSshAuthMethod={onSshAuthMethodChange}
          setAssetInstallMode={onAssetInstallModeChange}
          setPassword={onPasswordChange}
          setPrivateKeyPath={onPrivateKeyPathChange}
          setPrivateKeyPassphrase={onPrivateKeyPassphraseChange}
          setWslDistro={onWslDistroChange}
          setWslUser={onWslUserChange}
          setDockerContainer={onDockerContainerChange}
          setManualDockerContainer={onManualDockerContainerChange}
          refreshDockerContainers={onDockerContainersRefresh}
        />
      </div>

      <div className="flex items-center justify-end gap-3">
        {validationMessage ? (
          <div className="flex flex-1 min-w-0 items-center gap-2">
            <AlertTriangleIcon className="size-4 shrink-0 text-warning" />
            <span className="text-warning">{validationMessage}</span>
          </div>
        ) : null}
        <div className="flex shrink-0 justify-end gap-3">
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className="h-10 min-w-0 px-5"
            onClick={onBack}
            disabled={loading}
          >
            {intl.formatMessage({ id: "common.back" })}
          </Button>
          <Button
            type="button"
            size="lg"
            className="h-10 min-w-0 px-5"
            onClick={onConnect}
            disabled={loading}
          >
            {loading ? (
              <>
                <LoaderIcon className="size-4 animate-spin" />
                {intl.formatMessage({ id: "remote.connecting" })}
              </>
            ) : (
              intl.formatMessage({ id: "remote.startConnection" })
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function RemoteConnectionDirectoryStep({
  services,
  remoteTarget,
  localSkillSyncService,
  remoteSkillSyncService,
  localMcpSyncService,
  remoteMcpSyncService,
  localPluginSyncService,
  remotePluginSyncService,
  localZCodeAgentService,
  remoteZCodeAgentService,
  localWorkspacePath,
  selecting = false,
  onSelect,
  onBack,
  onCancel,
  onSkillsSynced,
  onMcpSynced,
  onPluginsSynced,
}: {
  services: IServiceAccessor | null;
  remoteTarget?: RemoteTarget | null;
  localSkillSyncService?: ISkillSyncService;
  remoteSkillSyncService?: ISkillSyncService | null;
  localMcpSyncService?: IMcpSyncService;
  remoteMcpSyncService?: IMcpSyncService | null;
  localPluginSyncService?: IPluginSyncService;
  remotePluginSyncService?: IPluginSyncService | null;
  localZCodeAgentService?: IZCodeAgentService;
  remoteZCodeAgentService?: IZCodeAgentService | null;
  localWorkspacePath?: string;
  selecting?: boolean;
  onSelect: (path: string) => void;
  onBack: () => void;
  onCancel: () => void;
  onSkillsSynced?: () => Promise<void> | void;
  onMcpSynced?: () => Promise<void> | void;
  onPluginsSynced?: () => Promise<void> | void;
}) {
  const { intl } = useZCodeIntl();
  const [selectedPath, setSelectedPath] = useState("");
  const [remoteSkillSyncOpen, setRemoteSkillSyncOpen] = useState(false);
  const [remoteMcpSyncOpen, setRemoteMcpSyncOpen] = useState(false);
  const [remotePluginSyncOpen, setRemotePluginSyncOpen] = useState(false);
  const canShowRemoteSyncActions = shouldShowRemoteSyncActions({
    remoteSessionId: remoteTarget ? "directory-step" : null,
    remoteTarget,
    clientMode: "desktop-continuous",
    hasLocalSourceService: Boolean(
      localSkillSyncService || localMcpSyncService || localPluginSyncService,
    ),
  });
  const canSyncRemoteSkills = Boolean(
    canShowRemoteSyncActions && localSkillSyncService && remoteSkillSyncService,
  );
  const canSyncRemoteMcp = Boolean(
    canShowRemoteSyncActions && localMcpSyncService && remoteMcpSyncService,
  );
  const canSyncRemotePlugins = Boolean(
    canShowRemoteSyncActions && localPluginSyncService && remotePluginSyncService,
  );

  if (!services) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-6 h-full">
        <div className="flex min-h-[22rem] flex-1 items-center justify-center rounded-2xl border border-border bg-card text-ui-base text-foreground-subtle">
          <LoaderIcon className="mr-2 size-4 animate-spin" />
          {intl.formatMessage({ id: "common.loading" })}
        </div>
        <div className="flex justify-end gap-3">
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className="h-10 min-w-0 w-32"
            onClick={onBack}
          >
            {intl.formatMessage({ id: "common.back" })}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 h-full" aria-busy={selecting}>
      <div className="flex flex-col flex-1 min-h-0 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-success bg-success px-4 py-3 text-ui-base text-success-foreground">
          <span>{intl.formatMessage({ id: "remote.success" })}</span>
          <RemoteSyncDropdownButton
            canSyncSkills={canSyncRemoteSkills}
            canSyncMcp={canSyncRemoteMcp}
            canSyncPlugins={canSyncRemotePlugins}
            mcpDisabled={!selectedPath.trim()}
            onOpenSkillSync={() => setRemoteSkillSyncOpen(true)}
            onOpenMcpSync={() => setRemoteMcpSyncOpen(true)}
            onOpenPluginSync={() => setRemotePluginSyncOpen(true)}
          />
        </div>
        {/* 该容器之前不是 flex，导致子级 DirectoryBrowser 的 flex-1 无法拿到有效高度，
            目录项变多时 overflow-y-auto 不生效，列表不能垂直滚动。 */}
        <div
          className={cn(
            "min-h-0 flex flex-1 overflow-hidden",
            selecting ? "pointer-events-none opacity-70" : "",
          )}
        >
          <DirectoryBrowser
            services={services}
            embedded
            onSelect={onSelect}
            onCancel={onCancel}
            onPathChange={setSelectedPath}
          />
        </div>
      </div>
      <div className="flex items-center justify-end gap-3">
        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="h-10 min-w-0 px-5"
          onClick={onBack}
          disabled={selecting}
        >
          {intl.formatMessage({ id: "common.back" })}
        </Button>
        <Button
          type="button"
          size="lg"
          className="h-10 min-w-0 px-5"
          onClick={() => selectedPath && !selecting && onSelect(selectedPath)}
          disabled={!selectedPath || selecting}
        >
          {selecting ? (
            <>
              <LoaderIcon className="size-4 animate-spin" />
              {intl.formatMessage({ id: "common.loading" })}
            </>
          ) : (
            intl.formatMessage({ id: "directoryBrowser.selectDir" })
          )}
        </Button>
      </div>
      <RemoteSyncDialogs
        canSyncSkills={canSyncRemoteSkills}
        canSyncMcp={canSyncRemoteMcp}
        canSyncPlugins={canSyncRemotePlugins}
        skillOpen={remoteSkillSyncOpen}
        mcpOpen={remoteMcpSyncOpen}
        pluginOpen={remotePluginSyncOpen}
        onSkillOpenChange={setRemoteSkillSyncOpen}
        onMcpOpenChange={setRemoteMcpSyncOpen}
        onPluginOpenChange={setRemotePluginSyncOpen}
        localSkillSyncService={localSkillSyncService}
        remoteSkillSyncService={remoteSkillSyncService}
        localMcpSyncService={localMcpSyncService}
        remoteMcpSyncService={remoteMcpSyncService}
        localPluginSyncService={localPluginSyncService}
        remotePluginSyncService={remotePluginSyncService}
        localZCodeAgentService={localZCodeAgentService}
        remoteZCodeAgentService={remoteZCodeAgentService}
        remoteTarget={remoteTarget}
        skillWorkspacePath=""
        mcpWorkspacePath={selectedPath.trim()}
        pluginWorkspacePath={selectedPath.trim()}
        pluginLocalWorkspacePath={localWorkspacePath}
        mcpLocalWorkspacePath={localWorkspacePath}
        onSkillsSynced={async () => {
          await onSkillsSynced?.();
        }}
        onMcpSynced={async () => {
          await onMcpSynced?.();
        }}
        onPluginsSynced={async () => {
          await onPluginsSynced?.();
        }}
      />
    </div>
  );
}
