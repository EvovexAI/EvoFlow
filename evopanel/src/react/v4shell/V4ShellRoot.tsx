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
 *   → V4ChatPane（= V4ConversationProvider → SessionPane）
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
import { V4ChatPane } from "@zcode/ui/v4/V4ChatPane.js";
// ZCode ui 全套样式（tailwind v4 source(".") 扫描 zcode-ui 树 + shadcn/tw-animate 变体）。
import "@zcode/ui/styles.css";
import { evoflowServices } from "./evoflowServices.js";
import { evoflowPlatform } from "./evoflowPlatform.js";

export interface V4ShellRootProps {
  /** EvoFlow 尚无 workspace 概念；恒定主 workspace 路径即可（服务端订阅不消费它）。 */
  workspacePath: string;
  /** v4 会话 id；null = 草稿态（新会话）。 */
  sessionId: string | null;
  onSessionCreated?: (sessionId: string) => void;
  children?: ReactNode;
}

export function V4ShellRoot({
  workspacePath,
  sessionId,
  onSessionCreated,
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
                      <V4ChatPane
                        workspacePath={workspacePath}
                        sessionId={sessionId}
                        isDesktop={false}
                        onSessionCreated={onSessionCreated}
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
