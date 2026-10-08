import { z } from "zod";
import { browserErrorCodeSchema, browserPageStateSchema } from "./commands.js";
import { browserViewportSizeSchema } from "./command-metadata.js";
import { browserBackendTypeSchema } from "./backend.js";
import { browserSnapshotSchema, browserSnapshotElementSchema } from "./snapshot.js";

/**
 * 受控 tab 摘要（list 命令返回）：agent 用 tabId 寻址某个具体 tab（含 human 开的 tab）。
 */
export const browserTabSummarySchema = z
  .object({
    tabId: z.string(),
    url: z.string(),
    title: z.string(),
    /** guest 当前真实 CSS viewport；normal/free-size 均必须返回。 */
    viewport: browserViewportSizeSchema,
    /**
     * main 侧最近可见/激活的内置浏览器 tab。用于让 agent 在用户手动改地址后，
     * 先绑定并读取当前页面，而不是误读 session 默认 tab。
     */
    active: z.boolean().optional(),
    lifecycle: z.enum(["active", "deliverable", "handoff"]).optional(),
  })
  .strict();
export type BrowserTabSummary = z.infer<typeof browserTabSummarySchema>;

/** 尚未被当前 browser session claim 的用户 IAB tab；claim 前不能执行普通 Tab command。 */
export const browserUserTabInfoSchema = z
  .object({
    id: z.string().min(1),
    lastOpened: z.string().optional(),
    tabGroup: z.string().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
  })
  .strict();
export type BrowserUserTabInfo = z.infer<typeof browserUserTabInfoSchema>;

/** JS 弹窗信息（getDialog 返回）。 */
export const browserDialogSchema = z
  .object({
    type: z.enum(["alert", "confirm", "prompt", "beforeunload"]),
    message: z.string(),
    defaultPrompt: z.string().optional(),
  })
  .strict();
export type BrowserDialog = z.infer<typeof browserDialogSchema>;

/** browser command 的 UI/客户端元数据；不会自动变成模型 image block。 */
export const browserResponseMetaSchema = z
  .object({
    browserUse: z.literal(true),
    backendType: browserBackendTypeSchema,
    browserId: z.string().min(1),
    browserGeneration: z.number().int().nonnegative(),
    openTabIds: z.array(z.string()),
    tabId: z.string().optional(),
    currentUrl: z.string().optional(),
    lifecycle: z.enum(["active", "deliverable", "handoff", "closed"]).optional(),
  })
  .strict();
export type BrowserResponseMeta = z.infer<typeof browserResponseMetaSchema>;

export const browserRecordingArtifactSchema = z
  .object({
    path: z.string().min(1),
    mimeType: z.literal("video/webm"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive(),
    durationMs: z.number().nonnegative(),
    frameCount: z.number().int().nonnegative(),
  })
  .strict();
export type BrowserRecordingArtifact = z.infer<typeof browserRecordingArtifactSchema>;

export const browserRecordingJobSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(["running", "completed", "failed", "cancelled"]),
    phase: z.enum(["preparing", "capturing", "finalizing", "completed", "failed", "cancelled"]),
    progress: z.number().min(0).max(1),
    startedAt: z.number().nonnegative(),
    updatedAt: z.number().nonnegative(),
    artifact: browserRecordingArtifactSchema.optional(),
    error: z.string().optional(),
  })
  .strict();
export type BrowserRecordingJob = z.infer<typeof browserRecordingJobSchema>;

/**
 * browser 命令的统一结果（agent BrowserControlPort / 协议 result / main executor 三处同源）。
 * 截图走 image；导航/getState 回 state；snapshot 回 snapshot；list 回 tabs；失败回结构化 error。
 */
export const browserCommandResultSchema = z
  .object({
    ok: z.boolean(),
    state: browserPageStateSchema.optional(),
    snapshot: browserSnapshotSchema.optional(),
    image: z
      .object({ base64: z.string(), mimeType: z.literal("image/png") })
      .strict()
      .optional(),
    /** list 命令返回：只包含当前 window/workspace/session/generation scope 可见的 tabs。 */
    tabs: z.array(browserTabSummarySchema).optional(),
    /** BrowserUser.openTabs() 返回；与当前 session 自有 tabs.list() 严格分离。 */
    userTabs: z.array(browserUserTabInfoSchema).optional(),
    /** newTab 返回的单个真实 tab。 */
    tab: browserTabSummarySchema.optional(),
    /** evaluate 返回：页面表达式的可 JSON 序列化结果。 */
    value: z.unknown().optional(),
    /** elementInfo 返回：坐标命中元素的信息（复用快照元素结构；未命中则省略）。 */
    element: browserSnapshotElementSchema.optional(),
    /** getDialog 返回：当前 JS 弹窗信息；无弹窗时为 null。 */
    dialog: browserDialogSchema.nullable().optional(),
    /** WebView 异步录制任务；main 临时 path 会在 Host materialize 后改写为 workspace path。 */
    recording: browserRecordingJobSchema.optional(),
    error: z
      .object({
        code: browserErrorCodeSchema,
        message: z.string(),
        sideEffect: z.enum(["none", "uncertain"]).optional(),
      })
      .strict()
      .optional(),
    meta: browserResponseMetaSchema.optional(),
    elapsedMs: z.number().nonnegative(),
  })
  .strict();
export type BrowserCommandResult = z.infer<typeof browserCommandResultSchema>;
