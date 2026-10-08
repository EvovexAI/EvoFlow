import { z } from "zod";
import { browserClientModeSchema } from "./commands.js";

/**
 * Browser backend family。Playwright 是 Tab 上的能力层，不是 backend。
 */
export const browserBackendTypeSchema = z.enum(["iab", "extension", "cdp"]);
export type BrowserBackendType = z.infer<typeof browserBackendTypeSchema>;

/** 单项 browser/tab capability 的稳定描述。 */
export const browserCapabilityDescriptorSchema = z
  .object({
    id: z.string().trim().min(1),
    description: z.string().trim().min(1),
  })
  .strict();
export type BrowserCapabilityDescriptor = z.infer<typeof browserCapabilityDescriptorSchema>;

/**
 * 可达 browser backend 的运行时描述。
 *
 * id 是 connection identity，同一 type 可以同时存在多个实例；只有完成握手并真实可用的
 * backend 才能出现在 discovery 结果中。
 */
export const browserBackendDescriptorSchema = z
  .object({
    id: z.string().trim().min(1),
    /** 同一 runtime id 的连接代次；旧代次对象不得自动漂移到新连接。 */
    generation: z.number().int().nonnegative().default(0),
    type: browserBackendTypeSchema,
    name: z.string().trim().min(1),
    capabilities: z
      .object({
        browser: z.array(browserCapabilityDescriptorSchema).optional(),
        tab: z.array(browserCapabilityDescriptorSchema).optional(),
      })
      .strict(),
    apiSupportOverrides: z.record(z.string(), z.boolean()).optional(),
    /** metadata 只允许非敏感字符串，禁止把 credential 混入 discovery。 */
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type BrowserBackendDescriptor = z.infer<typeof browserBackendDescriptorSchema>;

/** backend request 使用实时 session，或使用已缓存的 session context。 */
export const browserSessionContextKindSchema = z.enum(["live", "cached"]);
export type BrowserSessionContextKind = z.infer<typeof browserSessionContextKindSchema>;

/**
 * Discovery 的完整隔离上下文。workspaceKey 用于身份隔离，workspacePath 仅用于路径语义。
 */
export const browserDiscoveryContextSchema = z
  .object({
    requestId: z.string().trim().min(1),
    workspaceKey: z.string().trim().min(1),
    workspacePath: z.string().trim().min(1),
    workspaceIdentity: z.string().trim().min(1).optional(),
    remoteSessionId: z.string().trim().min(1).optional(),
    sessionId: z.string().trim().min(1),
    turnId: z.string().trim().min(1).optional(),
    clientMode: browserClientModeSchema,
    sessionContext: browserSessionContextKindSchema,
  })
  .strict();
export type BrowserDiscoveryContext = z.infer<typeof browserDiscoveryContextSchema>;

/** 执行命令时在 discovery context 上增加精确 runtime browser identity。 */
export const browserSessionContextSchema = browserDiscoveryContextSchema
  .extend({
    browserId: z.string().trim().min(1),
    browserGeneration: z.number().int().nonnegative(),
  })
  .strict();
export type BrowserSessionContext = z.infer<typeof browserSessionContextSchema>;

/** ZCode Protocol 的 discovery result 包装；port 层会解包并直接返回 browsers。 */
export const browserBackendListResultSchema = z
  .object({ browsers: z.array(browserBackendDescriptorSchema) })
  .strict();
export type BrowserBackendListResult = z.infer<typeof browserBackendListResultSchema>;
