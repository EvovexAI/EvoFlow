/* eslint-disable max-lines -- zcodeSessionService 聚合 desktop-continuous session 操作、draft lifecycle 和 task index 同步边界，拆分需要单独设计。 */
import type { IZCodeAgentService } from "#src/zcode-agent/zcodeAgent.js";
import type { ZCodeTaskIndexSyncer } from "#src/zcode-agent/zcodeTaskIndexSyncer.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  createSessionTraceId,
  type ZCodeSessionStateSnapshot,
  type ZCodeWorkspaceTaskListChanged,
} from "@zcode/shared";
import type {
  IZCodeSessionService,
  ZCodeSessionCreateParams,
  ZCodeSessionEventsParams,
  ZCodeSessionListParams,
  ZCodeSessionMessagesParams,
  ZCodeSessionReadParams,
  ZCodeSessionReadWorkspacePresentationParams,
  ZCodeSessionResumeParams,
  ZCodeSessionSetModeParams,
  ZCodeSessionSetModelParams,
  ZCodeSessionSetThoughtLevelParams,
  ZCodeTaskTarget,
  ZCodeSessionWorkspaceTarget,
} from "#src/zcode-session/zcodeSession.js";
import { formatModelPickerValue } from "#src/zcode-agent/zcodeConfigOptions.js";
import { createZCodeSessionApiRetryRuntimeTracker } from "#src/zcode-session/zcodeSessionApiRetry.js";
import { appendWorkspaceToFilesystemMcpServers } from "#src/session/mcpWorkspaceScope.js";
import { repairEmptyImportedClaudeSessionSnapshot } from "#src/zcode-session/importedClaudeSessionRepair.js";
import { createZCodeDeferredDraftRegistry } from "#src/zcode-session/zcodeSessionDraftRegistry.js";
import type { CuaProductMcpServerResolver } from "#src/cua-permission-broker/index.js";

const logger = createServiceLogger("zcode-session-service");

interface CreateZCodeSessionServiceOptions {
  agentService: IZCodeAgentService;
  /**
   * 后台 task index sqlite 同步器。注入后，每次 session 被创建/恢复/发送 prompt 或
   * 订阅事件时都会通知 syncer 维护 shadow 订阅，保证 desktop-continuous 路径下
   * sqlite 仍能跟随 runtime 状态收敛；同时每次会变更 session 状态的操作完成后会
   * 主动把最新 snapshot 同步到 sqlite 并广播 workspace_task_list_changed，
   * 让侧边栏列表立刻看到 first_input title 和 updatedAt 排序刷新。
   */
  taskIndexSyncer?: ZCodeTaskIndexSyncer;
  cuaProductMcpServerResolver?: CuaProductMcpServerResolver;
}

