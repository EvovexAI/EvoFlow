/* 官方 Server MCP 在 tool 调用被拦截 / 失败时下发的结构化标识。
 *
 * 服务端把它渲染成 **tool error content 的 JSON 文本**（不是 `_meta`）：
 * `{"error_code":"quota_exceeded","message":"...","request_id":"..."}`
 * 见 zcode-server `internal/domain/servermcp/toolerror.go` 的 `ToolError.Error()`。
 *
 * 放在 shared 是因为有三个分属不同包的消费者：
 * - `apps/zcode-cli/packages/core`：解析 MCP 结果，把 code 带进 tool result display；
 * - `packages/shared/src/zcode-protocol-v4/rows.ts`：row schema 校验该 code；
 * - `packages/ui`：按 code 决定输入框上方提示的文案与动作。
 * 三处必须同源，否则新增 code 时会出现一侧识别、另一侧丢弃。
 */

/**
 * 客户端会据此改变界面行为的 code。
 *
 * 服务端还有 `internal_error`，**故意不在这里**：它是"其它一切失败"的兜底掩码
 * （详情只留在服务端日志），用户无法自助解决，不该弹提示。
 */
export const OFFICIAL_MCP_TOOL_ERROR_CODES = ["quota_exceeded", "coding_plan_required"] as const;

export type OfficialMcpToolErrorCode = (typeof OFFICIAL_MCP_TOOL_ERROR_CODES)[number];

const OFFICIAL_MCP_TOOL_ERROR_CODE_SET = new Set<string>(OFFICIAL_MCP_TOOL_ERROR_CODES);

export interface OfficialMcpToolError {
  code: OfficialMcpToolErrorCode;
  /** 服务端给的英文可读文案；仅用于日志与排障，界面文案走 i18n。 */
  message?: string;
  /** 服务端 request id，便于与后端日志对账。 */
  requestId?: string;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * 从 tool error 文本里解析结构化标识。
 *
 * 严格解析：必须是 JSON 对象且 `error_code` 命中已知 code，否则返回 undefined。
 * 不做文案匹配兜底——那会让服务端改一句话就静默失效。
 */
export function parseOfficialMcpToolError(text: string): OfficialMcpToolError | undefined {
  const trimmed = text.trim();
  // 先按首字符快速排除绝大多数普通错误文本，避免每次失败都进 JSON.parse。
  if (!trimmed.startsWith("{")) return undefined;

  let payload: unknown;
  try {
    payload = JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null) return undefined;

  const record = payload as Record<string, unknown>;
  const code = readString(record.error_code);
  if (!code || !OFFICIAL_MCP_TOOL_ERROR_CODE_SET.has(code)) return undefined;

  const message = readString(record.message);
  const requestId = readString(record.request_id);
  return {
    code: code as OfficialMcpToolErrorCode,
    ...(message ? { message } : {}),
    ...(requestId ? { requestId } : {}),
  };
}
