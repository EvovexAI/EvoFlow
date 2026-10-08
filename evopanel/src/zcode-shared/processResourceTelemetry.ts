/**
 * 全进程 CPU / 内存监控埋点的共享契约。
 *
 * 这里只放"main 与单测都要用同一份"的常量与纯校验：进程角色枚举、三个事件名、
 * 每个事件的属性 key 白名单、属性计数与隐私校验。真正的采样与聚合在 desktop main 侧。
 */

/** 第一期 10 个进程角色。 */
export const PROCESS_RESOURCE_ROLES = [
  "main",
  "renderer_main",
  "renderer_guest",
  "gpu",
  "chromium_other",
  "host",
  "scheduler",
  "cli_chat",
  "cli_aux",
  "mcp",
] as const;

export type ProcessResourceRole = (typeof PROCESS_RESOURCE_ROLES)[number];

/**
 * zcode-cli 的自采周期，是 CLI 与 app 之间的节拍契约：
 * CLI 侧是定时器周期，main 侧既是「多久算一个 CLI 样本」也是过期判据（2 个周期）的基数。
 * 两侧必须同源，否则改 CLI 节拍会让 main 的 `sample_count` 静默偏离约定值。
 */
export const ZCODE_CLI_RESOURCE_SAMPLE_INTERVAL_MS = 60_000;

/**
 * zcode-cli 的进程泳道。
 *
 * lane 不是 CLI 协议字段——CLI 进程不知道自己被哪个进程管理器拉起，由 app 侧 services 层
 * 在解析样本时按所属进程管理器打标（`chat` 是 workspace 级 Agent，其余两条是控制面 lane）。
 */
export const PROCESS_RESOURCE_CLI_LANES = ["chat", "plugin", "mcp-status"] as const;

export type ProcessResourceCliLane = (typeof PROCESS_RESOURCE_CLI_LANES)[number];

/**
 * lane → 角色：`chat` 归 `cli_chat`（每 workspace 一个进程），其余两条 lane 合并为 `cli_aux`。
 *
 * 缺省（无 lane）归 `cli_chat`：唯一可能来源是版本落后、还没给样本打 lane 的远端 server，
 * 而远端 workspace 上长期存活并产生资源占用的是 chat lane；归到 cli_chat 比整条样本丢弃更接近事实。
 */
export function resolveCliProcessResourceRole(
  lane: ProcessResourceCliLane | undefined,
): Extract<ProcessResourceRole, "cli_chat" | "cli_aux"> {
  return lane === undefined || lane === "chat" ? "cli_chat" : "cli_aux";
}

/** 进程实际运行的位置；远端 CLI / MCP 的样本自带 remote。 */
export type ProcessResourceRuntimeSurface = "local" | "remote";

export const PROCESS_RESOURCE_EVENT_NAMES = {
  processWindow: "perf_process_window",
  systemWindow: "perf_system_window",
  toolExecResource: "perf_tool_exec_resource",
} as const;

export type ProcessResourceEventName =
  (typeof PROCESS_RESOURCE_EVENT_NAMES)[keyof typeof PROCESS_RESOURCE_EVENT_NAMES];

/** ARMS 单个自定义事件的属性数上限（全局属性与事件属性合并后计算）。 */
export const ARMS_CUSTOM_EVENT_PROPERTY_LIMIT = 20;

/** 所有资源事件共有的全局属性。 */
const PROCESS_RESOURCE_GLOBAL_PROPERTY_KEYS = [
  "platform",
  "app_version",
  "arms_env",
  "device_mid",
] as const;

/**
 * `perf_process_window` 的全部可能属性（21 个）。
 * 单条事件最多 20 个：Node 角色与 renderer_main 20（含 heap 两项、无 mcp_id）、
 * mcp 19（含 mcp_id、无 heap）、gpu / renderer_guest / chromium_other 18。
 */
