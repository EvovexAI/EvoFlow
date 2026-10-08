/**
 * Layer 6: Remote 远程连接抽象
 *
 * 这一层让 VS Code 能连接到 SSH、Docker、WSL 里的文件系统。
 *
 * 核心思路：
 * 1. RemoteAuthority: "ssh+myserver" 这样的字符串标识远程环境
 * 2. RemoteAuthorityResolver: 由扩展注册，把 authority 解析为实际连接地址
 * 3. RemoteSocketFactory: 根据连接类型创建不同的 socket
 * 4. URITransformer: 在客户端和服务端之间转换文件路径
 *
 * 连接建立流程：
 *   authority "ssh+myserver"
 *       ↓ (RemoteAuthorityResolver)
 *   { host: "1.2.3.4", port: 8080, token: "xxx" }
 *       ↓ (RemoteSocketFactory)
 *   ISocket (TCP/WebSocket)
 *       ↓ (PersistentProtocol)
 *   IMessagePassingProtocol (带 ACK + 重连)
 *       ↓ (IPCClient)
 *   可以调用远端的 channel 了！
 */

import { Emitter, IDisposable, toDisposable } from "./foundation.js";
import { ISocket } from "./protocol.js";
import { PersistentProtocol } from "./persistent-protocol.js";
import { IPCClient } from "./ipc.js";

// ============================================================================
// Remote Authority
// ============================================================================

/**
 * 远程连接类型
 */
export enum RemoteConnectionType {
  WebSocket = 0,
  Managed = 1,
}

/**
 * WebSocket 连接：直接连到 host:port
 */
export class WebSocketRemoteConnection {
  readonly type = RemoteConnectionType.WebSocket;
  constructor(
    public readonly host: string,
    public readonly port: number,
  ) {}

  toString(): string {
    return `WebSocket(${this.host}:${this.port})`;
  }
}

/**
 * 托管连接：通过 ID 引用已建立的连接（如 tunnel）
 */
export class ManagedRemoteConnection {
  readonly type = RemoteConnectionType.Managed;
  constructor(public readonly id: number) {}

  toString(): string {
    return `Managed(${this.id})`;
  }
}

export type RemoteConnection = WebSocketRemoteConnection | ManagedRemoteConnection;

/** 解析后的远程地址 */
export interface ResolvedAuthority {
  readonly authority: string;
  readonly connectTo: RemoteConnection;
  readonly connectionToken: string | undefined;
}

// ============================================================================
// Remote Authority Resolver
// ============================================================================

/**
 * IRemoteAuthorityResolver 负责把 authority 字符串解析为实际连接地址。
 *
 * 在 VS Code 中，这个接口由远程扩展实现：
 * - Remote-SSH 扩展注册 "ssh" 类型的 resolver
 * - Remote-WSL 扩展注册 "wsl" 类型的 resolver
 * - Dev Containers 扩展注册 "dev-container" 类型的 resolver
 *
 * 每种远程类型都知道如何解析自己的 authority 并返回可连接的地址。
 */
export interface IRemoteAuthorityResolver {
  resolve(authority: string): Promise<ResolvedAuthority>;
}

/**
 * RemoteAuthorityResolverService 管理多个 resolver
 */
export class RemoteAuthorityResolverService {
  private resolvers = new Map<string, IRemoteAuthorityResolver>();

  /** 注册一个 authority 类型的 resolver */
  registerResolver(type: string, resolver: IRemoteAuthorityResolver): IDisposable {
    this.resolvers.set(type, resolver);
    return toDisposable(() => this.resolvers.delete(type));
  }

  /**
   * 解析 authority
   * @param authority 如 "ssh+myserver", "wsl+Ubuntu"
   */
  async resolveAuthority(authority: string): Promise<ResolvedAuthority> {
    // 从 authority 中提取类型：ssh+myserver → ssh
    const plusIndex = authority.indexOf("+");
    const type = plusIndex >= 0 ? authority.substring(0, plusIndex) : authority;

    const resolver = this.resolvers.get(type);
    if (!resolver) {
      throw new Error(`No resolver registered for remote type: ${type}`);
    }

    return resolver.resolve(authority);
  }
}

// ============================================================================
// Remote Socket Factory
// ============================================================================

/**
 * ISocketFactory 创建特定类型的 socket 连接
 */
export interface ISocketFactory<T extends RemoteConnectionType = RemoteConnectionType> {
  supports(connectTo: RemoteConnection & { type: T }): boolean;
  connect(connectTo: RemoteConnection & { type: T }, path: string, query: string): Promise<ISocket>;
}

/**
 * RemoteSocketFactoryService 管理不同连接类型的 socket 工厂。
 *
 * 设计模式：策略模式
 * - Node.js 环境注册 NodeSocketFactory（TCP socket）
 * - 浏览器环境注册 BrowserSocketFactory（WebSocket）
 * - 每种 RemoteConnectionType 可以有多个工厂，按 supports() 选择
 */
export class RemoteSocketFactoryService {
  private readonly factories: Map<RemoteConnectionType, ISocketFactory[]> = new Map();

  register<T extends RemoteConnectionType>(type: T, factory: ISocketFactory<T>): IDisposable {
    if (!this.factories.has(type)) {
      this.factories.set(type, []);
    }
    this.factories.get(type)!.push(factory as ISocketFactory);
    return toDisposable(() => {
      const list = this.factories.get(type);
      if (list) {
        const idx = list.indexOf(factory as ISocketFactory);
        if (idx >= 0) {
          list.splice(idx, 1);
        }
      }
    });
  }

