/** Centralized UI placeholders for Owned KB (no backend fields yet). */
export const KB_UI_PLACEHOLDERS = {
  healthScore: 86,
  detailHealthScore: 92,
  healthLabel: "健康",
  healthHints: ["索引覆盖良好", "向量维度对齐", "建议每周再同步一次"],
  visitTrend: [
    { day: "一", visits: 12 },
    { day: "二", visits: 18 },
    { day: "三", visits: 9 },
    { day: "四", visits: 22 },
    { day: "五", visits: 16 },
    { day: "六", visits: 7 },
    { day: "日", visits: 11 },
  ],
  assistantPrompts: ["总结当前库要点", "找出高频主题", "列出待完善文档"],
};

export function kbSearchShortcutLabel() {
  if (typeof navigator === "undefined") return "Ctrl+K";
  return /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "") ? "⌘K" : "Ctrl+K";
}
