import { useCallback, useEffect, useRef, useState } from "react";
import type { ZCodeModelTrajectory } from "@zcode/services";
import { logger } from "@/logger.js";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";

interface ModelTrajectoryState {
  loading: boolean;
  data: ZCodeModelTrajectory | null;
  error: string | null;
}

const INITIAL_STATE: ModelTrajectoryState = {
  loading: false,
  data: null,
  error: null,
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }
  return String(error);
}

/**
 * 读取某个 task/session 的模型调用轨迹（model-io）。
 *
 * 路径解析与文件读取都收口在 zcodeTaskService.getModelTrajectory（host 侧），
 * 桌面读本机、手机远控读远端 host，UI 只消费结构化结果。
 */
export function useModelTrajectory(
  workspacePath: string,
  taskId: string | null,
  workspaceIdentity?: string,
): ModelTrajectoryState & { refresh: () => void } {
  const zcodeTaskService = useZCodeTaskService(workspacePath, undefined, workspaceIdentity);
  const [state, setState] = useState<ModelTrajectoryState>(INITIAL_STATE);
  const [reloadToken, setReloadToken] = useState(0);
  const requestVersionRef = useRef(0);

  const refresh = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    let disposed = false;

    if (!taskId) {
      requestVersionRef.current += 1;
      setState(INITIAL_STATE);
      return () => {
        disposed = true;
      };
    }

    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    setState({ loading: true, data: null, error: null });

    void zcodeTaskService
      .getModelTrajectory({ taskId })
      .then((data) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }
        setState({ loading: false, data, error: null });
      })
      .catch((error: unknown) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }
        const message = getErrorMessage(error);
        logger.warn("[useModelTrajectory] 读取模型调用轨迹失败", {
          workspacePath,
          taskId,
          workspaceIdentity,
          error: message,
        });
        setState({ loading: false, data: null, error: message });
      });

    return () => {
      disposed = true;
    };
  }, [zcodeTaskService, taskId, workspaceIdentity, workspacePath, reloadToken]);

  return { ...state, refresh };
}
