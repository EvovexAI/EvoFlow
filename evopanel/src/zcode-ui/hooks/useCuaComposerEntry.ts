/**
 * CUA 输入框常驻入口按钮的数据编排。
 *
 * 只做三件事：汇聚三路数据源、门控权限查询、把结果交给纯函数推导。
 * 判定规则本身全部在 lib/cuaComposerEntryState.ts，这里不复制任何一条分支。
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { isRemoteWorkspaceIdentity, ZCODE_CUA_OFFICIAL_PLUGIN_ID } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useCuaPermissionStatus } from "@/hooks/useCuaPermissionStatus.js";
import {
  resolveCuaComposerEntryView,
  type CuaComposerEntryView,
} from "@/lib/cuaComposerEntryState.js";
import {
  supportsLocalMacCuaPermissionOnboarding,
  supportsLocalWindowsCuaEntry,
} from "@/lib/cuaPlatform.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { getVisibleTaskMetas, getWorkspaceState } from "@/store/zcodeSessionStoreSelectors.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";

/** 与 zcodeSessionStoreTaskSlice 的 isRunningStatus 同口径。 */
const RUNNING_TASK_STATUSES = new Set(["creating", "restoring", "streaming"]);

export interface UseCuaComposerEntryParams {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  /** 手机 Web 远控壳；远控保护约束下不渲染本机 CUA 入口。 */
  /** 当前 composer 的 v4 snapshot.control.canStop，作为运行态的低延迟权威。 */
  currentSessionBusy?: boolean;
}

interface CuaComposerEntryController {
  view: CuaComposerEntryView;
  /** 点击按钮；仅在 view.clickAction === "open-settings" 时产生副作用。 */
  onActivate: () => void;
}

