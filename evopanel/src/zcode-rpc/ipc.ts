/**
 * Layer 4: 连接管理 —— IPCServer 和 IPCClient
 *
 * ChannelServer/ChannelClient 是单连接的 RPC 实现。
 * IPCServer/IPCClient 在其上构建连接管理能力：
 *
 * - IPCServer (1:N): 一个服务端接受多个客户端连接，
 *   每个连接独立创建 ChannelServer + ChannelClient。
 *   支持通过 Router 选择目标客户端进行调用。
 *
 * - IPCClient (1:1 双向): 既是客户端又是服务端，
 *   可以调远端的 channel，也可以注册自己的 channel 供远端调用。
 *
 * 关键协议：客户端连接后发送的第一条消息是 ctx（上下文/客户端ID），
 * 服务端据此识别客户端身份。
 */

import {
  Event,
  Emitter,
  IDisposable,
  DisposableStore,
  CancellationToken,
  EventMultiplexer,
} from "./foundation.js";
import { BufferReader, BufferWriter, serialize, deserialize } from "./serialization.js";
import { IMessagePassingProtocol } from "./protocol.js";
import {
  IChannel,
  IServerChannel,
  IChannelServer,
  IChannelClient,
  ChannelServer,
  ChannelClient,
  getDelayedChannel,
} from "./channels.js";

// ============================================================================
// Connection 相关接口
// ============================================================================

/** 客户端连接事件 */
export interface ClientConnectionEvent {
  protocol: IMessagePassingProtocol;
  readonly onDidClientDisconnect: Event<void>;
}

/** 客户端标识 */
export interface Client<TContext> {
  readonly ctx: TContext;
}

/** 连接 = 客户端标识 + 双向 channel */
interface Connection<TContext> extends Client<TContext> {
  readonly channelServer: ChannelServer<TContext>;
  readonly channelClient: ChannelClient;
}

/** 连接中心——暴露所有活跃连接 */
export interface IConnectionHub<TContext> {
  readonly connections: Connection<TContext>[];
  readonly onDidAddConnection: Event<Connection<TContext>>;
  readonly onDidRemoveConnection: Event<Connection<TContext>>;
}

/** 路由器——在多客户端场景中选择目标客户端 */
export interface IClientRouter<TContext = string> {
  routeCall(
    hub: IConnectionHub<TContext>,
    command: string,
    arg?: any,
    cancellationToken?: CancellationToken,
  ): Promise<Client<TContext>>;
  routeEvent(hub: IConnectionHub<TContext>, event: string, arg?: any): Promise<Client<TContext>>;
}

// ============================================================================
// IPCServer —— 一对多服务端
// ============================================================================

/**
 * IPCServer 是整个通信架构中的"大脑"。
 *
 * 它同时是：
 * - IChannelServer: 注册 channel 供客户端调用
 * - IRoutingChannelClient: 可以反向调用客户端的 channel（通过 Router 选择目标）
 * - IConnectionHub: 暴露所有活跃连接，支持连接增删事件
 *
 * 工作流程：
 * 1. 监听 onDidClientConnect 事件
 * 2. 客户端连接后，等待第一条消息（ctx = 客户端ID）
 * 3. 为每个连接创建独立的 ChannelServer + ChannelClient
 * 4. 把已注册的 channel 推送到新连接的 ChannelServer
 */
