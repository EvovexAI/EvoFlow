import type { Hook, ZCodeWorkspaceHookTrustGrantResult } from "@zcode/shared";
import type { WorkspaceHookBundleSnapshotData } from "@zcode/shared/workspace-hook-discovery";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IHooksService {
  /**
   * 加载 workspace 的 hooks 配置
   */
  loadHooks(params: { workspaceIdentity?: string; workspacePath: string }): Promise<{
    hooks: Hook[];
    hooksEnabled: boolean;
    workspaceHookSnapshot?: WorkspaceHookBundleSnapshotData;
    /** trust store 文件损坏/不可读时为 true（fail-closed：全部 hook 按未持久信任处理） */
    trustStoreCorrupt?: boolean;
  }>;

  /**
   * 保存 hooks 配置
   */
  saveHooks(params: {
    workspaceIdentity?: string;
    workspacePath: string;
    hooks: Hook[];
  }): Promise<void>;

  /**
   * 无 task/session 的 Workspace Hook 预信任。
   * 实现必须转发到 Agent authority 重新发现 canonical snapshot，禁止 service/UI 直接写 store。
   */
  grantWorkspaceHookTrust?(params: {
    workspaceIdentity?: string;
    workspacePath: string;
    bundleDigest: string;
    hookDeclarationDigest: string;
  }): Promise<ZCodeWorkspaceHookTrustGrantResult>;
}

export const IHooksService = createServiceDescriptor<IHooksService>(ServiceChannels.Hooks);
