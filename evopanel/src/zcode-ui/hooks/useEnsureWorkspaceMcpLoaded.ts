import { useEffect } from "react";
import { useServices } from "@/hooks/useServices.js";
import { setMcpStoreDirectoryService, useMcpStore } from "@/store/mcpStore.js";

export function useEnsureWorkspaceMcpLoaded(
  workspaceAbsPath: string,
  workspaceIdentity: string | undefined,
  rpcReady: boolean,
) {
  const services = useServices();

  useEffect(() => {
    if (!rpcReady) {
      return;
    }
    setMcpStoreDirectoryService(services.mcpSyncService);
    return () => {
      setMcpStoreDirectoryService(null);
    };
  }, [rpcReady, services.mcpSyncService]);

  useEffect(() => {
    if (!rpcReady) {
      // remote tab 恢复时 App 会先拿到断连代理；若立即
      // 读取 MCP 目录，只是在 store 内吞掉了断连错误，并未遵守 workspace
      // RPC 隔离边界。等待真实 services 注册后再执行，不缓存也不跨 transport 重放。
      return;
    }
    void useMcpStore
      .getState()
      .ensureLoadedForWorkspace(workspaceAbsPath, services.mcpSyncService, workspaceIdentity);
  }, [rpcReady, services.mcpSyncService, workspaceAbsPath, workspaceIdentity]);
}
