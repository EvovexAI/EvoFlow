import { useEffect } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeConfigOption } from "@zcode/shared";
import {
  buildTaskContextUsageFromUsageUpdate,
  recordTaskContextUsageUpdate,
} from "@/lib/zcodeTaskUsageFallback.js";
import { normalizeZCodeUiError } from "@/lib/zcodeUiError.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { useTabStoreApi } from "@/store/TabStoreProvider.js";
import {
  resolveBotTaskBroadcastRefresh,
  resolveBotTaskBroadcastRuntimeStatus,
} from "@/root/botsTaskBroadcast.js";
import { resolveBotTaskStreamBroadcast } from "@/root/botsTaskStreamBroadcast.js";
import {
  insertTaskIntoTaskCaches,
  syncTaskMetaToTaskCaches,
} from "@/lib/taskListMetaSync.js";

export function syncBotTaskConfigOptionsToStore(params: {
  zcodeSessionStore: Pick<
    ReturnType<typeof useZCodeSessionStore.getState>,
    "setTaskConfigOptions"
  >;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  configOptions: ZCodeConfigOption[];
}) {
  // Bugfix: Bot /mode 不经过 ChatInputToolbar/useTaskStreamEvents。
  // setTaskConfigOptions 会按 activeTaskId 决定是否同步到 workspace configOptions，
  // 当前 mode 再由 configOptions 派生，避免 UI 维护第二份模式状态。
  params.zcodeSessionStore.setTaskConfigOptions(
    params.workspacePath,
    params.taskId,
    params.configOptions,
    params.workspaceIdentity,
  );
}

export function shouldRefreshBotTaskList(
  event: string,
  hasTaskMeta: boolean,
): boolean {
  // Bugfix: Bot 新建任务时会随 created 广播携带 task meta，当前实现因此跳过整表刷新。
  // 但如果对应 workspace 的 task query cache 还没建立，增量写入没有落点，侧栏列表就不会主动拉到这个新任务。
  // created 事件频率低，保留一次版本 bump 作为兜底；其它高频事件仍优先走增量缓存更新，避免列表闪烁回归。
  if (event === "created") {
    return true;
  }
  if (hasTaskMeta) {
    return false;
  }
  return event === "created" || event === "updated" || event === "completed" || event === "error";
}

export function shouldMirrorBotTaskStreamToStore(params: {
  activeTaskId: string | null;
  taskId: string;
  workspaceIdentity?: string;
}): boolean {
  if (params.activeTaskId !== params.taskId) {
    return true;
  }

  // Bugfix: 远端 Bot task 的 stream 来自 bot runtime host，不一定会被当前 ChatView 的 ZCode Agent stream 订阅收到。
  // 之前 active task 直接跳过 bot broadcast，导致消息内容要切换任务重新拉 snapshot 后才显示。
  return Boolean(params.workspaceIdentity?.trim());
}

