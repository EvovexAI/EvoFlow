// Computer Use Helper 的 macOS 权限状态。状态来自 Helper 当前 runtime preflight，
// 历史 TCC 行不参与判定；展示口径见 cuaPermissionStatusStore 的 isCuaPermissionTccGranted。
//
// 刷新策略**不再定时轮询**，改为事件驱动，只在这三个时机各拉一次——
// - 挂载（进入设置页 / 输入框入口首次渲染）；
// - 窗口重获焦点（用户刚从 macOS 系统设置授权完切回来）；
// - 调用方显式 refresh（插件开关、Helper 重启、授权返回恢复链）。
//
// 去掉轮询的原因：授权状态是低频事件，秒级轮询除了压 host RPC，还会让 UI 持续抖动——
// 每轮查询开始都要把 fresh 置回 false，设置页的授权按钮就在「打开系统设置」与「验证中…」
// 之间反复横跳。状态本身存放在 lib/cuaPermissionStatusStore 的进程内共享缓存里，
// 设置页与输入框入口读同一份，重新进入页面时先渲染上次的授权状态，不再从「未知」闪起。
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { CuaPermissionStatusQueryOptions, CuaPermissionStatusResult } from "@zcode/services";
import {
  cuaPermissionStatusKey,
  fetchCuaPermissionStatus,
  getCuaPermissionStatusSnapshot,
  subscribeCuaPermissionStatus,
} from "@/lib/cuaPermissionStatusStore.js";
import { useOptionalServices } from "./useServices.js";

export function useCuaPermissionStatus(
  workspacePath: string | null,
  workspaceIdentity?: string,
): {
  status: CuaPermissionStatusResult | null;
  fresh: boolean;
  /** 展示用的稳定标志：有可展示内容即为 true，不随每次查询回落。见 store 内注释。 */
  settled: boolean;
  refresh: (options?: CuaPermissionStatusQueryOptions) => void;
} {
  const services = useOptionalServices();
  // cuaPermissionService 在 main 是可选字段（远端 host 无 CUA）。缺失时不查询，
  // 快照恒为空——调用方据此显示「未知」。
  const cuaPermissionService = services?.cuaPermissionService;
  const key =
    workspacePath && cuaPermissionService
      ? cuaPermissionStatusKey(workspacePath, workspaceIdentity)
      : null;

  const snapshot = useSyncExternalStore(
    subscribeCuaPermissionStatus,
    useCallback(() => getCuaPermissionStatusSnapshot(key), [key]),
  );

  const query = useCallback(
    (mode: "refresh" | "ensure", options?: CuaPermissionStatusQueryOptions): void => {
      if (!workspacePath || !cuaPermissionService) return;
      fetchCuaPermissionStatus({
        service: cuaPermissionService,
        workspacePath,
        mode,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(options ? { options } : {}),
      });
    },
    [cuaPermissionService, workspaceIdentity, workspacePath],
  );

  const refresh = useCallback(
    (options?: CuaPermissionStatusQueryOptions): void => query("refresh", options),
    [query],
  );

  useEffect(() => {
    if (!workspacePath || !cuaPermissionService) return;
    // 进入页面拉一次。设置页与输入框入口可能先后挂载，用 ensure 让后者搭上前者在飞的查询。
    query("ensure");
    // 用户刚从 macOS 系统设置授权完切回来：状态可能已变，必须是强制重查。
    const onFocus = (): void => query("refresh");
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [cuaPermissionService, query, workspacePath]);

  return {
    status: snapshot.status,
    fresh: snapshot.fresh,
    settled: snapshot.settled,
    refresh,
  };
}
