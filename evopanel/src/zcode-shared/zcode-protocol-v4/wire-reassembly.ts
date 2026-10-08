// V4 physical wire reassembly：所有 fragment 只进入 staging；bytes、checksum、
// UTF-8、JSON 与 schema 全部通过后，才产出一个可原子 apply 的 logical frame。
import { z } from "zod";
import { PROTOCOL_V4_LIMITS } from "./core.js";
import { crc32WireBytes, decodeWireBase64 } from "./wire-binary.js";
import type { TopicFrameDeliveryKind, TopicWireFrame } from "./wire.js";
import { WIRE_FAULT_INVALID_PAYLOAD } from "./wire-fault.js";

export type ReassembleTopicWireFramesResult<F> =
  | { kind: "complete"; frame: F; deliveryKind: TopicFrameDeliveryKind }
  | {
      kind: "incomplete";
      logicalFrameId: string;
      missingIndexes: number[];
    }
  | { kind: "rejected"; reasonCode: string };

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function frameMatchesEnvelope(
  frame: unknown,
  wire: { topic: string; subscriptionId: string },
): boolean {
  if (typeof frame !== "object" || frame === null) return false;
  const record = frame as { topic?: unknown; subscriptionId?: unknown };
  return record.topic === wire.topic && record.subscriptionId === wire.subscriptionId;
}

export function reassembleTopicWireFrames<F>(
  wires: readonly TopicWireFrame<unknown>[],
  frameSchema: z.ZodType<F>,
  options: { maxAssemblyBytes?: number } = {},
): ReassembleTopicWireFramesResult<F> {
  if (wires.length === 0) {
    return { kind: "rejected", reasonCode: "proto.frameAssemblyEmpty" };
  }
  const first = wires[0]!;
  const requestedMaxAssemblyBytes =
    options.maxAssemblyBytes ?? PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes;
  if (!Number.isFinite(requestedMaxAssemblyBytes) || requestedMaxAssemblyBytes <= 0) {
    return { kind: "rejected", reasonCode: "proto.invalidLimit.maxAssemblyBytes" };
  }
  const maxAssemblyBytes = Math.min(
    Math.floor(requestedMaxAssemblyBytes),
    PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes,
  );

  if (first.kind === "complete") {
    if (wires.length !== 1 || !frameMatchesEnvelope(first.frame, first)) {
      return {
        kind: "rejected",
        reasonCode: "proto.frameAssemblyMetadataMismatch",
      };
    }
    if (encodeJson(first.frame).byteLength > maxAssemblyBytes) {
      // complete 与 fragment 是同一个 logical frame 的两种物理
      // 承载，只限制 fragment 会允许接收端绕过 16 MiB 权威状态上限。
      return {
        kind: "rejected",
        reasonCode: "proto.frameAssemblyTooLarge",
      };
    }
    const parsed = frameSchema.safeParse(first.frame);
    return parsed.success
      ? { kind: "complete", frame: parsed.data, deliveryKind: first.deliveryKind }
      : { kind: "rejected", reasonCode: WIRE_FAULT_INVALID_PAYLOAD };
  }

  if (first.fragmentCount > PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxFragments) {
    // fragmentCount 曾只受 logicalBytes 约束，恶意元数据可在
    // 缺片路径制造千万级 missingIndexes，先用协议硬上限阻断无界分配。
    return {
      kind: "rejected",
      reasonCode: "proto.frameFragmentCountExceeded",
    };
  }
  if (first.logicalBytes > maxAssemblyBytes) {
    return {
      kind: "rejected",
      reasonCode: "proto.frameAssemblyTooLarge",
    };
  }

  const fragments = new Map<number, Uint8Array>();
  let decodedByteTotal = 0;
  for (const wire of wires) {
    if (
      wire.kind !== "fragment" ||
      wire.logicalFrameId !== first.logicalFrameId ||
      wire.logicalFrameOrdinal !== first.logicalFrameOrdinal ||
      wire.deliveryKind !== first.deliveryKind ||
      wire.topic !== first.topic ||
      wire.subscriptionId !== first.subscriptionId ||
      wire.fragmentCount !== first.fragmentCount ||
      wire.logicalBytes !== first.logicalBytes ||
      wire.checksum.algorithm !== first.checksum.algorithm ||
      wire.checksum.value !== first.checksum.value ||
      wire.fragmentCount > wire.logicalBytes ||
      wire.fragmentIndex < 0 ||
      wire.fragmentIndex >= wire.fragmentCount
    ) {
      return {
        kind: "rejected",
        reasonCode: "proto.frameAssemblyMetadataMismatch",
      };
    }
    const decoded = decodeWireBase64(wire.dataBase64);
    if (!decoded) {
      return {
        kind: "rejected",
        reasonCode: "proto.frameAssemblyInvalidBase64",
      };
    }
    const previous = fragments.get(wire.fragmentIndex);
    if (previous) {
      if (
        previous.byteLength !== decoded.byteLength ||
        previous.some((byte, index) => byte !== decoded[index])
      ) {
        return {
          kind: "rejected",
          reasonCode: "proto.frameAssemblyFragmentConflict",
        };
      }
      continue;
    }
    const nextDecodedByteTotal = decodedByteTotal + decoded.byteLength;
    if (nextDecodedByteTotal > maxAssemblyBytes) {
      // 总字节不能到所有分片收齐后才统计；每接纳一片就
      // 检查，使 staging assembly 的累计内存始终受协议上限约束。
      return {
        kind: "rejected",
        reasonCode: "proto.frameAssemblyTooLarge",
      };
    }
    if (nextDecodedByteTotal > first.logicalBytes) {
      return {
        kind: "rejected",
        reasonCode: "proto.frameAssemblyLengthMismatch",
      };
    }
    fragments.set(wire.fragmentIndex, decoded);
    decodedByteTotal = nextDecodedByteTotal;
  }

  const missingIndexes: number[] = [];
  for (let index = 0; index < first.fragmentCount; index += 1) {
    if (!fragments.has(index)) missingIndexes.push(index);
  }
  if (missingIndexes.length > 0) {
    return {
      kind: "incomplete",
      logicalFrameId: first.logicalFrameId,
      missingIndexes,
    };
  }
  if (decodedByteTotal !== first.logicalBytes) {
    return {
      kind: "rejected",
      reasonCode: "proto.frameAssemblyLengthMismatch",
    };
  }

  const logical = new Uint8Array(decodedByteTotal);
  let offset = 0;
  for (let index = 0; index < first.fragmentCount; index += 1) {
    const fragment = fragments.get(index)!;
    logical.set(fragment, offset);
    offset += fragment.byteLength;
  }
  if (crc32WireBytes(logical) !== first.checksum.value) {
    return {
      kind: "rejected",
      reasonCode: "proto.frameAssemblyChecksumMismatch",
    };
  }

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(logical);
  } catch {
    return {
      kind: "rejected",
      reasonCode: "proto.frameAssemblyInvalidUtf8",
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    return {
      kind: "rejected",
      reasonCode: "proto.frameAssemblyInvalidJson",
    };
  }
  if (!frameMatchesEnvelope(value, first)) {
    return {
      kind: "rejected",
      reasonCode: "proto.frameAssemblyMetadataMismatch",
    };
  }
  const parsed = frameSchema.safeParse(value);
  return parsed.success
    ? { kind: "complete", frame: parsed.data, deliveryKind: first.deliveryKind }
    : { kind: "rejected", reasonCode: WIRE_FAULT_INVALID_PAYLOAD };
}
