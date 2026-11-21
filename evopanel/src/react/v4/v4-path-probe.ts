/**
 * V4 投递路径「根因对账」：把 AG-UI 在跑 / frames SSE / store 订阅 / hub tip /
 * catchup notified 收成一条可机器判定的 verdict。
 *
 * 面板上 WIRE_WITHOUT_V4_TIP 只是症状；本探针回答「帧为什么没进当前投影」。
 */

import { extractStreamMaxRowId } from "./v4-viewport-anomaly.js";

export type V4PathVerdictCode =
  | "OK"
  | "IDLE"
  | "FRAMES_SSE_DOWN"
  | "NO_STORE_SUB"
  | "SUB_NOT_ACTIVATED"
  | "HUB_AHEAD_NOTIFIED0"
  | "HUB_AHEAD_NO_FRAMES"
  | "HUB_AHEAD"
  | "WIRE_WITHOUT_V4_TIP"
  | "STREAM_AHEAD";

export type V4PathProbe = {
  verdict: V4PathVerdictCode;
  /** 一行给人看：根因名 + 证据 */
  title: string;
  detail: string;
  framesUp: boolean;
  storeStatus: string | null;
  subscriptionId: string | null;
  subActive: boolean | null;
  stagedCount: number | null;
  activeSubCount: number;
  feTip: number | null;
  hubTip: number | null;
  tipDelta: number | null;
  streamMax: number | null;
  lastV4AgeMs: number | null;
  catchupReason: string | null;
  catchupNotified: number | null;
  catchupAgeMs: number | null;
  subscriberCount: number | null;
  executing: boolean;
  settled: boolean;
};

export type V4PathProbeInput = {
  nowMs?: number;
  tid: string;
  executing: boolean;
  settled: boolean;
  framesUp: boolean;
  storeStatus?: string | null;
  subscriptionId?: string | null;
  subActive?: boolean | null;
  stagedCount?: number | null;
  activeSubCount?: number;
  feTip?: number | null;
  hubTip?: number | null;
  streamMax?: number | null;
  lastV4AtMs?: number | null;
  catchupReason?: string | null;
  catchupNotified?: number | null;
  catchupAtMs?: number | null;
  subscriberCount?: number | null;
  hasOptimistic?: boolean;
  windowHasLive?: boolean;
  streamEntries?: ReadonlyArray<{
    atMs: number;
    channel: string;
    sessionId: string;
    headline?: string;
    jsonText?: string;
  }>;
};

const STALE_V4_MS = 8_000;

