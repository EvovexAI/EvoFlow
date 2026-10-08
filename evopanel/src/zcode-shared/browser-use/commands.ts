/* eslint-disable max-lines -- BrowserCommand 的 Zod discriminated union 必须保持单一运行时事实源，拆分会让协议方法与 schema 漂移。 */
import { z } from "zod";
import { browserViewportInputSchema } from "./command-metadata.js";

export {
  browserClientModeSchema,
  browserCommandContextSchema,
  browserCommandMethodSchema,
  browserErrorCodeSchema,
  browserPageStateSchema,
} from "./command-metadata.js";
export type {
  BrowserClientMode,
  BrowserCommandContext,
  BrowserCommandMethod,
  BrowserErrorCode,
  BrowserPageState,
} from "./command-metadata.js";

export const browserMouseButtonSchema = z.enum(["left", "right", "middle"]);
export type BrowserMouseButton = z.infer<typeof browserMouseButtonSchema>;

/** 键盘修饰键；CDP dispatchMouse/KeyEvent 的 modifiers 位掩码由 executor 映射。 */
export const browserKeyModifierSchema = z.enum([
  "Alt",
  "Control",
  "ControlOrMeta",
  "Meta",
  "Shift",
]);
export type BrowserKeyModifier = z.infer<typeof browserKeyModifierSchema>;

/** 视口坐标点（cua 坐标路 / elementInfo / drag 用；与 CDP Input 同坐标系）。 */
export const browserPointSchema = z.object({ x: z.number(), y: z.number() }).strict();
export type BrowserPoint = z.infer<typeof browserPointSchema>;

const browserRecordingDurationSchema = z.number().int().nonnegative().max(90_000);
const browserRecordingSelectorSchema = z.string().trim().min(1).max(2_000);

/** 内置 WebView 录制只接受受限动作 DSL；不能借录制入口执行任意页面脚本。 */
export const browserRecordingActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("wait"), durationMs: browserRecordingDurationSchema }).strict(),
  z
    .object({
      type: z.literal("click"),
      selector: browserRecordingSelectorSchema.optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      button: browserMouseButtonSchema.optional(),
      doubleClick: z.boolean().optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("type"),
      selector: browserRecordingSelectorSchema,
      text: z.string().max(100_000),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("hover"),
      selector: browserRecordingSelectorSchema.optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      durationMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("move"),
      x: z.number(),
      y: z.number(),
      durationMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("scroll"),
      deltaX: z.number().optional(),
      deltaY: z.number(),
      durationMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("scrollTo"),
      selector: browserRecordingSelectorSchema.optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      durationMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("wheel"),
      deltaX: z.number().optional(),
      deltaY: z.number(),
      times: z.number().int().min(1).max(100).optional(),
      intervalMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("drag"),
      path: z.array(browserPointSchema).min(2).max(200),
      durationMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("waitFor"),
      selector: browserRecordingSelectorSchema,
      state: z.enum(["attached", "detached", "visible", "hidden"]).optional(),
      timeoutMs: z.number().int().positive().max(30_000).optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
]);
export type BrowserRecordingAction = z.infer<typeof browserRecordingActionSchema>;

export const browserRecordingOptionsSchema = z
  .object({
    viewport: browserViewportInputSchema.optional(),
    fps: z.number().int().min(1).max(60).optional(),
    jpegQuality: z.number().int().min(1).max(100).optional(),
    maxDurationMs: z.number().int().min(1_000).max(90_000).optional(),
    settleMs: browserRecordingDurationSchema.optional(),
    showCursor: z.boolean().optional(),
    actions: z.array(browserRecordingActionSchema).max(500).optional(),
  })
  .strict();
export type BrowserRecordingOptions = z.infer<typeof browserRecordingOptionsSchema>;

const browserRecordingOutputPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .refine((value) => !/^[/\\]/u.test(value) && !/^[A-Za-z]:[/\\]/u.test(value), {
    message: "recording outputPath must be relative to the workspace",
  })
  .refine(
    (value) =>
      !value
        .split(/[\\/]+/u)
        .some((segment) => segment === ".." || segment === "." || segment.length === 0),
    { message: "recording outputPath cannot escape the workspace" },
  )
  .refine((value) => value.toLowerCase().endsWith(".webm"), {
    message: "recording outputPath must end with .webm",
  });

/** Playwright locator 的可跨进程终结操作。builder 本身只在 agent 内组合 selector。 */
export const browserPlaywrightLocatorOperationSchema = z.enum([
  "allTextContents",
  "click",
  "count",
  "dblclick",
  "downloadMedia",
  "evaluate",
  "fill",
  "getAttribute",
  "innerText",
  "isEnabled",
  "isVisible",
  "press",
  "selectOption",
  "setChecked",
  "textContent",
  "waitFor",
]);
export type BrowserPlaywrightLocatorOperation = z.infer<
  typeof browserPlaywrightLocatorOperationSchema
>;

export const browserPlaywrightModifierSchema = z.enum([
  "Alt",
  "Control",
  "ControlOrMeta",
  "Meta",
  "Shift",
]);
export type BrowserPlaywrightModifier = z.infer<typeof browserPlaywrightModifierSchema>;

const browserPlaywrightTimeoutSchema = z.number().int().positive().optional();
const browserPlaywrightSelectOptionSchema = z
  .object({
    value: z.string().optional(),
    label: z.string().optional(),
    index: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (selection) =>
      selection.value !== undefined ||
      selection.label !== undefined ||
      selection.index !== undefined,
    "Select option requires value, label, or index",
  );

/**
 * Playwright 公共操作使用与 backend 无关的消息结构，以 `name` 和 `operation` 区分动作，
 * 便于 extension/CDP adapter 复用同一契约。
 */
export const browserPlaywrightActionSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("domSnapshot") }).strict(),
  z
    .object({
      name: z.literal("elementInfo"),
      x: z.number(),
      y: z.number(),
      includeNonInteractable: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      name: z.literal("elementScreenshot"),
      x: z.number(),
      y: z.number(),
      includeNonInteractable: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      name: z.literal("evaluate"),
      expression: z.string().min(1),
      expressionKind: z.enum(["string", "function"]),
      arg: z.unknown().optional(),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("waitForLoadState"),
      state: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("waitForURL"),
      url: z.string().min(1),
      waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional(),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("waitForEvent"),
      event: z.enum(["download", "filechooser"]),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("downloadPath"),
      downloadId: z.string().min(1),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("fileChooserSetFiles"),
      fileChooserId: z.string().min(1),
      files: z.array(z.string()).min(1),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("locator"),
      selector: z.string().min(1),
      operation: browserPlaywrightLocatorOperationSchema,
      value: z.unknown().optional(),
      arg: z.unknown().optional(),
      expression: z.string().min(1).optional(),
      expressionKind: z.enum(["string", "function"]).optional(),
      attribute: z.string().min(1).optional(),
      checked: z.boolean().optional(),
      replace: z.boolean().optional(),
      force: z.boolean().optional(),
      button: browserMouseButtonSchema.optional(),
      modifiers: z.array(browserPlaywrightModifierSchema).optional(),
      state: z.enum(["attached", "detached", "visible", "hidden"]).optional(),
      selections: z.array(browserPlaywrightSelectOptionSchema).min(1).optional(),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
]);
export type BrowserPlaywrightAction = z.infer<typeof browserPlaywrightActionSchema>;

/**
 * 统一命令面：后端只认这一个判别联合类型。
 *
 * tabId（可选）：agent 对象模型用于寻址指定受控 tab（含 human 开的 tab）。缺省表示作用于
 * 该会话默认 view。manager 侧以 `command.tabId ?? key` 解析为受控 view 的 key。
 */
