/**
 * PersistentProtocol —— 可靠性层（从 protocol.ts 拆出，避免单文件超限）。
 *
 * 在 SocketProtocol 之上添加：
 * - 消息 ACK 确认机制
 * - 心跳保活 (keepAlive)
 * - 断线重连时重放未确认的消息（有界：字节上限 + 时间宽限窗）
 * - 拥塞信号：unacknowledgedBytes 水位 + onSaturated/onDrained
 *   （帧级对事件级的唯一新增接口——事件级据此暂停
 *   drain，丢弃/降级永远发生在通道层、进 rpc 之前；接了 send() 的帧绝不丢）
 *
 * 关键：Channel RPC 层完全不知道 PersistentProtocol 的存在，
 * 它只看到 IMessagePassingProtocol 接口。这就是分层抽象的威力。
 */

import { VSBuffer } from "./buffer.js";
import { Emitter, DisposableStore } from "./foundation.js";
import {
  ChunkStream,
  HEADER_SIZE,
  ProtocolMessage,
  ProtocolMessageType,
  writeProtocolMessage,
  type ConnectionFlowControl,
  type IMessagePassingProtocol,
  type ISocket,
} from "./protocol.js";

/** PersistentProtocol 可调参数（v4 通道层补丁）。 */
export interface PersistentProtocolOptions {
  /** 未 ACK 字节高水位：越过即 onSaturated（上层暂停 drain，让 coalesce 吸收）。 */
  saturationHighWaterMarkBytes?: number;
  /** 未 ACK 字节低水位：饱和后回落至此即 onDrained（上层恢复 drain）。 */
  saturationLowWaterMarkBytes?: number;
  /** 重放缓冲字节上限：越界 = 放弃协议会话（onClose），客户端走 subscribe(base)。 */
  replayBufferMaxBytes?: number;
  /** 重放缓冲时间宽限窗（ms）：最老未 ACK 消息超龄同样放弃会话。 */
  replayBufferGraceMs?: number;
}

interface UnackEntry {
  msg: ProtocolMessage;
  queuedAt: number;
}

export class PersistentProtocol implements IMessagePassingProtocol, ConnectionFlowControl {
  private readonly _onMessage = new Emitter<VSBuffer>();
  readonly onMessage = this._onMessage.event;

  private readonly _onClose = new Emitter<void>();
  readonly onClose = this._onClose.event;

  private readonly _onSocketClose = new Emitter<void>();
  readonly onSocketClose = this._onSocketClose.event;

  // 拥塞信号：高水位进入饱和 → onSaturated；回落低水位 → onDrained。
  private readonly _onSaturated = new Emitter<void>();
  readonly onSaturated = this._onSaturated.event;

  private readonly _onDrained = new Emitter<void>();
  readonly onDrained = this._onDrained.event;

  private socket: ISocket;
  private chunkStream = new ChunkStream();
  private disposables = new DisposableStore();

  // ACK 机制（队列有界化，条目携带入队时间用于宽限窗判定）
  private outgoingMsgId = 0;
  private outgoingUnackMsg: UnackEntry[] = [];
  private incomingAckId = 0;
  private unackBytes = 0;
  private saturated = false;
  private overflowed = false;

  // 心跳
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private readonly KEEP_ALIVE_INTERVAL = 5000; // 5 秒

  // ACK 超时
  private ackCheckTimer: ReturnType<typeof setInterval> | null = null;
  private readonly ACK_TIMEOUT = 20000; // 20 秒无 ACK 则断开
  private lastAckTime = Date.now();

  // 水位/上限默认值：高水位 1MiB（≈ v4 单帧上限），低水位取高水位 1/4；
  // 重放缓冲 8MiB / 45s——对端锁屏或长期不 ACK 时放弃会话而不是无界堆内存。
  private readonly saturationHighWaterMarkBytes: number;
  private readonly saturationLowWaterMarkBytes: number;
  private readonly replayBufferMaxBytes: number;
  private readonly replayBufferGraceMs: number;

  constructor(socket: ISocket, options: PersistentProtocolOptions = {}) {
    this.saturationHighWaterMarkBytes = options.saturationHighWaterMarkBytes ?? 1024 * 1024;
    this.saturationLowWaterMarkBytes =
      options.saturationLowWaterMarkBytes ?? Math.floor(this.saturationHighWaterMarkBytes / 4);
    this.replayBufferMaxBytes = options.replayBufferMaxBytes ?? 8 * 1024 * 1024;
    this.replayBufferGraceMs = options.replayBufferGraceMs ?? 45_000;
    this.socket = socket;
    this.bindSocket();
    this.startKeepAlive();
    this.startAckCheck();
  }

  /** 当前未被对端 ACK 的 payload 字节数（只读拥塞观测点）。 */
  get unacknowledgedBytes(): number {
    return this.unackBytes;
  }

  private bindSocket(): void {
    this.disposables.add(
      this.socket.onData((data) => {
        this.chunkStream.acceptChunk(data);
        this.readMessages();
      }),
    );

    this.disposables.add(
      this.socket.onClose(() => {
        this._onSocketClose.fire();
      }),
    );
  }

