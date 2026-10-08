import { useEffect, useRef } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast, dismissToast } from "@/components/ui/toast.js";
import {
  createAccountConnectionRefreshObserver,
  type AccountConnectionLoss,
} from "@/root/accountConnectionRefreshObserver.js";
import { prepareAccountConnectionSwitch } from "@/root/accountConnectionLossSuggestion.js";
import { logger } from "@/logger.js";

/** 根层只观察一次；页面/文案变化不重新建立账号基线。 */
export function useAccountConnectionLossNotification(
  services: IServiceAccessor,
  intentKey: string,
  refreshAppSettings?: () => Promise<void>,
) {
  const { intl } = useZCodeIntl();
  const latest = useRef({ intl, refreshAppSettings });
  latest.current = { intl, refreshAppSettings };
  const observerRef = useRef<ReturnType<typeof createAccountConnectionRefreshObserver> | null>(
    null,
  );
  const noticeRef = useRef<{ id: number; event: AccountConnectionLoss } | null>(null);
  useEffect(() => {
    // 设置/登录意图先于 Account 查询回包变化；即使切走又切回，旧按钮也不能重新有效。
    observerRef.current?.invalidate();
    if (noticeRef.current) dismissToast(noticeRef.current.id);
    noticeRef.current = null;
  }, [intentKey]);
  useEffect(() => {
    const observer = createAccountConnectionRefreshObserver(async (event) => {
      let suggestion: Awaited<ReturnType<typeof prepareAccountConnectionSwitch>> = null;
      try {
        suggestion = await prepareAccountConnectionSwitch(services, event);
      } catch (error) {
        logger.lifecycle.warn("[AccountConnection] 无法确认替代套餐，仅提示状态", { error });
      }
      if (!event.isCurrent()) return;
      const { intl: copy } = latest.current;
      const label =
        suggestion?.label ??
        (suggestion
          ? copy.formatMessage({
              id:
                suggestion.selection.kind === "start-plan"
                  ? "settings.modelProvider.codingPlan.purchaseBanner.startPlanTitle"
                  : "settings.modelProvider.codingPlan.purchase.individualsSectionTitle",
            })
          : "");
      const target = suggestion;
      let id: number;
      let submitting = false;
      const submit = () => {
        if (!target || submitting) return;
        submitting = true;
        void (async () => {
          try {
            const result = await target.apply();
            dismissToast(id);
            if (result === "stale") {
              toast(
                latest.current.intl.formatMessage({
                  id: "settings.modelProvider.connectionSuggestionStale",
                }),
                { variant: "info" },
              );
              return;
            }
            // 条件写入已成功；这里只刷新显示，不把刷新失败说成保存失败。
            try {
              await latest.current.refreshAppSettings?.();
            } catch (error) {
              logger.lifecycle.warn("[AccountConnection] 连接已保存，设置快照刷新失败", { error });
            }
          } catch (error) {
            logger.lifecycle.warn("[AccountConnection] 手动切换套餐失败", { error });
            if (!event.isCurrent()) return;
            // Toast 点击会自动关闭。失败时给同一建议的显式重试，不能后台选新目标。
            id = toast(
              latest.current.intl.formatMessage({
                id: "settings.modelProvider.connectionSwitchFailed",
              }),
              {
                variant: "warning",
                durationMs: 12000,
                actionLabel: latest.current.intl.formatMessage({ id: "common.retry" }),
                onAction: submit,
              },
            );
            noticeRef.current = { id, event };
          } finally {
            submitting = false;
          }
        })();
      };
      id = toast(copy.formatMessage({ id: "settings.modelProvider.connectionUnavailableNotice" }), {
        variant: "info",
        durationMs: 12000,
        actionLabel: target
          ? copy.formatMessage(
              { id: "settings.modelProvider.switchConnection" },
              { connection: label },
            )
          : undefined,
        onAction: target ? submit : undefined,
      });
      noticeRef.current = { id, event };
    });
    observerRef.current = observer;
    const accept = (view: Parameters<typeof observer.accept>[0]) => {
      void observer.accept(view);
      const notice = noticeRef.current;
      if (notice && !notice.event.isCurrent()) {
        dismissToast(notice.id);
        noticeRef.current = null;
      }
    };
    const subscription = services.providerSettingsService.onDidChange(accept);
    void services.providerSettingsService
      .getView()
      .then(accept)
      .catch((error) => {
        logger.lifecycle.warn("[AccountConnection] 初次读取失败，等待正常刷新", { error });
      });
    return () => {
      observer.dispose();
      observerRef.current = null;
      subscription.dispose();
      if (noticeRef.current) dismissToast(noticeRef.current.id);
      noticeRef.current = null;
    };
  }, [services]);
}
