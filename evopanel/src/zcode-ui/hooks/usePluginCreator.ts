import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import { loadPluginCreatorPrefill } from "@/settings/pluginCreatorPrefill.js";
import { isWorkspaceReadOnly } from "@/store/tabStore.js";
import { useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { usePaneLayoutStore } from "@/v4/paneLayoutStore.js";
import { resolveWorkbenchNewTaskTarget } from "@/v4/workbenchNewTaskTarget.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";

export function usePluginCreator(
  onCreateTask: ((request?: CreateTaskRequest) => void) | undefined,
) {
  const { intl } = useZCodeIntl();
  const tabStore = useTabStoreApi();
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const activeWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const paneLayout = usePaneLayoutStore((state) => state);
  const group = useWorkbenchGroupStore((state) =>
    state.activeGroupId ? (state.groups[state.activeGroupId] ?? null) : null,
  );
  const target = resolveWorkbenchNewTaskTarget({
    activeWorkspacePath,
    activeWorkspaceIdentity,
    activeGroup: group,
    paneLayout: paneLayout,
  });
  const targetKey = target?.workspaceIdentity?.trim() || target?.workspacePath || "";
  const resolution = useWorkspaceServicesResolution(
    target?.workspacePath,
    undefined,
    target?.workspaceIdentity,
  );
  const scope = useMemo(
    () => ({ active: true }),
    [targetKey, resolution.services, resolution.remoteSessionId, resolution.rpcReady, onCreateTask],
  );
  useEffect(() => {
    scope.active = true;
    return () => {
      scope.active = false;
    };
  }, [scope]);
  const pending = useRef<object | null>(null);
  const [busyScope, setBusyScope] = useState<object | null>(null);
  const create = useCallback(async () => {
    if (pending.current === scope || !target || !onCreateTask) return;
    if (!resolution.rpcReady) {
      toast(intl.formatMessage({ id: "pluginCreator.unavailable" }), { variant: "warning" });
      return;
    }
    const isCurrent = () => {
      const state = tabStore.getState();
      const groups = useWorkbenchGroupStore.getState();
      const current = resolveWorkbenchNewTaskTarget({
        activeWorkspacePath: state.activeWorkspacePath,
        activeWorkspaceIdentity: state.activeWorkspaceIdentity,
        activeGroup: groups.activeGroupId ? (groups.groups[groups.activeGroupId] ?? null) : null,
        paneLayout: usePaneLayoutStore.getState(),
      });
      return (
        scope.active &&
        (current?.workspaceIdentity?.trim() || current?.workspacePath || "") === targetKey &&
        !isWorkspaceReadOnly(state, target.workspacePath, target.workspaceIdentity)
      );
    };
    pending.current = scope;
    setBusyScope(scope);
    try {
      const prefill = await loadPluginCreatorPrefill(
        () =>
          resolution.services.skillsService.list({
            workspacePath: target.workspacePath,
            workspaceIdentity: target.workspaceIdentity,
            provider: ZCODE_AGENT_PROVIDER,
          }),
        isCurrent,
      );
      if (prefill) {
        logger.info("[PluginCreator] 已解析创建技能", { workspaceKey: targetKey });
        onCreateTask({ ...prefill, expectedWorkspaceKey: targetKey });
      }
    } catch (error) {
      if (isCurrent()) {
        logger.warn("[PluginCreator] 创建技能不可用", {
          error: error instanceof Error ? error.message : String(error),
          workspaceKey: targetKey,
        });
        toast(intl.formatMessage({ id: "pluginCreator.unavailable" }), { variant: "warning" });
      }
    } finally {
      if (pending.current === scope) pending.current = null;
      if (scope.active) setBusyScope(null);
    }
  }, [intl, onCreateTask, resolution, scope, tabStore, target, targetKey]);
  return { create, busy: busyScope === scope, available: Boolean(target && onCreateTask) };
}
