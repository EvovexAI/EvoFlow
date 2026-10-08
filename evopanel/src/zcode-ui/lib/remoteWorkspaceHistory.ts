/* eslint-disable max-lines -- 远端 workspace 历史集中维护持久化、凭据和 MCP 路径映射元数据，拆分会扩大恢复链路回归面。 */
import type {
  AppSettings,
  PersistedWorkspaceSessionEntry,
  RemoteTarget,
  RemoteTargetSnapshot,
  RemoteWorkspaceSessionEntry,
} from "@zcode/shared";
import type { WindowTabState } from "@/store/tabStore.js";
import { isWorkspaceTab } from "@/store/tabStore.js";

const REMOTE_WORKSPACE_SESSION_LIMIT = 20;

interface RemoteWorkspaceSessionMutation {
  entry: RemoteWorkspaceSessionEntry;
  nextRemoteSessions: RemoteWorkspaceSessionEntry[];
  credentialsToSave: {
    key: string;
    value: string;
  }[];
  credentialKeysToDelete: string[];
}

interface RemoveRemoteWorkspaceSessionEntriesResult {
  nextRemoteSessions: RemoteWorkspaceSessionEntry[];
  credentialKeysToDelete: string[];
}

function buildRemoteWorkspacePasswordCredentialKey(workspaceKey: string): string {
  return `remote-workspace:${workspaceKey}:password`;
}

function buildRemoteWorkspacePrivateKeyPassphraseCredentialKey(workspaceKey: string): string {
  return `remote-workspace:${workspaceKey}:private-key-passphrase`;
}

function collectRemoteWorkspaceCredentialKeys(snapshot: RemoteTargetSnapshot): string[] {
  if (snapshot.kind === "ssh") {
    return [snapshot.passwordCredentialKey, snapshot.privateKeyPassphraseCredentialKey].filter(
      (key): key is string => typeof key === "string" && key.length > 0,
    );
  }

  return [];
}

export function hasRemoteWorkspaceIdentity(entry: {
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  workspaceIdentity?: string;
}): boolean {
  return Boolean(entry.remoteSessionId || entry.remoteTarget || entry.workspaceIdentity);
}

type WslRemoteTargetLike = Extract<RemoteTarget | RemoteTargetSnapshot, { kind: "wsl" }>;

function getWslRemoteTargetUser(target: WslRemoteTargetLike): string | undefined {
  return target.user?.trim() || undefined;
}

function formatWslRemoteTargetAuthority(target: WslRemoteTargetLike): string {
  const user = getWslRemoteTargetUser(target);
  if (target.distro) {
    return user ? `wsl:${target.distro}:${user}` : `wsl:${target.distro}`;
  }

  return user ? `wsl:default:${user}` : "wsl";
}

export function formatRemoteWorkspaceTargetSubtitle(
  target: RemoteTarget | RemoteTargetSnapshot,
): string {
  switch (target.kind) {
    case "ssh":
      return `SSH · ${target.username}@${target.host}${target.port ? `:${target.port}` : ""}`;
    case "wsl": {
      const user = getWslRemoteTargetUser(target);
      return ["WSL", target.distro, user].filter(Boolean).join(" · ");
    }
    case "docker":
      return `Docker · ${target.container}`;
  }
}

export function formatRemoteWorkspaceHeaderHostLabel(
  target: RemoteTarget | RemoteTargetSnapshot,
): string {
  switch (target.kind) {
    case "ssh":
      return target.port && target.port !== 22 ? `${target.host}:${target.port}` : target.host;
    case "wsl":
      return formatWslRemoteTargetAuthority(target);
    case "docker":
      return `docker:${target.container}`;
  }
}

export function formatRemoteWorkspaceDisplayLabel(
  label: string,
  target?: RemoteTarget | RemoteTargetSnapshot,
): string {
  if (target?.kind !== "ssh") {
    return label;
  }

  const sshConfigAlias = target.sshConfigAlias?.trim();
  return sshConfigAlias ? `${label} [SSH: ${sshConfigAlias}]` : label;
}

function normalizeWorkspacePathForIdentity(path: string): string {
  // 远程目录可能出现符号链接别名（例如 /dev 与 /home/dev）。
  // 身份计算前统一做分隔符归一化与收尾斜杠清理，避免同一路径文本噪声导致身份漂移。
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.length > 0 ? normalized : "/";
}

