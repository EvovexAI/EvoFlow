import { VSBuffer } from "./buffer.js";
import { CancellationToken, Event, Emitter, type IDisposable } from "./foundation.js";
import { BufferReader, BufferWriter, deserialize, serialize } from "./serialization.js";
import type { IMessagePassingProtocol } from "./protocol.js";
import {
  type IChannel,
  type IChannelClient,
  type IHandler,
  type IRawResponse,
  RequestType,
  ResponseType,
} from "./channels.shared.js";

enum State {
  Uninitialized,
  Idle,
}

export class ChannelClient implements IChannelClient, IDisposable {
  private state = State.Uninitialized;
  private isDisposed = false;
  private activeRequests = new Set<IDisposable>();
  private handlers = new Map<number, IHandler>();
  // Promise 请求和事件监听共用 handlers，但只有前者需要在连接终结时 reject。
  // 单独维护 reject map，避免 dispose 把事件订阅误当成挂起的 RPC 请求。
  private pendingRejections = new Map<number, (error: Error) => void>();
  private lastRequestId = 0;
  private protocolListener: IDisposable | null;

  private readonly _onDidInitialize = new Emitter<void>();
  readonly onDidInitialize = this._onDidInitialize.event;

  constructor(private protocol: IMessagePassingProtocol) {
    this.protocolListener = this.protocol.onMessage((msg) => this.onBuffer(msg));
  }

  getChannel<T extends IChannel>(channelName: string): T {
    return {
      call: (command: string, arg?: any, cancellationToken?: CancellationToken) => {
        if (this.isDisposed) {
          return Promise.reject(new Error("ChannelClient is disposed"));
        }
        return this.requestPromise(channelName, command, arg, cancellationToken);
      },
      listen: (event: string, arg?: any) => {
        if (this.isDisposed) {
          return Event.None;
        }
        return this.requestEvent(channelName, event, arg);
      },
    } as T;
  }

  private requestPromise(
    channelName: string,
    name: string,
    arg?: any,
    cancellationToken = CancellationToken.None,
  ): Promise<any> {
    const id = this.lastRequestId++;

    if (cancellationToken.isCancellationRequested) {
      return Promise.reject(new Error("Cancelled"));
    }

    let disposable: IDisposable | undefined;
    const result = new Promise<any>((resolve, reject) => {
      this.pendingRejections.set(id, reject);
      const doRequest = () => {
        // dispose/cancel 可能发生在 Initialize 之前；此时不能再把已经 rejected
        // 的请求发送到新连接或已终结的传输上。
        if (this.isDisposed || !this.pendingRejections.has(id)) {
          return;
        }

        const handler: IHandler = (response) => {
          switch (response.type) {
            case ResponseType.PromiseSuccess:
              this.handlers.delete(id);
              this.pendingRejections.delete(id);
              resolve(response.data);
              return;
            case ResponseType.PromiseError: {
              this.handlers.delete(id);
              this.pendingRejections.delete(id);
              const error = new Error(response.data.message) as Error & Record<string, unknown>;
              error.name = response.data.name;
              if (response.data.stack) {
                error.stack = response.data.stack.join("\n");
              }
              const passthroughKeys = [
                "code",
                "kind",
                "status",
                "retryAfterMs",
                "data",
                "detail",
                "details",
                "taskId",
                "traceId",
              ] as const;
              for (const key of passthroughKeys) {
                const value = response.data[key];
                if (value !== undefined) {
                  error[key] = value;
                }
              }
              reject(error);
              return;
            }
            case ResponseType.PromiseErrorObj:
              this.handlers.delete(id);
              this.pendingRejections.delete(id);
              reject(response.data);
              return;
          }
        };

        this.handlers.set(id, handler);
        this.sendRequest(RequestType.Promise, id, channelName, name, arg);
      };

      if (this.state === State.Idle) {
        doRequest();
      } else {
        this.whenInitialized().then(doRequest);
      }

      disposable = cancellationToken.onCancellationRequested(() => {
        if (!this.pendingRejections.has(id)) {
          return;
        }
        this.sendCancelOrDispose(RequestType.PromiseCancel, id);
        this.handlers.delete(id);
        this.pendingRejections.delete(id);
        reject(new Error("Cancelled"));
      });
      this.activeRequests.add(disposable);
    });

    return result.finally(() => {
      disposable?.dispose();
      if (disposable) {
        this.activeRequests.delete(disposable);
      }
    });
  }

