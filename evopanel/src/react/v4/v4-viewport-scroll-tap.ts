/**
 * 视口调试浮层用：时间线滚轮 / scrollTop 轨迹环形缓冲。
 *
 * 目的：结束态上滚跳动时，把「谁改了 scrollTop、跳了多大、到顶语义」留给复制诊断。
 * 到顶语义必须写清三件事：
 * 1. 几何是否到顶（scrollTop≈0）
 * 2. 是否还会自动 loadOlder（预取带 + hasOlder + 非加载中）
 * 3. 无更早历史 vs 还有更早但窗口未拉到
 */

import {
  historyPrefetchTriggerPx,
  shouldTriggerLoadOlder,
} from "@zcode/ui/v4/timelineScrollAnchor.js";
import { consumeSharedScrollWriteSource } from "@zcode/ui/v4/scrollJitterDiag.js";
import { persistViewportTap } from "./v4-viewport-tap-persist.js";

export type ViewportScrollTapKind = "wheel" | "scroll";

export type ViewportScrollTopVerdict =
  | "mid"
  | "near_bottom"
  | "prefetch_zone"
  | "prefetch_zone_no_older"
  | "geom_top_can_autoload"
  | "geom_top_loading"
  | "geom_top_no_older"
  | "geom_top_has_older_stuck"
  | "geom_top_window_not_earliest";

export type ViewportScrollTapEntry = {
  id: number;
  atMs: number;
  kind: ViewportScrollTapKind;
  /** wheel 的 deltaY；上滚为负 */
  deltaY: number | null;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** 相对上一条样本的 scrollTop 变化（正=朝底） */
  dTop: number;
  /** 相对上一条样本的 scrollHeight 变化 */
  dHeight: number;
  gapBottom: number;
  gapTop: number;
  /** |dTop| 大到可疑（非本次 wheel 可解释） */
  jump: boolean;
  /** 程序化写入挂名，或 wheel / browser */
  source: string;
  /** data-following 属性：true=跟底，false=已解除 */
  followingAttr: string | null;
  loadingOlderAttr: string | null;
  hasOlder: boolean;
  loadingOlder: boolean;
  wouldTrigger: boolean;
  inPrefetchZone: boolean;
  triggerPx: number;
  firstRowId: number | null;
  windowFirstRowId: number | null;
  totalCount: number | null;
  windowCount: number;
  windowUserCount: number;
  windowTurnCount: number;
  verdict: ViewportScrollTopVerdict;
  /** 一行给人看的中文摘要 */
  headline: string;
};

export type ViewportScrollHistoryContext = {
  hasOlder: boolean;
  loadingOlder: boolean;
  firstRowId: number | null;
  windowFirstRowId: number | null;
  totalCount: number | null;
  windowCount: number;
  windowUserCount: number;
  windowTurnCount: number;
};

const MAX_RING = 240;
/** 当前页签会话，供落盘到 stream-compare/{sid}/overlay */
let persistSessionId = "";

export function setViewportScrollTapSessionId(
  sessionId: string | null | undefined,
): void {
  persistSessionId = String(sessionId || "").trim();
}
/** 无对应 wheel 时，单次 |ΔscrollTop|≥此值标 JUMP */
const JUMP_PX = 80;
/** 有 wheel 但位移远大于滚轮预期时也标 JUMP */
const JUMP_VS_WHEEL_RATIO = 3;
const GEOM_TOP_PX = 8;
const NEAR_BOTTOM_PX = 48;

let nextId = 1;
const ring: ViewportScrollTapEntry[] = [];
const listeners = new Set<() => void>();

let attachedEl: HTMLElement | null = null;
let lastTop = 0;
let lastHeight = 0;
/** 最近一次 wheel 的 deltaY，供随后 scroll 归因 */
let lastWheelDeltaY: number | null = null;
let lastWheelAtMs = 0;
let historyCtx: ViewportScrollHistoryContext = {
  hasOlder: false,
  loadingOlder: false,
  firstRowId: null,
  windowFirstRowId: null,
  totalCount: null,
  windowCount: 0,
  windowUserCount: 0,
  windowTurnCount: 0,
};

function notify(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      /* overlay only */
    }
  }
}

