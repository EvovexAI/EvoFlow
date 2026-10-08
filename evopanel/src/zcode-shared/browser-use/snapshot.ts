import { z } from "zod";

export const browserElementRectSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  })
  .strict();
export type BrowserElementRect = z.infer<typeof browserElementRectSchema>;

/**
 * 单个可交互元素的快照条目，以 role、name、ref 提供定位信息，避免转储整页 DOM。
 * ref 为按 DOM 序分配的稳定引用（e1, e2, ...），后续 action 用 ref 定位。
 */
export const browserSnapshotElementSchema = z
  .object({
    ref: z.string().min(1),
    tag: z.string(),
    role: z.string().optional(),
    /** accessibleName */
    name: z.string().optional(),
    text: z.string().optional(),
    value: z.string().optional(),
    disabled: z.boolean().optional(),
    checked: z.boolean().optional(),
    selector: z.string(),
    xpath: z.string(),
    rect: browserElementRectSchema,
    inViewport: z.boolean(),
    /** 父级可交互元素的 ref（层级线索；顶层/无父可交互元素时省略）。 */
    parentRef: z.string().optional(),
    /** 元素来源的 frame 路径（同源 iframe 穿透时标注，如 "0>2"；主文档省略）。 */
    framePath: z.string().optional(),
    /** 有界稳定属性，用于从 DOM 事实构造 locator；不返回 class/style/src 等高噪声字段。 */
    attributes: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type BrowserSnapshotElement = z.infer<typeof browserSnapshotElementSchema>;

/**
 * 可见语义 DOM 节点。它只负责“读懂页面”，可动作句柄仍由 elements/ref 单独维护，
 * 防止正文节点占满 action ref 预算。ref 仅在该语义节点同时属于 elements 时存在。
 */
export const browserSnapshotDomNodeSchema = z
  .object({
    tag: z.string(),
    depth: z.number().int().nonnegative(),
    inViewport: z.boolean(),
    ref: z.string().min(1).optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    text: z.string().optional(),
    attributes: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type BrowserSnapshotDomNode = z.infer<typeof browserSnapshotDomNodeSchema>;

export const browserSnapshotSchema = z
  .object({
    url: z.string(),
    title: z.string(),
    /**
     * 有界的可见语义 DOM；optional 保持旧 backend/result 的协议兼容。
     * 必须排在 elements 前定义：Zod 会按 schema 顺序重建对象，大页面工具结果被截断时
     * 应先让模型看到页面语义，而不是 selector/xpath/rect 等动作细节。
     */
    dom: z.array(browserSnapshotDomNodeSchema).optional(),
    /** 语义 DOM 节点超过内部预算时置 true。 */
    domTruncated: z.boolean().optional(),
    elements: z.array(browserSnapshotElementSchema),
    /** 元素数超过 maxElements 时截断。 */
    truncated: z.boolean(),
  })
  .strict();
export type BrowserSnapshot = z.infer<typeof browserSnapshotSchema>;
