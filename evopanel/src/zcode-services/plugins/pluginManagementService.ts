// 设置页插件管理薄服务实现——plugins/* 旧协议词的唯一 host 侧消费点。
// 插件安装/市场/启停的事实源在 zcode-cli 进程（读写 ~/.zcode 插件目录并热更新
// 运行态），host 无副本，故实现保持 agent 协议往返；收敛价值在 UI 层不再直触
// IZCodeAgentService，词表消费面从 UI 散点收拢到本文件一处。
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { IPluginManagementService } from "./pluginManagement.js";

interface PluginManagementServiceDependencies {
  zcodeAgentService: Pick<
    IZCodeAgentService,
    | "listPlugins"
    | "getPluginReferenceCatalog"
    | "resolveSuggestedPluginReference"
    | "onDynamicPluginOperationProgress"
    | "getPluginsOverview"
    | "addPluginMarketplace"
    | "removePluginMarketplace"
    | "updatePluginMarketplace"
    | "installPlugin"
    | "cancelPluginOperation"
    | "uninstallPlugin"
    | "updatePlugin"
    | "restoreBuiltinPlugin"
    | "configurePlugin"
    | "resetPluginConfig"
    | "validatePlugin"
    | "describePlugin"
    | "setPluginEnabled"
  >;
}

export function createPluginManagementService(
  dependencies: PluginManagementServiceDependencies,
): IPluginManagementService {
  const agent = dependencies.zcodeAgentService;
  return {
    listPlugins: (params) => agent.listPlugins(params),
    getPluginReferenceCatalog: (params) => agent.getPluginReferenceCatalog(params),
    resolveSuggestedPluginReference: (params) => agent.resolveSuggestedPluginReference(params),
    onDynamicPluginOperationProgress: (operationId) =>
      agent.onDynamicPluginOperationProgress(operationId),
    getPluginsOverview: (params) => agent.getPluginsOverview(params),
    addPluginMarketplace: (params) => agent.addPluginMarketplace(params),
    removePluginMarketplace: (params) => agent.removePluginMarketplace(params),
    updatePluginMarketplace: (params) => agent.updatePluginMarketplace(params),
    installPlugin: (params) => agent.installPlugin(params),
    cancelPluginOperation: (params) => agent.cancelPluginOperation(params),
    uninstallPlugin: (params) => agent.uninstallPlugin(params),
    updatePlugin: (params) => agent.updatePlugin(params),
    restoreBuiltinPlugin: (params) => agent.restoreBuiltinPlugin(params),
    configurePlugin: (params) => agent.configurePlugin(params),
    resetPluginConfig: (params) => agent.resetPluginConfig(params),
    validatePlugin: (params) => agent.validatePlugin(params),
    describePlugin: (params) => agent.describePlugin(params),
    setPluginEnabled: (params) => agent.setPluginEnabled(params),
  };
}
