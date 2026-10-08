import { randomUUID } from "node:crypto";
import {
  HostResponseTypes,
  hostBotRemoteWorkspaceConnectionStatusResultMessageSchema,
  hostBotRemoteWorkspaceRuntimePortMessageSchema,
  hostBotRemoteWorkspaceReconnectResultMessageSchema,
  type RemoteTarget,
} from "@zcode/shared";
import { type IZCodeTaskService as IZCodeTaskServiceShape } from "../session/zcodeTaskService.js";
import type { ICredentialService } from "../credential/credential.js";
import type { ISettingService } from "../setting/setting.js";
import { type ZCodeAgentAppRuntimePreferences } from "../zcode-agent/zcodeAgent.js";
import {
  createRemoteRuntimeServicesFromPort,
  type RemoteBotWorkspaceRuntimeServices,
} from "#src/bots/botRemoteRuntimeServices.js";

interface ParentPortLike {
  postMessage(message: unknown, transfer?: unknown[]): void;
  on(event: "message", listener: (event: ParentPortMessageEvent) => void): void;
  off?(event: "message", listener: (event: ParentPortMessageEvent) => void): void;
}

interface ParentPortMessageEvent {
  data: unknown;
  ports?: unknown[];
}

export function createBotRemoteWorkspaceService(params: {
  parentPort?: ParentPortLike | null;
  settingService: ISettingService;
  credentialService: ICredentialService;
}) {
  const parentPort = params.parentPort;
  if (!parentPort) {
    return undefined;
  }
  const activeParentPort = parentPort;
  const connectedWorkspaceKeys = new Set<string>();
  const pending = new Map<
    string,
    (result: { ok: boolean; sessionId?: string; error?: string }) => void
  >();
  const pendingRuntimePorts = new Map<
    string,
    (result: { ok: boolean; port?: unknown; error?: string }) => void
  >();
  const pendingConnectionStatus = new Map<
    string,
    (result: { ok: boolean; connected?: boolean; error?: string }) => void
  >();
  const runtimeServicesByWorkspaceKey = new Map<string, RemoteBotWorkspaceRuntimeServices>();
  let latestAppRuntimePreferences: ZCodeAgentAppRuntimePreferences | undefined;
  let appRuntimePreferencesRevision = 0;
  const onMessage = (event: ParentPortMessageEvent) => {
    const result = hostBotRemoteWorkspaceReconnectResultMessageSchema.safeParse(event.data);
    if (result.success) {
      const { requestId } = result.data;
      const resolve = pending.get(requestId);
      if (!resolve) {
        return;
      }
      pending.delete(requestId);
      resolve({
        ok: result.data.ok,
        sessionId: result.data.sessionId,
        error: result.data.error,
      });
      return;
    }

    const connectionStatusResult =
      hostBotRemoteWorkspaceConnectionStatusResultMessageSchema.safeParse(event.data);
    if (connectionStatusResult.success) {
      const { requestId } = connectionStatusResult.data;
      const resolve = pendingConnectionStatus.get(requestId);
      if (!resolve) {
        return;
      }
      pendingConnectionStatus.delete(requestId);
      resolve({
        ok: connectionStatusResult.data.ok,
        connected: connectionStatusResult.data.connected,
        error: connectionStatusResult.data.error,
      });
      return;
    }

    const runtimePortResult = hostBotRemoteWorkspaceRuntimePortMessageSchema.safeParse(event.data);
    if (!runtimePortResult.success) {
      return;
    }
    const { requestId } = runtimePortResult.data;
    const resolve = pendingRuntimePorts.get(requestId);
    if (!resolve) {
      return;
    }
    pendingRuntimePorts.delete(requestId);
    resolve({
      ok: runtimePortResult.data.ok,
      port: event.ports?.[0],
      error: runtimePortResult.data.error,
    });
  };
  activeParentPort.on("message", onMessage);

  async function buildRemoteTargetForWorkspace(target: {
    workspacePath: string;
    workspaceIdentity: string;
  }): Promise<RemoteTarget | null> {
    const settings = await params.settingService.get();
    const workspaceIdentity = target.workspaceIdentity.trim();
    const remoteSessions = (settings.lastWorkspaceSession ?? []).filter(
      (item) => item.kind === "remote",
    );
    const entry =
      // Bugfix: UI 建连后可能把 workspacePath 规范化为 realpath，但 bot context 仍保留旧路径。
      // 远端身份隔离语义以 workspaceIdentity 为准，查连接信息时必须先按 identity 命中。
      remoteSessions.find((item) => item.workspaceIdentity === workspaceIdentity) ??
      remoteSessions.find(
        (item) =>
          item.workspacePath === target.workspacePath &&
          item.workspaceIdentity === workspaceIdentity,
      );
    if (!entry || entry.kind !== "remote") {
      return null;
    }
    if (entry.target.kind !== "ssh") {
      return entry.target;
    }
    return {
      kind: "ssh",
      host: entry.target.host,
      port: entry.target.port,
      username: entry.target.username,
      privateKeyPath: entry.target.privateKeyPath,
      password: entry.target.passwordCredentialKey
        ? ((await params.credentialService.load(entry.target.passwordCredentialKey)) ?? undefined)
        : undefined,
      privateKeyPassphrase: entry.target.privateKeyPassphraseCredentialKey
        ? ((await params.credentialService.load(entry.target.privateKeyPassphraseCredentialKey)) ??
          undefined)
        : undefined,
    };
  }

  async function queryMainConnectionStatus(target: {
    workspacePath: string;
    workspaceIdentity: string;
    remoteTarget: RemoteTarget;
  }): Promise<boolean | null> {
    const requestId = `bot-status-${randomUUID()}`;
    const result = await new Promise<{
      ok: boolean;
      connected?: boolean;
      error?: string;
    }>((resolve) => {
      pendingConnectionStatus.set(requestId, resolve);
      activeParentPort.postMessage({
        type: HostResponseTypes.BotRemoteWorkspaceConnectionStatusRequest,
        requestId,
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        target: target.remoteTarget,
      });
      setTimeout(() => {
        if (pendingConnectionStatus.delete(requestId)) {
          resolve({ ok: false, error: "远端 workspace 连接状态查询超时。" });
        }
      }, 5_000);
    });
    return result.ok ? result.connected === true : null;
  }

  return {
    async isConnected(target: {
      workspacePath: string;
      workspaceIdentity: string;
    }): Promise<boolean> {
      const workspaceKey = target.workspaceIdentity.trim() || target.workspacePath;
      const remoteTarget = await buildRemoteTargetForWorkspace(target);
      if (!remoteTarget) {
        connectedWorkspaceKeys.delete(workspaceKey);
        return false;
      }

      // Bugfix: UI 手动重连不会经过 bot 的 /reconnect，单靠本地 Set 会误判为未连接。
      // 每次询问 main 的 live session 表，顺手清理远端断开后的陈旧 bot 标记。
      const connected = await queryMainConnectionStatus({
        ...target,
        remoteTarget,
      });
      if (connected !== null) {
        if (connected) {
          connectedWorkspaceKeys.add(workspaceKey);
        } else {
          connectedWorkspaceKeys.delete(workspaceKey);
        }
        return connected;
      }

      return connectedWorkspaceKeys.has(workspaceKey);
    },
    async ensureConnected(target: {
      workspacePath: string;
      workspaceIdentity: string;
    }): Promise<{ ok: boolean; message?: string }> {
      const remoteTarget = await buildRemoteTargetForWorkspace(target);
      if (!remoteTarget) {
        return {
          ok: false,
          message: "未找到该远端 workspace 的连接信息。",
        };
      }
      const requestId = `bot-reconnect-${randomUUID()}`;
      const result = await new Promise<{
        ok: boolean;
        sessionId?: string;
        error?: string;
      }>((resolve) => {
        pending.set(requestId, resolve);
        activeParentPort.postMessage({
          type: HostResponseTypes.BotRemoteWorkspaceReconnectRequest,
          requestId,
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          target: remoteTarget,
        });
        setTimeout(() => {
          if (pending.delete(requestId)) {
            resolve({ ok: false, error: "远端 workspace 重连超时。" });
          }
        }, 60_000);
      });
      if (result.ok) {
        connectedWorkspaceKeys.add(target.workspaceIdentity.trim() || target.workspacePath);
        return { ok: true };
      }
      return { ok: false, message: result.error ?? "unknown" };
    },
    async getZCodeTaskService(target: {
      workspacePath: string;
      workspaceIdentity: string;
    }): Promise<IZCodeTaskServiceShape | null> {
      return (await getRuntimeServices(target))?.zcodeTaskService ?? null;
    },
    async getModelSelectionService(target: { workspacePath: string; workspaceIdentity: string }) {
      return (await getRuntimeServices(target))?.modelSelectionService ?? null;
    },
    async syncAppRuntimePreferences(preferences: ZCodeAgentAppRuntimePreferences): Promise<void> {
      latestAppRuntimePreferences = preferences;
      appRuntimePreferencesRevision += 1;
      // 修复原因：远端 Bot runtime 不属于任何 renderer 窗口，Root 的 Agent 同步无法触达它。
      // 这里只更新已经缓存的 runtime，避免切换设置时为了闲置 Bot 新建远端 Host/Agent。
      await Promise.all(
        Array.from(runtimeServicesByWorkspaceKey.values()).map((services) =>
          services.zcodeAgentService.syncAppRuntimePreferences(preferences),
        ),
      );
    },
    dispose(): void {
      // Bugfix: host dispose 时移除 parentPort 监听，避免窗口 reload 后旧 bot 重连 promise 继续接收结果。
      activeParentPort.off?.("message", onMessage);
      pending.clear();
      pendingRuntimePorts.clear();
      pendingConnectionStatus.clear();
      runtimeServicesByWorkspaceKey.clear();
      connectedWorkspaceKeys.clear();
    },
  };

  async function getRuntimeServices(target: {
    workspacePath: string;
    workspaceIdentity: string;
  }): Promise<RemoteBotWorkspaceRuntimeServices | null> {
    const workspaceKey = target.workspaceIdentity.trim() || target.workspacePath;
    const cached = runtimeServicesByWorkspaceKey.get(workspaceKey);
    if (cached) {
      return cached;
    }
    const remoteTarget = await buildRemoteTargetForWorkspace(target);
    if (!remoteTarget) {
      return null;
    }
    const requestId = `bot-runtime-${randomUUID()}`;
    const result = await new Promise<{
      ok: boolean;
      port?: unknown;
      error?: string;
    }>((resolve) => {
      pendingRuntimePorts.set(requestId, resolve);
      activeParentPort.postMessage({
        type: HostResponseTypes.BotRemoteWorkspaceRuntimePortRequest,
        requestId,
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        target: remoteTarget,
      });
      setTimeout(() => {
        if (pendingRuntimePorts.delete(requestId)) {
          resolve({ ok: false, error: "远端 workspace runtime 初始化超时。" });
        }
      }, 60_000);
    });
    if (!result.ok || !result.port) {
      throw new Error(result.error ?? "远端 workspace runtime 初始化失败。");
    }
    // Bugfix: Bot 任务以前只知道远端 identity，却继续调用本地 task service。
    // 这里把 main 转发来的远端 RPC 端口包装成一组 runtime services；
    // task wrapper 命令走 IZCodeTaskService，session 主状态走 ZCode session facade。
    const services = createRemoteRuntimeServicesFromPort(result.port);
    // 远端 Bot 与 UI workspace 共用同一个远端 Environment。这里只确认远端
    // Model Selection Facade 已就绪，Desktop 不再向远端注入完整 Provider Registry。
    await services.modelSelectionService.getView();
    while (true) {
      const revision = appRuntimePreferencesRevision;
      const cachedPreferences = latestAppRuntimePreferences;
      const preferences: ZCodeAgentAppRuntimePreferences = cachedPreferences
        ? cachedPreferences
        : await params.settingService.get().then((settings) => ({
            askUserQuestionAutoResolutionEnabled:
              settings.askUserQuestionAutoResolutionEnabled !== false,
            modelIoFullRetentionEnabled: settings.modelIoFullRetentionEnabled === true,
          }));
      await services.zcodeAgentService.syncAppRuntimePreferences(preferences);
      if (revision === appRuntimePreferencesRevision) {
        break;
      }
    }
    // 只有远端 Registry 和 App Runtime Preferences 都已就绪后才缓存 runtime services。
    runtimeServicesByWorkspaceKey.set(workspaceKey, services);
    return services;
  }
}