  private requestEvent(channelName: string, name: string, arg?: any): Event<any> {
    const id = this.lastRequestId++;
    const emitter = new Emitter<any>({
      onWillAddFirstListener: () => {
        const doRequest = () => {
          this.activeRequests.add(emitter);
          this.sendRequest(RequestType.EventListen, id, channelName, name, arg);
        };

        if (this.state === State.Idle) {
          doRequest();
        } else {
          this.whenInitialized().then(doRequest);
        }
      },
      onDidRemoveLastListener: () => {
        this.activeRequests.delete(emitter);
        this.sendCancelOrDispose(RequestType.EventDispose, id);
        this.handlers.delete(id);
      },
    });

    this.handlers.set(id, (response) => {
      emitter.fire((response as { data: any }).data);
    });

    return emitter.event;
  }

  private sendRequest(
    type: RequestType,
    id: number,
    channelName: string,
    name: string,
    arg?: any,
  ): void {
    const writer = new BufferWriter();
    serialize(writer, [type, id, channelName, name]);
    serialize(writer, arg);
    try {
      this.protocol.send(writer.buffer);
    } catch {
      /* noop */
    }
  }

  private sendCancelOrDispose(
    type: RequestType.PromiseCancel | RequestType.EventDispose,
    id: number,
  ): void {
    const writer = new BufferWriter();
    serialize(writer, [type, id]);
    serialize(writer, undefined);
    try {
      this.protocol.send(writer.buffer);
    } catch {
      /* noop */
    }
  }

  private onBuffer(message: VSBuffer): void {
    const reader = new BufferReader(message);
    const header = deserialize(reader);
    const body = deserialize(reader);
    const type = header[0] as ResponseType;

    switch (type) {
      case ResponseType.Initialize:
        this.onResponse({ type: ResponseType.Initialize });
        return;
      case ResponseType.PromiseSuccess:
      case ResponseType.PromiseError:
      case ResponseType.EventFire:
      case ResponseType.PromiseErrorObj:
        this.onResponse({
          type,
          id: header[1],
          data: body,
        } as IRawResponse);
        return;
    }
  }

  private onResponse(response: IRawResponse): void {
    if (response.type === ResponseType.Initialize) {
      this.state = State.Idle;
      this._onDidInitialize.fire();
      return;
    }

    this.handlers.get(response.id)?.(response);
  }

  private whenInitialized(): Promise<void> {
    if (this.state === State.Idle) {
      return Promise.resolve();
    }
    return Event.toPromise(this.onDidInitialize);
  }

  dispose(reason?: Error): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    this.protocolListener?.dispose();
    this.protocolListener = null;

    const rejection = reason ?? new Error("ChannelClient disposed");
    if (!reason) {
      rejection.name = "ConnectionClosed";
    }
    // 传输已终结时，所有已发出以及排队等待 Initialize 的 Promise 请求都必须
    // fail-closed。否则上层的 in-flight 去重 Promise 会永久占用 workspace key。
    for (const [id, reject] of this.pendingRejections) {
      this.pendingRejections.delete(id);
      this.handlers.delete(id);
      reject(rejection);
    }
    for (const disposable of this.activeRequests) {
      disposable.dispose();
    }
    this.activeRequests.clear();
    this.pendingRejections.clear();
    this._onDidInitialize.dispose();
  }
}
