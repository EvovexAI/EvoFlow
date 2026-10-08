import type { ZCodeTaskMode } from "./zcode-task-types-core.js";
import type { ModelSelection } from "./model-selection.js";

// ---- 闲时任务(Off-Peak Task)领域类型 ----
// off_peak_tasks 存 tasks-index.sqlite。
// 与 automation 共用 scheduler 进程与派发管道，但数据表、消息类型、状态机全部独立，
// 禁止往 ZCodeAutomation 上加字段。sqlite 列名 snake_case，此处为跨域 camelCase 领域类型。

/**
 * 客户端执行态六态（服务端准入态 queued/ready/active/expired/settled 是另一轴）：
 * queued=排队等服务端 ready；paused=用户 Pause 停止派发；running=执行中；
 * permission/elicitation 在普通 session 内等待且聚合态保持 running；completed/failed/cancelled=终态。
 */
export type ZCodeOffPeakTaskStatus =
  | "queued"
  | "paused"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** 终态集合：不可逆出（状态机不变量）。 */
export const OFF_PEAK_TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

export function isOffPeakTerminalStatus(
  status: ZCodeOffPeakTaskStatus,
): status is "completed" | "failed" | "cancelled" {
  return (OFF_PEAK_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * 票据不可用（服务端 400/3102：active 3h 到期 / ready 5min 废票 / settled / 非本人）的
 * 稳定错误标记。zcode-cli 适配层把该业务码分类为不可重试失败并在错误消息里嵌入本标记；
 * host 终态回写据此改走"同 task_id 重新取号 → resume 续跑"而非落 failed。
 * 跨进程只能靠错误文本传递，标记必须全链路唯一且稳定，勿改；与
 * apps/zcode-cli/packages/adapters/src/model/offpeak-retry.ts 的同名常量跨包同值。
 */
export const OFF_PEAK_TICKET_EXPIRED_MARKER = "off-peak-ticket-expired";

/** Off-Peak Provider 与当前账号 Family 同身份；任务保存精确选择，不跨 Family 静默迁移。 */
export const OFF_PEAK_PROVIDER_IDS = {
  zai: "account:zai-offpeak-idle-plan",
  bigmodel: "account:bigmodel-offpeak-idle-plan",
} as const;

export function resolveOffPeakProviderId(
  family: "zai" | "bigmodel",
): (typeof OFF_PEAK_PROVIDER_IDS)[typeof family] {
  return OFF_PEAK_PROVIDER_IDS[family];
}

/** 当前 selected connection 可供 Off-Peak 使用的真实 Coding Plan 形态。 */
// zai/bigmodel Team Plan 对称化，新增 zai-team kind。
export type OffPeakCodingPlanKind =
  | "zai-personal"
  | "bigmodel-personal"
  | "bigmodel-team"
  | "zai-team";

/**
 * 脱敏的 Coding Plan 支持边界。renderer 只消费该结果，不读取 JWT/API Key。
 * `connection_unavailable` 同时覆盖 provider 缺失、disabled、过期和 Team runtime key 失效；
 * 这些情况都不能回退到其它缓存连接。
 */
export type OffPeakCodingPlanUnsupportedReason =
  | "provider_family_unselected"
  | "provider_family_api_key_mode"
  | "provider_identity_mismatch"
  | "connection_unselected"
  | "start_plan_not_supported"
  | "connection_unavailable"
  | "selection_changed"
  | "jwt_missing";

export type OffPeakCodingPlanSupport =
  | {
      supported: true;
      kind: OffPeakCodingPlanKind;
      providerFamily: "zai" | "bigmodel";
      providerId: string;
    }
  | {
      supported: false;
      reason: OffPeakCodingPlanUnsupportedReason;
    };

/**
 * 服务端取号额度的即时快照。
 * 只用于判断能否创建新的 ticket；真实 POST /ticket 仍是最终准入权威。
 */
export interface OffPeakTakeNumberAvailability {
  canTakeNumber: boolean;
  /** 当前不可取号时服务端给出的最早恢复时间，Unix 毫秒。 */
  nextTakeAt?: number;
}

export function isOffPeakTicketExpiredError(message: string | undefined): boolean {
  return Boolean(message?.includes(OFF_PEAK_TICKET_EXPIRED_MARKER));
}

/** 一条闲时任务：表单创建即取号排队，派发时 createTask 新建 session。 */
export interface ZCodeOffPeakTask {
  /** 本地主键，同时用作服务端 task_id（稳定，跨多个 ticket）。 */
  offPeakTaskId: string;
  /** 服务端取号返回的 Snowflake ticket_id；每次重新取号（3h 到期续跑/Continue 重取）更新。 */
  serverTicketId?: string;
  /** 表单 Task title。 */
  title: string;
  /** 宿主对话 taskId；首次派发成功后回填（表单：新建 session；会话内创建：绑定会话首跑），非空 = 已跑过。 */
  conversationId?: string;
  /**
   * 运行会话。表单创建首跑后回填；会话内创建在创建时即写入当前会话 id，
   * 首跑 resume 该会话而不新建。续跑/中断恢复 resume 同一 session 用。
   */
  sessionId?: string;
  /** 绑定会话的当前标题（list 时从 tasks-index 联查，只读派生，不落库）。 */
  sessionTitle?: string;
  /** 表单 Instructions。 */
  prompt: string;
  /** 权限四档全开放，映射现有 ZCodeTaskMode，默认 "default"（Ask for approval）。 */
  permissionMode: ZCodeTaskMode;
  /**
   * 创建被接受时固定的结构化 Submission 选择。
   *
   * 旧数据库记录可能只有 model/thought_level，读取时暂时为空；这类任务必须保留给用户
   * 修复，但在补回完整 Selection 前不能进入调度。
   */
  modelSelection?: ModelSelection;
  /** 旧记录无法可靠恢复 Selection 时的只读诊断事实。 */
  modelSelectionIssue?: {
    code: "repair-required";
    legacyModelId?: string;
    legacyReasoningLevel?: string;
  };
  /** workspaceIdentity?.trim() || workspacePath */
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  status: ZCodeOffPeakTaskStatus;
  /** FIFO 序依据（服务端权威序由取号顺序决定，本地仅展示/派发排序用）。 */
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
  failureReason?: string;
  /** 完成通知与状态条展示；复用现有 task diff 回填。 */
  filesChanged?: number;
  /** 终态核销服务端 ack 时间；undefined=未核销，outbox 补报。 */
  settledAt?: number;
  /**
   * 用户删除本地 History 行的时间。
   * 只控制 History 可见性，不删除 task/session，也不清空任何执行字段。
   */
  historyDeletedAt?: number;
  // -- 服务端同步快照（host offPeakTaskSync 写 / scheduler 跨进程读）--
  /** 取号成功时间（POST /ticket ack）；undefined=未取号。 */
  registeredAt?: number;
  /** 服务端 ready（粗阀）：true = 低峰窗口开 + 排到号，scheduler 可认领派发。 */
  schedulable?: boolean;
  /** 排队位次，UI "#N in queue"。 */
  queuePosition?: number;
  /** 下次轮询时间（间隔由服务端 next_poll_after 下发）。 */
  nextPollAt?: number;
  createdAt: number;
  updatedAt: number;
}

/** 创建闲时任务的入参（workspace 由调用方从上下文注入；取号在 service 层先行，成功才落库）。 */
export interface ZCodeOffPeakTaskCreateParams {
  title: string;
  prompt: string;
  permissionMode: ZCodeTaskMode;
  modelSelection: ModelSelection;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 会话内创建：绑定创建时所在会话，首跑 resume 该会话（对齐 CronCreate targetTaskId）。表单创建不传。 */
  boundSessionId?: string;
}

/** 创建边界返回的稳定票态；与服务端票态同值，但不暴露 server ticket ID。 */
export type OffPeakTaskTicketInitialState =
  | "queued"
  | "ready"
  | "active"
  | "expired"
  | "settled"
  | "not_found";

export type OffPeakTaskCreateFailureStage =
  | "client_validation"
  | "ticket_request"
  | "local_persist";

export type OffPeakTaskCreateErrorCategory =
  | "client_validation"
  | "eligibility_3101"
  | "quota_3103"
  | "network"
  | "invalid_response"
  | "local_persist"
  | "unknown";

/**
 * 创建 RPC 的判别联合。失败只保留稳定分类/业务码，禁止把 raw error 或响应体带过 RPC。
 * providerName 已在 Host 侧收窄为显式安全 hostname，不允许传完整 URL。
 */
export type OffPeakTaskCreateResult =
  | {
      ok: true;
      task: ZCodeOffPeakTask;
      ticketInitialState: OffPeakTaskTicketInitialState;
      queuePosition?: number;
      providerName: string;
    }
  | {
      ok: false;
      failureStage: OffPeakTaskCreateFailureStage;
      errorCategory: OffPeakTaskCreateErrorCategory;
      errorCode: string;
      providerName: string;
    };