  send(buffer: VSBuffer): void {
    const msg = new ProtocolMessage(
      ProtocolMessageType.Regular,
      ++this.outgoingMsgId,
      this.incomingAckId,
      buffer,
    );
    this.outgoingUnackMsg.push({ msg, queuedAt: Date.now() });
    this.unackBytes += buffer.byteLength;
    this.writeMessage(msg);
    // 重放缓冲字节越界 → 立即放弃会话（同步判定，不等定时器）。
    if (this.unackBytes > this.replayBufferMaxBytes) {
      this.abandonSession();
      return;
    }
    // 越过高水位进入饱和态（边沿触发，不重复通知）。
    if (!this.saturated && this.unackBytes > this.saturationHighWaterMarkBytes) {
      this.saturated = true;
      this._onSaturated.fire();
    }
  }

  /**
   * 重连时替换底层 socket，并重放所有未被确认的消息。
   * 这就是为什么 Remote 模式断线恢复后不丢消息的原因。
   */
  replaceSocket(newSocket: ISocket): void {
    this.disposables.dispose();
    this.disposables = new DisposableStore();
    this.chunkStream = new ChunkStream();
    this.socket = newSocket;
    this.bindSocket();

    // 重放未确认的消息
    for (const entry of this.outgoingUnackMsg) {
      this.writeMessage(entry.msg);
    }
  }

  private writeMessage(msg: ProtocolMessage): void {
    this.socket.write(writeProtocolMessage(msg));
  }

  private readMessages(): void {
    while (true) {
      if (this.chunkStream.byteLength < HEADER_SIZE) {
        break;
      }

      const header = this.chunkStream.peek(HEADER_SIZE);
      if (!header) {
        break;
      }

      const type = header.readUInt8(0) as ProtocolMessageType;
      const id = header.readUInt32BE(1);
      const ack = header.readUInt32BE(5);
      const length = header.readUInt32BE(9);

      const totalFrameLength = HEADER_SIZE + length;
      if (this.chunkStream.byteLength < totalFrameLength) {
        // PersistentProtocol 和 SocketProtocol 都跑在流式传输上，
        // 这里同样要等整帧到齐后再消费 header，避免分片时把消息头吃掉。
        break;
      }

      this.chunkStream.skip(HEADER_SIZE);

      let body = VSBuffer.alloc(0);
      if (length > 0) {
        const readBody = this.chunkStream.read(length);
        if (!readBody) {
          throw new Error("PersistentProtocol 读取到完整帧长度后 body 不应为空");
        }
        body = readBody;
      }

      // 处理对方的 ACK：清除已确认的发送队列
      this.processAck(ack);

      switch (type) {
        case ProtocolMessageType.Regular:
          this.incomingAckId = id;
          this._onMessage.fire(body);
          break;
        case ProtocolMessageType.Ack:
          // 纯 ACK 消息，只更新确认号
          break;
        case ProtocolMessageType.KeepAlive:
          // 心跳，只需更新最后活跃时间
          break;
        case ProtocolMessageType.Disconnect:
          this._onClose.fire();
          break;
      }

      this.lastAckTime = Date.now();
    }
  }

  /** 根据对方的 ACK 号清除已确认的消息 */
  private processAck(ack: number): void {
    while (this.outgoingUnackMsg.length > 0 && this.outgoingUnackMsg[0].msg.id <= ack) {
      const entry = this.outgoingUnackMsg.shift()!;
      this.unackBytes -= entry.msg.data.byteLength;
    }
    // 饱和后回落到低水位 → onDrained（边沿触发）。
    if (this.saturated && this.unackBytes <= this.saturationLowWaterMarkBytes) {
      this.saturated = false;
      this._onDrained.fire();
    }
  }

  /**
   * 重放缓冲越界（字节/宽限窗）：这条协议会话已不可能无损续传，
   * 主动断开走 onClose，客户端用 subscribe(base) 语义层恢复。
   */
  private abandonSession(): void {
    if (this.overflowed) {
      return;
    }
    this.overflowed = true;
    this.writeMessage(
      new ProtocolMessage(ProtocolMessageType.Disconnect, 0, this.incomingAckId, VSBuffer.alloc(0)),
    );
    this._onClose.fire();
  }

  private startKeepAlive(): void {
    this.keepAliveTimer = setInterval(() => {
      this.writeMessage(
        new ProtocolMessage(
          ProtocolMessageType.KeepAlive,
          0,
          this.incomingAckId,
          VSBuffer.alloc(0),
        ),
      );
    }, this.KEEP_ALIVE_INTERVAL);
  }

  private startAckCheck(): void {
    this.ackCheckTimer = setInterval(() => {
      if (this.outgoingUnackMsg.length > 0 && Date.now() - this.lastAckTime > this.ACK_TIMEOUT) {
        this._onSocketClose.fire();
      }
      // 最老未 ACK 消息超过宽限窗（对端锁屏/长期后台）→ 放弃会话。
      const oldest = this.outgoingUnackMsg[0];
      if (oldest && Date.now() - oldest.queuedAt > this.replayBufferGraceMs) {
        this.abandonSession();
      }
    }, this.ACK_TIMEOUT);
  }

  async drain(): Promise<void> {
    return this.socket.drain();
  }

  dispose(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
    }
    if (this.ackCheckTimer) {
      clearInterval(this.ackCheckTimer);
    }
    this.disposables.dispose();
    this._onMessage.dispose();
    this._onClose.dispose();
    this._onSocketClose.dispose();
    this._onSaturated.dispose();
    this._onDrained.dispose();
    this.socket.dispose();
  }
}
