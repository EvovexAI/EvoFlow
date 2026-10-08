import { memo, useCallback, useState } from "react";
import {
  TID_V4_WORKSPACE_HOOK_PENDING_BANNER,
  TID_V4_WORKSPACE_HOOK_PENDING_DISMISS,
  TID_V4_WORKSPACE_HOOK_PENDING_REVIEW,
} from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { logger } from "@/logger.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import {
  findWorkspaceHookCommandBinding,
  useWorkspaceHookReviewStore,
  type WorkspaceHookCommandBinding,
} from "@/store/workspaceHookReviewStore.js";
import { sendWorkspaceHookCommand } from "@/settings/workspaceHookReviewCommands.js";

/**
 * 软门禁 dismiss store：轻量模块级 Map。
 * 幂等 key = sessionId + bundleDigest；bundle 变化后提示条重新出现。
 * 不落盘——刷新或重载后重新提示，符合「用户应该知道」的产品语义。
 */
class WorkspaceHookPendingDismissStore {
  private dismissed = new Set<string>();

  /** 标记某个 session+bundle 组合已 dismiss */
  dismiss(sessionId: string, bundleDigest: string): void {
    this.dismissed.add(this.key(sessionId, bundleDigest));
  }

  /** 查询是否已 dismiss */
  isDismissed(sessionId: string, bundleDigest: string): boolean {
    return this.dismissed.has(this.key(sessionId, bundleDigest));
  }

  /** 清空全部 dismiss 记录（测试用） */
  clear(): void {
    this.dismissed.clear();
  }

  private key(sessionId: string, bundleDigest: string): string {
    return `${sessionId}:${bundleDigest}`;
  }
}

const workspaceHookPendingDismissStore = new WorkspaceHookPendingDismissStore();

interface WorkspaceHookAdmissionInfo {
  pendingCount: number;
  bundleDigest: string;
  workspaceIdentity?: string;
}

interface WorkspaceHookPendingBannerProps {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  admission: WorkspaceHookAdmissionInfo | null;
}

/**
 * 软门禁常驻提示条。
 *
 * 当 snapshot.workspaceHookAdmission.pendingCount > 0 时显示，提供 [去审核] 与 [忽略]。
 * - [去审核]：打开设置页 Hooks 分区 + 发送 requestWorkspaceHookReview 命令。
 *   命令发送失败不阻断导航（容错，logger 记 warn）。
 * - [忽略]：renderer 本地 dismiss，幂等 key = sessionId + bundleDigest。
 */
export const WorkspaceHookPendingBanner = memo(function WorkspaceHookPendingBanner({
  sessionId,
  workspacePath,
  workspaceIdentity,
  admission,
}: WorkspaceHookPendingBannerProps) {
  const { intl } = useZCodeIntl();
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  const commandBindings = useWorkspaceHookReviewStore((state) => state.commandBindings);
  const [, setDismissRevision] = useState(0);

  const handleReview = useCallback(() => {
    // 两行式打开设置页：设置 intent 再 open tab（仿 V4ComposerToolbar 的 handleOpenModelProviderSettings）
    setPendingSettingsSectionIntent("hooks");
    openSettingsTab?.();

    // 通过 command binding 发送 requestWorkspaceHookReview 命令。
    // 该通道正是为无 pending review interaction 时保留命令通道而设。
    const binding = findWorkspaceHookCommandBinding(
      commandBindings,
      workspacePath,
      workspaceIdentity,
    );
    if (binding && admission) {
      const payload = {
        sessionId,
        workspaceIdentity: admission.workspaceIdentity ?? workspaceIdentity ?? workspacePath,
        bundleDigest: admission.bundleDigest,
      };
      void sendWorkspaceHookCommand(
        binding as Pick<WorkspaceHookCommandBinding, "sendCommand" | "onCommandSettled">,
        sessionId,
        "requestWorkspaceHookReview",
        payload,
      ).catch((error) => {
        // 命令发送失败不阻断导航（容错）——用户已到达设置页，可手动操作。
        logger.warn("[workspace-hook-pending] requestWorkspaceHookReview 发送失败", {
          sessionId,
          bundleDigest: admission.bundleDigest,
          error,
        });
      });
    }
  }, [admission, commandBindings, openSettingsTab, sessionId, workspaceIdentity, workspacePath]);

  const handleDismiss = useCallback(() => {
    if (admission) {
      runUserAction({
        input: { featureId: "conversation.blocking.hook", action: "dismiss", trigger: "button" },
        operation: () => {
          workspaceHookPendingDismissStore.dismiss(sessionId, admission.bundleDigest);
          // Bug 原因：模块级 Set 的写入不属于 React 状态，memo 组件不会重渲染。
          setDismissRevision((revision) => revision + 1);
        },
        completed: { resultSource: "local_commit" },
        failureStage: "hook_dismiss",
      });
    }
  }, [admission, sessionId]);

  if (!admission || admission.pendingCount <= 0) {
    return null;
  }

  // 幂等 dismiss 检查：同 bundle 已 dismiss 则隐藏
  if (workspaceHookPendingDismissStore.isDismissed(sessionId, admission.bundleDigest)) {
    return null;
  }

  return (
    <div
      role="status"
      data-testid={TID_V4_WORKSPACE_HOOK_PENDING_BANNER}
      className="mb-3 flex w-full shrink-0 flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-ui-base text-foreground backdrop-blur-md"
    >
      <p className="min-w-0 flex-1">
        {intl.formatMessage(
          { id: "chat.workspaceHookPending.message" },
          { count: admission.pendingCount },
        )}
      </p>
      <button
        type="button"
        data-testid={TID_V4_WORKSPACE_HOOK_PENDING_REVIEW}
        className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-primary-foreground hover:bg-primary/80"
        onClick={handleReview}
      >
        {intl.formatMessage({ id: "chat.workspaceHookPending.review" })}
      </button>
      <button
        type="button"
        data-testid={TID_V4_WORKSPACE_HOOK_PENDING_DISMISS}
        className="shrink-0 rounded-md px-2 py-1 text-foreground-subtle hover:bg-hover"
        onClick={handleDismiss}
      >
        {intl.formatMessage({ id: "chat.workspaceHookPending.dismiss" })}
      </button>
    </div>
  );
});
