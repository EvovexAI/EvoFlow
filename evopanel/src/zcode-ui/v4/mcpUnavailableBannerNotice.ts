import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import type { OfficialMcpToolErrorCode } from "@zcode/shared";

/**
 * 官方 Server MCP 本次会话内被判定不可用的事实（额度耗尽 / 无 Coding Plan）。
 *
 * 事实来源是 tool row 上的 `display.unavailable`——CLI 侧只对官方 MCP 且 isError 的结果填充，
 * 因此这里不需要再判来源。
 */
export interface McpUnavailableNotice {
  code: OfficialMcpToolErrorCode;
  serverName: string;
  toolName: string;
  /** 去重用：同一次调用只提示一次，换一次新的失败调用会重新提示。 */
  rowId: number;
}

function readMcpToolCallRow(row: ConversationRow): ToolCallRow | null {
  return row.kind === "toolCall" ? row : null;
}

/**
 * 取窗口内最新一条带不可用标识的官方 MCP 工具调用。
 *
 * 取"最新"而不是"第一条"：同一会话里可能先撞额度、后换了连接又撞权益，提示要跟随最近事实。
 * 注意 rows 是窗口视图，滚动很远后旧标识会离开窗口、提示随之消失——刚发生的调用一定在窗口内，
 * 这是可接受的取舍。
 */
export function resolveMcpUnavailableNotice(
  rows: readonly ConversationRow[] | undefined,
): McpUnavailableNotice | null {
  if (!rows || rows.length === 0) return null;
  const seenTools = new Set<string>();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row) continue;
    const toolCallRow = readMcpToolCallRow(row);
    if (!toolCallRow) continue;
    const display = toolCallRow.display;
    if (display?.kind !== "mcp_tool") continue;
    const toolKey = `${display.serverName}\u0000${display.toolName}`;
    if (seenTools.has(toolKey)) continue;
    seenTools.add(toolKey);
    // 同一工具的最新成功事实覆盖旧失败；继续查找其它工具仍未被成功覆盖的失败。
    if (!display.unavailable) continue;
    return {
      code: display.unavailable.code,
      rowId: toolCallRow.rowId,
      serverName: display.serverName,
      toolName: display.toolName,
    };
  }
  return null;
}
