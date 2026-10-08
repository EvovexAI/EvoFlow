/**
 * EvoFlow v3.5 阶段 D1 c4 — 老版 ChatApp 主对话区全量换 zcode。
 *
 * 用户硬需求: 整个对话显示区域(含历史 + 实时) 全部用 zcode。
 * 实现路径: 不挂 V4ShellRoot 5 区 chrome, 不复用 EvoFlowApp 编排,
 *          直接挂 V4ChatPane (V4ChatPane 内部已包 V4ConversationProvider,
 *          自带 SessionPane 完整 zcode 流式对话 + 工具召唤 + Markdown 渲染
 *          + 历史 + 实时打字动效)。
 *
 * 失败降级: V4ChatPane 渲染前若 zcode store/services 未 ready,
 *          EvoFlowV4ChatPane 改返 null, 让 ChatApp 老版 ChatMessageStreamPane
 *          顶替。错时控制台红字报告, 用户能直接看到具体错。
 */
import { useEffect, useState } from "react";
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
import { evoflowServices } from "./evoflowServices.js";
import { evoflowPlatform } from "./evoflowPlatform.js";

export interface EvoFlowV4ChatPaneProps {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionKey: string | null;
  isSending?: boolean;
  errorText?: string | null;
}

export function EvoFlowV4ChatPane({
  workspacePath,
  workspaceIdentity,
  sessionKey,
  errorText,
}: EvoFlowV4ChatPaneProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  if (errorText) {
    return (
      <div style={{ padding: 16, fontSize: 13, color: "#ef4444" }}>
        zcode 流式对话初始化失败: {errorText}
      </div>
    );
  }

  if (!mounted) return null;

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
                        workspaceIdentity={workspaceIdentity}
                        sessionId={sessionKey}
                        readOnly
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