export function setViewportScrollHistoryContext(
  next: ViewportScrollHistoryContext,
): void {
  historyCtx = {
    hasOlder: !!next.hasOlder,
    loadingOlder: !!next.loadingOlder,
    firstRowId:
      typeof next.firstRowId === "number" && Number.isFinite(next.firstRowId)
        ? next.firstRowId
        : null,
    windowFirstRowId:
      typeof next.windowFirstRowId === "number" &&
      Number.isFinite(next.windowFirstRowId)
        ? next.windowFirstRowId
        : null,
    totalCount:
      typeof next.totalCount === "number" && Number.isFinite(next.totalCount)
        ? next.totalCount
        : null,
    windowCount:
      typeof next.windowCount === "number" && Number.isFinite(next.windowCount)
        ? Math.max(0, next.windowCount)
        : 0,
    windowUserCount:
      typeof next.windowUserCount === "number" &&
      Number.isFinite(next.windowUserCount)
        ? Math.max(0, next.windowUserCount)
        : 0,
    windowTurnCount:
      typeof next.windowTurnCount === "number" &&
      Number.isFinite(next.windowTurnCount)
        ? Math.max(0, next.windowTurnCount)
        : 0,
  };
}

/** 面板醒目标题：已显示 N 条 / 全量 M 条。 */
export function formatConversationRecordCounts(input: {
  windowCount: number;
  totalCount: number | null;
  windowTurnCount?: number;
  windowUserCount?: number;
}): string {
  const shown = Math.max(0, Math.floor(input.windowCount || 0));
  const total =
    typeof input.totalCount === "number" && Number.isFinite(input.totalCount)
      ? Math.max(0, Math.floor(input.totalCount))
      : null;
  const turns =
    typeof input.windowTurnCount === "number"
      ? Math.max(0, Math.floor(input.windowTurnCount))
      : null;
  const users =
    typeof input.windowUserCount === "number"
      ? Math.max(0, Math.floor(input.windowUserCount))
      : null;
  const main =
    total === null
      ? `已显示 ${shown} 条 / 全量 ∅`
      : `已显示 ${shown} 条 / 全量 ${total} 条`;
  const extras: string[] = [];
  if (turns !== null) extras.push(`窗内 ${turns} 轮`);
  if (users !== null) extras.push(`用户气泡 ${users}`);
  return extras.length === 0 ? main : `${main}（${extras.join(" · ")}）`;
}

export function classifyScrollTopVerdict(input: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  hasOlder: boolean;
  loadingOlder: boolean;
  firstRowId: number | null;
  windowFirstRowId: number | null;
  /** data-following；跟底中不预取，避免短尾窗假阳性「应自动拉」。 */
  following?: boolean;
}): ViewportScrollTopVerdict {
  const triggerPx = historyPrefetchTriggerPx(input.clientHeight);
  const gapBottom = Math.max(
    0,
    input.scrollHeight - input.clientHeight - input.scrollTop,
  );
  const atGeomTop = input.scrollTop <= GEOM_TOP_PX;
  const inPrefetch = input.scrollTop <= triggerPx;
  const following = input.following === true;
  const wouldTrigger = shouldTriggerLoadOlder({
    scrollTop: input.scrollTop,
    canLoadOlder: input.hasOlder,
    loadingOlder: input.loadingOlder,
    triggerPx,
    following,
    distanceFromBottom: gapBottom,
    viewportHeight: input.clientHeight,
  });

  if (atGeomTop) {
    if (input.loadingOlder) return "geom_top_loading";
    if (!input.hasOlder) {
      // 窗口首行已是全序最早 → 历史已尽；否则声明无更早但窗缘不对齐（异常）
      if (
        input.firstRowId !== null &&
        input.windowFirstRowId !== null &&
        input.windowFirstRowId > input.firstRowId
      ) {
        return "geom_top_window_not_earliest";
      }
      return "geom_top_no_older";
    }
    if (following) return "near_bottom";
    if (wouldTrigger) return "geom_top_can_autoload";
    return "geom_top_has_older_stuck";
  }

  if (gapBottom <= NEAR_BOTTOM_PX) return "near_bottom";
  // hasOlder=0 时绝不能写「可自动拉更早」——那是面板误导主因。
  if (inPrefetch) {
    if (following) return "near_bottom";
    return input.hasOlder ? "prefetch_zone" : "prefetch_zone_no_older";
  }
  return "mid";
}

