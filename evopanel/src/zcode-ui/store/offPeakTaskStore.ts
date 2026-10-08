import { create } from "zustand";
import {
  normalizeProviderFamilyDomain,
  type AppSettings,
  type OffPeakCodingPlanSupport,
  type OffPeakTaskCreateResult,
  type OffPeakTakeNumberAvailability,
  type ZCodeOffPeakTask,
  type ModelSelection,
} from "@zcode/shared";
import type {
  ICodingPlanSubscriptionService,
  IOffPeakTaskService,
  OffPeakClientConfig,
} from "@zcode/services";
import { logger } from "@/logger.js";

// 闲时任务管理 store（与 automationManagementStore 独立）：走 IOffPeakTaskService RPC。
// 位次/状态靠列表轮询刷新（host offPeakTaskSync 写 sqlite，renderer 只读快照）。

interface CreateOffPeakTaskInput {
  title: string;
  prompt: string;
  /** 权限四档（build/edit/plan/yolo）；类型收窄在服务端入参处完成。 */
  permissionMode: string;
  modelSelection: ModelSelection;
  workspacePath: string;
  workspaceIdentity?: string;
}

interface UpdateOffPeakTaskInput {
  title?: string;
  prompt?: string;
  permissionMode?: string;
  modelSelection?: ModelSelection | null;
}

/** New task 页模板卡点击后携带到 Automations 创建表单的预填草稿（模板=预填）。 */
export interface OffPeakCreateDraft {
  title?: string;
  prompt?: string;
  telemetrySource?: {
    eventRegion: "app.session" | "app.automations";
    templateId: string;
  };
}

/** availability 的请求状态与服务端额度快照分离；只有 ready + canTakeNumber=true 才能放行。 */
export type OffPeakTakeNumberAvailabilityStatus = "idle" | "loading" | "ready" | "error";

