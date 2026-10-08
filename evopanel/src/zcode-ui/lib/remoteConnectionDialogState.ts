import type { RemoteWizardStep } from "@/RemoteConnectionWizardChrome.js";

interface RemoteConnectionDialogSnapshot {
  currentStep: RemoteWizardStep;
  loading: boolean;
  connectedSessionId: string | null;
}

type RemoteConnectionCompletionStatus = "success" | "error";

interface RemoteConnectionCompletionDialogState {
  open: boolean;
  step: RemoteWizardStep;
}

interface RemoteConnectionDirectoryFailureState {
  connectedSessionId: string | null;
  step: RemoteWizardStep;
}

export function isRemoteConnectionFlowActive(snapshot: RemoteConnectionDialogSnapshot): boolean {
  return snapshot.loading || Boolean(snapshot.connectedSessionId);
}

export function shouldResetRemoteConnectionOnOpen(
  snapshot: RemoteConnectionDialogSnapshot,
): boolean {
  return !isRemoteConnectionFlowActive(snapshot);
}

export function getRemoteConnectionCompletionDialogState(
  status: RemoteConnectionCompletionStatus,
): RemoteConnectionCompletionDialogState {
  return {
    // 远程连接弹窗收起后，连接完成只更新内部步骤但没有重新展示弹窗，
    // 用户会停留在其它页面且看不到选目录或失败原因。连接完成后统一拉起弹窗到结果步骤。
    open: true,
    step: status === "success" ? "directory" : "connecting",
  };
}

export function getRemoteConnectionDirectoryFailureState(params: {
  connectedSessionId: string;
  sessionStillRegistered: boolean;
}): RemoteConnectionDirectoryFailureState {
  if (params.sessionStillRegistered) {
    return {
      connectedSessionId: params.connectedSessionId,
      step: "directory",
    };
  }

  // workspace 初始化失败会回收未确认 logical session。
  // 目录步骤继续持有旧 sessionId 时只能拿到空 services，并永久显示“加载中”。
  return {
    connectedSessionId: null,
    step: "settings",
  };
}
