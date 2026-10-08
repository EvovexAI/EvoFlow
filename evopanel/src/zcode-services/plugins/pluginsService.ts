import type { PluginScope, PluginsOverviewResult } from "@zcode/shared";
import type { IPluginsService } from "./plugins.js";

interface PluginsServiceOptions {
  isDesktopRuntime?: boolean;
}

function createRetiredOverview(): PluginsOverviewResult {
  return {
    marketplaces: [],
    availablePlugins: [],
    installedPlugins: [],
    capability: { supported: false },
  };
}

function throwRetiredPluginManagement(): never {
  throw new Error("Legacy plugin management has been retired in ZCode Agent mode");
}

export function createPluginsService(_options?: PluginsServiceOptions): IPluginsService {
  return {
    async getOverview(_params: {
      workspacePath: string;
      workspaceIdentity?: string;
    }): Promise<PluginsOverviewResult> {
      return createRetiredOverview();
    },

    async addMarketplace(_params: {
      workspacePath: string;
      workspaceIdentity?: string;
      source: string;
    }): Promise<void> {
      throwRetiredPluginManagement();
    },

    async removeMarketplace(_params: {
      workspacePath: string;
      workspaceIdentity?: string;
      marketplace: string;
    }): Promise<void> {
      throwRetiredPluginManagement();
    },

    async updateMarketplace(_params: {
      workspacePath: string;
      workspaceIdentity?: string;
      marketplace?: string;
    }): Promise<void> {
      throwRetiredPluginManagement();
    },

    async installPlugin(_params: {
      workspacePath: string;
      workspaceIdentity?: string;
      pluginName: string;
      marketplace: string;
      scope?: PluginScope;
    }): Promise<void> {
      throwRetiredPluginManagement();
    },

    async uninstallPlugin(_params: {
      workspacePath: string;
      workspaceIdentity?: string;
      pluginName: string;
      marketplace: string;
      scope?: PluginScope;
    }): Promise<void> {
      throwRetiredPluginManagement();
    },

    async setPluginEnabled(_params: {
      workspacePath: string;
      workspaceIdentity?: string;
      pluginName: string;
      marketplace: string;
      scope?: PluginScope;
      nativeScope?: "user" | "project" | "local";
      enabled: boolean;
    }): Promise<void> {
      throwRetiredPluginManagement();
    },
  };
}