interface OffPeakTaskState {
  tasks: ZCodeOffPeakTask[];
  loading: boolean;
  error: string | null;
  operationId: string | null;
  /** 灰度配置：null=未加载。未命中/关闭时入口整体不渲染。 */
  grayConfig: OffPeakClientConfig | null;
  /** 当前 selected provider/connection 的脱敏凭证支持快照；不含 JWT/API Key。 */
  codingPlanSupport: OffPeakCodingPlanSupport | null;
  /** 服务端取号额度即时快照；null=尚无成功响应。 */
  takeNumberAvailability: OffPeakTakeNumberAvailability | null;
  /** loading/idle/error 均禁入，避免把依赖异常误当成可创建。 */
  takeNumberAvailabilityStatus: OffPeakTakeNumberAvailabilityStatus;
  /** New task 页横幅本次会话是否已被用户关闭（关闭后下次登录/重启再开）。 */
  newTaskBannerDismissed: boolean;
  /** 模板卡→创建表单的预填草稿（跨视图导航一次性携带）。 */
  pendingCreateDraft: OffPeakCreateDraft | null;
  initialize(deps: {
    offPeakTaskService: IOffPeakTaskService;
    codingPlanSubscriptionService: ICodingPlanSubscriptionService;
  }): Promise<void>;
  refresh(service: IOffPeakTaskService): Promise<void>;
  refreshCodingPlanSupport(service: IOffPeakTaskService, freshnessKey?: string): Promise<void>;
  refreshTakeNumberAvailability(service: IOffPeakTaskService): Promise<void>;
  createTask(
    input: CreateOffPeakTaskInput,
    service: IOffPeakTaskService,
  ): Promise<OffPeakTaskCreateResult>;
  updateTask(
    offPeakTaskId: string,
    input: UpdateOffPeakTaskInput,
    service: IOffPeakTaskService,
  ): Promise<boolean>;
  pauseTask(offPeakTaskId: string, service: IOffPeakTaskService): Promise<void>;
  continueTask(offPeakTaskId: string, service: IOffPeakTaskService): Promise<void>;
  cancelTask(offPeakTaskId: string, service: IOffPeakTaskService): Promise<void>;
  deleteTask(offPeakTaskId: string, service: IOffPeakTaskService): Promise<void>;
  deleteHistory(offPeakTaskId: string, service: IOffPeakTaskService): Promise<void>;
  dismissNewTaskBanner(): void;
  /** 模板卡点击：暂存预填草稿供 Automations 创建表单消费（consume 后清空）。 */
  setPendingCreateDraft(draft: OffPeakCreateDraft): void;
  consumePendingCreateDraft(): OffPeakCreateDraft | null;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** support 必须仍对应 renderer 当前选择；切换连接后的旧 true 快照不能短暂放开创建。 */
export function isCurrentOffPeakCodingPlanSupported(
  support: OffPeakCodingPlanSupport | null,
  settings:
    | Pick<AppSettings, "providerFamilyConnectionSelections" | "providerFamilyDomain">
    | null
    | undefined,
): boolean {
  if (!support?.supported || !settings) return false;
  const providerFamily = normalizeProviderFamilyDomain(settings.providerFamilyDomain);
  if (!providerFamily || providerFamily !== support.providerFamily) return false;
  const selection = settings.providerFamilyConnectionSelections?.[providerFamily];
  if (selection?.kind === "individual-coding-plan") {
    return support.kind === `${providerFamily}-personal`;
  }
  if (selection?.kind === "team-coding-plan") {
    return support.kind === `${providerFamily}-team`;
  }
  return false;
}

/** 服务端 3103（取号超限）只按结构化分类识别，不再解析跨 RPC 的错误文本。 */
function isOffPeakQuotaError(result: OffPeakTaskCreateResult | null | undefined): boolean {
  return (
    result?.ok === false && result.errorCategory === "quota_3103" && result.errorCode === "3103"
  );
}

type OffPeakCreateErrorMessageId =
  | "offPeak.error.quota"
  | "offPeak.error.unavailable"
  | "offPeak.error.generic";

/** 创建失败只按服务端明确业务码映射；原始 RPC 文本仅留日志，不直接展示给用户。 */
export function resolveOffPeakCreateErrorMessageId(
  result: OffPeakTaskCreateResult | null | undefined,
): OffPeakCreateErrorMessageId {
  if (isOffPeakQuotaError(result)) return "offPeak.error.quota";
  if (
    result?.ok === false &&
    (result.errorCategory === "network" ||
      result.errorCategory === "invalid_response" ||
      result.errorCategory === "unknown")
  ) {
    return "offPeak.error.unavailable";
  }
  return "offPeak.error.generic";
}

let initializeInFlight: Promise<void> | null = null;
let initializationReady: Promise<void> = Promise.resolve();
let eligibilityInFlight: Promise<void> | null = null;
let eligibilityGeneration = 0;
let pendingEligibilityService: IOffPeakTaskService | null = null;
let lastEligibilityTrigger: { service: IOffPeakTaskService; key: string } | null = null;

export const useOffPeakTaskStore = create<OffPeakTaskState>((set, get) => ({
  tasks: [],
  loading: false,
  error: null,
  operationId: null,
  grayConfig: null,
  codingPlanSupport: null,
  takeNumberAvailability: null,
  takeNumberAvailabilityStatus: "idle",
  newTaskBannerDismissed: false,
  pendingCreateDraft: null,

  async initialize({ offPeakTaskService, codingPlanSubscriptionService }) {
    // Bug 原因：New Task 与 Automations 在页面切换时可能短暂重叠挂载，两个 initialize
    // 会并发请求同一个 Team Plan availability，后到的全局 429 可能覆盖先到的成功结果。
    // Store 级 single-flight 保证所有入口共用一次完整准入检查。
    if (initializeInFlight) return initializeInFlight;
    set({ loading: true, error: null });
    // 初始化和后续通知共用资格检查；灰度先就绪，资格与额度不能由两条异步链分别写入。
    initializationReady = Promise.all([
      codingPlanSubscriptionService
        .getOffPeakClientConfig({ forceRefresh: true })
        .catch((error) => {
          logger.warn("[off-peak] gray config load failed", toErrorMessage(error));
          return null;
        }),
      offPeakTaskService.list().catch((error) => {
        logger.warn("[off-peak] list failed", toErrorMessage(error));
        return [] as ZCodeOffPeakTask[];
      }),
    ]).then(([grayConfig, tasks]) => {
      set({ grayConfig, tasks });
    });
    const run = get().refreshCodingPlanSupport(offPeakTaskService);
    initializeInFlight = run;
    try {
      await run;
    } finally {
      if (initializeInFlight === run) {
        initializeInFlight = null;
        set({ loading: false });
      }
    }
  },

  async refresh(service) {
    try {
      const tasks = await service.list();
      set({ tasks, error: null });
    } catch (error) {
      set({ error: toErrorMessage(error) });
    }
  },

  refreshCodingPlanSupport(service, freshnessKey) {
    // 两个入口收到同一 Registry/连接通知只检查一次；手动刷新无 key，始终重查。
    if (
      freshnessKey !== undefined &&
      lastEligibilityTrigger?.service === service &&
      lastEligibilityTrigger.key === freshnessKey
    ) {
      return eligibilityInFlight ?? Promise.resolve();
    }
    lastEligibilityTrigger = freshnessKey === undefined ? null : { service, key: freshnessKey };
    eligibilityGeneration += 1;
    pendingEligibilityService = service;
    set({
      codingPlanSupport: null,
      takeNumberAvailability: null,
      takeNumberAvailabilityStatus: "loading",
    });
    if (eligibilityInFlight) return eligibilityInFlight;
    // 旧代码的 support/availability 独立请求会乱序覆盖。串行 drain 合并在途变化，
    // 旧成功、旧失败均丢弃；只有一代完整资格与额度能够一起发布。
    eligibilityInFlight = Promise.resolve().then(async () => {
      try {
        while (pendingEligibilityService) {
          const currentService = pendingEligibilityService;
          const generation = eligibilityGeneration;
          pendingEligibilityService = null;
          await initializationReady;
          if (generation !== eligibilityGeneration) continue;
          try {
            const codingPlanSupport = await currentService.getCodingPlanSupport();
            if (generation !== eligibilityGeneration) continue;
            const grayConfig = get().grayConfig;
            const shouldReadAvailability =
              grayConfig?.enabled &&
              (grayConfig.codingPlanActive === true || codingPlanSupport.supported === true);
            const takeNumberAvailability = shouldReadAvailability
              ? await currentService.getTakeNumberAvailability()
              : null;
            if (generation !== eligibilityGeneration) continue;
            set({
              codingPlanSupport,
              takeNumberAvailability,
              takeNumberAvailabilityStatus: shouldReadAvailability ? "ready" : "idle",
            });
          } catch (error) {
            if (generation !== eligibilityGeneration) continue;
            set({
              codingPlanSupport: null,
              takeNumberAvailability: null,
              takeNumberAvailabilityStatus: "error",
            });
            logger.warn("[off-peak] eligibility refresh failed", toErrorMessage(error));
          }
        }
      } finally {
        // 在 drain 同一微任务中释放，避免 finally 排队期间新请求挂到已结束的检查上。
        eligibilityInFlight = null;
      }
    });
    return eligibilityInFlight;
  },

  refreshTakeNumberAvailability(service) {
    return get().refreshCodingPlanSupport(service);
  },

  async createTask(input, service) {
    set({ operationId: "offpeak:create", error: null });
    try {
      const result = await service.createTask(
        input as Parameters<IOffPeakTaskService["createTask"]>[0],
      );
      if (result.ok) {
        await Promise.all([get().refresh(service), get().refreshTakeNumberAvailability(service)]);
        return result;
      }
      // 创建失败说明之前的准入快照已不足以继续放行；只保存稳定分类，不把 raw error 放进 UI 状态。
      set({
        error: result.errorCategory,
        takeNumberAvailability: null,
        takeNumberAvailabilityStatus: "error",
      });
      logger.warn("[off-peak] create failed", {
        errorCategory: result.errorCategory,
        errorCode: result.errorCode,
        failureStage: result.failureStage,
      });
      if (isOffPeakQuotaError(result)) {
        await get().refreshTakeNumberAvailability(service);
      }
      return result;
    } catch (error) {
      // Host/RPC transport 仍可能在结构化服务结果之外失败；统一收敛为 network，
      // toast 只消费稳定分类，禁止解析 raw error。
      const result = {
        ok: false,
        failureStage: "ticket_request",
        errorCategory: "network",
        errorCode: "",
        providerName: "",
      } as const satisfies OffPeakTaskCreateResult;
      set({
        error: result.errorCategory,
        takeNumberAvailability: null,
        takeNumberAvailabilityStatus: "error",
      });
      logger.warn("[off-peak] create RPC transport failed", {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return result;
    } finally {
      set({ operationId: null });
    }
  },

  async updateTask(offPeakTaskId, input, service) {
    set({ operationId: `offpeak:update:${offPeakTaskId}`, error: null });
    try {
      const updated = await service.updateTask(offPeakTaskId, input);
      await get().refresh(service);
      return updated !== null;
    } catch (error) {
      set({ error: toErrorMessage(error) });
      return false;
    } finally {
      set({ operationId: null });
    }
  },

  async pauseTask(offPeakTaskId, service) {
    set({ operationId: `offpeak:pause:${offPeakTaskId}`, error: null });
    try {
      await service.pauseTask(offPeakTaskId);
      await get().refresh(service);
    } catch (error) {
      set({ error: toErrorMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  async continueTask(offPeakTaskId, service) {
    set({ operationId: `offpeak:continue:${offPeakTaskId}`, error: null });
    try {
      await service.continueTask(offPeakTaskId);
      await get().refresh(service);
    } catch (error) {
      set({ error: toErrorMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  async cancelTask(offPeakTaskId, service) {
    set({ operationId: `offpeak:cancel:${offPeakTaskId}`, error: null });
    try {
      await service.cancelTask(offPeakTaskId);
      await get().refresh(service);
    } catch (error) {
      set({ error: toErrorMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  async deleteTask(offPeakTaskId, service) {
    set({ operationId: `offpeak:delete:${offPeakTaskId}`, error: null });
    try {
      await service.deleteTask(offPeakTaskId);
      await get().refresh(service);
    } catch (error) {
      set({ error: toErrorMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  async deleteHistory(offPeakTaskId, service) {
    set({
      operationId: `offpeak:delete-history:${offPeakTaskId}`,
      error: null,
    });
    try {
      await service.deleteHistory(offPeakTaskId);
      await get().refresh(service);
    } catch (error) {
      set({ error: toErrorMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  dismissNewTaskBanner() {
    set({ newTaskBannerDismissed: true });
  },

  setPendingCreateDraft(draft) {
    set({ pendingCreateDraft: draft });
  },

  consumePendingCreateDraft() {
    const draft = get().pendingCreateDraft;
    if (draft) set({ pendingCreateDraft: null });
    return draft;
  },
}));
