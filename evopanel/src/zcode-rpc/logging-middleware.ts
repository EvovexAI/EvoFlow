/**
 * RPC 日志拦截中间件
 *
 * 装饰 ChannelServer / ChannelClient，在不侵入核心逻辑的前提下
 * 统一记录所有 RPC 调用和事件订阅。
 *
 * 用法：
 *   const server = new ChannelServer(protocol, ctx);
 *   const logged = new LoggingChannelServer(server, logger.info);
 *   services.exposeOnChannelServer(logged);
 */

import type { IChannelServer, IChannelClient, IChannel, IServerChannel } from "./channels.js";
import type { CancellationToken } from "./foundation.js";
import { Event } from "./foundation.js";

// ============================================================================
// 日志函数类型
// ============================================================================

export type RPCLogger = (message: string, ...args: unknown[]) => void;

// ============================================================================
// LoggingServerChannel —— 装饰单个 IServerChannel，记录 call/listen
// ============================================================================

class LoggingServerChannel<TContext> implements IServerChannel<TContext> {
  constructor(
    private inner: IServerChannel<TContext>,
    private channelName: string,
    private logger: RPCLogger,
  ) {}

  async call<T>(
    ctx: TContext,
    command: string,
    arg?: any,
    cancellationToken?: CancellationToken,
  ): Promise<T> {
    const start = performance.now();
    try {
      const result = await this.inner.call<T>(ctx, command, arg, cancellationToken);
      const elapsed = (performance.now() - start).toFixed(1);
      this.logger(`[rpc:call] ${this.channelName}.${command} OK (${elapsed}ms)`);
      return result;
    } catch (err) {
      const elapsed = (performance.now() - start).toFixed(1);
      this.logger(`[rpc:call] ${this.channelName}.${command} FAIL (${elapsed}ms)`, err);
      throw err;
    }
  }

  listen<T>(ctx: TContext, event: string, arg?: any): Event<T> {
    try {
      const result = this.inner.listen<T>(ctx, event, arg);
      this.logger(`[rpc:listen] ${this.channelName}.${event} subscribed`);
      return result;
    } catch (err) {
      this.logger(`[rpc:listen] ${this.channelName}.${event} FAIL`, err);
      throw err;
    }
  }
}

// ============================================================================
// LoggingChannelServer —— 装饰 IChannelServer，拦截 registerChannel
// ============================================================================

/**
 * 包装 ChannelServer，为每个注册的频道自动加上日志。
 *
 * 在 host process 或 server 中使用：
 * ```ts
 * const server = new ChannelServer(protocol, ctx);
 * const logged = new LoggingChannelServer(server, console.error);
 * services.exposeOnChannelServer(logged);
 * ```
 */
export class LoggingChannelServer<TContext = string> implements IChannelServer<TContext> {
  constructor(
    private inner: IChannelServer<TContext>,
    private logger: RPCLogger,
  ) {}

  registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
    this.logger(`[rpc:register] channel "${channelName}"`);
    this.inner.registerChannel(
      channelName,
      new LoggingServerChannel(channel, channelName, this.logger),
    );
  }

  ready(): void {
    this.inner.ready?.();
  }
}

// ============================================================================
// LoggingChannel —— 装饰单个 IChannel（客户端侧），记录 call/listen
// ============================================================================

class LoggingChannel implements IChannel {
  constructor(
    private inner: IChannel,
    private channelName: string,
    private logger: RPCLogger,
  ) {}

  async call<T>(command: string, arg?: any, cancellationToken?: CancellationToken): Promise<T> {
    const start = performance.now();
    try {
      const result = await this.inner.call<T>(command, arg, cancellationToken);
      const elapsed = (performance.now() - start).toFixed(1);
      this.logger(`[rpc:call] ${this.channelName}.${command} → OK (${elapsed}ms)`);
      return result;
    } catch (err) {
      const elapsed = (performance.now() - start).toFixed(1);
      this.logger(`[rpc:call] ${this.channelName}.${command} → FAIL (${elapsed}ms)`, err);
      throw err;
    }
  }

  listen<T>(event: string, arg?: any): Event<T> {
    this.logger(`[rpc:listen] ${this.channelName}.${event} → subscribed`);
    return this.inner.listen<T>(event, arg);
  }
}

// ============================================================================
// LoggingChannelClient —— 装饰 IChannelClient，拦截 getChannel
// ============================================================================

/**
 * 包装 ChannelClient，为每个获取的频道自动加上日志。
 *
 * 在 renderer 或 client 中使用：
 * ```ts
 * const client = new ChannelClient(protocol);
 * const logged = new LoggingChannelClient(client, console.info);
 * const services = new RemoteServiceAccess(logged);
 * ```
 */
export class LoggingChannelClient implements IChannelClient {
  constructor(
    private inner: IChannelClient,
    private logger: RPCLogger,
  ) {}

  getChannel<T extends IChannel>(channelName: string): T {
    const channel = this.inner.getChannel<T>(channelName);
    return new LoggingChannel(
      channel as unknown as IChannel,
      channelName,
      this.logger,
    ) as unknown as T;
  }
}