export class IPCServer<TContext = string>
  implements IChannelServer<TContext>, IConnectionHub<TContext>, IDisposable
{
  private channels = new Map<string, IServerChannel<TContext>>();
  private _connections = new Set<Connection<TContext>>();

  private readonly _onDidAddConnection = new Emitter<Connection<TContext>>();
  readonly onDidAddConnection = this._onDidAddConnection.event;

  private readonly _onDidRemoveConnection = new Emitter<Connection<TContext>>();
  readonly onDidRemoveConnection = this._onDidRemoveConnection.event;

  private readonly disposables = new DisposableStore();

  get connections(): Connection<TContext>[] {
    return [...this._connections];
  }

  constructor(onDidClientConnect: Event<ClientConnectionEvent>) {
    this.disposables.add(
      onDidClientConnect(({ protocol, onDidClientDisconnect }) => {
        // 等待客户端发来的第一条消息：ctx（客户端身份标识）
        const onFirstMessage = Event.once(protocol.onMessage);

        this.disposables.add(
          onFirstMessage((msg) => {
            const reader = new BufferReader(msg);
            const ctx = deserialize(reader) as TContext;

            // 为这个连接创建独立的 ChannelServer 和 ChannelClient
            const channelServer = new ChannelServer(protocol, ctx);
            const channelClient = new ChannelClient(protocol);

            // 把已注册的 channel 推送给新连接
            this.channels.forEach((channel, name) => channelServer.registerChannel(name, channel));

            const connection: Connection<TContext> = { channelServer, channelClient, ctx };
            this._connections.add(connection);
            this._onDidAddConnection.fire(connection);

            // 客户端断开时清理
            this.disposables.add(
              onDidClientDisconnect(() => {
                channelServer.dispose();
                channelClient.dispose();
                this._connections.delete(connection);
                this._onDidRemoveConnection.fire(connection);
              }),
            );
          }),
        );
      }),
    );
  }

  /**
   * 获取客户端的 channel（反向调用）。
   *
   * 当有多个客户端时，需要 router 或 filter 来选择目标：
   * - router: 实现 IClientRouter 接口，自定义路由逻辑
   * - filter: 简单的过滤函数，随机选一个匹配的客户端
   */
  getChannel<T extends IChannel>(
    channelName: string,
    routerOrFilter: IClientRouter<TContext> | ((client: Client<TContext>) => boolean),
  ): T {
    const that = this;
    const isFilter = typeof routerOrFilter === "function";

    return {
      call(command: string, arg?: any, cancellationToken?: CancellationToken): Promise<any> {
        let connectionPromise: Promise<Client<TContext>>;

        if (isFilter) {
          const match = that.connections.find(routerOrFilter as (c: Client<TContext>) => boolean);
          connectionPromise = match
            ? Promise.resolve(match)
            : Event.toPromise(
                Event.filter(
                  that.onDidAddConnection,
                  routerOrFilter as (c: Client<TContext>) => boolean,
                ),
              );
        } else {
          connectionPromise = (routerOrFilter as IClientRouter<TContext>).routeCall(
            that,
            command,
            arg,
            cancellationToken,
          );
        }

        const channelPromise = connectionPromise.then((c) =>
          (c as Connection<TContext>).channelClient.getChannel(channelName),
        );

        return getDelayedChannel(channelPromise).call(command, arg, cancellationToken);
      },
      listen(event: string, arg?: any): Event<any> {
        if (isFilter) {
          return that.getMulticastEvent(
            channelName,
            routerOrFilter as (c: Client<TContext>) => boolean,
            event,
            arg,
          );
        }

        const channelPromise = (routerOrFilter as IClientRouter<TContext>)
          .routeEvent(that, event, arg)
          .then((c) => (c as Connection<TContext>).channelClient.getChannel(channelName));

        return getDelayedChannel(channelPromise).listen(event, arg);
      },
    } as T;
  }

  /** 聚合所有匹配客户端的同名事件为一个事件 */
  private getMulticastEvent<T>(
    channelName: string,
    filter: (c: Client<TContext>) => boolean,
    eventName: string,
    arg: any,
  ): Event<T> {
    const that = this;
    let disposables: DisposableStore | undefined;

    const emitter = new Emitter<T>({
      onWillAddFirstListener: () => {
        disposables = new DisposableStore();
        const multiplexer = new EventMultiplexer<T>();

        const onAdd = (connection: Connection<TContext>) => {
          const channel = connection.channelClient.getChannel(channelName);
          const event = channel.listen<T>(eventName, arg);
          multiplexer.add(event);
        };

        that.connections.filter(filter).forEach(onAdd);
        disposables.add(Event.filter(that.onDidAddConnection, filter)(onAdd));
        disposables.add(multiplexer.event((e) => emitter.fire(e)));
        disposables.add(multiplexer);
      },
      onDidRemoveLastListener: () => {
        disposables?.dispose();
        disposables = undefined;
      },
    });

    return emitter.event;
  }

  registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
    this.channels.set(channelName, channel);

    // 推送到所有已连接的客户端
    for (const connection of this._connections) {
      connection.channelServer.registerChannel(channelName, channel);
    }
  }

  dispose(): void {
    this.disposables.dispose();
    for (const connection of this._connections) {
      connection.channelClient.dispose();
      connection.channelServer.dispose();
    }
    this._connections.clear();
    this.channels.clear();
    this._onDidAddConnection.dispose();
    this._onDidRemoveConnection.dispose();
  }
}

// ============================================================================
// IPCClient —— 一对一双向
// ============================================================================

/**
 * IPCClient 是双向的：
 * - 可以调远端的 channel (IChannelClient)
 * - 也可以注册自己的 channel 供远端调用 (IChannelServer)
 *
 * 第一条消息发送 ctx（自己的身份标识），这样服务端能识别你是谁。
 */
export class IPCClient<TContext = string>
  implements IChannelClient, IChannelServer<TContext>, IDisposable
{
  private channelClient: ChannelClient;
  private channelServer: ChannelServer<TContext>;

  constructor(protocol: IMessagePassingProtocol, ctx: TContext) {
    // 第一条消息：发送自己的身份标识
    const writer = new BufferWriter();
    serialize(writer, ctx);
    protocol.send(writer.buffer);

    this.channelClient = new ChannelClient(protocol);
    this.channelServer = new ChannelServer(protocol, ctx);
  }

  getChannel<T extends IChannel>(channelName: string): T {
    return this.channelClient.getChannel(channelName);
  }

  registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
    this.channelServer.registerChannel(channelName, channel);
  }

  dispose(): void {
    this.channelClient.dispose();
    this.channelServer.dispose();
  }
}

// ============================================================================
// StaticRouter —— 简单路由器
// ============================================================================

/**
 * 根据静态条件选择客户端的路由器。
 * 例: new StaticRouter(ctx => ctx === 'main-window')
 */
export class StaticRouter<TContext = string> implements IClientRouter<TContext> {
  constructor(private fn: (ctx: TContext) => boolean | Promise<boolean>) {}

  async routeCall(hub: IConnectionHub<TContext>): Promise<Client<TContext>> {
    return this.route(hub);
  }

  async routeEvent(hub: IConnectionHub<TContext>): Promise<Client<TContext>> {
    return this.route(hub);
  }

  private async route(hub: IConnectionHub<TContext>): Promise<Client<TContext>> {
    for (const connection of hub.connections) {
      if (await Promise.resolve(this.fn(connection.ctx))) {
        return connection;
      }
    }
    // 等待新连接到来
    await Event.toPromise(hub.onDidAddConnection);
    return this.route(hub);
  }
}
