// V4 双轨闸门 + 开关（EvoFlow 自有代码；渲染路径不依赖 zcode-ui 组件）。
// 协议语义是 ZCode v4 的（wire/seq/apply），协议客户端（无 UI 的 store 数据层）
// 复用 vendor 树的 ConversationProjectionStore —— 它不是 UI 组件框架的一部分。

/** 双轨开关：**默认开启**。URL `?chatV4=0` 或 localStorage.evoflow_chat_v4=0 显式退回老链路；
`?chatV4=1` 强制开（调参调试用）。 */
export function isEvoflowChatV4Enabled(): boolean {
  try {
    const url = new URL(globalThis.location.href);
    const q = url.searchParams.get("chatV4");
    if (q === "1") return true;
    if (q === "0") return false;
    const stored = globalThis.localStorage?.getItem("evoflow_chat_v4");
    if (stored === "0") return false;
    if (stored === "1") return true;
  } catch {
    // ignore — 默认开启
  }
  return true;
}

/**
 * flag 开启时，这些 AG-UI 事件不再进老显示管线（streamRef / rt.rows / bump）——
 * 它们是逐 token 热路径（60fps × O(rows) 的来源），显示由 V4 帧管线接管。
 * TOOL_CALL_START/END/RESULT 与 RUN_* 保持放行：审批检测 / 工件 / plan / 协作
 * 等业务逻辑依赖它们，且频率是"每次工具调用"而非"每 token"。
 */
const V4_GATED_AGUI_DISPLAY_TYPES: ReadonlySet<string> = new Set([
  "TEXT_MESSAGE_START",
  "TEXT_MESSAGE_CONTENT",
  "TEXT_MESSAGE_END",
  "REASONING_MESSAGE_START",
  "REASONING_MESSAGE_CONTENT",
  "REASONING_MESSAGE_END",
  "TOOL_CALL_ARGS",
]);

export function isV4GatedAgUiDisplayEvent(type: unknown): boolean {
  return V4_GATED_AGUI_DISPLAY_TYPES.has(String(type || ""));
}

export function isV4GatedAgUiEvent(event: { type?: unknown } | null | undefined): boolean {
  if (!event) return false;
  return isV4GatedAgUiDisplayEvent(event.type);
}
