import {
  isFeishuBotProvider,
  type BotConfig,
  type BotProvider,
  type BotProviderCallbackResult,
  type BotsConfigFile,
} from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import {
  startFeishuBotWebSocket,
  type FeishuWebSocketClient,
} from "./providers/feishuProvider.js";
import {
  acquireFeishuWebSocketLock,
  assertBotCallbackSucceeded,
  BOT_RUNTIME_LOCK_RETRY_MS,
  createBotConnectionFingerprint,
  createLatestRuntimeRefreshQueue,
  type BotRuntimeLogger,
  type BotRuntimeStatusSink,
  waitFor,
  waitForAbort,
} from "./channelRuntime.js";

interface FeishuChannelRuntimeDeps {
  runBackgroundTasks?: boolean;
  credentialService: ICredentialService;
  logger: BotRuntimeLogger;
  statusSink: BotRuntimeStatusSink;
  ensureBotStorageMigrated(): Promise<void>;
  readConfig(): Promise<BotsConfigFile>;
  summarizeCallbackPayload(payload: unknown): string;
  processProviderCallback(
    provider: BotProvider,
    payload: unknown,
  ): Promise<BotProviderCallbackResult>;
}

export function createFeishuChannelRuntime(deps: FeishuChannelRuntimeDeps) {
  interface RuntimeEntry {
    controller: AbortController;
    fingerprint: string;
    done: Promise<void>;
  }

  const runtimes = new Map<string, RuntimeEntry>();
  const refreshQueue = createLatestRuntimeRefreshQueue();

  async function getConnectionFingerprint(bot: BotConfig): Promise<string> {
    const credential = bot.credentialRef
      ? await deps.credentialService.load(bot.credentialRef)
      : null;
    return createBotConnectionFingerprint([
      bot.provider,
      bot.feishuAppId ?? "",
      bot.credentialRef ?? "",
      credential ?? "",
    ]);
  }

  async function runBot(bot: BotConfig, signal: AbortSignal): Promise<void> {
    let client: FeishuWebSocketClient | null = null;
    while (!signal.aborted) {
      let lock: Awaited<ReturnType<typeof acquireFeishuWebSocketLock>>;
      try {
        lock = await acquireFeishuWebSocketLock(bot);
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        // Bugfix: runtime 停止或锁目录异常时，锁文件创建可能在进入连接 try 块前失败。
        // 必须把 acquire 纳入可恢复循环，否则多窗口关闭会留下未处理 rejection。
        deps.logger.warn(
          undefined,
          `acquire Feishu WebSocket lock failed bot=${bot.id}: ${error instanceof Error ? `${error.message}${"code" in error && typeof error.code === "string" ? ` code=${error.code}` : ""}` : String(error)}`,
        );
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
          status: "error",
          message: `Feishu WebSocket lock failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        await waitFor(5_000, signal);
        continue;
      }
      if (!lock) {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
          status: "idle",
          message: "Feishu WebSocket is handled by another ZCode window.",
        });
        await waitFor(BOT_RUNTIME_LOCK_RETRY_MS, signal);
        continue;
      }
      let retryAfterError = false;
      try {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
          status: "connected",
          messageId: "bots.runtime.feishuWebSocketConnecting",
          message: "Feishu WebSocket is connecting.",
        });
        client = await startFeishuBotWebSocket({
          bot,
          signal,
          onConnectionStateChange: (state) => {
            deps.statusSink.setRuntimeStatus({
              botId: bot.id,
              provider: bot.provider,
              status: "connected",
              message:
                state === "reconnecting"
                  ? "Feishu WebSocket is reconnecting."
                  : "Feishu WebSocket is running.",
              messageId:
                state === "reconnecting"
                  ? "bots.runtime.feishuWebSocketConnecting"
                  : "bots.runtime.feishuWebSocketRunning",
            });
          },
          deps: {
            loadCredential: (key) => deps.credentialService.load(key),
          },
          onPayload: async (payload) => {
            if (signal.aborted) {
              return;
            }
            deps.logger.debug(
              undefined,
              `feishu websocket payload bot=${bot.id} ${deps.summarizeCallbackPayload(payload)}`,
            );
            const callbackResult = await deps.processProviderCallback(
              bot.provider,
              payload,
            );
            assertBotCallbackSucceeded(
              bot.provider === "lark" ? "Lark" : "Feishu",
              callbackResult,
            );
            return callbackResult.replies[0];
          },
        });
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
          status: "connected",
          // 修复：运行状态会直接展示到 UI。补充 messageId，让前端按当前语言渲染，message 仅作为旧版本兜底。
          message: "Feishu WebSocket is running.",
          messageId: "bots.runtime.feishuWebSocketRunning",
        });
        // Bugfix：首次 ready 不是长连接生命周期终点。SDK 重连耗尽必须进入 catch，
        // 才能更新错误状态、关闭 client、释放跨窗口锁并进入外层恢复循环。
        await Promise.race([
          waitForAbort(signal),
          client.terminated,
        ]);
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
          status: "error",
          message: `Feishu WebSocket failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        retryAfterError = true;
      } finally {
        if (client) {
          try {
            client.close();
          } catch (error) {
            deps.logger.debug(
              undefined,
              `close Feishu WebSocket failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          client = null;
        }
        await lock.release().catch((error: unknown) => {
          deps.logger.warn(
            undefined,
            `release Feishu WebSocket lock failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      // 修复原因：重试退避不能占着旧 client 和跨窗口锁等待，必须先完整清理资源。
      if (retryAfterError) {
        await waitFor(5_000, signal);
      }
    }
  }

  async function stopWebSocket(botId: string): Promise<void> {
    const runtime = runtimes.get(botId);
    runtime?.controller.abort();
    if (runtime) {
      await runtime.done;
      if (runtimes.get(botId) === runtime) {
        runtimes.delete(botId);
      }
    }
    const previous = deps.statusSink.getRuntimeStatus(botId);
    if (previous) {
      deps.statusSink.setRuntimeStatus({
        ...previous,
        status: "idle",
        messageId: "bots.runtime.feishuWebSocketStopped",
        message: "Feishu WebSocket is stopped.",
      });
    }
  }

  function startWebSocket(bot: BotConfig, fingerprint: string): void {
    if (runtimes.has(bot.id)) {
      return;
    }
    const controller = new AbortController();
    deps.statusSink.setRuntimeStatus({
      botId: bot.id,
      provider: bot.provider,
      status: "connected",
      messageId: "bots.runtime.feishuWebSocketStarting",
      message: "Feishu WebSocket is starting.",
    });
    const runtime: RuntimeEntry = {
      controller,
      fingerprint,
      done: Promise.resolve(),
    };
    runtime.done = runBot(bot, controller.signal).finally(() => {
      if (runtimes.get(bot.id) === runtime) {
        runtimes.delete(bot.id);
        const previous = deps.statusSink.getRuntimeStatus(bot.id);
        if (previous?.status === "connected") {
          deps.statusSink.setRuntimeStatus({
            botId: bot.id,
            provider: bot.provider,
            status: "idle",
            messageId: "bots.runtime.feishuWebSocketStopped",
            message: "Feishu WebSocket is stopped.",
          });
        }
      }
    });
    runtimes.set(bot.id, runtime);
  }

  async function reconcile(
    config: BotsConfigFile | undefined,
    isLatest: () => boolean,
  ): Promise<void> {
    await deps.ensureBotStorageMigrated();
    const currentConfig = config ?? (await deps.readConfig());
    if (!isLatest()) {
      return;
    }
    const activeFeishuIds = new Set(
      currentConfig.bots
        .filter(
          (bot) =>
            isFeishuBotProvider(bot.provider) &&
            bot.enabled &&
            bot.credentialRef &&
            bot.feishuAppId,
        )
        .map((bot) => bot.id),
    );
    for (const botId of runtimes.keys()) {
      if (!activeFeishuIds.has(botId)) {
        await stopWebSocket(botId);
        if (!isLatest()) {
          return;
        }
      }
    }
    for (const bot of currentConfig.bots) {
      if (
        isFeishuBotProvider(bot.provider) &&
        bot.enabled &&
        bot.credentialRef &&
        bot.feishuAppId
      ) {
        const fingerprint = await getConnectionFingerprint(bot);
        if (!isLatest()) {
          return;
        }
        const runtime = runtimes.get(bot.id);
        if (runtime && runtime.fingerprint !== fingerprint) {
          // Bugfix: 飞书/Lark 的 provider、App ID 或凭据变化后，旧 WebSocket 仍持有旧配置。
          // 必须等待旧 client 和跨窗口锁释放后再启动新连接，保证同一 Bot 只有一个配置版本在线。
          await stopWebSocket(bot.id);
          if (!isLatest()) {
            return;
          }
        }
        startWebSocket(bot, fingerprint);
      } else if (isFeishuBotProvider(bot.provider) && !bot.enabled) {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
          status: "disabled",
          messageId: "bots.runtime.botDisabled",
          message: "Bot is disabled.",
        });
      }
    }
  }

  function refresh(config?: BotsConfigFile): Promise<void> {
    return refreshQueue.enqueue((isLatest) => reconcile(config, isLatest));
  }

  function scheduleRefresh(config?: BotsConfigFile): void {
    if (deps.runBackgroundTasks === false) {
      // 修复原因：remote workspace host / desktop-attached 远端只暴露控制面服务；
      // bot runtime 后台连接必须留在本地桌面 host，避免配置变更后重新抢跑。
      return;
    }
    void refresh(config).catch((error: unknown) => {
      deps.logger.warn(
        undefined,
        `refresh Feishu WebSocket failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async function dispose(): Promise<void> {
    refreshQueue.invalidate();
    const activeRuntimes = [...runtimes.values()];
    for (const runtime of activeRuntimes) {
      runtime.controller.abort();
    }
    // Bugfix：abort 只是发出取消信号；销毁终态必须等 WebSocket 关闭和 finally 释放跨进程锁。
    await Promise.allSettled(activeRuntimes.map((runtime) => runtime.done));
    for (const [botId, runtime] of runtimes) {
      if (activeRuntimes.includes(runtime)) {
        runtimes.delete(botId);
      }
    }
  }

  return {
    dispose,
    refresh,
    scheduleRefresh,
    stopWebSocket,
  };
}
