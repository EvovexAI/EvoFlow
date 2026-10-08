import type { Dispatch, SetStateAction } from "react";
import type { IPlatformService, RemoteWorkspaceSessionEntry } from "@zcode/shared";
import { stripRemoteTargetSecrets } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { toast } from "@/components/ui/toast.js";
import {
  buildRemoteWorkspaceSessionMutation,
  buildRemoteWorkspaceIdentity,
  createRemoteTargetFromSnapshot,
  resolveRemoteWorkspaceSessionIdentity,
} from "@/lib/remoteWorkspaceHistory.js";
import { logger } from "@/logger.js";
import {
  bindRemoteWorkspaceIdentity,
  bindRemoteWorkspacePath,
} from "@/store/remoteWorkspaceSessionStore.js";
import { refreshRemotePinnedTasksForSession } from "@/store/remotePinnedTaskStore.js";
import { refreshRemoteTimelineTasksForSession } from "@/store/remoteTimelineTaskStore.js";

/** 把 UI 最终确定的 canonical workspacePath/workspaceIdentity 绑定回 main/host 的 logical session。 */
export type BindRemoteWorkspaceSessionContextFn = (params: {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity: string;
}) => Promise<void>;

type ManualReconnectRemoteWorkspaceParams = {
  sessionEntry: RemoteWorkspaceSessionEntry;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  setReconnectingRemoteWorkspaceKeys: Dispatch<SetStateAction<string[]>>;
  loadCredential: IServiceAccessor["credentialService"]["load"];
  connectRemoteWorkspaceTarget: (
    target: Parameters<IPlatformService["connectRemote"]>[0],
    requestId?: string,
    context?: Parameters<IPlatformService["connectRemote"]>[2],
  ) => Promise<string>;
  resolveRemoteWorkspaceCanonicalPath: (
    sessionId: string,
    workspacePath: string,
  ) => Promise<string>;
  disposeRemoteWorkspaceSession: (sessionId: string) => Promise<void>;
  bindRemoteWorkspaceSessionContext: BindRemoteWorkspaceSessionContextFn;
  bindRemoteWorkspacePath: typeof bindRemoteWorkspacePath;
  bindRemoteWorkspaceIdentity: typeof bindRemoteWorkspaceIdentity;
  upsertWorkspaceTab: (
    workspacePath: string,
    options?: {
      remoteSessionId?: string;
      remoteTarget?: Parameters<IPlatformService["connectRemote"]>[0];
      workspaceIdentity?: string;
      localWorkspacePath?: string;
    },
  ) => void;
  commitRemoteWorkspaceSessionMutation: (
    mutation: ReturnType<typeof buildRemoteWorkspaceSessionMutation>,
  ) => Promise<RemoteWorkspaceSessionEntry>;
  getRemoteSessions: () => RemoteWorkspaceSessionEntry[];
  logger: Pick<typeof logger, "warn">;
  toast: typeof toast;
  shouldKeepReconnectedWorkspace?: (
    context: Pick<RemoteWorkspaceSessionEntry, "workspacePath" | "workspaceIdentity">,
  ) => boolean;
  onWorkspaceActivated?: (target: { workspacePath: string; workspaceIdentity: string }) => void;
  options?: ReconnectRemoteWorkspaceOptions;
};

export interface SshReconnectCredentials {
  password: string | null;
  privateKeyPassphrase: string | null;
}

export interface ReconnectRemoteWorkspaceOptions {
  activateWorkspaceAfterReconnect?: boolean;
  showErrorToast?: boolean;
  requestId?: string;
  throwOnFailure?: boolean;
  /** 共享 Host ready 后，sibling 复用 initiator 凭据附着，禁止再次读取各自历史凭据。 */
  sshCredentialsOverride?: SshReconnectCredentials;
  /** logical connect 已返回，表示共享 SSH Host ready；workspace 初始化仍可能继续或失败。 */
  onSshHostReady?: (credentials: SshReconnectCredentials) => void;
}

