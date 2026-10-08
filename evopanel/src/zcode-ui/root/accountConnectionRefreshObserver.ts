import { isBuiltinModelProviderId, isStartPlanModelProviderId } from "@zcode/shared";
import type { ProviderSettingsView } from "@zcode/services";
import { logger } from "@/logger.js";

export interface AccountConnectionLoss {
  readonly providerId: string;
  readonly connectionKey: string;
  /** 新账号/新连接/恢复可用会立即废弃旧建议，包括其在途查询。 */
  readonly isCurrent: () => boolean;
}

/** 只比较同一连接的确定状态；手动选未开通套餐不能触发自动回退。 */
export function createAccountConnectionRefreshObserver(
  notify: (event: AccountConnectionLoss) => void | Promise<void>,
) {
  let disposed = false;
  let latestRevision = -1;
  let key: string | undefined;
  let previous: string | undefined;
  let generation = 0;
  return {
    async accept(view: ProviderSettingsView) {
      if (disposed || view.revision < latestRevision) return;
      latestRevision = view.revision;
      const current = view.providers.find(
        (p) =>
          p.accountState?.current === true &&
          isBuiltinModelProviderId(p.providerId) &&
          !isStartPlanModelProviderId(p.providerId),
      );
      const nextKey = current?.accountState?.connectionKey;
      const next = current?.accountState?.availability;
      if (nextKey !== key) {
        key = nextKey;
        previous = undefined;
        generation++;
      }
      // 旧 Host 无身份事实时不猜测；unknown 不抹除已有确定基线。
      if (!key || !current || !next || next === "unknown") return;
      const lost = (previous === "available" || previous === "pending") && next === "unavailable";
      if (next !== previous) generation++;
      previous = next;
      if (!lost) return;
      const eventGeneration = generation;
      try {
        await notify({
          providerId: current.providerId,
          connectionKey: key,
          isCurrent: () =>
            !disposed && generation === eventGeneration && previous === "unavailable",
        });
      } catch (error) {
        // 提示查询失败不等于新的失效事件；不能由重复 View 发起无限通知/重试。
        logger.lifecycle.warn("[AccountConnection] 生成套餐失效提示失败，保留当前选择", { error });
      }
    },
    invalidate() {
      key = undefined;
      previous = undefined;
      generation++;
    },
    dispose() {
      disposed = true;
      generation++;
    },
  };
}
