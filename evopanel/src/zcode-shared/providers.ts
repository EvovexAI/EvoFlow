import { z } from "zod";

/**
 * ZCode agent 提供方的单一真源。
 *
 * 类型 ZCodeProvider、运行时 schema zcodeProviderSchema 都从这里派生,
 * 避免各处内联 z.enum([...]) 副本随新增/删除 provider 漂移。
 * 本模块只依赖 zod(叶子),可被 validation / zcode-protocol 等无环引用。
 */
const ZCODE_PROVIDERS = ["glm"] as const;

export const zcodeProviderSchema = z.enum(ZCODE_PROVIDERS);

export type ZCodeProvider = (typeof ZCODE_PROVIDERS)[number];
