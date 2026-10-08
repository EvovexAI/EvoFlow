import type { IPlatformService } from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { dismissToast, toast } from "@/components/ui/toast.js";

export async function runExportLogsAction(
  platform: Pick<IPlatformService, "exportLogs">,
  intl: IntlInstance,
): Promise<void> {
  const pendingToastId = toast(intl.formatMessage({ id: "sidebar.exportLogs.pending" }), {
    durationMs: Number.POSITIVE_INFINITY,
  });

  try {
    const result = await platform.exportLogs();
    if (!result.success) {
      toast(
        intl.formatMessage(
          { id: "sidebar.exportLogs.error" },
          { error: result.error ?? "unknown" },
        ),
      );
    }
  } catch (error) {
    toast(
      intl.formatMessage(
        { id: "sidebar.exportLogs.error" },
        { error: error instanceof Error ? error.message : String(error) },
      ),
    );
  } finally {
    dismissToast(pendingToastId);
  }
}
