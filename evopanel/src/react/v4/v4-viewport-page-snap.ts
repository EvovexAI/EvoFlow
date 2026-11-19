/**
 * 视口调试：页面「画面快照」环。
 * 只在对话内容真变了才记一帧（用户/正文/思考/工具），不变不刷。
 * 用来排查「乱套时屏幕/投影到底画了啥」。
 */

import { persistViewportTap } from "./v4-viewport-tap-persist.js";

export type ViewportPageSnapTurn = {
  turnId: string;
  dataIndex: string | null;
  displayText?: string;
  rawRows: Array<Record<string, unknown>>;
  orphanHeaderNoUser?: boolean;
  emptyAssistantCompleted?: boolean;
  /** 本轮仍在 streaming / running */
  live?: boolean;
};

export type ViewportPageSnapEntry = {
  id: number;
  atMs: number;
  sessionId: string;
  /** 相对上一帧内容是否变了（入环的都是变了的） */
  changed: boolean;
  /** 一行摘要 */
  headline: string;
  /** 点开看的多行明细 */
  detailText: string;
  sig: string;
};

const MAX_RING = 180;
const MAX_LINE = 120;
/** 内容签名只取尾部这么多轮；直播中轮即使更早也会钉进样本 */
const TAIL_TURN_LIMIT = 6;

function isLiveRow(row: Record<string, unknown>): boolean {
  const kind = String(row.kind || "");
  if (kind === "turnHeader") {
    const state = String(row.state || "");
    return state === "running" || state.startsWith("running");
  }
  if (kind === "assistantText" || kind === "reasoning") {
    return String(row.state || "") === "streaming";
  }
  if (kind === "toolCall") {
    const status = String(row.status || "");
    return (
      status === "running" ||
      status === "inputStreaming" ||
      status === "pending" ||
      status === "executing"
    );
  }
  return false;
}

let nextId = 1;
const ring: ViewportPageSnapEntry[] = [];
const listeners = new Set<() => void>();
let lastSig = "";
/** 上一帧签名，用于压 A↔B 来回抖 */
let prevSig = "";

