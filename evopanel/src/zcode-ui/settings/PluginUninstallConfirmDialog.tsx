import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

// 卸载是破坏性的彻底清除（缓存 + data 目录 + config 残留），UI 各入口共用同一个确认弹窗，
// 文案与行为保持一致，避免「已安装」与「市场」两个面板各写一份。
export function PluginUninstallConfirmDialog({
  open,
  pluginName,
  pending,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  pluginName: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent data-testid="plugin-store-uninstall-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {intl.formatMessage(
              { id: "settings.plugins.uninstall.confirmTitle" },
              { name: pluginName },
            )}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {intl.formatMessage({ id: "settings.plugins.uninstall.confirmDescription" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            type="button"
            size="sm"
            data-testid="plugin-store-uninstall-cancel"
            disabled={pending}
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </AlertDialogCancel>
          <AlertDialogAction
            type="button"
            data-testid="plugin-store-uninstall-confirm"
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={(event) => {
              // 阻止 Radix 默认在点击 action 后关闭弹窗；卸载是异步操作，等结果再由父组件收起。
              event.preventDefault();
              onConfirm();
            }}
          >
            {intl.formatMessage({ id: "settings.plugins.uninstall.confirm" })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
