// zcode-protocol-v4 toolCall 的展示层 schema。
// 从 rows.ts 拆出：两侧增量叠加后 rows.ts 触发 oxlint max-lines(400)。
// 本文件只含不依赖 rowBaseFields 的纯展示 union，rows.ts 单向依赖它，无循环。
import { z } from "zod";
import { bashOutputDisplaySchema } from "../bash-output-display.js";
import { timestampSchema } from "./core.js";
import { OFFICIAL_MCP_TOOL_ERROR_CODES } from "../official-mcp-tool-error.js";
import { cuaRequestAccessStatusSchema } from "./cuaPermission.js";
import { toolCallCreateWorkflowDisplaySchema } from "./create-workflow-display.js";
import {
  toolCallEvalWorkflowSnippetDisplaySchema,
  toolCallGetWorkflowRunDisplaySchema,
  toolCallListModelsDisplaySchema,
  toolCallListWorkflowRunsDisplaySchema,
  toolCallSavedWorkflowListDisplaySchema,
  toolCallResumeWorkflowRunDisplaySchema,
} from "./workflow-observation-display.js";

// toolCall 终态 output 的结构化展示模型（port 自 feat；CUA 工具靠 kind:"cua" 分支把
// errorCode/suggestedAction/media(screenshot) 等结构化内容带到 renderer）。consume-main 之前
// 缺这个 union + toolOutputSchema.display 字段——协议层 zod 校验会把 agent 下发的 display 整个
// strip 掉，导致 UI 永远拿不到 display?.kind==="cua"，CUA 工具调用退化成 fallback 渲染。
const toolResultDisplaySchema = z.discriminatedUnion("kind", [
  bashOutputDisplaySchema,
  z.object({
    kind: z.literal("file_diff"),
    filePath: z.string().min(1),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    structuredPatch: z.array(
      z.object({
        oldStart: z.number().int(),
        oldLines: z.number().int(),
        newStart: z.number().int(),
        newLines: z.number().int(),
        lines: z.array(z.string()),
      }),
    ),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("local_agent_message"),
    status: z.enum(["success", "failed"]),
    error: z.string().optional(),
    message: z.string().optional(),
  }),
  z.object({
    kind: z.literal("task_stop"),
    taskId: z.string().min(1),
    taskType: z.string().min(1),
    command: z.string().min(1).optional(),
    message: z.string().min(1),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("task_output"),
    retrievalStatus: z.enum(["success", "not_ready", "timeout"]),
    taskStatus: z.string().min(1).max(64).optional(),
    output: z.string().min(1).max(2_000).optional(),
    truncated: z.literal(true).optional(),
  }),
  z.object({
    kind: z.literal("respond_to_coordinator"),
    status: z.enum(["success", "failed"]),
  }),
  z.object({
    kind: z.literal("cua"),
    schemaVersion: z.literal(1),
    toolName: z.string().min(1),
    status: z.enum(["success", "failed"]),
    // 旧 v1 snapshot 曾重复携带 ToolCallRow.input；只为历史回放继续接受。
    input: z.string().optional(),
    structuredContent: z.string().optional(),
    text: z.string().optional(),
    errorCode: z.string().optional(),
    suggestedAction: z.string().optional(),
    permissionStatus: cuaRequestAccessStatusSchema.optional(),
    targetApp: z
      .object({
        schemaVersion: z.literal(1),
        displayName: z.string().trim().min(1).max(512).optional(),
        iconLocators: z
          .array(
            z.discriminatedUnion("kind", [
              z
                .object({
                  kind: z.literal("darwin-bundle-id"),
                  value: z.string().trim().min(1).max(512),
                })
                .strict(),
              z
                .object({
                  kind: z.literal("windows-executable-path"),
                  value: z.string().trim().min(1).max(32_768),
                })
                .strict(),
              z
                .object({
                  kind: z.literal("windows-aumid"),
                  value: z.string().trim().min(1).max(512),
                })
                .strict(),
            ]),
          )
          .max(3),
      })
      .strict()
      .optional(),
    media: z
      .array(
        z.object({
          mimeType: z.string().min(1),
          data: z.string().min(1).max(349_528).optional(),
          artifactUri: z.string().min(1).optional(),
        }),
      )
      .max(4)
      .optional(),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("mcp_tool"),
    serverName: z.string().min(1).max(256),
    toolName: z.string().min(1).max(256),
    description: z
      .string()
      .min(1)
      .max(4 * 1024)
      .optional(),
    // 与 toolCallMcpDisplaySchema 同源：不在这里声明，zod 会把 agent 下发的 unavailable
    // 静默 strip 掉，官方 MCP 额度提示在 v4 链路上失效（同本文件顶部 display strip 的坑）。
    unavailable: z
      .object({ code: z.enum(OFFICIAL_MCP_TOOL_ERROR_CODES) })
      .strict()
      .optional(),
  }),
  // buildToolOutput 把 CLI 侧 ToolResultDisplayPayload 原样塞进 toolOutput.display，
  // 而这条 union 是 strict 的——create_workflow 不在成员里，CreateWorkflow 的 display 会被整段
  // 拒掉/剥掉，工具卡退化成纯文本。两侧成员表必须同步（同 contracts 的
  // toolResultDisplayPayloadSchema），所以直接复用 toolCall 侧同形的那份 schema。
  toolCallCreateWorkflowDisplaySchema,
  // 观察类工作流工具的五个 display kind + ResumeWorkflowRun 的恢复卡（同上：与 contracts
  // 侧同步，缺成员 = 整块被剥）。
  toolCallGetWorkflowRunDisplaySchema,
  toolCallListWorkflowRunsDisplaySchema,
  toolCallEvalWorkflowSnippetDisplaySchema,
  toolCallSavedWorkflowListDisplaySchema,
  toolCallListModelsDisplaySchema,
  toolCallResumeWorkflowRunDisplaySchema,
]);
export type ToolResultDisplay = z.infer<typeof toolResultDisplaySchema>;

