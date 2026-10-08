import { useCallback, useEffect, useRef, useState } from "react";
import type { Hook } from "@zcode/shared";
import type { IHooksService } from "@zcode/services";
import { toast } from "@/components/ui/toast.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useHooksStore } from "@/store/hooksStore.js";
import {
  findWorkspaceHookCommandBinding,
  findWorkspaceHookReviewBinding,
  useWorkspaceHookReviewStore,
} from "@/store/workspaceHookReviewStore.js";
import { trustWorkspaceHookWithReview } from "./workspaceHookReviewCommands.js";
import {
  didWorkspaceHookReviewSettle,
  resolveWorkspaceHookReasonCodeMessageId,
  shouldSilenceStaleRejection,
} from "./workspaceHookTrustState.js";

export function useWorkspaceHookInlineTrust(input: {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  hooksService?: IHooksService;
  rpcReady?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const contextServices = useServices();
  // Settings 的 PluginScopeMenu 可以选中非当前激活的（远程）workspace。
  // 信任后的列表刷新与 settings 预信任回退若走 useServices() 的 context 服务（指向激活
  // tab 的 host），RPC 会打到错误 host；remote-waiting 时 fallback 更会把越界 RPC 发给
  // 断连代理。因此 hooksService 必须由调用方传入按 target workspace 解析的服务，且
  // rpcReady=false 时禁用 fallback 与 refresh——信任链路宁可不可用，不可打错 host。
  const hooksService =
    input.rpcReady === false
      ? undefined
      : (input.hooksService ??
        (input.rpcReady === true ? contextServices.hooksService : undefined));
  const canUseHooksService = hooksService !== undefined;
  const refreshHooks = useHooksStore((state) => state.refresh);
  const [trustingHookId, setTrustingHookId] = useState<string | null>(null);
  const activeReview = useWorkspaceHookReviewStore((state) =>
    findWorkspaceHookReviewBinding(state.bindings, input.workspacePath, input.workspaceIdentity),
  );
  const activeReviewInteractionId = activeReview?.request.interactionId;
  const hasWorkspaceGrantAuthority =
    canUseHooksService && Boolean(hooksService!.grantWorkspaceHookTrust);
  const trustActionAvailable = useWorkspaceHookReviewStore(
    (state) =>
      hasWorkspaceGrantAuthority ||
      Boolean(
        findWorkspaceHookReviewBinding(
          state.bindings,
          input.workspacePath,
          input.workspaceIdentity,
        ) ??
        findWorkspaceHookCommandBinding(
          state.commandBindings,
          input.workspacePath,
          input.workspaceIdentity,
        ),
      ),
  );

  // 审核绑定结束后刷新列表，避免 Trust 已落盘但行内按钮仍停留在旧快照。
  const previousReviewInteractionId = useRef(activeReviewInteractionId);
  useEffect(() => {
    const settled = didWorkspaceHookReviewSettle({
      previousInteractionId: previousReviewInteractionId.current,
      currentInteractionId: activeReviewInteractionId,
    });
    previousReviewInteractionId.current = activeReviewInteractionId;
    if (!settled || !input.workspacePath || !canUseHooksService) return;
    // 三元组与 service 同刻捕获，防止 refresh 等待期间 scope 切换后污染新 workspace。
    const service = hooksService!;
    const target = {
      workspacePath: input.workspacePath,
      workspaceIdentity: input.workspaceIdentity,
    };
    void refreshHooks(service, target);
  }, [
    activeReviewInteractionId,
    canUseHooksService,
    hooksService,
    input.workspaceIdentity,
    input.workspacePath,
    refreshHooks,
  ]);

  const trustHook = useCallback(
    async (hook: Hook) => {
      if (!canUseHooksService) return;
      const service = hooksService!;
      setTrustingHookId(hook.id);
      try {
        const result = await trustWorkspaceHookWithReview({
          hook,
          workspacePath: input.workspacePath,
          workspaceIdentity: input.workspaceIdentity,
          ...(service.grantWorkspaceHookTrust
            ? {
                grantWithoutSession: (target) => service.grantWorkspaceHookTrust!(target),
              }
            : {}),
        });
        if (!result.accepted) {
          const currentBinding = findWorkspaceHookReviewBinding(
            useWorkspaceHookReviewStore.getState().bindings,
            input.workspacePath,
            input.workspaceIdentity,
          );
          const hasLivePendingBinding = Boolean(currentBinding);
          if (
            !shouldSilenceStaleRejection({
              reasonCode: result.reasonCode,
              hasLivePendingBinding,
            })
          ) {
            toast(
              intl.formatMessage({
                id: resolveWorkspaceHookReasonCodeMessageId(result.reasonCode),
              }),
            );
          }
          return;
        }
        // 成功后按发起时的 target 原子刷新；等待期间 scope 已切换则由 store 守卫丢弃。
        await refreshHooks(service, {
          workspacePath: input.workspacePath,
          workspaceIdentity: input.workspaceIdentity,
        });
      } catch (cause) {
        logger.error("[workspace-hook-trust] 行内信任命令失败", { cause });
        toast(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setTrustingHookId(null);
      }
    },
    [
      canUseHooksService,
      hooksService,
      input.workspaceIdentity,
      input.workspacePath,
      intl,
      refreshHooks,
    ],
  );

  return {
    activeReviewInteractionId,
    trustActionAvailable,
    trustingHookId,
    trustHook,
  };
}
