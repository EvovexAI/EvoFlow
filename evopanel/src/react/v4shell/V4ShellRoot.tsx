/**
 * EvoFlow v4 shell — ZCode 主对话 UI 的挂载根。
 *
 * Provider 栈镜像 ZCode 应用根（``zcode-ui/Root.tsx`` 的挂载序），只保留 v4 聊天链路
 * 必需的层：
 *
 *   LucideProvider（图标默认 strokeWidth=1.5，与 ZCode 视觉一致）
 *   → TooltipProvider（Radix tooltip 全局共享；大会话性能要求根层唯一实例）
 *   → ServiceProvider（IServiceAccessor = EvoFlow 服务壳）
 *   → PlatformProvider（平台能力）
 *   → StoreProvider（zcode 全局 store，需 broadcastService）
 *   → TabStoreProvider（workspace/tab 上下文）
 *   → DiffsWorkerPoolProvider（@pierre/diffs worker 池）
 *   → ZCodeIntlProvider（i18n，50 文件消费）
 *   → EvoFlowApp（v3.5: zcode 桌面 App.tsx 的 EvoFlow 适配版，桥接 onSelectSession，
 *     内部挂 WorkspaceShellLayout）
 *
 * useTheme 是自包含 hook（localStorage + matchMedia），不需要 Provider。
 */

import type { ReactNode } from "react";
import { LucideProvider } from "lucide-react";
import { TooltipProvider } from "@zcode/ui/components/ui/tooltip.js";
import { PlatformProvider } from "@zcode/ui/hooks/usePlatform.js";
import { ServiceProvider } from "@zcode/ui/hooks/useServices.js";
import { ZCodeIntlProvider } from "@zcode/ui/i18n/IntlProvider.js";
import { StoreProvider } from "@zcode/ui/store/StoreProvider.js";
import { TabStoreProvider } from "@zcode/ui/store/TabStoreProvider.js";
import { DiffsWorkerPoolProvider } from "@zcode/ui/root/DiffsWorkerPoolProvider.js";
import { CodingPlanUpgradeDialogProvider } from "@zcode/ui/settings/CodingPlanUpgradeDialogProvider.js";
// v3.5: 用 EvoFlowApp（zcode App.tsx 适配版）替代裸挂 V4ChatPane。
// EvoFlowApp 内部挂 WorkspaceShellLayout，让用户看到 zcode 桌面完整视觉壳
// (header + sidebar + chat + side pane + terminal)。EvoFlowApp 在 zcode-ui 树内
// 因为它要直接消费 zcode 内部 store (useZCodeSessionStore 等)。
import { EvoFlowApp } from "@zcode/ui/app-shell/EvoFlowApp.js";
// ZCode ui 全套样式（tailwind v4 source(".") 扫描 zcode-ui 树 + shadcn/tw-animate 变体）。
import "@zcode/ui/styles.css";
import { evoflowServices } from "./evoflowServices.js";
import { evoflowPlatform } from "./evoflowPlatform.js";

export interface V4ShellRootProps {
  /** EvoFlow 尚无 workspace 概念；恒定主 workspace 路径即可（服务端订阅不消费它）。 */
  workspacePath: string;
  /** v4 会话 id；null = 草稿态（新会话）。 */
  sessionId: string | null;
  /**
   * v3.5: zcode 侧栏点选 / "+ New Task" / createSession 时，桥到 EvoFlow 旧会话选择态。
   * - 点已有会话或 v4 内部 createSession 成功 → 传该会话 id
   * - 点 "+ New Task" → 传 null（EvoFlow 旧版等价 setSelectedSessionKey('')）
   *
   * 如果不传：zcode 内部 activeTaskId 变化不会同步给 EvoFlow，v4 视觉壳子能
   * 切 activeTaskId 但 EvoFlow 旧消息/侧栏不会联动。
   */
  onSelectSession?: (sessionId: string | null) => void;
  children?: ReactNode;
}

export function V4ShellRoot({
  workspacePath,
  sessionId,
  onSelectSession,
}: V4ShellRootProps) {
  return (
    <LucideProvider strokeWidth={1.5}>
      <TooltipProvider>
        <ServiceProvider services={evoflowServices}>
          <PlatformProvider platform={evoflowPlatform}>
            <StoreProvider broadcastService={evoflowServices.broadcastService}>
              <TabStoreProvider>
                <DiffsWorkerPoolProvider>
                  <CodingPlanUpgradeDialogProvider>
                    <ZCodeIntlProvider initialLocale="zh-CN">
                      {/*
                        * EvoFlowApp 是 zcode App.tsx 的 EvoFlow 适配版，挂在 V4ShellRoot
                        * 内部。EvoFlowApp 内部:
                        *   1. useEffect 把 selectedSessionKey 同步进 zcode session
                        *      store 的 activeTaskId
                        *   2. 调起 zcode App.tsx 1280 行的 useXxx hook 编排
                        *   3. 末尾挂 <WorkspaceShellLayout services={...} ...>，100+
                        *      props 全部 EvoFlow noop / 空值（zcode 内部有 default
                        *      兜底）
                        *   4. handleSelectTask / handleStartDraftInWorkspace 桥回
                        *      onSelectSession
                        */}
                      <EvoFlowApp
                        services={evoflowServices}
                        workspaceAbsPath={workspacePath}
                        sessionId={sessionId}
                        onSelectSession={onSelectSession ?? (() => {})}
                      />
                    </ZCodeIntlProvider>
                  </CodingPlanUpgradeDialogProvider>
                </DiffsWorkerPoolProvider>
              </TabStoreProvider>
            </StoreProvider>
          </PlatformProvider>
        </ServiceProvider>
      </TooltipProvider>
    </LucideProvider>
  );
}
