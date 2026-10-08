/**
 * Layer 2: 传输协议抽象
 *
 * IMessagePassingProtocol 是整个 IPC 框架的"腰部"——
 * 它上面是 Channel RPC 层（完全传输无关），
 * 它下面是各种具体传输实现（Electron/MessagePort/Socket/ChildProcess）。
 *
 * 只要实现 send() 和 onMessage，就能接入整个 RPC 框架。
 */

import { VSBuffer } from "./buffer.js";
import { Event, Emitter, IDisposable, DisposableStore } from "./foundation.js";

// ============================================================================
// 核心传输接口
// ============================================================================

/**
 * IMessagePassingProtocol —— 整个框架的核心抽象
 *
 * 这就是 VS Code 通信能力的秘密：上层代码只看到 send/onMessage，
 * 不管底层是 Electron IPC、MessagePort、WebSocket 还是 TCP Socket。
 */
export interface IMessagePassingProtocol {
  send(buffer: VSBuffer): void;
  readonly onMessage: Event<VSBuffer>;
  drain?(): Promise<void>;
}

/**
 * 连接级只读流控观察面。
 *
 * transport 负责维护未确认字节与状态边沿；业务层只能订阅，不能伪造 ACK 或直接改水位。
 */
export interface ConnectionFlowControl {
  readonly unacknowledgedBytes: number;
  readonly onSaturated: Event<void>;
  readonly onDrained: Event<void>;
}

export type MessagePortFlowState = "saturated" | "drained";

export interface MessagePortFlowControl {
  __zcodeRpcControl: "connection-flow-v1";
  state: MessagePortFlowState;
}

export type MessagePortPayload = Uint8Array | MessagePortFlowControl;

function isMessagePortFlowControl(value: unknown): value is MessagePortFlowControl {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    record.__zcodeRpcControl === "connection-flow-v1" &&
    (record.state === "saturated" || record.state === "drained")
  );
}

// ============================================================================
// Socket 接口（用于 TCP/WebSocket 等流式传输）
// ============================================================================

/**
 * ISocket 抽象了底层的网络 socket。
 * 在 Node.js 环境是 net.Socket，在浏览器环境是 WebSocket。
 */
export interface ISocket extends IDisposable {
  onData: Event<VSBuffer>;
  onClose: Event<void>;
  onEnd: Event<void>;
  write(buffer: VSBuffer): void;
  end(): void;
  drain(): Promise<void>;
}

// ============================================================================
// ChunkStream —— 处理 TCP 的分片和粘包
// ============================================================================

/**
 * TCP 是流式协议，一次 write 不代表对面一次 read 就能完整收到。
 * ChunkStream 把收到的碎片攒起来，按需读取指定字节数。
 */
export class ChunkStream {
  private chunks: VSBuffer[] = [];
  private totalLength = 0;

  get byteLength(): number {
    return this.totalLength;
  }

  acceptChunk(chunk: VSBuffer): void {
    this.chunks.push(chunk);
    this.totalLength += chunk.byteLength;
  }

  /**
   * 预览前 byteCount 字节，但不消费底层缓冲。
   *
   * Socket/stdio 传输天然可能分片。
   * 之前协议层在 body 还没收全时就先把 header read 掉，后续再来的 body
   * 会失去对应的帧头，导致消息永远卡住。这里提供 peek，让调用方先判断
   * “整帧是否已经到齐”，确认足够后再真正消费。
   */
  peek(byteCount: number): VSBuffer | null {
    if (this.totalLength < byteCount) {
      return null;
    }

    if (this.chunks[0].byteLength >= byteCount) {
      return this.chunks[0].slice(0, byteCount);
    }

    const result = VSBuffer.alloc(byteCount);
    let offset = 0;
    for (const chunk of this.chunks) {
      if (offset >= byteCount) {
        break;
      }

      const remaining = byteCount - offset;
      const copyLength = Math.min(chunk.byteLength, remaining);
      result.set(copyLength === chunk.byteLength ? chunk : chunk.slice(0, copyLength), offset);
      offset += copyLength;
    }

    return result;
  }

  /** 丢弃前 byteCount 字节 */
  skip(byteCount: number): void {
    const discarded = this.read(byteCount);
    if (!discarded) {
      throw new Error(`ChunkStream.skip(${byteCount}) 超出可读范围`);
    }
  }

