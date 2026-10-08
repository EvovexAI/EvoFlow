import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { buildStartPlanEntitlementOptions } from "@/lib/startPlanEntitlementOptions.js";
import { useCallback } from "react";
import type { ModelSelectionView } from "@zcode/provider";
import {
  TID_START_PLAN_RECOMMENDATION_DIALOG,
  isStartPlanModelProviderId,
  type ModelSelection,
} from "@zcode/shared";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useUsageEntitlementWithService } from "@/hooks/useUsageEntitlement.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { resolveStartPlanRecommendation } from "@/lib/startPlanRecommendation.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";

/** 推荐只编辑本次提交的选择；设置与额度仍由 App/Host 的原服务拥有。 */
export function useStartPlanRecommendation(
  view: ModelSelectionView | null | undefined,
  surface?: "subagent",
) {
  const services = useOptionalBaseWorkspaceServices();
  const { intl } = useZCodeIntl();
  const requestChoice = useConfirmDialogStore((state) => state.requestChoice);
  // Registry 已完成登录品牌、权益、模型配置校验，不从展示名称推测执行身份。
  const start = view?.providers.find((provider) => isStartPlanModelProviderId(provider.providerId));
  const settings = useProviderSettingsView();
  const entitlement = useUsageEntitlementWithService(services?.usageStatsService, {
    ...buildStartPlanEntitlementOptions(
      settings.state.status === "ready" ? settings.state.view : null,
      start?.providerId ?? "",
    ),
    refreshOnMount: true,
    mountRefreshReason: "access",
  });
  return useCallback(
    async (selection: ModelSelection): Promise<ModelSelection | null> => {
      // 提交不等待网络；过期额度跳过推荐，访问刷新沿用一分钟节流与失败退避。
      void entitlement.refresh({ silent: true, reason: "access" });
      const candidate = entitlement.error
        ? null
        : resolveStartPlanRecommendation(selection, view, entitlement.snapshot);
      if (!candidate || !services) return selection;
      try {
        // 每次读同一 Host 的偏好，覆盖另一入口或手机刚勾选后的下一次提交。
        if ((await services.settingService.get()).startPlanRecommendationDismissed)
          return selection;
      } catch (error) {
        logger.warn("[StartRecommendation] 无法读取推荐偏好，继续原选择", { error });
        return selection;
      }
      let dismissed = false;
      const choice = await requestChoice({
        testId: TID_START_PLAN_RECOMMENDATION_DIALOG,
        title: intl.formatMessage({ id: "startPlan.recommendation.title" }),
        description: intl.formatMessage(
          {
            id:
              surface === "subagent"
                ? "startPlan.recommendation.subagentDescription"
                : "startPlan.recommendation.description",
          },
          { model: selection.modelId },
        ),
        confirmLabel: intl.formatMessage({ id: "startPlan.recommendation.switch" }),
        cancelLabel: intl.formatMessage({ id: "startPlan.recommendation.decline" }),
        showCloseButton: true,
        showKeyboardHints: false,
        checkbox: {
          label: intl.formatMessage({ id: "startPlan.recommendation.dismiss" }),
          onCheckedChange: (checked) => {
            dismissed = checked;
          },
        },
      });
      if (choice === "dismiss") return null;
      if (dismissed) {
        try {
          await services.settingService.update({ startPlanRecommendationDismissed: true });
        } catch (error) {
          logger.warn("[StartRecommendation] 保存推荐偏好失败", { error });
          toast(intl.formatMessage({ id: "startPlan.recommendation.preferenceSaveFailed" }));
        }
      }
      return choice === "confirm" ? candidate : selection;
    },
    [
      entitlement.error,
      entitlement.snapshot,
      entitlement.refresh,
      intl,
      requestChoice,
      services,
      surface,
      view,
    ],
  );
}