// toolCall。终态 output 全档统一 head+tail 截断，超出走 truncated.ref 按需拉。
// display 是展示载荷；版本不兼容时降级为无卡片，避免同一内容导致整条订阅反复恢复失败。
export const toolOutputSchema = z.object({
  text: z.string(),
  display: toolResultDisplaySchema.optional().catch(undefined),
  truncated: z
    .object({
      totalBytes: z.number(),
      ref: z.string(),
    })
    .optional(),
});
export type ToolOutput = z.infer<typeof toolOutputSchema>;

export const toolProgressSchema = z.object({
  bytes: z.number(),
  previewLine: z.string().optional(),
  updatedAt: timestampSchema,
});
export type ToolProgress = z.infer<typeof toolProgressSchema>;

/**
 * node_repl cell 的目标应用身份（Computer Use 的工具卡图标）。与 CLI contracts 的
 * `nodeReplCuaAppDisplaySchema` 必须同集——两侧都是 strict，少一个字段会让整块 display 被剥掉。
 */
const toolCallNodeReplCuaAppDisplaySchema = z
  .object({
    appKey: z.string().trim().min(1).max(2_048),
    displayName: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

const toolCallNodeReplImageDisplaySchema = z
  .object({
    kind: z.literal("node_repl_images"),
    // images 可选：CUA 的纯动作 cell 没有截图，但仍要携带 app 身份。kind 名保留不动，
    // 改名会让已持久化的 row 在这条 strict union 里整段校验失败。
    images: z
      .array(
        z
          .object({
            base64: z
              .string()
              .min(1)
              .max(200 * 1024),
            mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/iu),
          })
          .strict(),
      )
      .min(1)
      .max(2)
      .optional(),
    app: toolCallNodeReplCuaAppDisplaySchema.optional(),
    truncated: z.boolean().optional(),
    source: z.literal("browser_turn_end").optional(),
  })
  .strict();

const toolCallTaskOutputDisplaySchema = z
  .object({
    kind: z.literal("task_output"),
    retrievalStatus: z.enum(["success", "not_ready", "timeout"]),
    taskStatus: z.string().min(1).max(64).optional(),
    output: z.string().min(1).max(2_000).optional(),
    truncated: z.literal(true).optional(),
  })
  .strict();

const toolCallRespondToCoordinatorDisplaySchema = z
  .object({
    kind: z.literal("respond_to_coordinator"),
    status: z.enum(["success", "failed"]),
  })
  .strict();

const toolCallMcpDisplaySchema = z
  .object({
    kind: z.literal("mcp_tool"),
    serverName: z.string().min(1).max(256),
    toolName: z.string().min(1).max(256),
    description: z
      .string()
      .min(1)
      .max(4 * 1024)
      .optional(),
    /**
     * 官方 Server MCP 判定本次调用不可用（额度耗尽 / 无 Coding Plan）时下发的结构化标识。
     * CLI 侧只在官方来源 + isError 时填充，UI 据此在输入框上方提示。
     * 与 CLI contracts 的 mcpToolResultDisplayPayloadSchema 必须同步——两侧都是 strict，
     * 少加一处会让整条 row 校验失败。
     */
    unavailable: z
      .object({ code: z.enum(OFFICIAL_MCP_TOOL_ERROR_CODES) })
      .strict()
      .optional(),
  })
  .strict();

export const toolCallDisplaySchema = z.discriminatedUnion("kind", [
  toolCallNodeReplImageDisplaySchema,
  toolCallTaskOutputDisplaySchema,
  toolCallRespondToCoordinatorDisplaySchema,
  toolCallMcpDisplaySchema,
  toolCallCreateWorkflowDisplaySchema,
  toolCallGetWorkflowRunDisplaySchema,
  toolCallListWorkflowRunsDisplaySchema,
  toolCallEvalWorkflowSnippetDisplaySchema,
  toolCallSavedWorkflowListDisplaySchema,
  toolCallListModelsDisplaySchema,
  toolCallResumeWorkflowRunDisplaySchema,
]);
export type ToolCallDisplay = z.infer<typeof toolCallDisplaySchema>;
