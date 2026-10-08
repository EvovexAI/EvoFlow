import { useCallback, useEffect, useRef, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { DraftSuggestedPluginFlow } from "@/v4/ConversationDraftSuggestedPluginFlow.js";

const PLUGIN_ACTION_SUCCESS_DURATION_MS = 2_000;
const PLUGIN_ACTION_ERROR_DURATION_MS = 3_000;

export type DraftSuggestedPluginActionPopoverState = {
  anchorItemId: string;
  operationId: string;
  phase: "confirmation" | "progress" | "success" | "error";
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
};

type OperationTimer = {
  operationId: string;
  timer: ReturnType<typeof setTimeout>;
};

export function useDraftSuggestedPluginActionPopover() {
  const { intl } = useZCodeIntl();
  const [pluginActionPopover, setPluginActionPopover] =
    useState<DraftSuggestedPluginActionPopoverState | null>(null);
  const resultTimerRef = useRef<OperationTimer | null>(null);

  const clearTimer = useCallback(
    (timerRef: { current: OperationTimer | null }, operationId?: string) => {
      const current = timerRef.current;
      if (!current || (operationId && current.operationId !== operationId)) return;
      clearTimeout(current.timer);
      timerRef.current = null;
    },
    [],
  );

  const clearPluginActionPopover = useCallback(
    (operationId?: string) => {
      clearTimer(resultTimerRef, operationId);
      setPluginActionPopover((current) => {
        if (!current || (operationId && current.operationId !== operationId)) return current;
        return null;
      });
    },
    [clearTimer],
  );

  useEffect(() => {
    return () => {
      clearTimer(resultTimerRef);
    };
  }, [clearTimer]);

  const showPluginActionPopover = useCallback(
    (
      flow: DraftSuggestedPluginFlow,
      messageId: string,
      phase: DraftSuggestedPluginActionPopoverState["phase"],
      action?: { label: string; onAction: () => void; onDismiss?: () => void },
    ) => {
      clearTimer(resultTimerRef);
      setPluginActionPopover({
        anchorItemId: flow.anchorItemId,
        operationId: flow.operationId,
        phase,
        message: intl.formatMessage({ id: messageId }, { pluginLabel: flow.plugin.label }),
        ...(action
          ? {
              actionLabel: action.label,
              onAction: action.onAction,
              ...(action.onDismiss ? { onDismiss: action.onDismiss } : {}),
            }
          : {}),
      });
    },
    [clearTimer, intl],
  );

  const showPluginActionResultPopover = useCallback(
    (flow: DraftSuggestedPluginFlow, messageId: string, succeeded: boolean) => {
      showPluginActionPopover(flow, messageId, succeeded ? "success" : "error");
    },
    [showPluginActionPopover],
  );

  useEffect(() => {
    const current = pluginActionPopover;
    if (!current || (current.phase !== "success" && current.phase !== "error")) return;
    // 成功反馈的 2000ms 从 DOM 已提交后的 effect 开始计时，避免异步 render 吞掉可见时长。
    const durationMs =
      current.phase === "success"
        ? PLUGIN_ACTION_SUCCESS_DURATION_MS
        : PLUGIN_ACTION_ERROR_DURATION_MS;
    resultTimerRef.current = {
      operationId: current.operationId,
      timer: setTimeout(() => clearPluginActionPopover(current.operationId), durationMs),
    };
    return () => clearTimer(resultTimerRef, current.operationId);
  }, [clearPluginActionPopover, clearTimer, pluginActionPopover]);

  return {
    clearPluginActionPopover,
    pluginActionPopover,
    showPluginActionPopover,
    showPluginActionResultPopover,
  };
}