export function useCuaComposerEntry({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  currentSessionBusy = false,
}: UseCuaComposerEntryParams): CuaComposerEntryController {
  const platform = usePlatform();
  const services = useServices();
  const { settings } = useSettings();
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);

  const macLocalDesktop = supportsLocalMacCuaPermissionOnboarding(platform);
  const windowsLocalDesktop = supportsLocalWindowsCuaEntry(platform);
  // 与 ComputerUseSection 同口径的本地 workspace 判定：远程 workspace 的 CUA 会操作
  // 远端机器的屏幕，产品上不提供。
  const isLocalWorkspace =
    !remoteSessionId &&
    !(workspaceIdentity?.trim() && isRemoteWorkspaceIdentity(workspaceIdentity.trim()));

  // 默认隐藏：只有显式存过 false 才展示。
  // 用 !== false 而不是 === true，是因为 settings 未加载（null）或老用户缺该字段时都应按
  // 隐藏处理——若反过来默认展示，新用户会先闪一下按钮再消失，且后台白跑一轮权限查询。
  const hiddenBySettings = settings?.computerUseComposerEntryHidden !== false;

  const plugins = usePluginManagementStore((state) => state.plugins);
  const togglingPluginId = usePluginManagementStore((state) => state.togglingPluginId);
  const pluginStoreError = usePluginManagementStore((state) => state.error);
  // store.error 是插件面共享字段（marketplace/validate/load/任意插件 setEnabled
  // 失败都写）。只有失败操作的目标是 zcode-cua 时才映射为本按钮的错误态，
  // 归属由 store 的 lastFailedPluginId 记录。
  const lastFailedPluginId = usePluginManagementStore((state) => state.lastFailedPluginId);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  const cuaPlugin = plugins.find((plugin) => plugin.id === ZCODE_CUA_OFFICIAL_PLUGIN_ID);
  const pluginEnabled = cuaPlugin?.enabled === true;

  const pluginManagementService = services.pluginManagementService;
  const platformSupported = (macLocalDesktop || windowsLocalDesktop) && isLocalWorkspace;
  // 插件列表是按钮状态的必要输入。store 是全局单例且 initialize 内部按 workspaceKey 做了
  // in-flight 去重 + 缓存复用，因此与设置页共用同一条初始化路径不会放大 plugins/list 请求。
  const initializedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!platformSupported || hiddenBySettings || !workspacePath || !pluginManagementService) {
      return;
    }
    const key = `${workspacePath}\0${workspaceIdentity ?? ""}`;
    if (initializedKeyRef.current === key) return;
    initializedKeyRef.current = key;
    void initializePlugins({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      pluginService: pluginManagementService,
    });
  }, [
    hiddenBySettings,
    initializePlugins,
    platformSupported,
    pluginManagementService,
    workspaceIdentity,
    workspacePath,
  ]);

  // 输入框入口不承载状态展示（无色点、固定跳设置页），因此**完全不再查询权限**——权限查询
  // 会按需启动 Helper（getStatus 拉起链），挂载即查等于「打开 app 就启动 Helper」，违背懒
  // 启动语义。哪怕加上「按钮可见 + mac + 插件已启用」的门禁也不改变这一点：用户开了插件不
  // 等于此刻要付 Helper 启动的代价。权限真值只在两处读：设置页（打开时查询）与显式授权流。
  // permissionStatus 恒为 null；resolveUiState 把 null 归入 idle 中性态（非 error）。
  const { status: permissionStatus } = useCuaPermissionStatus(null, workspaceIdentity);

  // session-busy 判定粒度是 workspace：切换插件会让该 workspace 全部会话的
  // 工具集变化、prompt 缓存失效，影响面与禁用面必须一致，因此不能只看当前 task。
  // 复用 getWorkspaceState 的 identity→path fallback，避免这里重写一份 workspaceKey 规则。
  const workspaceSessionBusy = useZCodeSessionStore((state) => {
    const workspaceState = getWorkspaceState(state, workspacePath, workspaceIdentity);
    const runtimeBusy = Object.values(workspaceState.taskRuntimeByTaskId ?? {}).some(
      (runtime) =>
        RUNNING_TASK_STATUSES.has(runtime.status) || Boolean(runtime.activeInputId?.trim()),
    );
    if (runtimeBusy) return true;
    // 根因：V4 snapshot 已进入可停止的模型轮次时，workspace runtime 投影可能短暂
    // 回到 ready；task index 仍权威记录 persist status=running。只看 runtime 会让
    // CUA 入口在真实执行中保持可点击。合并两条既有事实源，任一 running 都锁住。
    return getVisibleTaskMetas(workspaceState).some((task) => task.status === "running");
  });
  // 当前 pane 的 snapshot.control.canStop 比 workspace 投影更早到达；两者 OR
  // 既保证本 composer 立即锁定，也保留同 workspace 其它 composer 的共享锁。
  const sessionBusy = currentSessionBusy || workspaceSessionBusy;

  const view = useMemo(
    () =>
      resolveCuaComposerEntryView({
        macLocalDesktop: macLocalDesktop && isLocalWorkspace,
        windowsLocalDesktop: windowsLocalDesktop && isLocalWorkspace,
        hiddenBySettings,
        permissionServiceAvailable: Boolean(services.cuaPermissionService),
        pluginEnabled,
        pluginToggling: togglingPluginId === ZCODE_CUA_OFFICIAL_PLUGIN_ID,
        pluginError:
          Boolean(pluginStoreError) && lastFailedPluginId === ZCODE_CUA_OFFICIAL_PLUGIN_ID,
        permissionStatus: permissionStatus ?? null,
        sessionBusy,
      }),
    [
      cuaPlugin,
      hiddenBySettings,
      lastFailedPluginId,
      isLocalWorkspace,
      macLocalDesktop,
      permissionStatus,
      pluginEnabled,
      pluginStoreError,
      sessionBusy,
      services.cuaPermissionService,
      togglingPluginId,
      windowsLocalDesktop,
    ],
  );

  const onActivate = useCallback(() => {
    if (!view.visible || view.clickAction !== "open-settings") return;
    setPendingSettingsSectionIntent("computerUse");
    openSettingsTab();
  }, [openSettingsTab, view]);

  return { view, onActivate };
}