export const browserCommandSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("navigate"),
      url: z.string().min(1),
      tabId: z.string().optional(),
    })
    .strict(),
  z.object({ method: z.literal("back"), tabId: z.string().optional() }).strict(),
  z.object({ method: z.literal("forward"), tabId: z.string().optional() }).strict(),
  z.object({ method: z.literal("reload"), tabId: z.string().optional() }).strict(),
  z
    .object({
      method: z.literal("snapshot"),
      maxElements: z.number().int().positive().optional(),
      includeHidden: z.boolean().optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("click"),
      // ref（快照句柄）与坐标 (x,y) 二选一：ref 走 dom_cua 式定位，(x,y) 走 cua 视觉坐标定位。
      ref: z.string().min(1).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      button: browserMouseButtonSchema.optional(),
      doubleClick: z.boolean().optional(),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("fill"),
      ref: z.string().min(1),
      value: z.string(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("type"),
      ref: z.string().min(1).optional(),
      text: z.string(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("press"),
      key: z.string().min(1),
      ref: z.string().min(1).optional(),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // CUA 组合键输入：keys 是一个组合键，必须保留逐键 down/up 顺序，不能压成末键 + bitmask。
  z
    .object({
      method: z.literal("cuaKeypress"),
      keys: z.array(z.string().min(1)).min(1),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("scroll"),
      ref: z.string().min(1).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // CUA 滚动输入：视口锚点与滚动 delta 是两组不同坐标，且可携带 modifier。
  z
    .object({
      method: z.literal("cuaScroll"),
      x: z.number(),
      y: z.number(),
      scrollX: z.number(),
      scrollY: z.number(),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // DOM CUA 滚动输入：nodeId 缺省时从视口中心滚动；存在时从该节点中心滚动。
  z
    .object({
      method: z.literal("domCuaScroll"),
      nodeId: z.string().min(1).optional(),
      scrollX: z.number(),
      scrollY: z.number(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("screenshot"),
      ref: z.string().min(1).optional(),
      fullPage: z.boolean().optional(),
      // 区域截图：CDP Page.captureScreenshot 的 clip（视口 CSS px）。与 fullPage 互斥。
      clip: z
        .object({
          x: z.number(),
          y: z.number(),
          width: z.number().positive(),
          height: z.number().positive(),
        })
        .strict()
        .optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z.object({ method: z.literal("getState"), tabId: z.string().optional() }).strict(),
  // hover：移动鼠标到元素(ref)或坐标(x,y)，触发 hover 态（cua move / dom_cua 定位后 move）。
  z
    .object({
      method: z.literal("hover"),
      ref: z.string().min(1).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // select：对 <select> 选择一个或多个 option（按 value 或可见文本匹配）。
  z
    .object({
      method: z.literal("select"),
      ref: z.string().min(1),
      values: z.array(z.string()).min(1),
      tabId: z.string().optional(),
    })
    .strict(),
  // check：设置 checkbox/radio 勾选态（checked 缺省为 true）。
  z
    .object({
      method: z.literal("check"),
      ref: z.string().min(1),
      checked: z.boolean().optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // drag：从 起点(fromRef 或 from{x,y}) 拖到 终点(toRef 或 to{x,y})，走 CDP Input 合成鼠标拖拽。
  z
    .object({
      method: z.literal("drag"),
      fromRef: z.string().min(1).optional(),
      toRef: z.string().min(1).optional(),
      from: browserPointSchema.optional(),
      to: browserPointSchema.optional(),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // CUA drag 输入：完整 path 是公共合同，backend 必须逐点发送而不是只取首尾。
  z
    .object({
      method: z.literal("cuaDrag"),
      path: z.array(browserPointSchema).min(1),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // elementInfo：给视口坐标 (x,y)，反查该点命中元素的信息（role/name/rect/selector），打通视觉↔结构。
  z
    .object({
      method: z.literal("elementInfo"),
      x: z.number(),
      y: z.number(),
      tabId: z.string().optional(),
    })
    .strict(),
  // evaluate：在页面作用域执行 JS 表达式，返回可 JSON 序列化的结果。
  z
    .object({
      method: z.literal("evaluate"),
      expression: z.string().min(1),
      tabId: z.string().optional(),
    })
    .strict(),
  // getDialog：读取当前 JS 弹窗（alert/confirm/prompt/beforeunload）信息，无则返回 dialog=null。
  z.object({ method: z.literal("getDialog"), tabId: z.string().optional() }).strict(),
  // handleDialog：接受/取消当前 JS 弹窗；prompt 可带 promptText。
  z
    .object({
      method: z.literal("handleDialog"),
      accept: z.boolean(),
      promptText: z.string().optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("waitFor"),
      selector: z.string().min(1).optional(),
      text: z.string().min(1).optional(),
      textGone: z.string().min(1).optional(),
      timeoutMs: z.number().int().positive().optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // PlaywrightAPI.waitForTimeout：固定等待只接受非负整数，0 表示让出一次 timer tick。
  z
    .object({
      method: z.literal("playwrightWaitForTimeout"),
      timeoutMs: z.number().int().nonnegative(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("playwright"),
      action: browserPlaywrightActionSchema,
      tabId: z.string().optional(),
    })
    .strict(),
  z.object({ method: z.literal("capabilities"), tabId: z.string().optional() }).strict(),
  z.object({ method: z.literal("browserVisibilityGet") }).strict(),
  z.object({ method: z.literal("browserVisibilitySet"), visible: z.boolean() }).strict(),
  browserViewportInputSchema
    .extend({
      method: z.literal("browserViewportSet"),
      tabId: z.string().optional(),
    })
    .strict(),
  z.object({ method: z.literal("browserViewportReset"), tabId: z.string().optional() }).strict(),
  z
    .object({
      method: z.literal("recordingStart"),
      options: browserRecordingOptionsSchema.optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("recordingStatus"),
      recordingId: z.string().trim().min(1),
      outputPath: browserRecordingOutputPathSchema.optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("recordingCancel"),
      recordingId: z.string().trim().min(1),
      tabId: z.string().optional(),
    })
    .strict(),
  // tabs.get(id) 的 backend 激活步骤：校验并更新该 scope selected tab；renderer 决定前台展示或后台记录。
  z.object({ method: z.literal("activateTab"), tabId: z.string().min(1) }).strict(),
  z.object({ method: z.literal("newTab") }).strict(),
  z.object({ method: z.literal("listUserTabs") }).strict(),
  z.object({ method: z.literal("claimTab"), tabId: z.string().min(1) }).strict(),
  z
    .object({
      method: z.literal("finalizeTabs"),
      keep: z.array(
        z.object({ tabId: z.string().min(1), status: z.enum(["handoff", "deliverable"]) }).strict(),
      ),
    })
    .strict(),
  z.object({ method: z.literal("markDeliverable"), tabId: z.string().min(1) }).strict(),
  z.object({ method: z.literal("markHandoff"), tabId: z.string().min(1) }).strict(),
  z.object({ method: z.literal("nameSession"), name: z.string().trim().min(1) }).strict(),
  z
    .object({
      method: z.literal("finalize"),
      tabId: z.string().optional(),
      deliverable: z.boolean().optional(),
    })
    .strict(),
  z.object({ method: z.literal("turnEnded"), turnId: z.string().min(1).optional() }).strict(),
  z.object({ method: z.literal("closeSession") }).strict(),
  z.object({ method: z.literal("cancelRequest"), requestId: z.string().min(1) }).strict(),
  // close：关闭指定受控 tab（tabId 缺省=当前 tab）。manager 层处理：detach + 通知 renderer 卸载 webview。
  z.object({ method: z.literal("close"), tabId: z.string().optional() }).strict(),
  // list：枚举当前会话窗口下所有受控 tab 摘要。manager 层拦截处理，返回 result.tabs。
  z.object({ method: z.literal("list") }).strict(),
]);
export type BrowserCommand = z.infer<typeof browserCommandSchema>;
