/**
 * 视口调试浮层用：AG-UI / V4 流式原始帧环形缓冲。
 * 在 wire 入口轻量落盘（裁剪大字段），供浮层滚动查看「流式长什么样」。
 */

export type ViewportStreamTapChannel = "agui" | "v4" | "openai" | "evf" | "raw";

export type ViewportStreamTapEntry = {
  id: number;
  atMs: number;
  channel: ViewportStreamTapChannel;
  sessionKey: string;
  runId: string;
  type: string;
  headline: string;
  jsonText: string;
};

const MAX_RING = 64;
const MAX_JSON_CHARS = 2200;
const MAX_DELTA_CHARS = 180;

let nextId = 1;
const ring: ViewportStreamTapEntry[] = [];
const listeners = new Set<() => void>();

function clipText(raw: unknown, max: number): string {
  const s = String(raw ?? "");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(+${s.length - max})`;
}

function safeJson(value: unknown, max = MAX_JSON_CHARS): string {
  let text = "";
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(+${text.length - max} chars)`;
}

function notify(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      /* overlay only */
    }
  }
}

function pushEntry(entry: Omit<ViewportStreamTapEntry, "id" | "atMs">): void {
  ring.push({
    ...entry,
    id: nextId++,
    atMs: Date.now(),
  });
  while (ring.length > MAX_RING) ring.shift();
  notify();
}

/** AG-UI / OpenAI / EVF 原始 data 对象 → 裁剪后入环 */
export function pushViewportStreamAguiTap(opts: {
  channel?: ViewportStreamTapChannel;
  sessionKey?: string;
  runId?: string;
  data: Record<string, unknown> | null | undefined;
}): void {
  const data = opts.data && typeof opts.data === "object" ? opts.data : null;
  if (!data) return;
  const type = String(data.type || "").trim() || "?";
  const runId =
    String(opts.runId || data.runId || "")
      .trim()
      .slice(0, 36) || "";
  const sessionKey = String(opts.sessionKey || "").trim();
  const channel = opts.channel || "agui";

  const compact: Record<string, unknown> = { type };
  if (runId) compact.runId = runId;
  if (typeof data.threadId === "string" && data.threadId) {
    compact.threadId = String(data.threadId).slice(0, 36);
  }
  if (typeof data.messageId === "string" && data.messageId) {
    compact.messageId = String(data.messageId).slice(0, 40);
  }
  if (typeof data.toolCallId === "string" && data.toolCallId) {
    compact.toolCallId = String(data.toolCallId).slice(0, 40);
  }
  if (typeof data.toolCallName === "string" && data.toolCallName) {
    compact.toolCallName = data.toolCallName;
  }
  if (typeof data.name === "string" && data.name) compact.name = data.name;
  if (typeof data.delta === "string") {
    compact.deltaLen = data.delta.length;
    compact.delta = clipText(data.delta, MAX_DELTA_CHARS);
  }
  if (typeof data.content === "string") {
    compact.contentLen = data.content.length;
    compact.content = clipText(data.content, MAX_DELTA_CHARS);
  }
  if (data.result !== undefined) {
    compact.result = clipText(
      typeof data.result === "string" ? data.result : safeJson(data.result, 400),
      240,
    );
  }
  if (typeof data.status === "string") compact.status = data.status;
  if (data.value !== undefined && typeof data.value !== "object") {
    compact.value = data.value;
  }

  const bits: string[] = [channel, type];
  if (typeof data.toolCallName === "string" && data.toolCallName) {
    bits.push(data.toolCallName);
  }
  if (typeof data.delta === "string" && data.delta) {
    bits.push(`Δ${data.delta.length} ${clipText(data.delta, 48)}`);
  }

  pushEntry({
    channel,
    sessionKey,
    runId,
    type,
    headline: bits.join(" · "),
    jsonText: safeJson(compact),
  });
}

/** V4 frames SSE 候选帧 → 摘要入环（不塞整窗 snapshot rows） */
export function pushViewportStreamV4Tap(opts: {
  topic?: string;
  deliveryKind?: string;
  wireBytes?: number;
  frame?: {
    fromSeq?: number;
    toSeq?: number;
    subscriptionId?: string;
    payload?: {
      kind?: string;
      deltas?: unknown[];
      snapshot?: { rows?: { window?: unknown[] } | unknown[] };
    };
  };
}): void {
  const frame = opts.frame;
  const payload = frame?.payload;
  const kind = String(payload?.kind || opts.deliveryKind || "frame").trim();
  let windowRows = 0;
  const rows = payload?.snapshot?.rows;
  if (Array.isArray(rows)) windowRows = rows.length;
  else if (rows && typeof rows === "object" && Array.isArray(rows.window)) {
    windowRows = rows.window.length;
  }
  const deltaCount = Array.isArray(payload?.deltas) ? payload!.deltas!.length : 0;
  const topic = String(opts.topic || "").trim();
  const compact: Record<string, unknown> = {
    channel: "v4",
    kind,
    deliveryKind: opts.deliveryKind || null,
    topic: topic || null,
    fromSeq: frame?.fromSeq ?? null,
    toSeq: frame?.toSeq ?? null,
    subscriptionId: frame?.subscriptionId
      ? String(frame.subscriptionId).slice(0, 28)
      : null,
    windowRows,
    deltaCount,
    wireBytes: opts.wireBytes ?? null,
  };
  // delta 抽样：最多 2 条 kind/row 摘要，避免刷爆浮层
  if (deltaCount > 0 && Array.isArray(payload?.deltas)) {
    compact.deltaSample = payload!.deltas!.slice(0, 2).map((d) => {
      if (!d || typeof d !== "object") return { raw: clipText(d, 80) };
      const o = d as Record<string, unknown>;
      return {
        op: o.op ?? o.kind ?? o.type ?? null,
        rowId: o.rowId ?? o.id ?? null,
        turnId: typeof o.turnId === "string" ? String(o.turnId).slice(0, 12) : null,
        text: typeof o.text === "string" ? clipText(o.text, 64) : undefined,
      };
    });
  }

  pushEntry({
    channel: "v4",
    sessionKey: "",
    runId: "",
    type: kind,
    headline: `v4 · ${kind} · seq=${frame?.fromSeq ?? "?"}→${frame?.toSeq ?? "?"}${
      windowRows ? ` · rows=${windowRows}` : ""
    }${deltaCount ? ` · Δ=${deltaCount}` : ""}`,
    jsonText: safeJson(compact),
  });
}

export function listViewportStreamTapEntries(opts?: {
  sessionKey?: string | null;
  limit?: number;
}): ViewportStreamTapEntry[] {
  const limit = Math.max(1, Math.min(MAX_RING, opts?.limit ?? MAX_RING));
  const sk = String(opts?.sessionKey || "").trim();
  const source = sk
    ? ring.filter((e) => !e.sessionKey || e.sessionKey === sk || e.channel === "v4")
    : ring;
  return source.slice(-limit);
}

export function subscribeViewportStreamTap(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearViewportStreamTap(): void {
  ring.length = 0;
  notify();
}