function clip(raw: unknown, max = MAX_LINE): string {
  const s = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  return s.length <= max ? s : `${s.slice(0, max)}[+${s.length - max}]`;
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

function rowBits(row: Record<string, unknown>): string | null {
  const kind = String(row.kind || "");
  if (kind === "userInput") {
    const t = clip(row.text, 80);
    return t ? `用户 ${t}` : "用户（空）";
  }
  if (kind === "assistantText") {
    const t = clip(row.text, 80);
    return t ? `正文 ${t}` : "正文（空）";
  }
  if (kind === "reasoning") {
    const t = clip(row.text, 60);
    return t ? `思考 ${t}` : "思考（空）";
  }
  if (kind === "toolCall") {
    const name = String(row.toolName || row.name || "tool");
    const status = String(row.status || "");
    // 状态进摘要给人看，但不进签名：inputStreaming↔running 会抖成假变化
    return `工具 ${name}${status ? `[${status}]` : ""}`;
  }
  if (kind === "turnHeader") {
    const state = String(row.state || "");
    return state ? `轮头 ${state}` : null;
  }
  return null;
}

/** 签名用：工具只留名字，忽略 status / DOM / scroll */
function rowSigBits(row: Record<string, unknown>): string | null {
  const kind = String(row.kind || "");
  if (kind === "userInput") {
    const t = clip(row.text, 120);
    return t ? `U:${t}` : "U:∅";
  }
  if (kind === "assistantText") {
    const t = clip(row.text, 120);
    return t ? `T:${t}` : "T:∅";
  }
  if (kind === "reasoning") {
    const t = clip(row.text, 80);
    return t ? `R:${t}` : "R:∅";
  }
  if (kind === "toolCall") {
    const name = String(row.toolName || row.name || "tool");
    return `K:${name}`;
  }
  if (kind === "turnHeader") {
    const state = String(row.state || "");
    // completed / running 切换是真变化；空 state 忽略
    return state ? `H:${state}` : null;
  }
  return null;
}

/**
 * 从投影窗 rows 按 turn 顺序抽出尾部若干轮（权威内容，不跟视口滚动抖）。
 * 直播中 / streaming 轮即使不在尾部也会钉进样本，避免「最新显示 333、流式却在回 666」。
 */
export function turnsFromWindowRows(
  rows: ReadonlyArray<Record<string, unknown>>,
  limit = TAIL_TURN_LIMIT,
): ViewportPageSnapTurn[] {
  const order: string[] = [];
  const byTurn = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const turnId = String(row.turnId || "").trim();
    if (!turnId) continue;
    if (!byTurn.has(turnId)) {
      byTurn.set(turnId, []);
      order.push(turnId);
    }
    byTurn.get(turnId)!.push(row);
  }
  const liveIds = order.filter((id) =>
    (byTurn.get(id) || []).some((r) => isLiveRow(r)),
  );
  const tailIds = order.slice(-Math.max(1, limit));
  const picked: string[] = [];
  for (const id of [...tailIds, ...liveIds]) {
    if (!picked.includes(id)) picked.push(id);
  }
  // 保持窗内出现顺序
  picked.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return picked.map((turnId) => {
    const rawRows = byTurn.get(turnId) ?? [];
    const header = rawRows.find((r) => String(r.kind) === "turnHeader");
    const hasUser = rawRows.some((r) => String(r.kind) === "userInput");
    const headerOrigin =
      header && typeof header.origin === "string" ? header.origin : null;
    const headerState =
      header && typeof header.state === "string" ? header.state : null;
    const live = rawRows.some((r) => isLiveRow(r));
    return {
      turnId,
      dataIndex: String(order.indexOf(turnId)),
      rawRows,
      orphanHeaderNoUser: !!header && headerOrigin === "userInput" && !hasUser,
      emptyAssistantCompleted: Boolean(
        hasUser &&
          headerState &&
          (headerState.startsWith("completed") || headerState === "failed") &&
          !rawRows.some((r) => {
            const k = String(r.kind);
            return k === "assistantText" || k === "reasoning" || k === "toolCall";
          }),
      ),
      live,
    };
  });
}

function buildDetail(
  turns: ViewportPageSnapTurn[],
  meta: { runLabel: string; scrollTop: number; scrollHeight: number },
): { headline: string; detailText: string; sig: string } {
  const lines: string[] = [];
  lines.push(
    `run=${meta.runLabel} scroll=${meta.scrollTop}/${meta.scrollHeight} 尾轮=${turns.length}`,
  );
  const sigParts: string[] = [];
  if (turns.length === 0) {
    lines.push("  （投影窗无 turn）");
    sigParts.push("EMPTY");
  }
  /** 窗序最后一轮（已完成也可能） */
  let tailContent:
    | { user: string; text: string; tool: string; flags: string[]; live: boolean }
    | null = null;
  /** 仍在跑的一轮：优先当「最新」，避免流式回 666 时头条还钉在已完成的 333 */
  let liveContent:
    | { user: string; text: string; tool: string; flags: string[]; live: boolean }
    | null = null;
  for (const t of turns) {
    const flags: string[] = [];
    if (t.orphanHeaderNoUser) flags.push("!孤儿头");
    if (t.emptyAssistantCompleted) flags.push("!空回复");
    if (t.live) flags.push("!直播中");
    let user = "";
    let text = "";
    let tool = "";
    const bits: string[] = [];
    for (const row of t.rawRows) {
      const b = rowBits(row);
      if (b) {
        bits.push(b);
        if (b.startsWith("用户 ")) user = b;
        else if (b.startsWith("正文 ")) text = b;
        else if (b.startsWith("工具 ")) tool = b;
      }
      const sb = rowSigBits(row);
      if (sb) sigParts.push(sb);
    }
    if (bits.length === 0 && flags.length === 0) {
      lines.push(
        `  turn#${t.dataIndex ?? "∅"} ${t.turnId.slice(0, 8)} （仅轮头/空）`,
      );
      continue;
    }
    lines.push(
      `  turn#${t.dataIndex ?? "∅"} ${t.turnId.slice(0, 8)}${
        flags.length ? ` ${flags.join("")}` : ""
      }`,
    );
    for (const b of bits) lines.push(`    ${b}`);
    sigParts.push(`turn:${t.turnId}${flags.join("")}`);
    const pack = {
      user,
      text,
      tool,
      flags,
      live: !!t.live,
    };
    tailContent = pack;
    if (t.live) liveContent = pack;
  }
  const latestContent = liveContent || tailContent;
  const headBits: string[] = [];
  if (latestContent) {
    if (liveContent && tailContent && liveContent !== tailContent) {
      // 直播轮不在窗序末尾：把窗尾用户也打出来，方便对「777 在播、窗尾仍是 6666」
      const tailUser = tailContent.user ? tailContent.user.replace(/^用户 /, "") : "∅";
      headBits.push(`!非窗尾直播(尾=${tailUser})`);
    }
    if (latestContent.user) headBits.push(latestContent.user);
    if (latestContent.text) headBits.push(latestContent.text);
    else if (latestContent.user) headBits.push("正文 （等首字）");
    if (latestContent.tool) headBits.push(latestContent.tool);
    if (latestContent.flags.length) {
      headBits.push(
        ...latestContent.flags.filter((f) => f !== "!直播中"),
      );
    }
  }
  const sig = sigParts.join("|");
  const tag = liveContent ? "直播" : "最新";
  const tail = headBits.join(" | ") || "（无用户/正文/工具）";
  const headline = `${tag} · ${tail}`;
  return { headline, detailText: lines.join("\n"), sig };
}

