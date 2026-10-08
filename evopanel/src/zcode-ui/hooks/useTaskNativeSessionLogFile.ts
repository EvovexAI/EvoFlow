import { useEffect, useRef, useState } from "react";
import type { ZCodeProvider } from "@zcode/shared";
import { logger } from "@/logger.js";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";

/**
 * useWorkspaceActiveTaskState 的导出返回类型间接引用此接口，声明生成要求它可导出。
 * @lintignore
 */
export interface TaskNativeSessionLogFileState {
  provider: ZCodeProvider | null;
  path: string | null;
  exists: boolean;
  loading: boolean;
  error: string | null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }

  return String(error);
}

const INITIAL_STATE: TaskNativeSessionLogFileState = {
  provider: null,
  path: null,
  exists: false,
  loading: false,
  error: null,
};

function supportsTaskNativeSessionLogFile(_provider: ZCodeProvider | null | undefined): boolean {
  // 仅剩 glm provider，始终支持读取原生会话日志。
  return true;
}

/**
 * 读取当前 task 对应的原生会话日志路径。
 *
 * 路径规则统一通过 zcodeTaskService 解析，避免 UI 层猜 provider 自己的目录结构。
 */
export function useTaskNativeSessionLogFile(
  workspacePath: string,
  taskId: string | null,
  providerHint?: ZCodeProvider | null,
  workspaceIdentity?: string,
  options: { enabled?: boolean } = {},
) {
  const zcodeTaskService = useZCodeTaskService(workspacePath, undefined, workspaceIdentity);
  const [state, setState] = useState<TaskNativeSessionLogFileState>(INITIAL_STATE);
  const requestVersionRef = useRef(0);
  const enabled = options.enabled ?? true;

  useEffect(() => {
    let disposed = false;

    if (!enabled || !workspacePath || !taskId) {
      requestVersionRef.current += 1;
      // 原生日志路径只在菜单动作里使用；拖拽时不应让每个 row 都发路径 RPC。
      setState(INITIAL_STATE);
      return () => {
        disposed = true;
      };
    }

    if (!supportsTaskNativeSessionLogFile(providerHint)) {
      requestVersionRef.current += 1;
      setState({
        provider: providerHint ?? null,
        path: null,
        exists: false,
        loading: false,
        error: null,
      });
      return () => {
        disposed = true;
      };
    }

    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;

    setState({
      provider: providerHint ?? null,
      path: null,
      exists: false,
      loading: true,
      error: null,
    });

    void zcodeTaskService
      .getTaskNativeSessionLogFile({
        taskId,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      })
      .then((result) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }

        setState({
          provider: result.provider ?? providerHint ?? null,
          path: result.path,
          exists: result.exists,
          loading: false,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }

        const message = getErrorMessage(error);
        logger.warn("[useTaskNativeSessionLogFile] 读取 task 原生日志路径失败", {
          workspacePath,
          taskId,
          providerHint,
          workspaceIdentity,
          error: message,
        });
        setState({
          provider: providerHint ?? null,
          path: null,
          exists: false,
          loading: false,
          error: message,
        });
      });

    return () => {
      disposed = true;
    };
  }, [enabled, zcodeTaskService, providerHint, taskId, workspaceIdentity, workspacePath]);

  return state;
}
