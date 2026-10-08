/**
 * Layer 0: 基础设施
 * - IDisposable / DisposableStore: 资源生命周期管理
 * - Event / Emitter: 事件系统
 * - CancellationToken: 取消令牌
 *
 * 这些是整个 IPC 框架的地基，所有上层模块都依赖它们。
 */

// ============================================================================
// Disposable - 资源释放模式
// ============================================================================

export interface IDisposable {
  dispose(): void;
}

export function toDisposable(fn: () => void): IDisposable {
  return { dispose: once(fn) };
}

function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (!called) {
      called = true;
      fn();
    }
  };
}

/**
 * DisposableStore 收集多个 IDisposable，统一释放。
 * VS Code 里几乎每个类都有一个 DisposableStore 来管理子资源。
 */
export class DisposableStore implements IDisposable {
  private items = new Set<IDisposable>();
  private isDisposed = false;

  add<T extends IDisposable>(item: T): T {
    if (this.isDisposed) {
      console.warn("Adding to a disposed DisposableStore");
      item.dispose();
      return item;
    }
    this.items.add(item);
    return item;
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    for (const item of this.items) {
      item.dispose();
    }
    this.items.clear();
  }
}

// ============================================================================
// Event System - 事件系统
// ============================================================================

/**
 * Event<T> 就是一个函数签名：传入 listener，返回一个 IDisposable 用于取消订阅。
 * 这是整个 IPC 框架中事件流转的核心类型。
 */
export type Event<T> = (listener: (e: T) => void) => IDisposable;

export namespace Event {
  /** 永远不触发的事件 */
  export const None: Event<any> = () => ({ dispose() {} });

  /** 只触发一次就自动取消订阅 */
  export function once<T>(event: Event<T>): Event<T> {
    return (listener) => {
      let fired = false;
      const disposable = event((e) => {
        if (!fired) {
          fired = true;
          disposable.dispose();
          listener(e);
        }
      });
      return disposable;
    };
  }

  /** 把事件转为 Promise，resolve 后自动取消订阅 */
  export function toPromise<T>(event: Event<T>): Promise<T> {
    return new Promise((resolve) => once(event)(resolve));
  }

  /** 过滤事件 */
  export function filter<T>(event: Event<T>, fn: (e: T) => boolean): Event<T> {
    return (listener) =>
      event((e) => {
        if (fn(e)) {
          listener(e);
        }
      });
  }

  /** 映射事件 */
  export function map<T, R>(event: Event<T>, fn: (e: T) => R): Event<R> {
    return (listener) => event((e) => listener(fn(e)));
  }
}

/**
 * Emitter<T> 是事件的发射器。
 *
 * 关键设计：
 * - onWillAddFirstListener: 第一个订阅者到来时触发（懒初始化资源）
 * - onDidRemoveLastListener: 最后一个订阅者离开时触发（释放资源）
 *
 * 这个"懒订阅"机制在 IPC 框架中至关重要——
 * ChannelClient 的 requestEvent 正是利用它来实现
 * "有人监听才发送 EventListen 请求，无人监听就发 EventDispose"。
 */
export class Emitter<T> implements IDisposable {
  private listeners = new Set<(e: T) => void>();
  private disposed = false;
  private options?: EmitterOptions;

  constructor(options?: EmitterOptions) {
    this.options = options;
  }

  get event(): Event<T> {
    return (listener: (e: T) => void) => {
      if (this.disposed) {
        return { dispose() {} };
      }

      const isFirst = this.listeners.size === 0;
      this.listeners.add(listener);

      if (isFirst) {
        this.options?.onWillAddFirstListener?.();
      }

      return toDisposable(() => {
        this.listeners.delete(listener);
        if (this.listeners.size === 0) {
          this.options?.onDidRemoveLastListener?.();
        }
      });
    };
  }

  fire(event: T): void {
    if (this.disposed) {
      return;
    }
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

interface EmitterOptions {
  onWillAddFirstListener?: () => void;
  onDidRemoveLastListener?: () => void;
}

/**
 * Relay 是一个"事件中继器"，可以动态切换输入源。
 * 用于 getDelayedChannel 中：先创建 Relay，等 channel promise resolve 后切换 input。
 */
export class Relay<T> implements IDisposable {
  private emitter = new Emitter<T>();
  private inputDisposable: IDisposable = { dispose() {} };

  readonly event = this.emitter.event;

  set input(event: Event<T>) {
    this.inputDisposable.dispose();
    this.inputDisposable = event((e) => this.emitter.fire(e));
  }

  dispose(): void {
    this.inputDisposable.dispose();
    this.emitter.dispose();
  }
}

/**
 * EventMultiplexer 聚合多个事件源为一个事件。
 * IPCServer 的 getMulticastEvent 用它来聚合所有客户端的同名事件。
 */
export class EventMultiplexer<T> implements IDisposable {
  private readonly emitter = new Emitter<T>();
  private readonly disposables: IDisposable[] = [];

  readonly event = this.emitter.event;

  add(event: Event<T>): IDisposable {
    const d = event((e) => this.emitter.fire(e));
    this.disposables.push(d);
    return d;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.emitter.dispose();
  }
}

// ============================================================================
// CancellationToken - 取消令牌
// ============================================================================

export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  readonly onCancellationRequested: Event<void>;
}

export namespace CancellationToken {
  export const None: CancellationToken = {
    isCancellationRequested: false,
    onCancellationRequested: Event.None,
  };
}

export class CancellationTokenSource implements IDisposable {
  private _token?: CancellationToken;
  private emitter = new Emitter<void>();
  private _isCancelled = false;

  get token(): CancellationToken {
    if (!this._token) {
      this._token = {
        isCancellationRequested: false,
        onCancellationRequested: this.emitter.event,
      };
    }
    return this._token;
  }

  cancel(): void {
    if (!this._isCancelled) {
      this._isCancelled = true;
      this.emitter.fire();
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