export function pushViewportPageSnap(opts: {
  sessionId?: string | null;
  runLabel?: string;
  scrollTop?: number;
  scrollHeight?: number;
  turns: ViewportPageSnapTurn[];
  /**
   * 仅手动「刷新」时用：即使签名相同也记一帧（仍标 changed=false）。
   * 自动轮询禁止 force，避免无变化刷屏。
   */
  force?: boolean;
}): ViewportPageSnapEntry | null {
  const sessionId = String(opts.sessionId || "").trim();
  if (!sessionId) return null;
  const built = buildDetail(opts.turns || [], {
    runLabel: String(opts.runLabel || "∅"),
    scrollTop: Math.round(Number(opts.scrollTop) || 0),
    scrollHeight: Math.round(Number(opts.scrollHeight) || 0),
  });
  const changed = built.sig !== lastSig;
  // 无变化：默认不记。手动 force 才补一帧现场。
  if (!changed && !opts.force) return null;
  // A↔B 抖：新签名等于「上上帧」则当作回弹，跳过
  if (changed && built.sig === prevSig && !opts.force) {
    lastSig = built.sig;
    return null;
  }

  const entry: ViewportPageSnapEntry = {
    id: nextId++,
    atMs: Date.now(),
    sessionId,
    changed,
    headline: built.headline,
    detailText: built.detailText,
    sig: built.sig,
  };
  ring.push(entry);
  while (ring.length > MAX_RING) ring.shift();
  if (changed) {
    prevSig = lastSig;
    lastSig = built.sig;
  }
  persistViewportTap(sessionId, "page", {
    id: entry.id,
    atMs: entry.atMs,
    changed: entry.changed,
    headline: entry.headline,
    detailText: entry.detailText,
  });
  notify();
  return entry;
}

export function listViewportPageSnapEntries(opts?: {
  sessionId?: string | null;
  limit?: number;
}): ViewportPageSnapEntry[] {
  const limit = Math.max(1, Math.min(MAX_RING, opts?.limit ?? MAX_RING));
  const sid = String(opts?.sessionId || "").trim();
  const source = sid ? ring.filter((e) => e.sessionId === sid) : ring;
  return source.slice(-limit);
}

export function clearViewportPageSnap(): void {
  ring.length = 0;
  lastSig = "";
  prevSig = "";
  notify();
}

export function subscribeViewportPageSnap(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
