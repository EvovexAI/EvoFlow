/**
 * EvoFlow v4 shell — ZCode 主对话 UI 的挂载根。
 *
 * 把 vendored ``zcode-ui`` 的 ``V4ChatPane``（SessionPane 全链路）包进它所需的最小
 * Provider 栈（见 docs/h2-v4-shell.md 的 H3-C 清单 + ZCode WorkspaceShellLayout 用法）：
 *
 *   PlatformProvider（平台能力） → ZCodeIntlProvider（i18n，50 文件消费）
 *   → StoreProvider（zcode 全局 store，需 broadcastService）
 *   → TabStoreProvider（workspace/tab 上下文）
 *   → ServiceProvider（IServiceAccessor = EvoFlow 服务壳）
 *   → V4ChatPane（= V4ConversationProvider → SessionPane）
 *
 * useTheme 是自包含 hook（localStorage + matchMedia），不需要 Provider。
 */

import type { ReactNode } from "react";
import { PlatformProvider } from "@zcode/ui/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "@zcode/ui/i18n/IntlProvider.js";
import { StoreProvider } from "@zcode/ui/store/StoreProvider.js";
import { TabStoreProvider } from "@zcode/ui/store/TabStoreProvider.js";
import { V4ChatPane } from "@zcode/ui/v4/V4ChatPane.js";
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
    <PlatformProvider platform={evoflowPlatform}>
      <ZCodeIntlProvider initialLocale="zh-CN">
        <StoreProvider broadcastService={evoflowServices.broadcastService}>
          <TabStoreProvider>
            <V4ChatPane
              workspacePath={workspacePath}
              sessionId={sessionId}
              isDesktop={false}
              onSessionCreated={onSessionCreated}
            />
          </TabStoreProvider>
        </StoreProvider>
      </ZCodeIntlProvider>
    </PlatformProvider>
  );
}
