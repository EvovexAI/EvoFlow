import { useCallback, useRef } from "react";
import { ensureAgentV4ConnectionHandshake } from "@/v4/agentV4ConnectionHandshake.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { resolveWorkspaceRemoteSessionId } from "@/lib/workspaceServiceResolver.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { sendInteractionAutoResolutionSnooze } from "@/v4/interactionAutoResolutionCommand.js";

interface TaskInteractionAutoResolutionTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
}

/**
 * 侧栏 task 可能来自本地、远端、timeline 或 pinned 列表；暂停命令必须按 workspace identity
 * 找到原 host，不能因为当前激活 tab 不同而发到当前窗口的 service。
 */
export function useTaskInteractionAutoResolutionSnooze(
  target: TaskInteractionAutoResolutionTarget,
) {
  const loggedInteractionIdsRef = useRef(new Set<string>());
  const contextServices = useOptionalServices();
  const workspaceIdentity = target.workspaceIdentity?.trim() || undefined;
  const remoteSessionId = target.remoteSessionId?.trim() || undefined;
  const isRemoteTarget = Boolean(workspaceIdentity || remoteSessionId);
  const selectTargetServices = useCallback(
    (state: ReturnType<typeof useRemoteWorkspaceSessionStore.getState>) => {
      if (!isRemoteTarget) {
        return state.baseServices ?? contextServices;
      }

      const resolvedRemoteSessionId = resolveWorkspaceRemoteSessionId(
        {
          workspacePath: target.workspacePath,
          workspaceIdentity,
          remoteSessionId,
          // 该 hook 的 target 类型只携带 task 路由字段；remoteSessionId 已存在就足以
          // 表明旧数据可使用 path 兼容恢复，不需要伪造具体 RemoteTarget。
          remoteTarget: remoteSessionId ? true : undefined,
        },
        state,
      );
      if (resolvedRemoteSessionId) {
        return state.sessionsById[resolvedRemoteSessionId]?.services ?? null;
      }
      // 远程 task 找不到原 host 时禁止回退本地 service，否则相同 taskId
      // 可能被投递到错误 workspace；保留可重试失败，等待远端 attachment 恢复。
      return null;
    },
    [contextServices, isRemoteTarget, remoteSessionId, target.workspacePath, workspaceIdentity],
  );
  const targetServices = useRemoteWorkspaceSessionStore(selectTargetServices);

  return useCallback(
    async (interactionId: string): Promise<boolean> => {
      const agentService = targetServices?.zcodeAgentService;
      if (!agentService) {
        logger.warn("[task-interaction] 暂停自动结束时目标 workspace 未连接", {
          interactionId,
          sessionId: target.sessionId,
          workspaceKey: workspaceIdentity ?? target.workspacePath,
        });
        return false;
      }
      if (!loggedInteractionIdsRef.current.has(interactionId)) {
        loggedInteractionIdsRef.current.add(interactionId);
        logger.debug("[task-interaction] 用户从侧栏请求暂停自动结束", {
          interactionId,
          sessionId: target.sessionId,
          source: "taskBadge",
        });
      }

      return sendInteractionAutoResolutionSnooze({
        sessionId: target.sessionId,
        interactionId,
        source: "taskBadge",
        sendCommand: async (envelope) => {
          await ensureAgentV4ConnectionHandshake(agentService);
          return agentService.sendConversationCommandV4({
            workspacePath: target.workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            envelope,
          });
        },
      });
    },
    [target.sessionId, target.workspacePath, targetServices, workspaceIdentity],
  );
}
