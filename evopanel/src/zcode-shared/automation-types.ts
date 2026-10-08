import type { ZCodeTaskMode } from "./zcode-task-types-core.js";
import type { ZCodeAutomationBotDeliveryTarget } from "./bots.js";
import type { ModelSelection } from "./model-selection.js";

// ---- 定时任务(Automation)领域类型 ----
// automation / automation_runs 存 tasks-index.sqlite。
// 这里是跨 services / cli / desktop / ui 复用的 camelCase 领域类型；sqlite 列名为 snake_case。

/** 单个本地任务索引允许保留的定时任务定义总数；所有生命周期状态都计入。 */
export const AUTOMATION_CREATE_LIMIT = 20;
export const AUTOMATION_CREATE_LIMIT_ERROR_CODE = "AUTOMATION_CREATE_LIMIT_REACHED";

export function isAutomationCreateLimitError(error: unknown): boolean {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return message.includes(AUTOMATION_CREATE_LIMIT_ERROR_CODE);
}

/** 整条 automation 的生命周期。 */
export type ZCodeAutomationLifecycleStatus = "active" | "completed" | "failed" | "paused";

/** 单条 automation 当前一轮的派发信息态（供 UI/诊断）。 */
export type ZCodeAutomationDispatchStatus =
  | "idle"
  | "claimed"
  | "dispatched"
  | "failed_to_dispatch";

/** workspace 位置；本期恒为 local，远端预留。 */
export type ZCodeAutomationLocationKind = "local" | "remote";

/** 触发来源：定时 or 立即运行。 */
export type ZCodeAutomationTrigger = "schedule" | "manual";

/** 自定义重复规则；cronExpr 保留为兼容展示，调度以本字段为权威。 */
export interface ZCodeAutomationScheduleRule {
  unit: "minute" | "hourly" | "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  hour: number;
  minute: number;
  anchorAt: number;
  weekdays?: number[];
  monthDays?: number[];
  /** yearly 用：1-12 人类月份。缺省回退 anchorAt 的月份（兼容未写该字段的旧记录）。 */
  months?: number[];
  monthlyMode?: "date" | "weekday";
}

/**
 * 会话侧长间隔周期 carrier 的 unit 枚举。与 scheduleRule.unit 同集，但 carrier 是受控入参
 * （模型不能直接写完整 scheduleRule），由 service 层归一化为权威 scheduleRule。
 */
export type ZCodeAutomationIntervalUnit = ZCodeAutomationScheduleRule["unit"];

/** 单次 run 的派发结果（scheduler 权威，驱动重试）。skipped=错过触发窗口。 */
export type ZCodeAutomationRunDispatchStatus =
  | "claimed"
  | "dispatched"
  | "failed_to_dispatch"
  | "skipped";

/** 单次 run 产出 session 后的运行结果（由 session runtime 回写，仅用于展示）。 */
export type ZCodeAutomationRunOutcome = "running" | "succeeded" | "failed" | "stopped";

