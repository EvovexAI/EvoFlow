import type { ArmsCustomEventPayload, IPlatformService } from "@zcode/shared";
import { logger } from "@/logger.js";

// Composer 发送漏斗埋点的 ARMS 出口。
// 本组事件只走 ARMS，不进 /event/report；reporter 由 Root.tsx 按 isDesktop 安装，
// Web / 手机远控拿不到 reporter，整组静默。

const SEND_FUNNEL_ARMS_GROUP = "send_funnel";

const SEND_FUNNEL_EVENT_INPUT_FOCUS = "send_input_focus";
const SEND_FUNNEL_EVENT_SEND_CLICK = "send_click";
const SEND_FUNNEL_EVENT_SEND_RESULT = "send_result";

type ArmsReporter = Pick<IPlatformService, "reportArmsCustomEvent">;

/** 发送落定的原因码。 */
export type SendFunnelReasonCode =
  | "attachment_not_ready"
  | "blocked"
  | "rejected"
  | "stale"
  | "failed"
  | "render_timeout"
  | "transport_error"
  | "provider_not_ready"
  | "composer_error";

let armsReporter: ArmsReporter | null = null;

export function setSendFunnelArmsReporter(reporter: ArmsReporter | null): void {
  armsReporter = reporter;
}

// 原因:ARMS 属观测链路,发送主链路不得因埋点失败而中断。
function emit(payload: ArmsCustomEventPayload): void {
  if (!armsReporter) {
    return;
  }
  try {
    void Promise.resolve(armsReporter.reportArmsCustomEvent(payload)).catch((error) => {
      logger.warn("[send-funnel] ARMS 上报失败", { name: payload.name, error });
    });
  } catch (error) {
    logger.warn("[send-funnel] ARMS 上报异常", { name: payload.name, error });
  }
}

/** 会话态 / 草稿态，用于区分「已有会话里发」和「新建任务首发」两类漏斗。 */
function composerScopeOf(sessionId: string | null | undefined): "session" | "draft" {
  return sessionId ? "session" : "draft";
}

/** 空 sessionId / commandId 不下发对应 property，避免 ARMS 侧出现空串维度。 */
function optionalId(value: string | null | undefined): string | undefined {
  return value ? value : undefined;
}

/** 点击输入框（仅用户真实聚焦，程序性自动聚焦由 composer 侧拦截）。 */
export function reportSendFunnelInputFocus(params: {
  sessionId: string | null;
  focusTime: number;
}): void {
  emit({
    name: SEND_FUNNEL_EVENT_INPUT_FOCUS,
    group: SEND_FUNNEL_ARMS_GROUP,
    value: 1,
    properties: {
      focus_time: params.focusTime,
      composer_scope: composerScopeOf(params.sessionId),
      talk_id: optionalId(params.sessionId),
    },
  });
}

/** 点击发送 / Enter 提交并通过发送门禁。 */
export function reportSendFunnelSendClick(params: {
  sessionId: string | null;
  sendClickId: string;
  sendTime: number;
  trigger: "button" | "shortcut";
  extraDetail: Record<string, string>;
}): void {
  emit({
    name: SEND_FUNNEL_EVENT_SEND_CLICK,
    group: SEND_FUNNEL_ARMS_GROUP,
    value: 1,
    properties: {
      ...params.extraDetail,
      send_click_id: params.sendClickId,
      input_send_time: params.sendTime,
      send_trigger: params.trigger,
      composer_scope: composerScopeOf(params.sessionId),
      talk_id: optionalId(params.sessionId),
    },
  });
}

/**
 * 发送落定（成功与失败共用）。value 取 send_cost_ms，
 * 让 ARMS 可以直接对该事件做 avg/p50/p95/p99 并按 status / reason_code 切分。
 *
 * costMs 是**端到端**耗时：点击发送 → 用户消息呈现在对话历史里。
 * ackCostMs 单独留出「点击发送 → 收到 ACK」那一段，两者相减即「回流 + 渲染」耗时。
 */
export function reportSendFunnelSendResult(params: {
  sessionId: string | null;
  commandId?: string;
  sendClickId: string;
  status: "success" | "fail";
  ackStatus?: string;
  reasonCode?: SendFunnelReasonCode;
  costMs: number;
  ackCostMs?: number;
  queueConfirmed: boolean;
  extraDetail: Record<string, string>;
}): void {
  const costMs = Math.max(0, Math.round(params.costMs));
  const ackCostMs =
    params.ackCostMs === undefined ? undefined : Math.max(0, Math.round(params.ackCostMs));
  emit({
    name: SEND_FUNNEL_EVENT_SEND_RESULT,
    group: SEND_FUNNEL_ARMS_GROUP,
    value: costMs,
    properties: {
      ...params.extraDetail,
      send_click_id: params.sendClickId,
      status: params.status,
      reason_code: params.reasonCode,
      ack_status: params.ackStatus,
      send_cost_ms: costMs,
      ack_cost_ms: ackCostMs,
      send_queue_confirmed: params.queueConfirmed,
      talk_id: optionalId(params.sessionId),
      message_id: optionalId(params.commandId),
    },
  });
}