function getRemoteWorkspaceAuthorityKey(target: RemoteTarget | RemoteTargetSnapshot): string {
  switch (target.kind) {
    case "ssh": {
      const normalizedHost = target.host.trim().toLowerCase();
      const normalizedUsername = target.username.trim();
      const normalizedPort = target.port ?? 22;
      return ["ssh", normalizedHost, normalizedPort, normalizedUsername].join(":");
    }
    case "wsl": {
      // WSL 默认用户与 root/其他显式用户的文件权限边界不同，
      // workspace identity 必须区分显式 user，避免 session、缓存和队列串用。
      const user = getWslRemoteTargetUser(target);
      const base = ["wsl", target.distro ?? "default"];
      return user ? [...base, user].join(":") : base.join(":");
    }
    case "docker":
      return ["docker", target.container].join(":");
  }
}

export function buildRemoteWorkspaceIdentity(
  workspacePath: string,
  target: RemoteTarget | RemoteTargetSnapshot,
): string {
  const authority = getRemoteWorkspaceAuthorityKey(target);
  const normalizedPath = normalizeWorkspacePathForIdentity(workspacePath);
  return `remote:${authority}:${normalizedPath}`;
}

export function resolveRemoteWorkspaceSessionIdentity(
  entry: Pick<RemoteWorkspaceSessionEntry, "workspacePath" | "target" | "workspaceIdentity">,
): string {
  return entry.workspaceIdentity || buildRemoteWorkspaceIdentity(entry.workspacePath, entry.target);
}

export function buildWorkspaceSessionKey(entry: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  return entry.workspaceIdentity?.trim() || entry.workspacePath;
}

function normalizeOptionalPath(path: string | undefined): string | undefined {
  const trimmed = path?.trim();
  return trimmed ? trimmed : undefined;
}

function findMatchingRemoteWorkspaceSessionEntry(
  sessions: RemoteWorkspaceSessionEntry[],
  workspacePath: string,
  target: RemoteTarget | RemoteTargetSnapshot,
): RemoteWorkspaceSessionEntry | null {
  const workspaceIdentity = buildRemoteWorkspaceIdentity(workspacePath, target);
  return (
    sessions.find((entry) => resolveRemoteWorkspaceSessionIdentity(entry) === workspaceIdentity) ??
    null
  );
}

function createRemoteTargetSnapshot(
  workspaceKey: string,
  target: RemoteTarget,
  previousSnapshot?: RemoteTargetSnapshot,
): RemoteTargetSnapshot {
  switch (target.kind) {
    case "ssh":
      return {
        kind: "ssh",
        host: target.host,
        port: target.port,
        username: target.username,
        ...(target.sshConfigAlias?.trim() ? { sshConfigAlias: target.sshConfigAlias.trim() } : {}),
        assetInstallMode: target.assetInstallMode,
        privateKeyPath: target.privateKeyPath,
        passwordCredentialKey:
          target.password && target.password.length > 0
            ? previousSnapshot?.kind === "ssh" && previousSnapshot.passwordCredentialKey
              ? previousSnapshot.passwordCredentialKey
              : buildRemoteWorkspacePasswordCredentialKey(workspaceKey)
            : undefined,
        privateKeyPassphraseCredentialKey:
          target.privateKeyPassphrase && target.privateKeyPassphrase.length > 0
            ? previousSnapshot?.kind === "ssh" && previousSnapshot.privateKeyPassphraseCredentialKey
              ? previousSnapshot.privateKeyPassphraseCredentialKey
              : buildRemoteWorkspacePrivateKeyPassphraseCredentialKey(workspaceKey)
            : undefined,
      };
    case "wsl": {
      const user = target.user?.trim();
      return {
        kind: "wsl",
        distro: target.distro,
        ...(user ? { user } : {}),
      };
    }
    case "docker":
      return {
        kind: "docker",
        container: target.container,
      };
  }
}

