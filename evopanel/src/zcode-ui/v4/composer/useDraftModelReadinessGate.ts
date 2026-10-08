import { useCallback, useEffect, useMemo, useState } from "react";
import { isZCodeAgentProvider, ZCODE_AGENT_PROVIDER, type ZCodeProvider } from "@zcode/shared";
import type { IModelSelectionService, ModelSelectionView } from "@zcode/services";
import {
  buildModelConfigMissingUiError,
  type ModelConfigMissingUiError,
} from "@/lib/chatPrepareError.js";
import { logger } from "@/logger.js";

type DraftModelReadinessStatus = "checking" | "ready" | "missing" | "check-failed";

interface DraftModelReadinessState {
  gateKey: string;
  status: DraftModelReadinessStatus;
  dismissed: boolean;
}

interface DraftModelReadinessGate {
  /** 只有 readiness 已确认或检查本身不可用时，才允许进入 workspace prepare/prewarm。 */
  agentStartupAllowed: boolean;
  error: ModelConfigMissingUiError | null;
  dismissError(): void;
  /** 首发 admission 的权威复查；false 表示应保留 composer 并返回 blocked。 */
  ensureReadyForSend(): Promise<boolean>;
  /** Host 门禁在 UI 复查后竞态命中时，将同一错误重新投影到草稿横幅。 */
  markProviderNotReady(): void;
}

function resolveModelSelectionReadinessStatus(
  view: ModelSelectionView,
): Extract<DraftModelReadinessStatus, "ready" | "missing"> {
  return view.providers.some((provider) => provider.models.length > 0) ? "ready" : "missing";
}

/**
 * V4 草稿的 provider/model admission。
 *
 * V4 迁移删除了旧 useWorkspacePrepare 的 renderer readiness 门禁，草稿首发
 * 会先登记 pending command，再由 Host 以 provider_not_ready 拒绝。这个确定性拒绝随后会
 * 被恢复账本误判成 unknown。这里恢复 UI 前置门禁；Host 门禁继续负责进程级竞态兜底。
 */
export function useDraftModelReadinessGate(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  provider?: ZCodeProvider;
  sessionId: string | null;
  modelSelectionService: Pick<IModelSelectionService, "getView" | "onDidChange">;
}): DraftModelReadinessGate {
  const { workspacePath, workspaceIdentity, provider, sessionId, modelSelectionService } = params;
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  const enabled = sessionId === null && isZCodeAgentProvider(displayProvider);
  const gateKey = `${workspaceKey}\u0000${displayProvider}`;
  const [state, setState] = useState<DraftModelReadinessState>(() => ({
    gateKey,
    status: enabled ? "checking" : "ready",
    dismissed: false,
  }));

  const commitStatus = useCallback(
    (status: DraftModelReadinessStatus, options: { revealMissing?: boolean } = {}) => {
      setState((current) => ({
        gateKey,
        status,
        dismissed:
          status === "missing"
            ? options.revealMissing
              ? false
              : current.gateKey === gateKey && current.status === "missing"
                ? current.dismissed
                : false
            : false,
      }));
    },
    [gateKey],
  );

  useEffect(() => {
    if (!enabled) {
      commitStatus("ready");
      return;
    }

    commitStatus("checking");
    let disposed = false;
    let registryEventVersion = 0;
    const applyStatus = (status: DraftModelReadinessStatus) => {
      if (disposed) return;
      commitStatus(status);
    };
    const subscription = modelSelectionService.onDidChange((view) => {
      registryEventVersion += 1;
      applyStatus(resolveModelSelectionReadinessStatus(view));
    });
    const initialReadVersion = registryEventVersion;
    void modelSelectionService
      .getView()
      .then((view) => {
        // 读取在变更事件之前发起、之后才返回时，事件快照更新；禁止旧读取覆盖新状态。
        if (registryEventVersion !== initialReadVersion) return;
        applyStatus(resolveModelSelectionReadinessStatus(view));
      })
      .catch((error) => {
        handleReadinessFailure(error);
      });

    function handleReadinessFailure(error: unknown) {
      if (disposed) return;
      // registry 读取异常不等价于“确实没有模型”。保留 Host 门禁作为兜底，避免把
      // app-global service 的瞬时故障错误显示成用户配置问题。
      commitStatus("check-failed");
      logger.warn("[v4-draft-readiness] provider registry 检查失败，回落 Host 门禁", {
        error: error instanceof Error ? error.message : String(error),
        workspaceKey,
      });
    }

    return () => {
      disposed = true;
      subscription?.dispose();
    };
  }, [commitStatus, enabled, modelSelectionService, workspaceKey]);

  const effectiveState: DraftModelReadinessState =
    state.gateKey === gateKey
      ? state
      : { gateKey, status: enabled ? "checking" : "ready", dismissed: false };

  const markProviderNotReady = useCallback(() => {
    commitStatus("missing", { revealMissing: true });
  }, [commitStatus]);

  const ensureReadyForSend = useCallback(async (): Promise<boolean> => {
    if (!enabled) return true;
    try {
      const view = await modelSelectionService.getView();
      const status = resolveModelSelectionReadinessStatus(view);
      commitStatus(status, { revealMissing: status === "missing" });
      if (status === "missing") {
        logger.info("[v4-draft-readiness] 无可用 provider/model，草稿首发在 UI admission 拒绝", {
          providerCount: view.providers.length,
          revision: view.revision,
          workspaceKey,
        });
        return false;
      }
      return true;
    } catch (error) {
      // 与 mount 检查一致：读 registry 失败不冒充“没有模型”，继续由 Host 启动门禁裁决。
      commitStatus("check-failed");
      logger.warn("[v4-draft-readiness] 首发复查 provider registry 失败，回落 Host 门禁", {
        error: error instanceof Error ? error.message : String(error),
        workspaceKey,
      });
      return true;
    }
  }, [commitStatus, enabled, modelSelectionService, workspaceKey]);

  const error = useMemo(
    () =>
      enabled && effectiveState.status === "missing" && !effectiveState.dismissed
        ? buildModelConfigMissingUiError()
        : null,
    [effectiveState.dismissed, effectiveState.status, enabled],
  );

  const dismissError = useCallback(() => {
    setState((current) =>
      current.gateKey === gateKey && current.status === "missing"
        ? { ...current, dismissed: true }
        : current,
    );
  }, [gateKey]);

  return {
    agentStartupAllowed:
      !enabled || effectiveState.status === "ready" || effectiveState.status === "check-failed",
    error,
    dismissError,
    ensureReadyForSend,
    markProviderNotReady,
  };
}
