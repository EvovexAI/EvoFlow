// V4 physical wire schema：logical topic frame 保持原子 seq 语义，超大帧只在
// UTF-8 byte 层分片。codec/reassembly 纯函数见 wire-codec.ts。
import { z } from "zod";
import { PROTOCOL_V4_LIMITS, V4_WIRE_PROTOCOL_VERSION } from "./core.js";
import { topicWireBase64Schema } from "./wire-binary.js";

export const topicWireChecksumSchema = z
  .object({
    algorithm: z.literal("crc32"),
    value: z.string().regex(/^[0-9a-f]{8}$/u),
  })
  .strict();
export type TopicWireChecksum = z.infer<typeof topicWireChecksumSchema>;

/** publisher reservation 对物理帧用途的权威标记；consumer 禁止按 RPC 时序猜测。 */
export const topicFrameDeliveryKindSchema = z.enum(["initial", "online", "recovery"]);
export type TopicFrameDeliveryKind = z.infer<typeof topicFrameDeliveryKindSchema>;

export type TopicWireFrame<F> =
  | {
      wireVersion: typeof V4_WIRE_PROTOCOL_VERSION;
      kind: "complete";
      deliveryKind: TopicFrameDeliveryKind;
      logicalFrameId: string;
      logicalFrameOrdinal: number;
      topic: string;
      subscriptionId: string;
      frame: F;
    }
  | {
      wireVersion: typeof V4_WIRE_PROTOCOL_VERSION;
      kind: "fragment";
      deliveryKind: TopicFrameDeliveryKind;
      logicalFrameId: string;
      logicalFrameOrdinal: number;
      topic: string;
      subscriptionId: string;
      fragmentIndex: number;
      fragmentCount: number;
      logicalBytes: number;
      checksum: TopicWireChecksum;
      dataBase64: string;
    };

/**
 * service 边界只验证可安全路由/计量的 outer 形状；range/base64/checksum/logical
 * payload 的完整校验必须在 ownership 过滤后的 assembler 中产生 typed fault。
 */
export const topicWireFrameCandidateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      wireVersion: z.literal(V4_WIRE_PROTOCOL_VERSION),
      kind: z.literal("complete"),
      // ownership 路由只读 topic/subId；坏 deliveryKind 必须进入 owned assembler
      // 产生 typed fault，不能在 service 边界 warn/drop 后让 store 永久等待。
      deliveryKind: z.unknown().optional(),
      logicalFrameId: z.string().min(1),
      logicalFrameOrdinal: z.number(),
      topic: z.string().min(1),
      subscriptionId: z.string().min(1),
      // inner payload 故意不在 service route boundary 校验；缺失/类型/extra 由
      // ownership 后 assembler 统一转 typed fault，避免早期 warn/drop 永久 loading。
      frame: z.unknown().optional(),
    })
    .passthrough(),
  z
    .object({
      wireVersion: z.literal(V4_WIRE_PROTOCOL_VERSION),
      kind: z.literal("fragment"),
      deliveryKind: z.unknown().optional(),
      logicalFrameId: z.string().min(1),
      logicalFrameOrdinal: z.number(),
      topic: z.string().min(1),
      subscriptionId: z.string().min(1),
      fragmentIndex: z.unknown().optional(),
      fragmentCount: z.unknown().optional(),
      logicalBytes: z.unknown().optional(),
      checksum: z.unknown().optional(),
      dataBase64: z.unknown().optional(),
    })
    .passthrough(),
]);
export type TopicWireFrameCandidate = z.infer<typeof topicWireFrameCandidateSchema>;

export function createTopicWireFrameSchema<F extends z.ZodTypeAny>(frameSchema: F) {
  return z
    .discriminatedUnion("kind", [
      z
        .object({
          wireVersion: z.literal(V4_WIRE_PROTOCOL_VERSION),
          kind: z.literal("complete"),
          deliveryKind: topicFrameDeliveryKindSchema,
          logicalFrameId: z.string().min(1),
          logicalFrameOrdinal: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          topic: z.string().min(1),
          subscriptionId: z.string().min(1),
          frame: frameSchema,
        })
        .strict(),
      z
        .object({
          wireVersion: z.literal(V4_WIRE_PROTOCOL_VERSION),
          kind: z.literal("fragment"),
          deliveryKind: topicFrameDeliveryKindSchema,
          logicalFrameId: z.string().min(1),
          logicalFrameOrdinal: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          topic: z.string().min(1),
          subscriptionId: z.string().min(1),
          fragmentIndex: z.number().int().nonnegative(),
          fragmentCount: z
            .number()
            .int()
            .positive()
            .max(PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxFragments),
          logicalBytes: z.number().int().positive(),
          checksum: topicWireChecksumSchema,
          dataBase64: topicWireBase64Schema,
        })
        .strict(),
    ])
    .superRefine((wire, context) => {
      const value = wire as unknown as TopicWireFrame<z.output<F>>;
      if (value.kind === "fragment") {
        if (value.fragmentIndex >= value.fragmentCount) {
          context.addIssue({
            code: "custom",
            message: "fragmentIndex must be smaller than fragmentCount",
            path: ["fragmentIndex"],
          });
        }
        if (value.fragmentCount > value.logicalBytes) {
          context.addIssue({
            code: "custom",
            message: "fragmentCount cannot exceed logicalBytes",
            path: ["fragmentCount"],
          });
        }
        return;
      }
      const frame = value.frame as {
        topic?: unknown;
        subscriptionId?: unknown;
      };
      if (frame.topic !== value.topic) {
        context.addIssue({
          code: "custom",
          message: "complete wire topic must match logical frame topic",
          path: ["topic"],
        });
      }
      if (frame.subscriptionId !== value.subscriptionId) {
        context.addIssue({
          code: "custom",
          message: "complete wire subscriptionId must match logical frame subscriptionId",
          path: ["subscriptionId"],
        });
      }
    });
}