export async function reconnectRemoteWorkspaceHistoryEntry({
  sessionEntry,
  activateTabByPath,
  setReconnectingRemoteWorkspaceKeys,
  loadCredential,
  connectRemoteWorkspaceTarget,
  resolveRemoteWorkspaceCanonicalPath,
  disposeRemoteWorkspaceSession,
  bindRemoteWorkspaceSessionContext,
  bindRemoteWorkspacePath,
  bindRemoteWorkspaceIdentity,
  upsertWorkspaceTab,
  commitRemoteWorkspaceSessionMutation,
  getRemoteSessions,
  logger,
  toast,
  shouldKeepReconnectedWorkspace,
  onWorkspaceActivated,
  options,
}: ManualReconnectRemoteWorkspaceParams): Promise<void> {
  const activateWorkspaceAfterReconnect = options?.activateWorkspaceAfterReconnect ?? true;
  const showErrorToast = options?.showErrorToast ?? true;
  const fallbackWorkspaceIdentity = resolveRemoteWorkspaceSessionIdentity(sessionEntry);
  const reconnectWorkspaceKey = fallbackWorkspaceIdentity?.trim() || sessionEntry.workspacePath;

  setReconnectingRemoteWorkspaceKeys((currentKeys) =>
    currentKeys.includes(reconnectWorkspaceKey)
      ? currentKeys
      : [...currentKeys, reconnectWorkspaceKey],
  );

  let reconnectTarget = createRemoteTargetFromSnapshot(sessionEntry.target, {
    password: null,
    privateKeyPassphrase: null,
  });
  let resolvedWorkspacePath = sessionEntry.workspacePath;
  let resolvedWorkspaceIdentity = fallbackWorkspaceIdentity;
  try {
    const sshCredentials = options?.sshCredentialsOverride ?? {
      password:
        sessionEntry.target.kind === "ssh" && sessionEntry.target.passwordCredentialKey
          ? await loadCredential(sessionEntry.target.passwordCredentialKey)
          : null,
      privateKeyPassphrase:
        sessionEntry.target.kind === "ssh" && sessionEntry.target.privateKeyPassphraseCredentialKey
          ? await loadCredential(sessionEntry.target.privateKeyPassphraseCredentialKey)
          : null,
    };
    reconnectTarget = createRemoteTargetFromSnapshot(sessionEntry.target, sshCredentials);
    const sessionId = await connectRemoteWorkspaceTarget(reconnectTarget, options?.requestId, {
      workspacePath: sessionEntry.workspacePath,
      workspaceIdentity: fallbackWorkspaceIdentity,
      connectTrigger: "reconnect",
    });
    if (reconnectTarget.kind === "ssh") {
      // Host ready 与 provider/task 等 workspace 初始化必须分阶段通知。
      // sibling 从此刻即可复用 initiator credential 创建 attachment，无需等待或重复读取凭据。
      options?.onSshHostReady?.(sshCredentials);
    }
    resolvedWorkspacePath = await resolveRemoteWorkspaceCanonicalPath(
      sessionId,
      sessionEntry.workspacePath,
    );
    resolvedWorkspaceIdentity = buildRemoteWorkspaceIdentity(
      resolvedWorkspacePath,
      reconnectTarget,
    );

    if (
      resolvedWorkspacePath !== sessionEntry.workspacePath ||
      resolvedWorkspaceIdentity !== fallbackWorkspaceIdentity
    ) {
      // connect 只携带历史记录里的 path/identity，main 的 logical session descriptor 也停在这组值上；
      // realpath 归一化后若结果不同，tab 会用新值而 descriptor 仍是旧值，
      // 手机远控桥接按 tab 的 path/identity 比对 descriptor 时就会被 REMOTE_WORKSPACE_IDENTITY_MISMATCH 拒绝。
      // 绑定失败说明 session 与 tab 无法对齐：回收 session 并走失败落库，不留下半连接 workspace。
      // 这次 await 必须放在下方保留校验之前：校验与 upsertWorkspaceTab 之间不能再有异步间隙，
      // 否则用户在 bind 等待 ready ACK 期间移除 tab，校验结果已过期，workspace 会被重新加回来。
      try {
        await bindRemoteWorkspaceSessionContext({
          sessionId,
          workspacePath: resolvedWorkspacePath,
          workspaceIdentity: resolvedWorkspaceIdentity,
        });
      } catch (error) {
        await disposeRemoteWorkspaceSession(sessionId);
        throw error;
      }
    }

    // 手动重连过程中，用户可能先点重连再立即把该远端 tab 移除。
    // 如果这里不在成功落库前再做一次保留校验，会把用户刚移除的 workspace 又重新加回来。
    if (
      shouldKeepReconnectedWorkspace &&
      !shouldKeepReconnectedWorkspace({
        workspacePath: resolvedWorkspacePath,
        workspaceIdentity: resolvedWorkspaceIdentity,
      })
    ) {
      logger.warn("[Root] 远程 workspace 在重连过程中已被移除，跳过恢复并回收 session", {
        workspacePath: resolvedWorkspacePath,
      });
      await disposeRemoteWorkspaceSession(sessionId);
      return;
    }
    bindRemoteWorkspacePath(resolvedWorkspacePath, sessionId);
    bindRemoteWorkspaceIdentity(resolvedWorkspaceIdentity, sessionId);
    upsertWorkspaceTab(resolvedWorkspacePath, {
      remoteSessionId: sessionId,
      remoteTarget: stripRemoteTargetSecrets(reconnectTarget),
      workspaceIdentity: resolvedWorkspaceIdentity,
      localWorkspacePath: sessionEntry.localWorkspacePath,
    });
    if (activateWorkspaceAfterReconnect) {
      // 侧栏重连过去会先激活只有 identity、尚无 remoteSessionId 的断连 tab，
      // conversation provider 因 remote-waiting 返回 null，导致连接期间右侧整块黑屏。
      // 必须先绑定 services 并静默回填 tab 的 session 元数据，再一次性激活 tab 与草稿。
      const activated = activateTabByPath(resolvedWorkspacePath, {
        workspaceIdentity: resolvedWorkspaceIdentity,
      });
      if (activated) {
        onWorkspaceActivated?.({
          workspacePath: resolvedWorkspacePath,
          workspaceIdentity: resolvedWorkspaceIdentity,
        });
      }
    }
    await commitRemoteWorkspaceSessionMutation(
      buildRemoteWorkspaceSessionMutation({
        remoteSessions: getRemoteSessions(),
        workspacePath: resolvedWorkspacePath,
        localWorkspacePath: sessionEntry.localWorkspacePath,
        workspaceIdentity: resolvedWorkspaceIdentity,
        target: reconnectTarget,
        lastConnectionStatus: "connected",
        touchOpenedAt: true,
      }),
    );
    await Promise.all([
      refreshRemotePinnedTasksForSession({
        sessionId,
        workspacePath: resolvedWorkspacePath,
        workspaceIdentity: resolvedWorkspaceIdentity,
      }),
      refreshRemoteTimelineTasksForSession({
        sessionId,
        workspacePath: resolvedWorkspacePath,
        workspaceIdentity: resolvedWorkspaceIdentity,
      }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("[Root] 手动重连远程 workspace 失败", {
      workspacePath: resolvedWorkspacePath,
      error: message,
    });
    await commitRemoteWorkspaceSessionMutation(
      buildRemoteWorkspaceSessionMutation({
        remoteSessions: getRemoteSessions(),
        workspacePath: resolvedWorkspacePath,
        workspaceIdentity: resolvedWorkspaceIdentity,
        target: reconnectTarget,
        lastConnectionStatus: "failed",
        lastConnectionError: message,
        touchOpenedAt: false,
      }),
    );
    if (showErrorToast) {
      toast(message);
    }
    if (options?.throwOnFailure) {
      // 桌面端重连按钮需要吞掉异常并通过 toast/状态落库反馈，
      // 但手机端 Web 远控是 RPC 语义，必须把失败明确回传给手机端。
      throw error;
    }
  } finally {
    setReconnectingRemoteWorkspaceKeys((currentKeys) =>
      currentKeys.filter((key) => key !== reconnectWorkspaceKey),
    );
  }
}
