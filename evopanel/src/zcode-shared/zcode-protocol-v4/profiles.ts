// Delivery profile 过滤纯函数。
// 通道层 flush 管线的第一步：filter → coalesce → 打帧。恢复回放走同一函数
// （「先过该订阅者的 profile 过滤器再 coalesce」），保证断线重连的确定性重投递。
//
// 收口不变量（进黄金测试）：被 profile 过滤的事件必须最终被某个不可过滤的事件收口——
// row.delta(inputText) 被滤掉后，工具输入定稿时的 row.upserted 必须携带完整 inputText，
// 否则 replayable 订阅者终态缺数据。任何 reducer 改动破坏该不变量会撞
// 「两 profile 终态逐字节一致」测试。
import type { DeliveryProfile } from "./core.js";
import type { ConversationDelta } from "./delta.js";
import type { ConversationRow } from "./rows.js";

export function filterConversationRowsForProfile(
  rows: readonly ConversationRow[],
  _profile: DeliveryProfile,
): ConversationRow[] {
  // HookInvocationRow 已收敛为 desktop/mobile 共用的 client-safe summary；当前没有
  // profile-specific 完整行，仍保留纯函数边界供未来受控 row 使用。
  return [...rows];
}

/**
 * 按 profile 的 streamPaths 开关过滤 delta 序列。
 * row.delta 按流式能力过滤；结构性完整行在两个 profile 中保持同一产品事实。
 * 纯函数，不修改入参；输出保持权威日志序。
 */
export function filterConversationDeltasForProfile(
  deltas: readonly ConversationDelta[],
  profile: DeliveryProfile,
): ConversationDelta[] {
  return deltas.filter((delta) => {
    if (delta.op === "row.delta") return profile.streamPaths[delta.path];
    return true;
  });
}