  /** 读取 byteCount 字节，不够就返回 null */
  read(byteCount: number): VSBuffer | null {
    if (this.totalLength < byteCount) {
      return null;
    }

    if (this.chunks[0].byteLength === byteCount) {
      const result = this.chunks.shift()!;
      this.totalLength -= byteCount;
      return result;
    }

    if (this.chunks[0].byteLength > byteCount) {
      const result = this.chunks[0].slice(0, byteCount);
      this.chunks[0] = this.chunks[0].slice(byteCount);
      this.totalLength -= byteCount;
      return result;
    }

    // 需要跨多个 chunk 拼接
    const result = VSBuffer.alloc(byteCount);
    let offset = 0;
    while (offset < byteCount) {
      const chunk = this.chunks[0];
      const needed = byteCount - offset;
      if (chunk.byteLength <= needed) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
        this.chunks.shift();
      } else {
        result.set(chunk.slice(0, needed), offset);
        this.chunks[0] = chunk.slice(needed);
        offset += needed;
      }
    }
    this.totalLength -= byteCount;
    return result;
  }
}

// ============================================================================
// Protocol —— 在 ISocket 上实现 IMessagePassingProtocol
// ============================================================================

/**
 * 消息帧格式 (13 bytes header):
 *
 * ┌─────────┬──────────┬──────────┬──────────────┐
 * │ type(1) │  id(4)   │  ack(4)  │  length(4)   │
 * └─────────┴──────────┴──────────┴──────────────┘
 *
 * type:   消息类型（Regular, Ack, KeepAlive 等）
 * id:     消息序号
 * ack:    确认号（告诉对方"我已收到你的消息到第 ack 号"）
 * length: payload 长度
 */
export enum ProtocolMessageType {
  None = 0,
  Regular = 1,
  Control = 2,
  Ack = 3,
  Disconnect = 5,
  ReplayRequest = 6,
  Pause = 7,
  Resume = 8,
  KeepAlive = 9,
}

export const HEADER_SIZE = 13; // 1 + 4 + 4 + 4

export class ProtocolMessage {
  constructor(
    public readonly type: ProtocolMessageType,
    public readonly id: number,
    public readonly ack: number,
    public readonly data: VSBuffer,
  ) {}

  get byteLength(): number {
    return HEADER_SIZE + this.data.byteLength;
  }
}

export function writeProtocolMessage(msg: ProtocolMessage): VSBuffer {
  const result = VSBuffer.alloc(HEADER_SIZE + msg.data.byteLength);
  result.writeUInt8(msg.type, 0);
  result.writeUInt32BE(msg.id, 1);
  result.writeUInt32BE(msg.ack, 5);
  result.writeUInt32BE(msg.data.byteLength, 9);
  result.set(msg.data, HEADER_SIZE);
  return result;
}

/**
 * 基础 Protocol: 在 ISocket 上加消息帧，实现 IMessagePassingProtocol。
 * 只做消息分帧，不做 ACK/重连（那是 PersistentProtocol 的事）。
 */
export class SocketProtocol implements IMessagePassingProtocol {
  private readonly _onMessage = new Emitter<VSBuffer>();
  readonly onMessage = this._onMessage.event;

  private readonly chunkStream = new ChunkStream();
  private readonly disposables = new DisposableStore();

  constructor(private socket: ISocket) {
    this.disposables.add(
      socket.onData((data) => {
        this.chunkStream.acceptChunk(data);
        this.readMessages();
      }),
    );
  }

  send(buffer: VSBuffer): void {
    this.writeMessage(new ProtocolMessage(ProtocolMessageType.Regular, 0, 0, buffer));
  }

  private writeMessage(msg: ProtocolMessage): void {
    this.socket.write(writeProtocolMessage(msg));
  }