export function collectV4PathProbe(input: V4PathProbeInput): V4PathProbe {
  const now = input.nowMs ?? Date.now();
  const framesUp = !!input.framesUp;
  const storeStatus = input.storeStatus ?? null;
  const subscriptionId = input.subscriptionId
    ? String(input.subscriptionId)
    : null;
  const subActive =
    typeof input.subActive === "boolean" ? input.subActive : null;
  const stagedCount =
    typeof input.stagedCount === "number" ? input.stagedCount : null;
  const activeSubCount = Math.max(0, Number(input.activeSubCount) || 0);
  const feTip =
    typeof input.feTip === "number" && Number.isFinite(input.feTip)
      ? input.feTip
      : null;
  const hubTip =
    typeof input.hubTip === "number" && Number.isFinite(input.hubTip)
      ? input.hubTip
      : null;
  const tipDelta =
    feTip != null && hubTip != null ? hubTip - feTip : null;
  const streamMax =
    typeof input.streamMax === "number" && Number.isFinite(input.streamMax)
      ? input.streamMax
      : input.streamEntries
        ? extractStreamMaxRowId(
            input.streamEntries.map((e) => ({
              ...e,
              headline: e.headline ?? "",
              jsonText: e.jsonText ?? "",
            })),
            input.tid,
            now - 30_000,
          )
        : null;
  const lastV4AgeMs =
    typeof input.lastV4AtMs === "number" && Number.isFinite(input.lastV4AtMs)
      ? Math.max(0, now - input.lastV4AtMs)
      : null;
  const catchupReason = input.catchupReason
    ? String(input.catchupReason)
    : null;
  const catchupNotified =
    typeof input.catchupNotified === "number" &&
    Number.isFinite(input.catchupNotified)
      ? input.catchupNotified
      : null;
  const catchupAgeMs =
    typeof input.catchupAtMs === "number" && Number.isFinite(input.catchupAtMs)
      ? Math.max(0, now - input.catchupAtMs)
      : null;
  const subscriberCount =
    typeof input.subscriberCount === "number" &&
    Number.isFinite(input.subscriberCount)
      ? input.subscriberCount
      : null;
  const executing = !!input.executing;
  const settled = !!input.settled;
  const hubAhead = tipDelta != null && tipDelta > 0;
  const notified0 =
    catchupNotified != null
      ? catchupNotified <= 0
      : typeof catchupReason === "string" && catchupReason.includes("notified0");
  const v4Stale =
    lastV4AgeMs == null || lastV4AgeMs >= STALE_V4_MS || streamMax == null;

  let verdict: V4PathVerdictCode = "IDLE";
  let title = "空闲 / 未在跑";
  let detail = "exec=0";

  if (!executing || settled) {
    if (hubAhead && notified0) {
      verdict = "HUB_AHEAD_NOTIFIED0";
      title = "hub 超前且 recovery 无人收";
      detail = `hub=${hubTip} fe=${feTip} Δ+${tipDelta} notified=${catchupNotified ?? 0} reason=${catchupReason || "∅"}`;
    } else if (hubAhead) {
      verdict = "HUB_AHEAD";
      title = "hub tip 超前本机（非直播轮）";
      detail = `hub=${hubTip} fe=${feTip} Δ+${tipDelta} catchup=${catchupReason || "∅"}`;
    } else {
      verdict = executing && settled ? "OK" : "IDLE";
      title = settled ? "已 settled" : "空闲";
      detail = `feTip=${feTip ?? "∅"} hubTip=${hubTip ?? "∅"} frames=${framesUp ? "up" : "down"}`;
    }
  } else if (!framesUp) {
    verdict = "FRAMES_SSE_DOWN";
    title = "AG-UI 在跑，V4 frames SSE 断";
    detail = `wire 在推但 frames 未连；store=${storeStatus || "∅"} sub=${subscriptionId ? subscriptionId.slice(0, 12) : "∅"}`;
  } else if (!subscriptionId) {
    verdict = "NO_STORE_SUB";
    title = "frames 已连，本会话无 subscriptionId";
    detail = `store=${storeStatus || "∅"} activeSubs=${activeSubCount} —— hub 写行也没人收`;
  } else if (subActive === false) {
    verdict = "SUB_NOT_ACTIVATED";
    title = "有 sub 但未 activate（帧在 staging）";
    detail = `sub=${subscriptionId.slice(0, 12)} staged=${stagedCount ?? "∅"} activeSubs=${activeSubCount}`;
  } else if (hubAhead && notified0) {
    verdict = "HUB_AHEAD_NOTIFIED0";
    title = "hub 已超前，catchup recovery notified=0";
    detail = `hub=${hubTip} fe=${feTip} Δ+${tipDelta} notified=0 reason=${catchupReason || "∅"} subs=${subscriberCount ?? "∅"} —— 根因：本会话在 hub 上无活订阅`;
  } else if (hubAhead && v4Stale) {
    verdict = "HUB_AHEAD_NO_FRAMES";
    title = "hub 超前且近期无 V4 帧进环";
    detail = `hub=${hubTip} fe=${feTip} Δ+${tipDelta} lastV4AgeMs=${lastV4AgeMs ?? "∅"} streamMax=${streamMax ?? "∅"} sub=${subscriptionId.slice(0, 12)}`;
  } else if (hubAhead) {
    verdict = "HUB_AHEAD";
    title = "hub tip 超前，帧在途或尚未 apply";
    detail = `hub=${hubTip} fe=${feTip} Δ+${tipDelta} streamMax=${streamMax ?? "∅"} catchup=${catchupReason || "∅"}`;
  } else if (
    input.hasOptimistic &&
    streamMax == null &&
    !input.windowHasLive
  ) {
    verdict = "WIRE_WITHOUT_V4_TIP";
    title = "AG-UI 在跑，V4 投影 tip 未跟上";
    detail = `乐观泡有、streamMax=∅、窗无 streaming；sub=${subscriptionId.slice(0, 12)} active=${subActive === true ? 1 : subActive === false ? 0 : "∅"}`;
  } else if (
    streamMax != null &&
    feTip != null &&
    streamMax > feTip
  ) {
    verdict = "STREAM_AHEAD";
    title = "流式 tip 超前投影窗（软顶挤出）";
    detail = `streamMax=${streamMax} feTip=${feTip} Δ+${streamMax - feTip}`;
  } else {
    verdict = "OK";
    title = "投递路径对齐";
    detail = `feTip=${feTip ?? "∅"} hubTip=${hubTip ?? "∅"} streamMax=${streamMax ?? "∅"} sub=${subscriptionId.slice(0, 12)}`;
  }

  return {
    verdict,
    title,
    detail,
    framesUp,
    storeStatus,
    subscriptionId,
    subActive,
    stagedCount,
    activeSubCount,
    feTip,
    hubTip,
    tipDelta,
    streamMax,
    lastV4AgeMs,
    catchupReason,
    catchupNotified,
    catchupAgeMs,
    subscriberCount,
    executing,
    settled,
  };
}

