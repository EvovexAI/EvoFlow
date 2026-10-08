import { useCallback, useState } from "react";
import type { GitChangeSourceId } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

export function useGitActions(options: { workspacePath: string }) {
  const { workspacePath } = options;
  const { intl } = useZCodeIntl();
  const [refreshVersion, setRefreshVersion] = useState(0);

  const announcePlaceholder = useCallback(
    (action: string, detail: Record<string, unknown>) => {
      logger.info(`[GitPane] ${action} workspace=${workspacePath}`, detail);
      toast(intl.formatMessage({ id: "diff.placeholder.toast" }));
    },
    [intl, workspacePath],
  );

  const refresh = useCallback(
    async (sourceId: GitChangeSourceId) => {
      setRefreshVersion((value) => value + 1);
      announcePlaceholder("refresh", { sourceId });
    },
    [announcePlaceholder],
  );

  const stagePaths = useCallback(
    async (paths: string[]) => {
      announcePlaceholder("stagePaths", { count: paths.length, paths });
    },
    [announcePlaceholder],
  );

  const unstagePaths = useCallback(
    async (paths: string[]) => {
      announcePlaceholder("unstagePaths", { count: paths.length, paths });
    },
    [announcePlaceholder],
  );

  const discardPaths = useCallback(
    async (paths: string[]) => {
      announcePlaceholder("discardPaths", { count: paths.length, paths });
    },
    [announcePlaceholder],
  );

  const commit = useCallback(
    async (message: string) => {
      announcePlaceholder("commit", { messageLength: message.trim().length });
    },
    [announcePlaceholder],
  );

  return {
    refreshVersion,
    refresh,
    stagePaths,
    unstagePaths,
    discardPaths,
    commit,
  };
}