export function createRemoteTargetFromSnapshot(
  snapshot: RemoteTargetSnapshot,
  credentials: {
    password: string | null;
    privateKeyPassphrase: string | null;
  },
): RemoteTarget {
  switch (snapshot.kind) {
    case "ssh":
      return {
        kind: "ssh",
        host: snapshot.host,
        port: snapshot.port,
        username: snapshot.username,
        ...(snapshot.sshConfigAlias ? { sshConfigAlias: snapshot.sshConfigAlias } : {}),
        ...(snapshot.assetInstallMode ? { assetInstallMode: snapshot.assetInstallMode } : {}),
        ...(snapshot.privateKeyPath ? { privateKeyPath: snapshot.privateKeyPath } : {}),
        ...(credentials.password ? { password: credentials.password } : {}),
        ...(credentials.privateKeyPassphrase
          ? { privateKeyPassphrase: credentials.privateKeyPassphrase }
          : {}),
      };
    case "wsl":
      return {
        kind: "wsl",
        distro: snapshot.distro,
        ...(snapshot.user ? { user: snapshot.user } : {}),
      };
    case "docker":
      return {
        kind: "docker",
        container: snapshot.container,
      };
  }
}

function upsertRemoteWorkspaceSessionEntries(
  sessions: RemoteWorkspaceSessionEntry[],
  nextEntry: RemoteWorkspaceSessionEntry,
): RemoteWorkspaceSessionEntry[] {
  const nextWorkspaceKey = buildWorkspaceSessionKey(nextEntry);
  return [
    nextEntry,
    ...sessions.filter((entry) => buildWorkspaceSessionKey(entry) !== nextWorkspaceKey),
  ]
    .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt)
    .slice(0, REMOTE_WORKSPACE_SESSION_LIMIT);
}

export function removeRemoteWorkspaceSessionEntries(
  sessions: readonly RemoteWorkspaceSessionEntry[],
  workspaceKeys: readonly string[],
): RemoveRemoteWorkspaceSessionEntriesResult {
  const workspaceKeySet = new Set(
    workspaceKeys.map((workspaceKey) => workspaceKey.trim()).filter(Boolean),
  );
  const credentialKeysToDelete = new Set<string>();
  const nextRemoteSessions: RemoteWorkspaceSessionEntry[] = [];

  for (const session of sessions) {
    const sessionWorkspaceKey = buildWorkspaceSessionKey(session);
    if (!workspaceKeySet.has(sessionWorkspaceKey)) {
      nextRemoteSessions.push(session);
      continue;
    }

    for (const credentialKey of collectRemoteWorkspaceCredentialKeys(session.target)) {
      credentialKeysToDelete.add(credentialKey);
    }
  }

  return {
    nextRemoteSessions,
    credentialKeysToDelete: [...credentialKeysToDelete],
  };
}