export function createZCodeSessionService({
  agentService,
  taskIndexSyncer,
  cuaProductMcpServerResolver,
}: CreateZCodeSessionServiceOptions): IZCodeSessionService {
  const { withApiRetryRuntime } = createZCodeSessionApiRetryRuntimeTracker();
  const deferredDraftSessions = createZCodeDeferredDraftRegistry();

  function notifySyncer(
    target: ZCodeTaskTarget,
    options?: {
      includeSnapshot?: boolean;
    },
  ): void {
    if (!taskIndexSyncer) {
      return;
    }
    taskIndexSyncer.ensureSessionSubscription(
      {
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        sessionId: target.sessionId,
      },
      options,
    );
  }

  function getSessionSnapshotDiagnostics(snapshot: ZCodeSessionStateSnapshot) {
    // 日志诊断不能假设测试 mock 或未来 partial snapshot 一定带齐 messages/pendingRequestIds。
    // 原因是 readSession 的业务结果已经由 agent 层校验，服务层这里只记录观测字段；若日志读取抛错，会反过来打断
    // desktop-continuous snapshot 恢复。这里仅对诊断值做空数组统计，不修改返回给 UI 的 snapshot 本体。
    const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    const pendingRequestIds = Array.isArray(snapshot.runtime.pendingRequestIds)
      ? snapshot.runtime.pendingRequestIds
      : [];
    return {
      activeTurnId: snapshot.runtime.activeTurnId ?? null,
      eventSeq: snapshot.runtime.eventSeq,
      messageCount: messages.length,
      pendingRequestCount: pendingRequestIds.length,
      sessionStatus: snapshot.session.status,
      stateRevision: snapshot.runtime.stateRevision,
    };
  }

  function readSnapshotAvailableThoughtLevels(
    snapshot: ZCodeSessionStateSnapshot,
  ): Set<string> | null {
    const thoughtLevel = snapshot.settings.thoughtLevel;
    if (!thoughtLevel.enabled) {
      return new Set();
    }
    const available = Array.isArray(thoughtLevel.available)
      ? (thoughtLevel.available as readonly unknown[])
      : [];
    if (available.length === 0) {
      return null;
    }
    const values = available
      .map((option) => {
        if (typeof option === "string") {
          return option.trim();
        }
        if (typeof option === "object" && option !== null && "value" in option) {
          const value = (option as { value?: unknown }).value;
          return typeof value === "string" ? value.trim() : "";
        }
        return "";
      })
      .filter((value) => value.length > 0);
    return values.length > 0 ? new Set(values) : null;
  }

  function canReplayThoughtLevelFromResumeSnapshot(params: {
    snapshot: ZCodeSessionStateSnapshot;
    thoughtLevel: string;
  }): boolean {
    const availableThoughtLevels = readSnapshotAvailableThoughtLevels(params.snapshot);
    return availableThoughtLevels === null || availableThoughtLevels.has(params.thoughtLevel);
  }

  // zcodeSessionService 是 desktop-continuous 主路径，状态变更后必须
  // 广播 snapshot，否则 sqlite 永远停留在 createSession 时写的 "New session"，侧边栏也收不到
  // workspace_task_list_changed。旧写路径（send/steer/fork/compact/rewind pass-through）
  // 已删除，仅剩 createSession/resumeSession/setModel 等生命周期与配置 op 调用本方法。
  async function broadcastSnapshot(
    snapshot: ZCodeSessionStateSnapshot,
    tag: string,
    options: {
      modelOverride?: string;
      thoughtLevelOverride?: string;
      moveGroupedTaskToTop?: boolean;
      /** 设计修正：必填，发射点必须声明变更类别。 */
      broadcastReason: ZCodeWorkspaceTaskListChanged["reason"];
    },
  ): Promise<void> {
    if (!taskIndexSyncer) {
      return;
    }
    try {
      // 排查日志（左侧列表随输入框操作刷新）：确认是哪个生命周期 op（setModel/createSession/resumeSession）触发了 snapshot 广播。
      logger.debug(
        undefined,
        `[list-refresh-trace] broadcastSnapshot tag=${tag} taskId=${snapshot.session.sessionId}`,
      );
      await taskIndexSyncer.syncSnapshotAndBroadcast(snapshot, options);
    } catch (error) {
      logger.warn(
        undefined,
        `[zcode-session-service] ${tag} syncSnapshotAndBroadcast 失败 taskId=${snapshot.session.sessionId}`,
        error,
      );
    }
  }

  async function repairEmptyImportedClaudeSession(
    snapshot: ZCodeSessionStateSnapshot,
    params: ZCodeSessionResumeParams | ZCodeSessionReadParams,
  ): Promise<ZCodeSessionStateSnapshot> {
    return withApiRetryRuntime(
      await repairEmptyImportedClaudeSessionSnapshot({
        agentService,
        snapshot,
        target: params,
      }),
    );
  }

  async function withResolvedMcpServers<
    T extends ZCodeSessionCreateParams | ZCodeSessionResumeParams,
  >(params: T): Promise<T> {
    const mcpServers = appendWorkspaceToFilesystemMcpServers(
      params.mcpServers,
      params.workspacePath,
    );
    const resolvedMcpServers = cuaProductMcpServerResolver
      ? await cuaProductMcpServerResolver.resolveMcpServers(mcpServers, {
          workspacePath: params.workspacePath,
        })
      : mcpServers;
    if (resolvedMcpServers === params.mcpServers) {
      return params;
    }
    // desktop-continuous session 路径绕过 legacy task adapter，之前不会执行
    // filesystem MCP 的 workspace 注入，导致同一 MCP 在直接 session 首发时缺少当前项目授权。
    // 这里只改发往 runtime 的临时参数，不回写用户配置，避免污染跨 workspace 的 MCP 设置；
    // product CUA broker socket/token 同样只注入 runtime 参数。
    return { ...params, mcpServers: resolvedMcpServers };
  }

  return {
    async initializeWorkspace(params: ZCodeSessionWorkspaceTarget) {
      const result = await agentService.initialize(params);
      // task index 的 v4 摄入（sessions-index/workspace-config）是
      // workspace 级常驻订阅。v4 命令路径（createSession/sendText 走 v4/command）
      // 不再经过本 service 的 session 操作入口，必须在 workspace 预热点建立订阅，
      // 否则纯 v4 会话的终态/标题/配置目录永远进不了 sqlite 与 workspace 广播。
      if (result.available && taskIndexSyncer) {
        taskIndexSyncer.ensureWorkspaceSubscription({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        });
      }
      return result;
    },

    getWorkspaceRuntimeIdentity(params: ZCodeSessionWorkspaceTarget) {
      return agentService.getWorkspaceRuntimeIdentity(params);
    },

    readWorkspacePresentation(params: ZCodeSessionReadWorkspacePresentationParams) {
      return agentService.readWorkspacePresentation(params);
    },

    async createSession(params: ZCodeSessionCreateParams) {
      const startedAt = Date.now();
      const sessionTraceId = params.sessionTraceId ?? createSessionTraceId();
      const agentParams = await withResolvedMcpServers({ ...params, sessionTraceId });
      logger.info(sessionTraceId, "[zcode-session-service] createSession 分配 session trace", {
        persistence: agentParams.persistence,
        workspaceIdentity: agentParams.workspaceIdentity,
        workspacePath: agentParams.workspacePath,
      });
      const snapshot = await agentService.createSession(agentParams);
      logger.info(sessionTraceId, "[zcode-session-service] createSession agent 返回", {
        durationMs: Date.now() - startedAt,
        mcpServerCount: agentParams.mcpServers?.length ?? 0,
        persistence: agentParams.persistence,
        snapshotTraceId: snapshot.session.traceId ?? null,
        sessionId: snapshot.session.sessionId,
        workspaceIdentity: agentParams.workspaceIdentity,
        workspacePath: agentParams.workspacePath,
      });
      if (agentParams.persistence === "deferred") {
        // 未发送前的草稿 session 只用于让 toolbar 和 agent runtime 共用同一份状态。
        // 这类空 session 不能进入 app 的 task index sqlite，否则侧边栏/搜索会出现没有用户输入的会话。
        // 同时记录这个草稿，后续 setModel 等状态变更也必须被挡在 task index 之外。
        deferredDraftSessions.remember(agentParams, snapshot);
        return snapshot;
      }
      // desktop-continuous 路径不会经过 ZCode task adapter，sqlite 的 task index 全靠
      // syncer 的 shadow 订阅刷新。createSession 成功后立刻 ensure，保证后续 runtime
      // 事件首条到达前订阅已就位。
      notifySyncer({
        workspacePath: snapshot.session.workspace.workspacePath,
        workspaceIdentity: snapshot.session.workspace.workspaceIdentity,
        sessionId: snapshot.session.sessionId,
      });
      // 立刻把初始 snapshot 也同步到 sqlite + 广播，让 UI 列表第一时间看到新会话行。
      // desktop-continuous 首发不会经过 legacy createTask，必须在这里同步写 grouped 顶部顺序。
      const snapshotWithRuntime = withApiRetryRuntime(snapshot);
      const broadcastStartedAt = Date.now();
      await broadcastSnapshot(snapshotWithRuntime, "createSession", {
        moveGroupedTaskToTop: true,
        // 首发广播沿用 task_meta_changed 旧语义（低频，一个任务一次）；
        // 语义化成 task_created（insert-active）需连同乐观插入去重一起改。
        broadcastReason: "task_meta_changed",
      });
      logger.info(sessionTraceId, "[zcode-session-service] createSession task index 同步完成", {
        broadcastDurationMs: Date.now() - broadcastStartedAt,
        durationMs: Date.now() - startedAt,
        sessionId: snapshot.session.sessionId,
        workspaceIdentity: params.workspaceIdentity,
        workspacePath: params.workspacePath,
      });
      return snapshotWithRuntime;
    },

    async resumeSession(params: ZCodeSessionResumeParams) {
      const startedAt = Date.now();
      const { broadcastSnapshot: shouldBroadcastSnapshot = true, ...resumeParams } = params;
      const agentParams = await withResolvedMcpServers(resumeParams);
      let snapshot = await repairEmptyImportedClaudeSession(
        withApiRetryRuntime(await agentService.resumeSession(agentParams)),
        agentParams,
      );
      const requestedThoughtLevelOverride = agentParams.thoughtLevel?.trim();
      let thoughtLevelOverride = requestedThoughtLevelOverride;
      if (
        requestedThoughtLevelOverride &&
        snapshot.settings.thoughtLevel.current !== requestedThoughtLevelOverride
      ) {
        if (
          !canReplayThoughtLevelFromResumeSnapshot({
            snapshot,
            thoughtLevel: requestedThoughtLevelOverride,
          })
        ) {
          // 恢复历史 task 时，模型已经被切回 task-local 模型，但旧 task config
          // 仍可能带着上一模型的 thoughtLevel，例如 GLM-5-Turbo 被传入 max。
          // snapshot.settings.thoughtLevel.available 是当前模型能力事实源，不支持时不能再重放给 agent。
          thoughtLevelOverride = undefined;
          logger.warn(
            undefined,
            "[zcode-session-service] resumeSession 跳过不支持的 task 思考强度",
            {
              availableThoughtLevels: Array.from(
                readSnapshotAvailableThoughtLevels(snapshot) ?? [],
              ),
              requestedThoughtLevel: requestedThoughtLevelOverride,
              sessionId: agentParams.sessionId,
              snapshotThoughtLevel: snapshot.settings.thoughtLevel.current ?? null,
              workspaceIdentity: agentParams.workspaceIdentity ?? null,
              workspacePath: agentParams.workspacePath,
            },
          );
        }
      }
      if (thoughtLevelOverride && snapshot.settings.thoughtLevel.current !== thoughtLevelOverride) {
        logger.info(undefined, "[zcode-session-service] resumeSession 重放 task 思考强度", {
          requestedThoughtLevel: thoughtLevelOverride,
          sessionId: agentParams.sessionId,
          snapshotThoughtLevel: snapshot.settings.thoughtLevel.current ?? null,
          workspaceIdentity: agentParams.workspaceIdentity ?? null,
          workspacePath: agentParams.workspacePath,
        });
        // 打开历史 task 时，resume 返回的 snapshot 可能仍带同 workspace 草稿态的最新思考强度。
        // 这里对同一个 session 显式重放 task-local thoughtLevel，再把修正后的 snapshot 广播出去；
        // 否则 syncer/UI 会把草稿的 high 写回原本是 max 的 active task。
        snapshot = await repairEmptyImportedClaudeSession(
          withApiRetryRuntime(
            await agentService.setThoughtLevel({
              workspacePath: agentParams.workspacePath,
              workspaceIdentity: agentParams.workspaceIdentity,
              sessionId: agentParams.sessionId,
              thoughtLevel: thoughtLevelOverride,
            }),
          ),
          agentParams,
        );
      }
      const agentDurationMs = Date.now() - startedAt;
      notifySyncer(agentParams, { includeSnapshot: shouldBroadcastSnapshot });
      const broadcastStartedAt = Date.now();
      const modelOverride = agentParams.model
        ? formatModelPickerValue(agentParams.model)
        : undefined;
      const syncOptions =
        modelOverride || thoughtLevelOverride
          ? {
              ...(modelOverride ? { modelOverride } : {}),
              ...(thoughtLevelOverride ? { thoughtLevelOverride } : {}),
            }
          : undefined;
      if (shouldBroadcastSnapshot) {
        // 打开/恢复任务是快照收敛，不改变 pin/archive/unread 归属；
        // 缺省 task_meta_changed 会让"每次点开任务"都触发全局 membership 重拉。
        await broadcastSnapshot(snapshot, "resumeSession", {
          ...syncOptions,
          broadcastReason: "task_status_changed",
        });
      } else if (modelOverride && taskIndexSyncer) {
        await taskIndexSyncer.syncTaskModel(
          {
            workspacePath: agentParams.workspacePath,
            workspaceIdentity: agentParams.workspaceIdentity,
            sessionId: agentParams.sessionId,
          },
          modelOverride,
        );
      }
      logger.info(undefined, "[zcode-session-service] resumeSession 历史恢复完成", {
        agentDurationMs,
        broadcastDurationMs: shouldBroadcastSnapshot ? Date.now() - broadcastStartedAt : 0,
        broadcastSnapshot: shouldBroadcastSnapshot,
        durationMs: Date.now() - startedAt,
        mcpServerCount: agentParams.mcpServers?.length ?? 0,
        sessionId: agentParams.sessionId,
        snapshot: getSessionSnapshotDiagnostics(snapshot),
        workspaceIdentity: agentParams.workspaceIdentity ?? null,
        workspacePath: agentParams.workspacePath,
      });
      return snapshot;
    },

    listSessions(params: ZCodeSessionListParams) {
      return agentService.listSessions(params);
    },

    async readSession(params: ZCodeSessionReadParams) {
      const startedAt = Date.now();
      const snapshot = await repairEmptyImportedClaudeSession(
        withApiRetryRuntime(await agentService.readSession(params)),
        params,
      );
      logger.info(undefined, "[zcode-session-service] readSession 历史快照读取完成", {
        deliveryKind: params.deliveryKind,
        durationMs: Date.now() - startedAt,
        messageLimit: params.messageLimit ?? null,
        sessionId: params.sessionId,
        snapshot: getSessionSnapshotDiagnostics(snapshot),
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
      return snapshot;
    },

    readSessionMessages(params: ZCodeSessionMessagesParams) {
      return agentService.readSessionMessages(params);
    },

    readSessionEvents(params: ZCodeSessionEventsParams) {
      return agentService.readSessionEvents(params);
    },

    promoteDeferredDraftSession(params: ZCodeTaskTarget) {
      const wasDeferredDraft = deferredDraftSessions.has(params);
      deferredDraftSessions.forget(params);
      if (!wasDeferredDraft) {
        return Promise.resolve();
      }
      // 手机 replayable 首发由 task facade 消费 deferred draft，需要在这里清除草稿标记
      // 并通知 task index 同步，避免桌面后续控制同一 task 时仍按 deferred 规则跳过同步。
      notifySyncer(params);
      logger.info(undefined, "[zcode-session-service] deferred draft session 已提升为 task", {
        sessionId: params.sessionId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
      return Promise.resolve();
    },

    closeSession(params: ZCodeTaskTarget) {
      deferredDraftSessions.forget(params);
      return agentService.closeSession(params).then(() => undefined);
    },

    async closeDeferredDraftSession(params: ZCodeTaskTarget) {
      try {
        const closed = await agentService.closeSession({
          ...params,
          expectedPersistence: "deferred",
        });
        if (closed) {
          deferredDraftSessions.forget(params);
        }
        return closed;
      } catch (error) {
        // 旧 Agent 会拒绝 expectedPersistence。安全降级是保留旧 session 并创建新草稿，
        // 不能回退到无条件 close，否则可能关闭刚被其他客户端提升的 active task。
        logger.warn(
          undefined,
          "[zcode-session-service] 条件关闭 deferred draft 失败，保留旧 session",
          {
            error: error instanceof Error ? error.message : String(error),
            sessionId: params.sessionId,
            workspaceIdentity: params.workspaceIdentity ?? null,
            workspacePath: params.workspacePath,
          },
        );
        return false;
      }
    },

    async setModel(params: ZCodeSessionSetModelParams) {
      const isDeferredDraft = deferredDraftSessions.has(params);
      if (!isDeferredDraft) {
        notifySyncer(params);
      }
      const snapshot = withApiRetryRuntime(await agentService.setModel(params));
      if (isDeferredDraft) {
        // deferred draft 只存在于 runtime 内存中，setModel 返回的是无消息空快照。
        // 如果这里订阅/写入 task index，进程重启后列表会留下无法 resume 的 "Session not found" 脏会话。
        return snapshot;
      }
      await broadcastSnapshot(snapshot, "setModel", {
        modelOverride: formatModelPickerValue(params.model),
        // 切模型属于纯配置变更，广播必须用 task_model_changed；
        // 之前落到缺省 task_meta_changed，UI 会误判为归属相关变更，
        // 触发全局 membership 重拉 + 左侧所有列表整刷。
        broadcastReason: "task_model_changed",
      });
      return snapshot;
    },

    async setThoughtLevel(params: ZCodeSessionSetThoughtLevelParams) {
      return withApiRetryRuntime(await agentService.setThoughtLevel(params));
    },

    async setMode(params: ZCodeSessionSetModeParams) {
      return withApiRetryRuntime(await agentService.setMode(params));
    },

    // onDynamicSessionEvent（renderer 侧旧 session/subscribe 订阅面）已删。
    // v4 UI 的会话事件走 agentService 的 conversation 帧通道，本 service 不再向
    // agentService.onDynamicSessionEvent 建立任何订阅。
  };
}