export function formatScrollTopVerdict(verdict: ViewportScrollTopVerdict): string {
  switch (verdict) {
    case "mid":
      return "中部·不自动拉历史";
    case "near_bottom":
      return "近底·跟底区";
    case "prefetch_zone":
      return "预取带内·可自动拉更早";
    case "prefetch_zone_no_older":
      return "预取带内·无更早可拉（窗已覆盖全量或声明 hasOlder=0）";
    case "geom_top_can_autoload":
      return "几何到顶·还有更早·应自动 loadOlder";
    case "geom_top_loading":
      return "几何到顶·正在 loadOlder 展开历史";
    case "geom_top_no_older":
      return "几何到顶·无更早历史（已拉尽/本来就到头）";
    case "geom_top_has_older_stuck":
      return "几何到顶·仍有更早但未触发（卡住？）";
    case "geom_top_window_not_earliest":
      return "几何到顶·声明无更早但窗首≠全序首（异常）";
    default:
      return verdict;
  }
}

function buildHeadline(entry: Omit<ViewportScrollTapEntry, "headline">): string {
  const dir =
    entry.kind === "wheel"
      ? entry.deltaY !== null && entry.deltaY < 0
        ? "上滚"
        : entry.deltaY !== null && entry.deltaY > 0
          ? "下滚"
          : "滚轮"
      : entry.dTop < -0.5
        ? "上移"
        : entry.dTop > 0.5
          ? "下移"
          : "停";
  const jump = entry.jump ? " !JUMP" : "";
  const dTop =
    entry.dTop === 0 ? "Δ0" : `Δ${entry.dTop > 0 ? "+" : ""}${Math.round(entry.dTop)}`;
  const dH =
    entry.dHeight === 0
      ? ""
      : ` h${entry.dHeight > 0 ? "+" : ""}${Math.round(entry.dHeight)}`;
  const follow =
    entry.followingAttr === "false"
      ? " follow=0"
      : entry.followingAttr === "true"
        ? " follow=1"
        : "";
  return (
    `${dir}${jump} top=${Math.round(entry.scrollTop)} ${dTop}${dH}` +
    ` gap↓${Math.round(entry.gapBottom)} src=${entry.source}${follow}` +
    ` · ${formatScrollTopVerdict(entry.verdict)}`
  );
}

function pushEntry(
  partial: Omit<ViewportScrollTapEntry, "id" | "headline">,
): void {
  const base = { ...partial, id: nextId++ };
  const entry: ViewportScrollTapEntry = {
    ...base,
    headline: buildHeadline(base),
  };
  ring.push(entry);
  while (ring.length > MAX_RING) ring.shift();
  lastTop = entry.scrollTop;
  lastHeight = entry.scrollHeight;
  if (persistSessionId) {
    persistViewportTap(persistSessionId, "scroll", {
      id: entry.id,
      atMs: entry.atMs,
      kind: entry.kind,
      jump: entry.jump,
      source: entry.source,
      verdict: entry.verdict,
      headline: entry.headline,
      scrollTop: entry.scrollTop,
      scrollHeight: entry.scrollHeight,
      clientHeight: entry.clientHeight,
      dTop: entry.dTop,
      dHeight: entry.dHeight,
      gapBottom: entry.gapBottom,
      gapTop: entry.gapTop,
      hasOlder: entry.hasOlder,
      loadingOlder: entry.loadingOlder,
      windowCount: entry.windowCount,
      totalCount: entry.totalCount,
    });
  }
  notify();
}

function readMetrics(el: HTMLElement) {
  return {
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  };
}

function resolveSource(kind: ViewportScrollTapKind): string {
  const written = consumeSharedScrollWriteSource();
  if (written) return written;
  if (kind === "wheel") return "wheel";
  if (lastWheelDeltaY !== null && Date.now() - lastWheelAtMs <= 80) {
    return "wheel→scroll";
  }
  return "browser/native";
}

function isJump(input: {
  kind: ViewportScrollTapKind;
  dTop: number;
  deltaY: number | null;
  source: string;
}): boolean {
  const abs = Math.abs(input.dTop);
  if (abs < JUMP_PX) return false;
  // 程序化贴底 / 记忆恢复本身就会大跳，标 JUMP 便于对照，不算误报
  if (input.source.startsWith("scrollTo") || input.source.includes("Restore")) {
    return true;
  }
  if (input.kind === "wheel" || input.source.startsWith("wheel")) {
    const dy = Math.abs(input.deltaY ?? lastWheelDeltaY ?? 0);
    if (dy > 0 && abs <= dy * JUMP_VS_WHEEL_RATIO + 40) return false;
    return abs >= JUMP_PX;
  }
  return true;
}