export function buildRemoteWorkspaceSessionMutation(params: {
  remoteSessions: RemoteWorkspaceSessionEntry[];
  workspacePath: string;
  localWorkspacePath?: string;
  workspaceIdentity?: string;
  target: RemoteTarget;
  lastConnectionStatus: RemoteWorkspaceSessionEntry["lastConnectionStatus"];
  lastConnectionError?: string;
  touchOpenedAt: boolean;
}): RemoteWorkspaceSessionMutation {
  const currentEntry =
    findMatchingRemoteWorkspaceSessionEntry(
      params.remoteSessions,
      params.workspacePath,
      params.target,
    ) ?? null;
  const resolvedWorkspaceIdentity =
    params.workspaceIdentity ??
    currentEntry?.workspaceIdentity ??
    buildRemoteWorkspaceIdentity(params.workspacePath, params.target);
  const workspaceKey = resolvedWorkspaceIdentity?.trim() || params.workspacePath;
  const nextSnapshot =
    params.lastConnectionStatus === "failed" && currentEntry
      ? currentEntry.target
      : createRemoteTargetSnapshot(workspaceKey, params.target, currentEntry?.target);
  const localWorkspacePath = normalizeOptionalPath(
    params.localWorkspacePath ?? currentEntry?.localWorkspacePath,
  );
  const nextEntry: RemoteWorkspaceSessionEntry = {
    kind: "remote",
    workspacePath: params.workspacePath,
    // filesystem MCP 同步需要用“本机 workspace -> 远端 workspace”映射。
    // 远端历史之前只保存远端路径，已连接后的 Settings/Header 入口无法再恢复本机基准路径。
    ...(localWorkspacePath ? { localWorkspacePath } : {}),
    workspaceIdentity: resolvedWorkspaceIdentity,
    target: nextSnapshot,
    lastOpenedAt: params.touchOpenedAt ? Date.now() : (currentEntry?.lastOpenedAt ?? Date.now()),
    lastConnectionStatus: params.lastConnectionStatus,
    lastConnectionError:
      params.lastConnectionStatus === "failed"
        ? (params.lastConnectionError ?? currentEntry?.lastConnectionError)
        : undefined,
  };
  const nextRemoteSessions = upsertRemoteWorkspaceSessionEntries(params.remoteSessions, nextEntry);
  const nextRemoteWorkspaceKeys = new Set(
    nextRemoteSessions.map((entry) => buildWorkspaceSessionKey(entry)),
  );
  const credentialKeysToDelete = new Set<string>();
  const previousCredentialKeys = new Set(
    currentEntry ? collectRemoteWorkspaceCredentialKeys(currentEntry.target) : [],
  );
  const nextCredentialKeys = new Set(collectRemoteWorkspaceCredentialKeys(nextSnapshot));

  for (const previousCredentialKey of previousCredentialKeys) {
    if (!nextCredentialKeys.has(previousCredentialKey)) {
      credentialKeysToDelete.add(previousCredentialKey);
    }
  }

  for (const removedEntry of params.remoteSessions) {
    if (nextRemoteWorkspaceKeys.has(buildWorkspaceSessionKey(removedEntry))) {
      continue;
    }

    for (const credentialKey of collectRemoteWorkspaceCredentialKeys(removedEntry.target)) {
      credentialKeysToDelete.add(credentialKey);
    }
  }

  const credentialsToSave: { key: string; value: string }[] = [];

  if (
    params.target.kind === "ssh" &&
    nextSnapshot.kind === "ssh" &&
    params.target.password &&
    nextSnapshot.passwordCredentialKey
  ) {
    credentialsToSave.push({
      key: nextSnapshot.passwordCredentialKey,
      value: params.target.password,
    });
  }

  if (
    params.target.kind === "ssh" &&
    nextSnapshot.kind === "ssh" &&
    params.target.privateKeyPassphrase &&
    nextSnapshot.privateKeyPassphraseCredentialKey
  ) {
    credentialsToSave.push({
      key: nextSnapshot.privateKeyPassphraseCredentialKey,
      value: params.target.privateKeyPassphrase,
    });
  }

  return {
    entry: nextEntry,
    nextRemoteSessions,
    credentialsToSave,
    credentialKeysToDelete: [...credentialKeysToDelete],
  };
}

export function buildPersistedWorkspaceSessionEntries(
  tabs: WindowTabState[],
  remoteSessionsByWorkspaceKey: ReadonlyMap<string, RemoteWorkspaceSessionEntry>,
): PersistedWorkspaceSessionEntry[] {
  return tabs.reduce<PersistedWorkspaceSessionEntry[]>((entries, tab) => {
    if (!isWorkspaceTab(tab)) {
      return entries;
    }

    if (hasRemoteWorkspaceIdentity(tab)) {
      const workspaceKey = buildWorkspaceSessionKey(tab);
      const remoteEntry = remoteSessionsByWorkspaceKey.get(workspaceKey);

      // lastWorkspaceSession 现在是远端 workspace 的唯一持久化来源。
      // 如果这里因为 tab 断连就把 remote 项漏掉，下次启动会直接丢失“手动重连”的入口。
      // 因此只要当前 tab 具有远端身份，就必须写回完整 remote 条目。
      if (!remoteEntry) {
        return entries;
      }

      entries.push(remoteEntry);
      return entries;
    }

    entries.push({
      kind: "local",
      workspacePath: tab.workspacePath,
      ...(tab.workspacePurpose ? { workspacePurpose: tab.workspacePurpose } : {}),
    });
    return entries;
  }, []);
}

export function readPersistedWorkspaceSessionEntries(
  settings: Pick<AppSettings, "lastWorkspaceSession">,
): PersistedWorkspaceSessionEntry[] {
  return settings.lastWorkspaceSession ?? [];
}

export function getRemoteWorkspaceSessionEntries(
  settings: Pick<AppSettings, "lastWorkspaceSession">,
): RemoteWorkspaceSessionEntry[] {
  return (settings.lastWorkspaceSession ?? []).flatMap((entry) =>
    entry.kind === "remote" ? [entry] : [],
  );
}

export function buildRemoteWorkspaceSessionEntryMap(
  entries: readonly RemoteWorkspaceSessionEntry[],
): Map<string, RemoteWorkspaceSessionEntry> {
  return new Map(entries.map((entry) => [buildWorkspaceSessionKey(entry), entry] as const));
}
