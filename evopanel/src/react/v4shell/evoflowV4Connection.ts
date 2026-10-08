/**
 * EvoFlow v4 shell — ZCode v4 wire 帧的 SSE 连接管理。
 *
 * 一个页面加载 = 一个 connectionId（与后端 hello/subscribe/frames 端点对齐）。
 * wire 帧形状见 ``@zcode/shared/zcode-protocol-v4`` 的 ``ConversationTopicWireCandidate``；
 * 后端实现见 ``backend/app/gateway/v4/conversation.py``。
 */

import type { ConversationTopicWireCandidate } from "@zcode/shared/zcode-protocol-v4";

const CONNECTION_STORAGE_KEY = "evoflowV4ConnectionId";

/** 页面生命周期内稳定的连接 id；刷新后重连视作新连接（后端订阅为进程内内存态）。 */
export function getV4ConnectionId(): string {
  try {
    const existing = window.sessionStorage.getItem(CONNECTION_STORAGE_KEY);
    if (existing) return existing;
    const fresh = `conn-${crypto.randomUUID().slice(0, 12)}`;
    window.sessionStorage.setItem(CONNECTION_STORAGE_KEY, fresh);
    return fresh;
  } catch {
    return `conn-${Math.random().toString(36).slice(2, 12)}`;
  }
}

type WireListener = (wire: ConversationTopicWireCandidate) => void;

class V4FrameConnection {
  private source: EventSource | null = null;
  private listeners = new Set<WireListener>();
  private connecting = false;

  private ensureSource(): void {
    if (this.source || this.connecting) return;
    this.connecting = true;
    const url = `/api/v4/conversation/frames?connectionId=${encodeURIComponent(getV4ConnectionId())}`;
    const source = new EventSource(url);
    this.source = source;
    source.addEventListener("v4.wire", (event) => {
      try {
        const wire = JSON.parse((event as MessageEvent<string>).data) as ConversationTopicWireCandidate;
        for (const listener of [...this.listeners]) listener(wire);
      } catch (error) {
        // 单帧解码失败不杀连接；后端保证同一 logical frame 的候选片序完整。
        console.warn("[v4shell] wire frame decode failed", error);
      }
    });
    source.onerror = () => {
      // EventSource 自带重连；仅在没有监听者时主动关闭，避免后台空转。
      if (this.listeners.size === 0) {
        source.close();
        this.source = null;
      }
    };
    this.connecting = false;
  }

  onWire(listener: WireListener): () => void {
    this.listeners.add(listener);
    this.ensureSource();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.source) {
        this.source.close();
        this.source = null;
      }
    };
  }
}

/** 单例：所有 transport 共享一条 SSE 长连接（与 ZCode 的单 host 连接模型一致）。 */
export const v4FrameConnection = new V4FrameConnection();

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`[v4shell] ${path} failed (${response.status}): ${detail.slice(0, 200)}`);
  }
  return (await response.json()) as T;
}

export const v4Post = postJson;