  private readMessages(): void {
    while (true) {
      const header = this.chunkStream.peek(HEADER_SIZE);
      if (!header) {
        break;
      }

      const type = header.readUInt8(0) as ProtocolMessageType;
      const _id = header.readUInt32BE(1);
      const _ack = header.readUInt32BE(5);
      const length = header.readUInt32BE(9);

      const totalFrameLength = HEADER_SIZE + length;
      if (this.chunkStream.byteLength < totalFrameLength) {
        // 不能在 body 未到齐时提前消费 header，否则下一段数据拼上来后
        // 已经找不到这帧的长度信息，调用方就会一直等待一个永远不会完成的 Promise。
        break;
      }

      this.chunkStream.skip(HEADER_SIZE);

      if (length === 0) {
        if (type === ProtocolMessageType.Regular) {
          this._onMessage.fire(VSBuffer.alloc(0));
        }
        continue;
      }

      const body = this.chunkStream.read(length);
      if (!body) {
        throw new Error("SocketProtocol 读取到完整帧长度后 body 不应为空");
      }

      if (type === ProtocolMessageType.Regular) {
        this._onMessage.fire(body);
      }
    }
  }

  async drain(): Promise<void> {
    return this.socket.drain();
  }

  dispose(): void {
    this.disposables.dispose();
    this._onMessage.dispose();
  }
}

// ============================================================================
// QueueProtocol —— 内存中的协议对，用于测试
// ============================================================================

/**
 * 创建一对通过内存队列连接的 protocol，
 * 一端 send 的消息会出现在另一端的 onMessage。
 * 非常适合单元测试，不需要真正的网络连接。
 */
export function createQueuePair(): [IMessagePassingProtocol, IMessagePassingProtocol] {
  const emitterA = new Emitter<VSBuffer>();
  const emitterB = new Emitter<VSBuffer>();

  const protocolA: IMessagePassingProtocol = {
    send: (buffer: VSBuffer) => {
      // A 发送的消息 → B 收到
      setTimeout(() => emitterB.fire(buffer), 0);
    },
    onMessage: emitterA.event,
  };

  const protocolB: IMessagePassingProtocol = {
    send: (buffer: VSBuffer) => {
      // B 发送的消息 → A 收到
      setTimeout(() => emitterA.fire(buffer), 0);
    },
    onMessage: emitterB.event,
  };

  return [protocolA, protocolB];
}

// ============================================================================
// MessagePort Protocol —— 用于 Web Worker / Electron sandbox
// ============================================================================

/**
 * MessagePort 接口的最小声明，
 * 使得这个 Protocol 可以同时在浏览器和 Electron 中使用。
 */
export interface MessagePortLike {
  addEventListener(type: "message", listener: (e: { data: MessagePortPayload }) => void): void;
  removeEventListener(type: "message", listener: (e: { data: MessagePortPayload }) => void): void;
  postMessage(message: MessagePortPayload): void;
  start(): void;
  close(): void;
}

/**
 * 在 MessagePort 上实现 IMessagePassingProtocol。
 * 这是最简单的传输实现——不需要分帧，因为 MessagePort 本身就是消息边界的。
 */
export class MessagePortProtocol implements IMessagePassingProtocol {
  private readonly _onMessage = new Emitter<VSBuffer>();
  readonly onMessage = this._onMessage.event;
  private readonly _onFlowState = new Emitter<MessagePortFlowState>();
  readonly onFlowState = this._onFlowState.event;

  private readonly handler: (e: { data: MessagePortPayload }) => void;

  constructor(private port: MessagePortLike) {
    this.handler = (e: { data: MessagePortPayload }) => {
      if (isMessagePortFlowControl(e.data)) {
        this._onFlowState.fire(e.data.state);
        return;
      }
      // MessagePort control object 不能进入 Channel deserialize；未知对象和伪造
      // connection-flow-v1 一律丢弃，只有真实 Uint8Array 才是 RPC binary。
      if (e.data instanceof Uint8Array) this._onMessage.fire(VSBuffer.wrap(e.data));
    };
    this.port.addEventListener("message", this.handler);
    this.port.start();
  }

  send(buffer: VSBuffer): void {
    this.port.postMessage(buffer.buffer);
  }

  sendFlowState(state: MessagePortFlowState): void {
    this.port.postMessage({ __zcodeRpcControl: "connection-flow-v1", state });
  }

  disconnect(): void {
    this.port.removeEventListener("message", this.handler);
    this.port.close();
    this._onMessage.dispose();
    this._onFlowState.dispose();
  }
}
