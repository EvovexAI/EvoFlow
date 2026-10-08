import { useEffect, useMemo } from "react";
import type { ICodingPlanSubscriptionService } from "@zcode/services";
import {
  useDynamicWorkflowAvailabilityStore,
  type DynamicWorkflowAvailabilitySnapshot,
} from "@/store/dynamicWorkflowAvailabilityStore.js";

/**
 * 读动态工作流灰度快照。
 * 只读，不触发请求：取数由 Root 里的 loader 唯一负责。消费方（自动化页、run 面板）可能位于
 * 工作区级 ServiceProvider 内（远程 Host 的 accessor），让它们各自取数会把 app 级那一份覆盖掉。
 */
export function useDynamicWorkflowAvailability(): DynamicWorkflowAvailabilitySnapshot {
  // 逐字段订阅：返回对象字面量的 selector 每次都是新引用，useSyncExternalStore 会判定为变化。
  const status = useDynamicWorkflowAvailabilityStore((state) => state.status);
  const enabled = useDynamicWorkflowAvailabilityStore((state) => state.enabled);
  const config = useDynamicWorkflowAvailabilityStore((state) => state.config);
  return useMemo(() => ({ status, enabled, config }), [config, enabled, status]);
}

/**
 * app 会话级取数，挂在 Root 里一次。service 换了（手机 `/remote` 完成工作区桥接）会重试，
 * 取数与失败重试的规则见 dynamicWorkflowAvailabilityStore。
 */
export function useDynamicWorkflowAvailabilityLoader(
  service: ICodingPlanSubscriptionService,
): void {
  const ensureLoaded = useDynamicWorkflowAvailabilityStore((state) => state.ensureLoaded);
  useEffect(() => {
    void ensureLoaded(service);
  }, [ensureLoaded, service]);
}
