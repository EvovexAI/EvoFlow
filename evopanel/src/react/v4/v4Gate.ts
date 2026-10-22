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
 * TOOL_CALL_START/END/RESULT 与 RUN_*、CUSTOM、平台事件保持放行：审批检测 /
 * 工件 / plan / 协作 / 右侧面板配置等业务逻辑依赖它们。
 */
const V4_GATED_AGUI_DISPLAY_TYPES: ReadonlySet<string> = new Set([
  "TEXT_MESSAGE_START",
  "TEXT_MESSAGE_CONTENT",
  "TEXT_MESSAGE_END",
  "REASONING_MESSAGE_START",
  "REASONING_MESSAGE_CONTENT",
  "REASONING_MESSAGE_END",
]);

/**
 * 重型参数流工具（小写）：只有它们的 TOOL_CALL_ARGS 才闸——参数逐 token 流式，
 * 是 60fps 热路径的主要来源之一。平台工具（panel_set/stage_set/platform 等）
 * 的参数是右侧面板配置/交互载荷且量小，必须放行旧链路：
 * TOOL_CALL_RESULT 分支从 aguiTurn 读 argsText 配置面板，闸掉会让右侧通知整块消失。
 * 名单与 agui-turn-reducer 的 write-progress 一致并补 edit/patch 族。
 */
const V4_GATED_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "write",
  "write_file",
  "write_to_file",
  "edit",
  "edit_file",
  "replace",
  "str_replace",
  "replace_in_file",
  "multi_edit",
  "apply_patch",
]);

const V4_TOOL_NAME_MEMORY_MAX = 512;
const v4ToolNameById = new Map<string, string>();

export function isV4GatedAgUiDisplayEvent(type: unknown): boolean {
  return V4_GATED_AGUI_DISPLAY_TYPES.has(String(type || ""));
}

export function isV4GatedAgUiEvent(
  event: { type?: unknown; toolCallId?: unknown; toolCallName?: unknown } | null | undefined,
): boolean {
  if (!event) return false;
  const type = String(event.type || "");

  // TOOL_CALL_START 永远放行（旧链路登记 + 平台交互），顺手登记工具名供 ARGS 判定
  //（ARG 事件本身不带工具名）。
  if (type === "TOOL_CALL_START") {
    const tcid = String(event.toolCallId || "").trim();
    const name = String(event.toolCallName || "").trim();
    if (tcid && name) {
      v4ToolNameById.set(tcid, name);
      if (v4ToolNameById.size > V4_TOOL_NAME_MEMORY_MAX) {
        const oldest = v4ToolNameById.keys().next().value;
        if (oldest !== undefined) v4ToolNameById.delete(oldest);
      }
    }
    return false;
  }

  if (type === "TOOL_CALL_ARGS") {
    const tcid = String(event.toolCallId || "").trim();
    const name = (tcid ? v4ToolNameById.get(tcid) : "") || "";
    return V4_GATED_WRITE_TOOL_NAMES.has(name.toLowerCase());
  }

  return V4_GATED_AGUI_DISPLAY_TYPES.has(type);
}
