/**
 * V4「已工作」折叠健康度校验。
 *
 * ZCode 约定：每个 visual work segment 折叠外最多一条 assistantText（段末/流式）。
 * 中间 complete 正文、工具链应在 history 里。一旦摊在外面，UI 就会像
 * 「多段已工作 + usage 叠罗汉」——肉眼难查，用这条 invariant 直接打 warn。
 *
 * 排查：
 * - DevTools / frontend 日志过滤 `[v4-life]` + `fold_anomaly`
 * - `window.__evoflowV4Life` 环形缓冲
 */
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";

export type FoldHealthFinding = {
  code:
    | "multi_visible_assistant_text"
    | "live_user_missing_from_flow"
    | "exposed_mid_complete_text";
  turnKey: string;
  segmentKey: string;
  detail: string;
};

export type FoldHealthReport = {
  ok: boolean;
  findings: FoldHealthFinding[];
  /** 稳定签名，变化才值得打日志 */
  signature: string;
};

function visibleAssistantTextsInSegment(unit: ConversationTurnRenderUnit, segmentKey: string): string[] {
  const segment = unit.workSegments?.find((s) => s.key === segmentKey);
  const items = segment?.flowItems ?? unit.flowItems ?? [];
  return items
    .filter((item) => item.kind === "assistantText")
    .map((item) => (item.kind === "assistantText" ? String(item.row.text || "").slice(0, 40) : ""));
}

/**
 * 纯函数：检查 render units 是否违反「一段一可见正文」等折叠约定。
 */
export function inspectConversationTurnFoldHealth(
  units: readonly ConversationTurnRenderUnit[],
): FoldHealthReport {
  const findings: FoldHealthFinding[] = [];

  for (const unit of units) {
    const segments = unit.workSegments?.length
      ? unit.workSegments
      : [
          {
            key: unit.key,
            flowItems: unit.flowItems ?? [],
            assistantHistoryRows: unit.assistantHistoryRows ?? [],
            assistantFollowingRows: unit.assistantFollowingRows ?? [],
            assistantWorkRows: unit.assistantWorkRows ?? [],
            assistantHistoryDefaultOpen: unit.assistantHistoryDefaultOpen,
          },
        ];

    for (const segment of segments) {
      const visibleTexts = (segment.flowItems ?? [])
        .filter((item) => item.kind === "assistantText")
        .map((item) => (item.kind === "assistantText" ? item.row : null))
        .filter((row): row is NonNullable<typeof row> => row != null);

      if (visibleTexts.length > 1) {
        findings.push({
          code: "multi_visible_assistant_text",
          turnKey: unit.key,
          segmentKey: segment.key,
          detail: `折叠外 ${visibleTexts.length} 条正文：${visibleTexts
            .map((r) => `「${String(r.text || "").slice(0, 24)}」`)
            .join(" / ")}`,
        });
      }

      // 折叠外的 complete 正文必须是该段最后一条 assistantText；否则中间答复被摊开。
      const historyTexts = (segment.assistantHistoryRows ?? []).filter(
        (row) => row.kind === "assistantText",
      );
      const followingTexts = (segment.assistantFollowingRows ?? []).filter(
        (row) => row.kind === "assistantText",
      );
      const allSegmentTextIds = [
        ...historyTexts.map((r) => r.rowId),
        ...visibleTexts.map((r) => r.rowId),
        ...followingTexts.map((r) => r.rowId),
      ];
      const lastTextId = allSegmentTextIds.at(-1);
      for (const row of visibleTexts) {
        if (row.state !== "complete") continue;
        if (lastTextId != null && row.rowId !== lastTextId) {
          findings.push({
            code: "exposed_mid_complete_text",
            turnKey: unit.key,
            segmentKey: segment.key,
            detail: `中间 complete 正文留在折叠外 rowId=${row.rowId}「${String(row.text || "").slice(0, 24)}」(段末应为 ${lastTextId})`,
          });
        }
      }
    }

    if (unit.isLastTurn && unit.isRunning) {
      const realUsers = unit.visibleUserInputs.filter((r) => r.origin === "realUser");
      const flowHasUser = (unit.workSegments ?? []).some((s) =>
        s.flowItems.some((item) => item.kind === "userInput"),
      );
      if (realUsers.length > 0 && !flowHasUser) {
        findings.push({
          code: "live_user_missing_from_flow",
          turnKey: unit.key,
          segmentKey: unit.workSegments?.at(-1)?.key ?? unit.key,
          detail: `直播轮有 visibleUserInputs(${realUsers.length}) 但 flowItems 无 userInput`,
        });
      }
    }
  }

  const signature = findings
    .map((f) => `${f.code}:${f.turnKey}:${f.segmentKey}:${f.detail}`)
    .join("|");
  return { ok: findings.length === 0, findings, signature };
}

/** 给日志用的短中文摘要。 */
export function summarizeFoldHealthFindings(findings: readonly FoldHealthFinding[]): string {
  if (findings.length === 0) return "折叠健康";
  return findings.map((f) => `[${f.code}] ${f.detail}`).join("；");
}

/** 测试/诊断辅助：取某 unit 某 segment 折叠外正文预览。 */
export function debugVisibleAssistantTexts(
  unit: ConversationTurnRenderUnit,
  segmentKey: string,
): string[] {
  return visibleAssistantTextsInSegment(unit, segmentKey);
}