/** 一条定时任务定义 + 调度状态。 */
export interface ZCodeAutomation {
  automationId: string;
  title: string;
  /** 5 段 cron，本地时区。 */
  cronExpr: string;
  prompt: string;
  /** 缺失表示 Select 阶段继续跟随 Workspace 首选；存在时固定结构化模型意图。 */
  modelSelection?: ModelSelection;
  /** 权限模式；派发时透传给 createTask，缺省走 workspace 默认。 */
  mode?: ZCodeTaskMode;
  /** workspaceIdentity?.trim() || workspacePath */
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 会话内创建的 cron 绑定到当前 task；后续触发都投递回该 task，不再新建 session。 */
  targetTaskId?: string;
  locationKind: ZCodeAutomationLocationKind;
  /** true=无限循环；false=有限次（配合 maxRuns）。 */
  recurring: boolean;
  maxRuns?: number;
  /** 自定义重复的截止时间（本地所选日期的日末，毫秒时间戳）。 */
  endAt?: number;
  scheduleRule?: ZCodeAutomationScheduleRule;
  /** 会话来源的只读调度是否已被用户在管理页显式删除并重设。 */
  scheduleEditedByUser?: boolean;
  runCount: number;
  enabled: boolean;
  lifecycleStatus: ZCodeAutomationLifecycleStatus;
  nextRunAt?: number;
  lastRunAt?: number;
  dispatchStatus: ZCodeAutomationDispatchStatus;
  dispatchAttempts: number;
  retryAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

/** parseAutomationRunId 的解析结果；scheduledAt 仅 schedule 触发存在。 */
export interface ZCodeAutomationRunIdParts {
  automationId: string;
  trigger: ZCodeAutomationTrigger;
  /** runId 内嵌的本轮理论触发时间（Unix 毫秒）。 */
  scheduledAt?: number;
}

/**
 * runId 契约（见 ZCodeAutomationRun.runId）的唯一解析入口；desktop host/scheduler 与
 * CLI telemetry 不各自按字符串猜格式。不符合两种声明格式的输入一律返回 null。
 */
export function parseAutomationRunId(runId: string): ZCodeAutomationRunIdParts | null {
  const separatorIndex = runId.indexOf(":");
  if (separatorIndex <= 0) return null;
  const automationId = runId.slice(0, separatorIndex);
  const rest = runId.slice(separatorIndex + 1);
  if (rest.startsWith("manual:")) {
    return rest.length > "manual:".length ? { automationId, trigger: "manual" } : null;
  }
  const scheduledAt = Number(rest);
  if (!Number.isSafeInteger(scheduledAt) || scheduledAt <= 0) return null;
  return { automationId, trigger: "schedule", scheduledAt };
}

/** 一次触发的运行历史 / runId 幂等台账。 */
export interface ZCodeAutomationRun {
  /** automationId:scheduledAt / automationId:manual:uuid */
  runId: string;
  automationId: string;
  workspaceKey: string;
  scheduledAt?: number;
  trigger: ZCodeAutomationTrigger;
  /** Select 转 Submission 后固定；同一 run 的派发重试不得重新读取 Workspace 首选。 */
  modelSelection?: ModelSelection;
  dispatchStatus: ZCodeAutomationRunDispatchStatus;
  outcome?: ZCodeAutomationRunOutcome;
  /** dispatched 成功后回填，用于历史跳转。 */
  sessionId?: string;
  error?: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

/** 创建 automation 的入参（workspace 由调用方从 session 上下文注入）。 */
export interface ZCodeAutomationCreateParams {
  title: string;
  cronExpr: string;
  /** 仅创建期使用：由服务层基于真实当前时间换算为 cronExpr，不写入数据库。 */
  relativeDelayMinutes?: number;
  prompt: string;
  modelSelection?: ModelSelection;
  mode?: ZCodeTaskMode;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 当前会话内创建时由 runtime 注入，模型不可控。 */
  targetTaskId?: string;
  /** Bot 会话创建时由 Host 注入；仅供 scheduler 终态回推，不进入 UI 展示模型。 */
  botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
  recurring: boolean;
  maxRuns?: number;
  endAt?: number;
  scheduleRule?: ZCodeAutomationScheduleRule;
  /**
   * 会话侧自定义重复 carrier。每 N 分钟/小时/天/周/月/年均配对提交 intervalUnit + interval，
   * 真实间隔由 service 层归一化为权威 scheduleRule 承载；cronExpr 仅作合法兼容展示。
   * 与 scheduleRule、relativeDelayMinutes 互斥。undefined=不使用 carrier。
   */
  intervalUnit?: ZCodeAutomationIntervalUnit;
  /** 1–200 的整数间隔，必须与 intervalUnit 配对。 */
  interval?: number;
}

/** 编辑 automation 的可变字段。 */
export interface ZCodeAutomationUpdateParams {
  title?: string;
  cronExpr?: string;
  prompt?: string;
  /** undefined=不修改；null=清空，回退到 Workspace 首选。 */
  modelSelection?: ModelSelection | null;
  /** undefined=不修改；null=清空，回退到 workspace 默认权限模式。 */
  mode?: ZCodeTaskMode | null;
  recurring?: boolean;
  /** undefined=通常不修改；recurring=true 时领域层会自动清空旧上限；显式 null 必须同时传 recurring=true。 */
  maxRuns?: number | null;
  /** undefined=不修改；null=永不结束。 */
  endAt?: number | null;
  /** undefined=不修改；null=恢复为普通 cron。 */
  scheduleRule?: ZCodeAutomationScheduleRule | null;
  /**
   * 会话侧自定义重复 carrier（同 create 侧）。配对提交 intervalUnit + interval，service 层
   * 归一化为权威 scheduleRule（anchorAt 重置为本次修改时刻）。undefined=不修改。
   */
  intervalUnit?: ZCodeAutomationIntervalUnit;
  /** 1–200 的整数间隔，必须与 intervalUnit 配对。 */
  interval?: number;
  /** 仅由管理页在用户实际修改调度时写入；undefined=保留原来源状态。 */
  scheduleEditedByUser?: boolean;
}
