import type { IPlatformService } from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { FeedbackSubmitDraft } from "@/feedback/feedbackStore.js";
import { runExportLogsAction } from "@/lib/exportLogsAction.js";
import { ZCODE_PRODUCT_DOCS_URL } from "@/lib/productDocs.js";

interface HelpMenuActionHandlers {
  openIssueReport: () => Promise<void>;
  openProductDocs: () => void;
  exportLogs: () => void;
}

export function createHelpMenuActionHandlers({
  platform,
  intl,
  openSubmit,
}: {
  platform: Pick<IPlatformService, "captureWindowScreenshot" | "exportLogs" | "openExternal">;
  intl: IntlInstance;
  openSubmit: (draft?: FeedbackSubmitDraft) => void;
}): HelpMenuActionHandlers {
  return {
    openIssueReport: async () => {
      openSubmit({
        type: "bug",
        module: "其它",
        severity: "P2-中",
        includeLogs: false,
        screenshots: [],
      });
    },
    openProductDocs: () => {
      platform.openExternal(ZCODE_PRODUCT_DOCS_URL);
    },
    exportLogs: () => {
      void runExportLogsAction(platform, intl);
    },
  };
}
