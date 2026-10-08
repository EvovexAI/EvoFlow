import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 广播消息
 *
 * 用于跨窗口状态同步。从 Renderer 发出后经 host → main → 其他 host → 对应 Renderer。
 */
export interface BroadcastMessage {
  /** 频道名，如 "state:theme"、"state:locale" */
  channel: string;
  /** 消息负载 */
  payload: unknown;
  /** 发送源窗口 ID（由 BroadcastHub 填充，接收端可用来跳过自己） */
  sourceWindowId?: number;
}

/** 跨窗口 opaque claim 的临时 reservation；token 用于安全 commit/release。 */
export interface BroadcastClaimLease {
  key: string;
  token: string;
}

export type BroadcastClaimAcquireResult =
  | { status: "acquired"; lease: BroadcastClaimLease }
  | { status: "busy"; retryAfterMs: number }
  | { status: "committed" }
  | { status: "unavailable" };

/**
 * 广播服务接口
 *
 * 路径：Renderer → (RPC call) → Host → (parentPort) → Main(BroadcastHub)
 *       → (postMessage) → 其他 Host → (RPC event onMessage) → 对应 Renderer
 */
export interface IBroadcastService {
  /** 发送广播消息 */
  send(message: BroadcastMessage): Promise<void>;
  /** 申请带 token 的临时 reservation；busy 可在 retryAfterMs 后重试。 */
  acquireClaim(key: string): Promise<BroadcastClaimAcquireResult>;
  /** 把 reservation 提交为应用进程生命周期内的永久 claim。 */
  commitClaim(lease: BroadcastClaimLease): Promise<void>;
  /** 按 token 释放尚未 commit 的 reservation；迟到 token 不影响后来 winner。 */
  releaseClaim(lease: BroadcastClaimLease): Promise<void>;
  /** 在当前应用进程内原子占用 opaque key；同一 key 仅首次返回 true。 */
  tryClaim(key: string): Promise<boolean>;
  /** 接收来自其他窗口的广播 */
  onMessage: Event<BroadcastMessage>;
}

export const IBroadcastService = createServiceDescriptor<IBroadcastService>(
  ServiceChannels.Broadcast,
);