function sample(
  el: HTMLElement,
  kind: ViewportScrollTapKind,
  deltaY: number | null,
): void {
  const m = readMetrics(el);
  const dTop = m.scrollTop - lastTop;
  const dHeight = m.scrollHeight - lastHeight;
  // 纯 wheel 且尚未引起 scrollTop 变化：仍记一笔意图，便于对照随后跳变
  if (kind === "wheel" && Math.abs(dTop) < 0.5 && Math.abs(dHeight) < 0.5) {
    // 保留 last*，只记意图
  }
  const triggerPx = historyPrefetchTriggerPx(m.clientHeight);
  const gapBottom = Math.max(0, m.scrollHeight - m.clientHeight - m.scrollTop);
  const gapTop = Math.max(0, m.scrollTop);
  const inPrefetchZone = m.scrollTop <= triggerPx;
  const followingAttr = el.getAttribute("data-following");
  const following = followingAttr !== "false";
  const wouldTrigger = shouldTriggerLoadOlder({
    scrollTop: m.scrollTop,
    canLoadOlder: historyCtx.hasOlder,
    loadingOlder: historyCtx.loadingOlder,
    triggerPx,
    following,
    distanceFromBottom: gapBottom,
    viewportHeight: m.clientHeight,
  });
  const verdict = classifyScrollTopVerdict({
    scrollTop: m.scrollTop,
    clientHeight: m.clientHeight,
    scrollHeight: m.scrollHeight,
    hasOlder: historyCtx.hasOlder,
    loadingOlder: historyCtx.loadingOlder,
    firstRowId: historyCtx.firstRowId,
    windowFirstRowId: historyCtx.windowFirstRowId,
    following,
  });
  const source = resolveSource(kind);
  const jump = isJump({ kind, dTop, deltaY, source });
  pushEntry({
    atMs: Date.now(),
    kind,
    deltaY,
    scrollTop: m.scrollTop,
    scrollHeight: m.scrollHeight,
    clientHeight: m.clientHeight,
    dTop,
    dHeight,
    gapBottom,
    gapTop,
    jump,
    source,
    followingAttr,
    loadingOlderAttr: el.getAttribute("data-loading-older"),
    hasOlder: historyCtx.hasOlder,
    loadingOlder: historyCtx.loadingOlder,
    wouldTrigger,
    inPrefetchZone,
    triggerPx,
    firstRowId: historyCtx.firstRowId,
    windowFirstRowId: historyCtx.windowFirstRowId,
    totalCount: historyCtx.totalCount,
    windowCount: historyCtx.windowCount,
    windowUserCount: historyCtx.windowUserCount,
    windowTurnCount: historyCtx.windowTurnCount,
    verdict,
  });
}

function onWheel(ev: WheelEvent): void {
  if (!attachedEl) return;
  lastWheelDeltaY = ev.deltaY;
  lastWheelAtMs = Date.now();
  sample(attachedEl, "wheel", ev.deltaY);
}

function onScroll(): void {
  if (!attachedEl) return;
  sample(attachedEl, "scroll", lastWheelDeltaY);
  if (Date.now() - lastWheelAtMs > 120) {
    lastWheelDeltaY = null;
  }
}

export function attachViewportScrollTap(el: HTMLElement | null): void {
  if (attachedEl === el) return;
  if (attachedEl) {
    attachedEl.removeEventListener("wheel", onWheel);
    attachedEl.removeEventListener("scroll", onScroll);
  }
  attachedEl = el;
  if (!el) return;
  lastTop = el.scrollTop;
  lastHeight = el.scrollHeight;
  el.addEventListener("wheel", onWheel, { passive: true, capture: true });
  el.addEventListener("scroll", onScroll, { passive: true });
}

export function detachViewportScrollTap(): void {
  if (!attachedEl) return;
  attachedEl.removeEventListener("wheel", onWheel);
  attachedEl.removeEventListener("scroll", onScroll);
  attachedEl = null;
}

export function clearViewportScrollTap(): void {
  ring.length = 0;
  notify();
}

export function subscribeViewportScrollTap(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function listViewportScrollTapEntries(opts?: {
  limit?: number;
  jumpsOnly?: boolean;
}): ViewportScrollTapEntry[] {
  const limit = Math.max(1, Math.min(MAX_RING, opts?.limit ?? 80));
  const base = opts?.jumpsOnly ? ring.filter((e) => e.jump) : ring;
  if (base.length <= limit) return base.slice();
  return base.slice(base.length - limit);
}

export function countViewportScrollJumps(): number {
  return ring.reduce((n, e) => n + (e.jump ? 1 : 0), 0);
}
