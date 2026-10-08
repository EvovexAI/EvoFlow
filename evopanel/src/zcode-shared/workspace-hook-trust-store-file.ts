import { z } from "zod";

/**
 * Workspace Hook Trust store 文件格式（`workspace-hook-trust-v1.json`）的
 * 单一权威 schema。
 *
 * 完整 schema 不能只存在于 contracts（CLI 侧，zod3）：
 * services 层无法依赖 apps 下的包，只好手写局部字段校验（只看
 * workspaceIdentity 与 digest 形状）。结果同一份"JSON 合法但结构非法"的
 * store 文件，runtime/adapters 判 corrupt（fail-closed 全部阻断），services
 * 却把其中的 digest 当作已信任展示——UI 显示"已信任"、执行层永远拒绝，
 * 且无法通过统一路径诊断。信任存储是权限边界，所有消费者必须对同一
 * 文件得出同一结论，因此 schema 下沉到 shared 作为单源，contracts 侧
 * re-export 本模块保持既有 import 路径兼容。
 *
 * 注意：contracts 与本模块分属 zod3 / zod4 两个实例，本 schema 不得被
 * contracts 内部的 zod3 schema 组合引用（当前仅 re-export，无组合）。
 */

export const WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION = 1 as const;

/** 与 contracts 的 workspaceHookEventNameSchema 保持一致（7 个现有事件）。 */
const workspaceHookEventNameSchema = z.enum([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
]);

const nonEmptyStringSchema = z.string().trim().min(1);
const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const nonnegativeIntegerSchema = z.number().int().nonnegative();

export const workspaceHookTrustRecordSchema = z
  .object({
    workspaceIdentity: nonEmptyStringSchema,
    hookDeclarationDigest: sha256DigestSchema,
    digestAlgorithm: z.literal("sha256"),
    decision: z.literal("trusted"),
    grantedAt: z.string().datetime(),
    lastUsedAt: z.string().datetime().optional(),
    bundleDigestAtGrant: sha256DigestSchema.optional(),
    eventAtGrant: workspaceHookEventNameSchema,
    displayCommandAtGrant: nonEmptyStringSchema,
    sourcePathAtGrant: nonEmptyStringSchema,
    sourceDiscoveryOrderAtGrant: nonnegativeIntegerSchema.optional(),
    matcherAtGrant: z.string().nullable().optional(),
    matcherIndexAtGrant: nonnegativeIntegerSchema.optional(),
    hookIndexAtGrant: nonnegativeIntegerSchema.optional(),
    appVersionAtGrant: nonEmptyStringSchema.optional(),
  })
  .strict();
export type WorkspaceHookTrustRecord = z.infer<typeof workspaceHookTrustRecordSchema>;

export const workspaceHookTrustStoreFileSchema = z
  .object({
    schemaVersion: z.literal(WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION),
    records: z.array(workspaceHookTrustRecordSchema),
  })
  .strict()
  .superRefine((store, context) => {
    const keys = store.records.map(
      (record) => `${record.workspaceIdentity}\u0000${record.hookDeclarationDigest}`,
    );
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["records"],
        message: "workspace identity and declaration digest keys must be unique",
      });
    }
  });
export type WorkspaceHookTrustStoreFile = z.infer<typeof workspaceHookTrustStoreFileSchema>;

export type WorkspaceHookTrustStoreParseResult =
  | { status: "ok"; file: WorkspaceHookTrustStoreFile }
  | { status: "invalid" };

/**
 * 解析 trust store 文件内容。JSON 语法错误与 schema 校验失败统一归为
 * `invalid`——两者在消费语义上等价：文件不可信，必须 fail-closed，
 * 不得返回任何部分结果。
 */
export function parseWorkspaceHookTrustStoreContent(
  content: string,
): WorkspaceHookTrustStoreParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return { status: "invalid" };
  }
  const result = workspaceHookTrustStoreFileSchema.safeParse(parsed);
  if (!result.success) return { status: "invalid" };
  return { status: "ok", file: result.data };
}