export function formatV4PathProbeForDiag(probe: V4PathProbe): string[] {
  const bad =
    probe.verdict !== "OK" &&
    probe.verdict !== "IDLE";
  const mark = bad ? " ←根因" : "";
  return [
    "### 根因对账（V4 投递路径）",
    `- verdict=${probe.verdict} · ${probe.title}${mark}`,
    `- ${probe.detail}`,
    `- frames=${probe.framesUp ? "up" : "down"} store=${probe.storeStatus || "∅"} sub=${probe.subscriptionId ? probe.subscriptionId.slice(0, 16) : "∅"} active=${probe.subActive === true ? 1 : probe.subActive === false ? 0 : "∅"} staged=${probe.stagedCount ?? "∅"} activeSubs=${probe.activeSubCount}`,
    `- tip fe=${probe.feTip ?? "∅"} hub=${probe.hubTip ?? "∅"} Δ=${probe.tipDelta ?? "∅"} streamMax=${probe.streamMax ?? "∅"} lastV4AgeMs=${probe.lastV4AgeMs ?? "∅"}`,
    `- catchup reason=${probe.catchupReason || "∅"} notified=${probe.catchupNotified ?? "∅"} ageMs=${probe.catchupAgeMs ?? "∅"} hubSubs=${probe.subscriberCount ?? "∅"}`,
  ];
}

/** 把路径根因塞进异常表（与 WIRE_WITHOUT_V4_TIP 并存时优先看 V4_PATH_*）。 */
export function anomalyFromV4PathProbe(probe: V4PathProbe): {
  code:
    | "V4_PATH_FRAMES_DOWN"
    | "V4_PATH_NO_SUB"
    | "V4_PATH_SUB_STAGED"
    | "V4_PATH_HUB_AHEAD_NOTIFIED0"
    | "V4_PATH_HUB_AHEAD_NO_FRAMES";
  severity: "error";
  title: string;
  detail: string;
} | null {
  const map: Record<
    string,
    | "V4_PATH_FRAMES_DOWN"
    | "V4_PATH_NO_SUB"
    | "V4_PATH_SUB_STAGED"
    | "V4_PATH_HUB_AHEAD_NOTIFIED0"
    | "V4_PATH_HUB_AHEAD_NO_FRAMES"
    | null
  > = {
    FRAMES_SSE_DOWN: "V4_PATH_FRAMES_DOWN",
    NO_STORE_SUB: "V4_PATH_NO_SUB",
    SUB_NOT_ACTIVATED: "V4_PATH_SUB_STAGED",
    HUB_AHEAD_NOTIFIED0: "V4_PATH_HUB_AHEAD_NOTIFIED0",
    HUB_AHEAD_NO_FRAMES: "V4_PATH_HUB_AHEAD_NO_FRAMES",
  };
  const code = map[probe.verdict] ?? null;
  if (!code) return null;
  return {
    code,
    severity: "error",
    title: probe.title,
    detail: probe.detail,
  };
}
