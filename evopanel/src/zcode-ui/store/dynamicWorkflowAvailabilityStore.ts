import { create } from "zustand";
import type { DynamicWorkflowClientConfig } from "@zcode/shared";
import type { ICodingPlanSubscriptionService } from "@zcode/services";
import { logger } from "@/logger.js";

// ============================================================
// 动态工作流灰度快照在 renderer 的唯一副本
// ============================================================
//
// Host 是唯一的决策者，这里只缓存它给出的那一份 `{ mode, enabled, source }`：
//   - 一个 app 会话只取一次。发请求的是 Root 里的 loader（唯一 owner），
//     自动化页与 run 面板只读，不各自再发一次；
//   - 不带 forceRefresh。Host 用同一份 1h 快照推导发给 CLI 的工具策略，
//     renderer 单独 force 一次会让「界面有入口 / 模型没工具」这类分歧成为可能；
//     要强制重取走 refresh()；
//   - 请求失败按 disabled 处理（fail-closed，与 resolveDynamicWorkflowClientConfig 同一裁决），
//     但**不记住失败**：换一份 service 实例会重试。手机 `/remote` 在工作区桥接前拿到的是
//     unsupported 代理，必然抛错，桥接完成后 accessor 会换一份，那一次必须能纠正回来。

export type DynamicWorkflowAvailabilityStatus = "loading" | "ready";

export interface DynamicWorkflowAvailabilitySnapshot {
  readonly status: DynamicWorkflowAvailabilityStatus;
  /** loading 期间恒为 false：未知即不提供，入口宁可晚半拍出现也不闪一下再收起。 */
  readonly enabled: boolean;
  /** 未就绪或取数失败时为 null；`source` 只用于观测，区分「服务端关」与「本地覆盖」。 */
  readonly config: DynamicWorkflowClientConfig | null;
}

interface DynamicWorkflowAvailabilityState extends DynamicWorkflowAvailabilitySnapshot {
  /** 首次取数；同一个 service 出过结果后是 no-op，并发调用共用同一次请求。 */
  ensureLoaded(service: ICodingPlanSubscriptionService): Promise<void>;
  /** 绕过闩与 Host 的 1h 快照缓存重取（forceRefresh）。 */
  refresh(service: ICodingPlanSubscriptionService): Promise<void>;
}

const INITIAL_SNAPSHOT: DynamicWorkflowAvailabilitySnapshot = {
  status: "loading",
  enabled: false,
  config: null,
};

let inFlight: Promise<void> | null = null;
/** 已经出过结果（成功或失败）的 service 实例；同一实例不再重复请求。 */
let settledService: ICodingPlanSubscriptionService | null = null;

type PublishSnapshot = (snapshot: DynamicWorkflowAvailabilitySnapshot) => void;

async function loadDynamicWorkflowConfig(
  service: ICodingPlanSubscriptionService,
  options: { forceRefresh?: boolean },
  publish: PublishSnapshot,
): Promise<void> {
  try {
    const config = await service.getDynamicWorkflowClientConfig(options);
    publish({ status: "ready", enabled: config.enabled === true, config });
  } catch (error) {
    logger.warn(
      "[dynamic-workflow] 灰度快照读取失败，按未命中处理",
      error instanceof Error ? error.message : String(error),
    );
    publish({ status: "ready", enabled: false, config: null });
  } finally {
    settledService = service;
  }
}

export const useDynamicWorkflowAvailabilityStore = create<DynamicWorkflowAvailabilityState>(
  (set, get) => ({
    ...INITIAL_SNAPSHOT,

    ensureLoaded(service): Promise<void> {
      if (settledService === service) return Promise.resolve();
      if (inFlight) {
        // 在途的可能是另一份 service（手机 `/remote` 桥接期间 accessor 会换）：排在它后面再判一次。
        // 若在途的就是这一份，那时 settledService 已等于它，递归会立即命中上面的 no-op。
        return inFlight.then(() => get().ensureLoaded(service));
      }
      const run = loadDynamicWorkflowConfig(service, {}, set).finally(() => {
        if (inFlight === run) inFlight = null;
      });
      inFlight = run;
      return run;
    },

    refresh(service): Promise<void> {
      return loadDynamicWorkflowConfig(service, { forceRefresh: true }, set);
    },
  }),
);