export function useBotBroadcastEffects(
  services: IServiceAccessor,
  tabStoreApi: ReturnType<typeof useTabStoreApi>,
) {
  useEffect(() => {
    const disposable = services.broadcastService.onMessage((message) => {
      const stream = resolveBotTaskStreamBroadcast(
        message,
        tabStoreApi.getState().tabs,
      );
      if (stream) {
        const zcodeSessionStore = useZCodeSessionStore.getState();
        const workspaceState = zcodeSessionStore.getWorkspaceState(
          stream.workspacePath,
          stream.workspaceIdentity,
        );
        if (
          !shouldMirrorBotTaskStreamToStore({
            activeTaskId: workspaceState.activeTaskId,
            taskId: stream.taskId,
            workspaceIdentity: stream.workspaceIdentity,
          })
        ) {
          return;
        }

        // Bot task 在后台运行或远端 runtime 中运行时，本窗口不一定订阅到同一条流。
        // 消息正文不再回放进 renderer 本地 store——bot 发的 prompt
        // 走 v4 命令后，消息由 conversation 投影（订阅该 session 的 pane）自然呈现；
        // 这里只同步运行态/权限/用量等 A 区状态，供侧栏与弹窗消费。
        const event = stream.event;
        switch (event.type) {
          case "agent_message_chunk":
          case "agent_thought_chunk":
          case "tool_call":
            zcodeSessionStore.setTaskRuntimeState(
              stream.workspacePath,
              stream.taskId,
              "streaming",
              undefined,
              stream.workspaceIdentity,
            );
            break;
          case "permission_request":
            zcodeSessionStore.setTaskPermissionRequest(stream.workspacePath, stream.taskId, event, stream.workspaceIdentity);
            zcodeSessionStore.setTaskRuntimeState(
              stream.workspacePath,
              stream.taskId,
              "streaming",
              undefined,
              stream.workspaceIdentity,
            );
            break;
          case "task_complete":
            zcodeSessionStore.setTaskRuntimeState(
              stream.workspacePath,
              stream.taskId,
              "completed",
              undefined,
              stream.workspaceIdentity,
            );
            zcodeSessionStore.setTaskPermissionRequest(stream.workspacePath, stream.taskId, null, stream.workspaceIdentity);
            zcodeSessionStore.setTaskError(stream.workspacePath, stream.taskId, null, stream.workspaceIdentity);
            break;
          case "task_error": {
            const normalizedError = normalizeZCodeUiError(
              {
                message: event.error,
                detail: event.detail,
                code: event.code,
              },
              {
                fallbackCode: event.code ?? "UNKNOWN",
                traceId: event.traceId,
                taskId: event.taskId,
              },
            );
            zcodeSessionStore.setTaskRuntimeState(
              stream.workspacePath,
              stream.taskId,
              "failed",
              normalizedError.message,
              stream.workspaceIdentity,
            );
            zcodeSessionStore.setTaskPermissionRequest(stream.workspacePath, stream.taskId, null, stream.workspaceIdentity);
            zcodeSessionStore.setTaskError(stream.workspacePath, stream.taskId, normalizedError, stream.workspaceIdentity);
            break;
          }
          case "task_warning":
            zcodeSessionStore.setTaskError(
              stream.workspacePath,
              stream.taskId,
              normalizeZCodeUiError(
                {
                  message: event.warning,
                  detail: event.detail,
                  code: event.code,
                },
                {
                  fallbackCode: event.code ?? "WARNING",
                  traceId: event.traceId,
                  taskId: event.taskId,
                },
              ),
              stream.workspaceIdentity,
            );
            break;
          case "usage_update":
            {
              const workspaceState = zcodeSessionStore.getWorkspaceState(
                stream.workspacePath,
                stream.workspaceIdentity,
              );
              const previousUsage =
                workspaceState.taskRuntimeByTaskId[stream.taskId]?.usage ?? null;
              // taskMessagesByTaskId 已随消息回放一并退役，估算用不到最近一条
              // 用户输入时走 fallback 估算（该分支只影响 usage 弹窗的比例展示兜底）。
              const incomingUsage = {
                size: event.size,
                used: event.used,
                cost: event.cost,
                ...(event.cache ? { cache: event.cache } : {}),
                ...(event.breakdown ? { breakdown: event.breakdown } : {}),
              };
              const nextUsage = buildTaskContextUsageFromUsageUpdate({
                currentUsage: previousUsage,
                incomingUsage,
              });
              recordTaskContextUsageUpdate({
                workspacePath: stream.workspacePath,
                workspaceIdentity: stream.workspaceIdentity,
                taskId: stream.taskId,
                size: event.size,
                used: event.used,
              });
              zcodeSessionStore.setTaskContextWindow(
                stream.workspacePath,
                stream.taskId,
                event.size,
                stream.workspaceIdentity,
              );
              zcodeSessionStore.setTaskUsage(
                stream.workspacePath,
                stream.taskId,
                nextUsage,
                stream.workspaceIdentity,
              );
            }
            break;
          case "session_info_update":
            if (event.apiRetry !== undefined) {
              zcodeSessionStore.setTaskApiRetryStatus(
                stream.workspacePath,
                stream.taskId,
                event.apiRetry ?? null,
                stream.workspaceIdentity,
              );
            }
            break;
        }
        return;
      }

      const refresh = resolveBotTaskBroadcastRefresh(
        message,
        tabStoreApi.getState().tabs,
      );
      if (!refresh) {
        return;
      }
      // Bots 在 host 侧创建/推进 task，不会挂载聊天视图里的 stream 订阅。
      // 因此除了刷新列表，还要同步 task 运行态；否则 sidebar 能看到新 task，却不会显示进行中状态。
      const zcodeSessionStore = useZCodeSessionStore.getState();
      const workspaceState = zcodeSessionStore.getWorkspaceState(
        refresh.workspacePath,
        refresh.workspaceIdentity,
      );
      const provider = refresh.task?.provider ?? refresh.provider;
      const shouldSyncVisibleTaskConfig = workspaceState.activeTaskId === refresh.taskId;
      if (provider && shouldSyncVisibleTaskConfig) {
        // Bugfix: /model、/mode 可以从第三方 Bot 修改当前 task 的真实 ZCode Agent 状态。
        // 这些操作不经过 ChatInputToolbar，本地 store 以前不会同步 provider/configOptions，
        // 导致 Bot 回复已切换但 UI 下拉仍显示旧状态。
        zcodeSessionStore.bindRuntimeProvider(
          refresh.workspacePath,
          provider,
          refresh.workspaceIdentity,
        );
      }
      if (refresh.configOptions) {
        syncBotTaskConfigOptionsToStore({
          zcodeSessionStore,
          workspacePath: refresh.workspacePath,
          workspaceIdentity: refresh.workspaceIdentity,
          taskId: refresh.taskId,
          configOptions: refresh.configOptions,
        });
      }
      zcodeSessionStore.setTaskRuntimeState(
        refresh.workspacePath,
        refresh.taskId,
        resolveBotTaskBroadcastRuntimeStatus(refresh.event),
        undefined,
        refresh.workspaceIdentity,
      );
      if (refresh.task) {
        // Bugfix: Bot 状态变化以前靠 bumpTaskListVersion 整表重查。
        // prompt_sent / completed 等连续事件会让 sidebar queryKey 反复换新，旧缓存短暂失效导致任务列表闪烁。
        // 这里有 task meta 时直接增量写入 task/query cache，只在缺少 meta 的旧广播上保留整表刷新兜底。
        const membership = { pinned: false, archived: false };
        if (refresh.event === "created") {
          insertTaskIntoTaskCaches({
            workspacePath: refresh.workspacePath,
            workspaceIdentity: refresh.workspaceIdentity,
            task: refresh.task,
            membership,
          });
        } else {
          syncTaskMetaToTaskCaches({
            workspacePath: refresh.workspacePath,
            workspaceIdentity: refresh.workspaceIdentity,
            task: refresh.task,
            membership,
            ensureInWorkspaceTaskCache: true,
          });
        }
      }
      // prompt_sent 不再向 renderer 本地补写 user message——bot 发的
      // prompt 经 v4 命令进入 session 事件日志，订阅该 session 的 conversation 投影
      // 会自然出现该消息；本地拼装面（zcodeChatMessages）随旧 ChatView 退役。
      if (refresh.event === "permission_request" && refresh.permissionRequest) {
        zcodeSessionStore.setTaskPermissionRequest(
          refresh.workspacePath,
          refresh.taskId,
          refresh.permissionRequest,
          refresh.workspaceIdentity,
        );
      } else if (refresh.event === "permission_resolved" && refresh.requestId) {
        zcodeSessionStore.removeTaskPermissionRequest(
          refresh.workspacePath,
          refresh.taskId,
          refresh.requestId,
          refresh.workspaceIdentity,
        );
      } else if (refresh.event === "elicitation_request" && refresh.elicitationRequest) {
        // Bugfix: Bot channel 消费 AskUserQuestion 后，下一题只会先到 Bot runtime。
        // 当前 UI 窗口不一定有同一条 ZCode Agent stream 订阅，必须把新的 elicitation_request 显式写回 store。
        zcodeSessionStore.setTaskElicitationRequest(
          refresh.workspacePath,
          refresh.taskId,
          refresh.elicitationRequest,
          refresh.workspaceIdentity,
        );
      } else if (refresh.event === "elicitation_resolved" && refresh.requestId) {
        // Bugfix: Bot 代用户提交 AskUserQuestion 时，当前 UI 窗口不一定能收到 ZCode Agent stream 的
        // elicitation_response。通过 bots:task 明确同步 requestId 出队，避免问答弹窗一直挂着。
        zcodeSessionStore.removeTaskElicitationRequest(
          refresh.workspacePath,
          refresh.taskId,
          refresh.requestId,
          refresh.workspaceIdentity,
        );
      } else if (refresh.event === "completed" || refresh.event === "error") {
        zcodeSessionStore.setTaskPermissionRequest(
          refresh.workspacePath,
          refresh.taskId,
          null,
          refresh.workspaceIdentity,
        );
      }
      if (shouldRefreshBotTaskList(refresh.event, Boolean(refresh.task))) {
        zcodeSessionStore.bumpTaskListVersion(refresh.workspacePath, refresh.workspaceIdentity);
      }
    });
    return () => disposable.dispose();
  }, [services.broadcastService, tabStoreApi]);
}
