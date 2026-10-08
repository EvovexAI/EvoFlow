// V4 physical wire encoder：按调用方真实 JSON/RPC envelope 计量，logical frame
// 超过物理上限时只在 UTF-8 bytes 层分片，不改变 seq/apply 语义。
import { PROTOCOL_V4_LIMITS, V4_WIRE_PROTOCOL_VERSION } from "./core.js";
import { crc32WireBytes, encodeWireBytesBase64 } from "./wire-binary.js";
import type {
  TopicFrameDeliveryKind,
  TopicWireChecksum,
  TopicWireFrame,
  TopicWireFrameCandidate,
} from "./wire.js";

const CHANNEL_EVENT_RESPONSE_TYPE = 204;
const SOCKET_PROTOCOL_HEADER_BYTES = 13;

function vqlByteLength(value: number): number {
  let bytes = 1;
  for (let remaining = value >>> 7; remaining > 0; remaining >>>= 7) bytes += 1;
  return bytes;
}

/**
 * 按当前生产三层真实承载计量 topic notification。mobile relay
 * 会把 Channel binary 再 base64，不能只测 CLI 的 logical JSON。
 */
export function measureTopicNotificationEnvelopeBytes(wire: TopicWireFrameCandidate): {
  cliNdjsonBytes: number;
  channelSocketBytes: number;
  mobileRelayBytes: number;
  maxBytes: number;
} {
  const cliNdjsonBytes =
    utf8JsonByteLength({
      method: "v4/conversation/frame",
      params: wire,
    }) + 1;

  const wireJsonBytes = utf8JsonByteLength(wire);
  // @zcode/rpc serialization：Array tag+length+[EventFire,id]，再加 Object tag+length+JSON。
  // ChannelClient 的 id 无 31-bit wrap；超过 signed int 后 serialize 会走 Object JSON
  // fallback。因此按 Number.MAX_SAFE_INTEGER 的 16-byte JSON 形态计算最坏 header。
  const maxEventIdJsonBytes = String(Number.MAX_SAFE_INTEGER).length;
  const maxEventIdSerializedBytes = 1 + vqlByteLength(maxEventIdJsonBytes) + maxEventIdJsonBytes;
  const channelHeaderBytes =
    1 +
    vqlByteLength(2) +
    1 +
    vqlByteLength(CHANNEL_EVENT_RESPONSE_TYPE) +
    maxEventIdSerializedBytes;
  const channelPayloadBytes = channelHeaderBytes + 1 + vqlByteLength(wireJsonBytes) + wireJsonBytes;
  // SocketProtocol/PersistentProtocol 在 Channel payload 外再加固定 13-byte frame header。
  const channelSocketBytes = channelPayloadBytes + SOCKET_PROTOCOL_HEADER_BYTES;
  // topic encoder 继续用 legacy 单片 outer 作为保守 logical budget；production 已不发送该形态，
  // Channel payload 会再经 acknowledged raw adapter 独立分片并按最终 JSON 精确计量。
  // 两层预算分别约束 topic logical frame 与 relay physical frame，不能互相替代。
  const dataBase64Bytes = 4 * Math.ceil(channelPayloadBytes / 3);
  const transportId = "x".repeat(PROTOCOL_V4_LIMITS.transportEnvelopeIdMaxChars);
  const mobileRelayFixedBytes = utf8JsonByteLength({
    type: "data",
    payload: {
      zcode_type: "rpc-frame",
      bridgeSessionId: transportId,
      bridgeGeneration: Number.MAX_SAFE_INTEGER,
      recoveryId: transportId,
      seq: Number.MAX_SAFE_INTEGER,
      dataBase64: "",
    },
    client_ts: Number.MAX_SAFE_INTEGER,
    server_ts: Number.MAX_SAFE_INTEGER,
  });
  const mobileRelayBytes = mobileRelayFixedBytes + dataBase64Bytes;
  return {
    cliNdjsonBytes,
    channelSocketBytes,
    mobileRelayBytes,
    maxBytes: Math.max(cliNdjsonBytes, channelSocketBytes, mobileRelayBytes),
  };
}

export function utf8JsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export class TopicWireFrameEncodingError extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
    this.name = "TopicWireFrameEncodingError";
  }
}

function hardBound(value: number | undefined, maximum: number, name: string): number {
  const resolved = value ?? maximum;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new TopicWireFrameEncodingError(`proto.invalidLimit.${name}`);
  }
  return Math.min(Math.floor(resolved), maximum);
}

export interface EncodeTopicWireFramesOptions<F> {
  deliveryKind: TopicFrameDeliveryKind;
  topic: string;
  subscriptionId: string;
  logicalFrameId: string;
  logicalFrameOrdinal: number;
  maxPhysicalFrameBytes?: number;
  maxAssemblyBytes?: number;
  measurePhysicalFrameBytes(wire: TopicWireFrame<F>): number;
}

