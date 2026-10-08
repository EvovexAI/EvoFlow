// workspace-config topic（v4 additive 新增）：workspace 级配置目录的活性数据源。
// 背景：旧协议里 provider registry / 模型目录热更新经 per-session `state.updated`（settings patch）
// 下发，host 侧 zcodeTaskIndexSyncer 转成 workspace_config_options_update 广播给 UI；
// 旧 session/subscribe + state.updated 词表不承载配置目录，统一改走本 topic。
// 语义：conflated 最新态（同 sessions-index），载荷是 workspace 级配置目录 + slash 命令目录。
// 注意这是 workspace 级不是 session 级——session 级 current 选择在 conversation topic 的
// `config`（sessionConfigStateSchema）里；本 topic 的 currentValue 表示 workspace 缺省。
// 纪律：additive 演进——新增 topic / 新增可选字段合法，改已有字段形状不合法。
import { z } from "zod";

// 与 host 侧 ZCodeConfigSelectValue（zcode-task-types-core）结构对齐：
// syncer 转发 workspace_config_options_update 时零映射直通，下游 useZCodeConfig 消费面不改。
export const workspaceConfigSelectValueSchema = z.object({
  value: z.string(),
  name: z.string(),
  description: z.string().optional(),
  // 值来源：原生模型列表或会话侧注入项（UI 去重与展示控制）。
  origin: z.enum(["native", "injected"]).optional(),
  // 模型选项所属供应商/分组 id（provider → model 分组选择）。
  modelProviderId: z.string().optional(),
  modelProviderName: z.string().optional(),
  // 缺失表示旧 payload/能力未知；空数组表示 catalog 已知没有可选 reasoning 档位。
  modelThoughtLevels: z.array(z.string()).optional(),
  modelDefaultThoughtLevel: z.string().optional(),
});
export type WorkspaceConfigSelectValue = z.infer<typeof workspaceConfigSelectValueSchema>;

// 与 host 侧 ZCodeConfigOption 结构对齐（id: model / mode / thought_level / 自定义）。
export const workspaceConfigOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  category: z.string().optional(),
  type: z.enum(["select", "boolean"]),
  currentValue: z.union([z.string(), z.boolean()]),
  options: z.array(workspaceConfigSelectValueSchema).optional(),
});
export type WorkspaceConfigOption = z.infer<typeof workspaceConfigOptionSchema>;

// slash 命令目录（workspace 级；与 host 侧 ZCodeSlashCommand 对齐）。
export const workspaceSlashCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputHint: z.string().optional(),
  source: z.enum(["builtin", "custom"]).optional(),
});
export type WorkspaceSlashCommand = z.infer<typeof workspaceSlashCommandSchema>;

// topic 载荷本体：整体替换语义（conflated 最新态，绝不深合并——同一纪律）。
export const workspaceConfigStateSchema = z.object({
  configOptions: z.array(workspaceConfigOptionSchema),
  slashCommands: z.array(workspaceSlashCommandSchema),
});
export type WorkspaceConfigState = z.infer<typeof workspaceConfigStateSchema>;

export const workspaceConfigSnapshotSchema = z.object({
  protocolVersion: z.literal(1),
  workspaceId: z.string(),
  // host 级配置日志代际（与 sessions-index 的 logEpoch 同构、彼此独立）。
  logEpoch: z.string(),
  config: workspaceConfigStateSchema,
});
export type WorkspaceConfigSnapshot = z.infer<typeof workspaceConfigSnapshotSchema>;

// delta 集合刻意只有一个 op：配置目录是小体量整体替换态，不做字段级增量。
export const workspaceConfigDeltaSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("config.updated"), config: workspaceConfigStateSchema }),
]);
export type WorkspaceConfigDelta = z.infer<typeof workspaceConfigDeltaSchema>;

/** workspace-config topic key 构造（与 parseWorkspaceConfigTopic 对偶）。 */
export function workspaceConfigTopic(workspaceId: string): string {
  return `workspace-config/${workspaceId}`;
}

/** workspace-config topic key 解析（"workspace-config/<workspaceId>"）。 */
export function parseWorkspaceConfigTopic(topic: string): string | null {
  if (!topic.startsWith("workspace-config/")) return null;
  const workspaceId = topic.slice("workspace-config/".length);
  return workspaceId.length > 0 ? workspaceId : null;
}