  async connect(connectTo: RemoteConnection, path: string, query: string): Promise<ISocket> {
    const factories = this.factories.get(connectTo.type) || [];
    const factory = factories.find((f) => f.supports(connectTo as any));
    if (!factory) {
      throw new Error(`No socket factory found for ${connectTo}`);
    }
    return factory.connect(connectTo as any, path, query);
  }
}

// ============================================================================
// URI Transformer
// ============================================================================

/**
 * URI 转换器——在客户端和服务端之间转换文件路径。
 *
 * 问题：
 * - 客户端用 vscode-remote://ssh+myserver/home/user/file.txt 标识远程文件
 * - 服务端（远端机器上）用 file:///home/user/file.txt 操作真实文件
 *
 * 转换规则：
 *   客户端 → 服务端:
 *     vscode-remote://authority/path → file:///path
 *     file:///local/path → vscode-local:///local/path
 *
 *   服务端 → 客户端:
 *     file:///path → vscode-remote://authority/path
 *     vscode-local:///local/path → file:///local/path
 */
export interface IURITransformer {
  /** 客户端 URI → 服务端 URI */
  transformIncoming(uri: SimpleURI): SimpleURI;
  /** 服务端 URI → 客户端 URI */
  transformOutgoing(uri: SimpleURI): SimpleURI;
}

/** 简化的 URI 表示 */
export interface SimpleURI {
  scheme: string;
  authority: string;
  path: string;
}

/**
 * 创建一个 URI 转换器
 * @param remoteAuthority 远程 authority 字符串，如 "ssh+myserver"
 */
export function createURITransformer(remoteAuthority: string): IURITransformer {
  return {
    transformIncoming(uri: SimpleURI): SimpleURI {
      // vscode-remote://authority/path → file:///path
      if (uri.scheme === "vscode-remote" && uri.authority === remoteAuthority) {
        return { scheme: "file", authority: "", path: uri.path };
      }
      // file:///local → vscode-local:///local
      if (uri.scheme === "file") {
        return { scheme: "vscode-local", authority: "", path: uri.path };
      }
      return uri;
    },

    transformOutgoing(uri: SimpleURI): SimpleURI {
      // file:///path → vscode-remote://authority/path
      if (uri.scheme === "file") {
        return { scheme: "vscode-remote", authority: remoteAuthority, path: uri.path };
      }
      // vscode-local:///local → file:///local
      if (uri.scheme === "vscode-local") {
        return { scheme: "file", authority: "", path: uri.path };
      }
      return uri;
    },
  };
}

// ============================================================================
// Remote Agent Connection —— 把所有 Remote 抽象串起来
// ============================================================================

/**
 * 重连策略
 */
const RECONNECT_DELAYS = [0, 5, 5, 10, 10, 10, 10, 10, 30]; // 秒

export interface RemoteConnectionState {
  type: "connected" | "reconnecting" | "disconnected";
}

/**
 * RemoteAgentConnection 是远程连接的完整生命周期管理器。
 *
 * 它串联了所有 Remote 层的抽象：
 * 1. 用 RemoteAuthorityResolver 解析地址
 * 2. 用 RemoteSocketFactory 建立 socket
 * 3. 用 PersistentProtocol 添加可靠性
 * 4. 包装为 IPCClient 供上层使用
 * 5. 断线后自动重连
 */
export class RemoteAgentConnection implements IDisposable {
  private protocol: PersistentProtocol | null = null;
  private client: IPCClient<string> | null = null;

  private readonly _onDidStateChange = new Emitter<RemoteConnectionState>();
  readonly onDidStateChange = this._onDidStateChange.event;

  constructor(
    private readonly authority: string,
    private readonly resolverService: RemoteAuthorityResolverService,
    private readonly socketFactory: RemoteSocketFactoryService,
  ) {}

  /**
   * 建立连接并返回 IPCClient
   */
  async connect(): Promise<IPCClient<string>> {
    // Step 1: 解析 authority
    const resolved = await this.resolverService.resolveAuthority(this.authority);

    // Step 2: 建立 socket
    const query = resolved.connectionToken ? `token=${resolved.connectionToken}` : "";
    const socket = await this.socketFactory.connect(resolved.connectTo, "/", query);

    // Step 3: 用 PersistentProtocol 包装（加 ACK + 重连能力）
    this.protocol = new PersistentProtocol(socket);

    // Step 4: 包装为 IPCClient
    this.client = new IPCClient(this.protocol, this.authority);

    // Step 5: 监听断线，触发重连
    this.protocol.onSocketClose(() => {
      this._onDidStateChange.fire({ type: "reconnecting" });
      this.reconnect(resolved, 0);
    });

    this._onDidStateChange.fire({ type: "connected" });
    return this.client;
  }

  private async reconnect(resolved: ResolvedAuthority, attempt: number): Promise<void> {
    if (attempt >= RECONNECT_DELAYS.length) {
      this._onDidStateChange.fire({ type: "disconnected" });
      return;
    }

    const delay = RECONNECT_DELAYS[attempt] * 1000;
    await new Promise((r) => setTimeout(r, delay));

    try {
      const query = resolved.connectionToken ? `token=${resolved.connectionToken}` : "";
      const newSocket = await this.socketFactory.connect(resolved.connectTo, "/", query);

      // 用新 socket 替换，PersistentProtocol 会自动重放未确认的消息
      this.protocol!.replaceSocket(newSocket);
      this._onDidStateChange.fire({ type: "connected" });
    } catch {
      this.reconnect(resolved, attempt + 1);
    }
  }

  dispose(): void {
    this.client?.dispose();
    this.protocol?.dispose();
    this._onDidStateChange.dispose();
  }
}