function makeFragment<F>(params: {
  options: EncodeTopicWireFramesOptions<F>;
  fragmentIndex: number;
  fragmentCount: number;
  logicalBytes: number;
  checksum: TopicWireChecksum;
  dataBase64: string;
}): TopicWireFrame<F> {
  return {
    wireVersion: V4_WIRE_PROTOCOL_VERSION,
    kind: "fragment",
    deliveryKind: params.options.deliveryKind,
    logicalFrameId: params.options.logicalFrameId,
    logicalFrameOrdinal: params.options.logicalFrameOrdinal,
    topic: params.options.topic,
    subscriptionId: params.options.subscriptionId,
    fragmentIndex: params.fragmentIndex,
    fragmentCount: params.fragmentCount,
    logicalBytes: params.logicalBytes,
    checksum: params.checksum,
    dataBase64: params.dataBase64,
  };
}

function findFragmentByteBudget<F>(params: {
  options: EncodeTopicWireFramesOptions<F>;
  logicalBytes: number;
  checksum: TopicWireChecksum;
  maxPhysicalFrameBytes: number;
}): number {
  let low = 1;
  let high = Math.min(params.logicalBytes, params.maxPhysicalFrameBytes);
  let best = 0;
  // 使用最坏索引位数测量，实际 fragment 的 envelope 只会更小。
  const worstCount = params.logicalBytes;
  while (low <= high) {
    const candidate = Math.floor((low + high) / 2);
    const dataBase64 = "A".repeat(4 * Math.ceil(candidate / 3));
    const wire = makeFragment({
      options: params.options,
      fragmentIndex: Math.max(0, worstCount - 1),
      fragmentCount: worstCount,
      logicalBytes: params.logicalBytes,
      checksum: params.checksum,
      dataBase64,
    });
    if (params.options.measurePhysicalFrameBytes(wire) <= params.maxPhysicalFrameBytes) {
      best = candidate;
      low = candidate + 1;
    } else {
      high = candidate - 1;
    }
  }
  return best;
}

export function encodeTopicWireFrames<F>(
  frame: F,
  options: EncodeTopicWireFramesOptions<F>,
): TopicWireFrame<F>[] {
  const maxPhysicalFrameBytes = hardBound(
    options.maxPhysicalFrameBytes,
    PROTOCOL_V4_LIMITS.maxFrameBytes,
    "maxPhysicalFrameBytes",
  );
  const maxAssemblyBytes = hardBound(
    options.maxAssemblyBytes,
    PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes,
    "maxAssemblyBytes",
  );
  const logical = encodeJson(frame);
  if (logical.byteLength > maxAssemblyBytes) {
    throw new TopicWireFrameEncodingError("proto.frameAssemblyTooLarge");
  }

  const complete: TopicWireFrame<F> = {
    wireVersion: V4_WIRE_PROTOCOL_VERSION,
    kind: "complete",
    deliveryKind: options.deliveryKind,
    logicalFrameId: options.logicalFrameId,
    logicalFrameOrdinal: options.logicalFrameOrdinal,
    topic: options.topic,
    subscriptionId: options.subscriptionId,
    frame,
  };
  if (options.measurePhysicalFrameBytes(complete) <= maxPhysicalFrameBytes) {
    return [complete];
  }

  const checksum: TopicWireChecksum = {
    algorithm: "crc32",
    value: crc32WireBytes(logical),
  };
  const chunkBytes = findFragmentByteBudget({
    options,
    logicalBytes: logical.byteLength,
    checksum,
    maxPhysicalFrameBytes,
  });
  if (chunkBytes < 1) {
    throw new TopicWireFrameEncodingError("proto.frameEnvelopeTooLarge");
  }
  const fragmentCount = Math.ceil(logical.byteLength / chunkBytes);
  if (fragmentCount > PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxFragments) {
    throw new TopicWireFrameEncodingError("proto.frameFragmentCountExceeded");
  }

  const frames: TopicWireFrame<F>[] = [];
  for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex += 1) {
    const start = fragmentIndex * chunkBytes;
    const end = Math.min(start + chunkBytes, logical.byteLength);
    const wire = makeFragment({
      options,
      fragmentIndex,
      fragmentCount,
      logicalBytes: logical.byteLength,
      checksum,
      dataBase64: encodeWireBytesBase64(logical.subarray(start, end)),
    });
    if (options.measurePhysicalFrameBytes(wire) > maxPhysicalFrameBytes) {
      // physical 上限包含调用方真实 envelope；任何估算漂移都必须
      // fail closed，不能把超限 frame 交给下游再静默截断。
      throw new TopicWireFrameEncodingError("proto.frameEnvelopeTooLarge");
    }
    frames.push(wire);
  }
  return frames;
}
