import { useCallback, useEffect, useMemo } from "react";
import type { ICommandsService } from "@zcode/services";
import { useCommandsStore } from "@/store/commandsStore.js";
import type {
  CommandAgentSource,
  CommandConfig,
  CommandCreateParams,
  CommandDeleteParams,
  CommandSetEnabledParams,
  CommandUpdateParams,
} from "@zcode/shared";

interface UseCommandsOptions {
  // service 曾隐式取自 useServices()，而 workspacePath 由调用方按 Scope target 传入，
  // 于是 B 的路径会被发往 A 的 remote host。改为必传，由调用方按 target 解析后注入。
  commandsService: ICommandsService;
  workspacePath?: string;
  workspaceIdentity?: string;
  enabled?: boolean;
}

export function useCommands(options: UseCommandsOptions) {
  const { commandsService, workspacePath, workspaceIdentity, enabled = true } = options;

  const commands = useCommandsStore((state) => state.commands);
  const userCommands = useCommandsStore((state) => state.userCommands);
  const pluginCommands = useCommandsStore((state) => state.pluginCommands);
  const capability = useCommandsStore((state) => state.capability);
  const loading = useCommandsStore((state) => state.loading);
  const error = useCommandsStore((state) => state.error);
  const operatingCommandId = useCommandsStore((state) => state.operatingCommandId);
  const loadedWorkspacePath = useCommandsStore((state) => state.loadedWorkspacePath);
  const loadedWorkspaceIdentity = useCommandsStore((state) => state.loadedWorkspaceIdentity);
  // commandsStore 是单例，Scope 可在同一页面切 target。投影尚未对齐当前 target 时
  // 不能把上一个 host 的命令交给调用方渲染——那些行的 filePath 属于别的主机，一旦被
  // delete/toggle 就会拿着旧路径在当前 target 的 host 上执行。
  const projectionMatchesTarget =
    (loadedWorkspaceIdentity?.trim() || loadedWorkspacePath || "") ===
    (workspaceIdentity?.trim() || workspacePath || "");
  const initialize = useCommandsStore((state) => state.initialize);
  const refreshStore = useCommandsStore((state) => state.refresh);
  const createStore = useCommandsStore((state) => state.createCommand);
  const updateStore = useCommandsStore((state) => state.updateCommand);
  const deleteStore = useCommandsStore((state) => state.deleteCommand);
  const toggleStore = useCommandsStore((state) => state.toggleCommand);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    void initialize(workspacePath, commandsService, workspaceIdentity);
  }, [enabled, workspacePath, workspaceIdentity, commandsService, initialize]);

  const refresh = useCallback(() => refreshStore(commandsService), [commandsService, refreshStore]);

  const createCommand = useCallback(
    (
      config: CommandConfig,
      agentSource?: CommandAgentSource,
      params?: Omit<CommandCreateParams, "config" | "agentSource">,
    ) => createStore({ agentSource, config, ...params }, commandsService),
    [commandsService, createStore],
  );

  const updateCommand = useCallback(
    (params: CommandUpdateParams) => updateStore(params, commandsService),
    [commandsService, updateStore],
  );

  const deleteCommand = useCallback(
    (params: CommandDeleteParams) => deleteStore(params, commandsService),
    [commandsService, deleteStore],
  );

  const toggleCommand = useCallback(
    (params: CommandSetEnabledParams) => toggleStore(params, commandsService),
    [commandsService, toggleStore],
  );

  return useMemo(
    () => ({
      commands,
      userCommands,
      pluginCommands,
      capability,
      loading,
      error,
      operatingCommandId,
      projectionMatchesTarget,
      refresh,
      createCommand,
      updateCommand,
      deleteCommand,
      toggleCommand,
    }),
    [
      commands,
      userCommands,
      pluginCommands,
      capability,
      loading,
      error,
      operatingCommandId,
      projectionMatchesTarget,
      refresh,
      createCommand,
      updateCommand,
      deleteCommand,
      toggleCommand,
    ],
  );
}