export const PERF_PROCESS_WINDOW_PROPERTY_KEYS = [
  ...PROCESS_RESOURCE_GLOBAL_PROPERTY_KEYS,
  "process_role",
  "runtime_surface",
  "arch",
  "logical_cpu_count",
  "total_memory_gb",
  "mcp_id",
  "background_ratio",
  "uptime_minutes",
  "cpu_percent_p95",
  "cpu_percent_peak",
  "rss_kb_total_mean",
  "rss_kb_total_peak",
  "rss_kb_max_process_peak",
  "heap_used_kb_mean",
  "heap_used_kb_peak",
  "process_count_peak",
  "sample_count",
] as const;

/** `perf_system_window` 的全部属性（17 个）。 */
export const PERF_SYSTEM_WINDOW_PROPERTY_KEYS = [
  ...PROCESS_RESOURCE_GLOBAL_PROPERTY_KEYS,
  "arch",
  "logical_cpu_count",
  "total_memory_gb",
  "background_ratio",
  "app_uptime_minutes",
  "system_cpu_percent_p95",
  "system_free_memory_kb_min",
  "app_cpu_percent_p95",
  "app_rss_kb_total_mean",
  "app_rss_kb_total_peak",
  "process_count_total_peak",
  "sample_count",
  "telemetry_self_ms",
] as const;

/** `perf_tool_exec_resource` 的全部属性（12 个；Windows 缺 tree_* 两项共 10）。 */
export const PERF_TOOL_EXEC_RESOURCE_PROPERTY_KEYS = [
  ...PROCESS_RESOURCE_GLOBAL_PROPERTY_KEYS,
  "runtime_surface",
  "tool_name",
  "exit_kind",
  "tree_rss_kb_peak",
  "tree_cpu_time_ms",
  "sample_count",
  "cli_rss_kb",
  "system_free_memory_kb",
] as const;

const PROPERTY_KEY_WHITELIST: Record<ProcessResourceEventName, readonly string[]> = {
  [PROCESS_RESOURCE_EVENT_NAMES.processWindow]: PERF_PROCESS_WINDOW_PROPERTY_KEYS,
  [PROCESS_RESOURCE_EVENT_NAMES.systemWindow]: PERF_SYSTEM_WINDOW_PROPERTY_KEYS,
  [PROCESS_RESOURCE_EVENT_NAMES.toolExecResource]: PERF_TOOL_EXEC_RESOURCE_PROPERTY_KEYS,
};

/**
 * 隐私红线：属性 key 不得出现 pid / 路径 / workspace / session / task / 命令语义。
 * `device_mid` 与 `mcp_id` 不匹配该模式（`mid`、`p_id` 都不是 `pid` 子串）。
 */
export const PROCESS_RESOURCE_FORBIDDEN_PROPERTY_KEY_PATTERN =
  /pid|path|workspace|session|task|command/i;

export interface ProcessResourceEventPropertyCheck {
  /** 白名单内、数量不超上限且不含隐私 key。 */
  ok: boolean;
  /** 实际会上报的属性数（值为 undefined 的不计入）。 */
  count: number;
  overLimit: boolean;
  unknownKeys: string[];
  forbiddenKeys: string[];
}

/** 校验一条资源事件的属性集合是否符合白名单、属性数上限与隐私红线。 */
export function checkProcessResourceEventProperties(
  eventName: ProcessResourceEventName,
  properties: Record<string, string | number | boolean | undefined>,
): ProcessResourceEventPropertyCheck {
  const whitelist = new Set(PROPERTY_KEY_WHITELIST[eventName]);
  const presentKeys = Object.entries(properties)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
  const unknownKeys = presentKeys.filter((key) => !whitelist.has(key));
  const forbiddenKeys = presentKeys.filter((key) =>
    PROCESS_RESOURCE_FORBIDDEN_PROPERTY_KEY_PATTERN.test(key),
  );
  const count = presentKeys.length;
  const overLimit = count > ARMS_CUSTOM_EVENT_PROPERTY_LIMIT;

  return {
    ok: unknownKeys.length === 0 && forbiddenKeys.length === 0 && !overLimit,
    count,
    overLimit,
    unknownKeys,
    forbiddenKeys,
  };
}
