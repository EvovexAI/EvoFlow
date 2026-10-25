// V4PreviewPane — 右侧面板的 ZCode 正式预览件（全量接入 vendored PreviewPane）。
// 覆盖 CodeViewerSource 全部 9 种：file / patch / code-review / text / image /
// media / pdf / pptx / multi-file-diff——渲染与数据加载都在 ZCode 原实现里
// （fileService.stat / mediaPreview / pdf / pptx 由 useWorkspaceServices 拉取），
// 本文件只做宿主装配：Intl + Store + Platform + ServiceProvider（EvoFlow 沙箱文件服务）。
import { useMemo } from "react";
import { PreviewPane } from "@zcode/ui/PreviewPane.js";
import { ZCodeIntlProvider } from "@zcode/ui/i18n/IntlProvider.js";
import { StoreProvider } from "@zcode/ui/store/StoreProvider.js";
import { PlatformProvider } from "@zcode/ui/hooks/usePlatform.js";
import { ServiceProvider } from "@zcode/ui/hooks/useServices.js";
import type { IBroadcastService, BroadcastMessage } from "@zcode/services";
import type { CodeViewerSource } from "@zcode/ui/lib/codeViewer.js";
import { evoflowStubPlatform } from "../../../pages/settings/evoflow-bridge-services.js";
import { createEvoflowPartialServices } from "../../v4/V4ZCodeTimeline.js";

/**
 * Web 端 no-op 广播：createZCodeStore 注释明确 Web 可传 no-op 实现。
 * 右侧面板是单例视图，没有跨窗口同步诉求。
 */
const NOOP_BROADCAST: IBroadcastService = {
  async send() {},
  async acquireClaim() {
    return { status: "unavailable" } as const;
  },
  async commitClaim() {},
  async releaseClaim() {},
  async tryClaim() {
    return true;
  },
  onMessage: ((_listener: (message: BroadcastMessage) => void) => ({
    dispose() {},
  })) as IBroadcastService["onMessage"],
};

/** 宿主常写 source={{ type:'file', path }}，每帧新对象；按语义字段稳住引用，避免 PreviewPane 反复读盘。 */
function codeViewerSourceKey(source: CodeViewerSource): string {
  try {
    return JSON.stringify(source);
  } catch {
    const s = source as { type?: string; path?: string; title?: string };
    return `${s.type || ""}:${s.path || ""}:${s.title || ""}`;
  }
}

export function V4PreviewPane(props: {
  source: CodeViewerSource;
  /** LangGraph thread id：serve-file 按会话沙箱解析相对路径。 */
  threadId?: string;
  /** 会话工作区根（绝对路径）：面包屑/相对路径显示与文件解析依赖它。 */
  workspacePath?: string;
  onClose: () => void;
  /** 面板内部再次跳转（code-review 卡/引用/多文件列表）→ 换 tab 打开。 */
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
}): React.JSX.Element {
  const { source, threadId, workspacePath, onClose, onOpenCodeViewer } = props;
  const sourceKey = codeViewerSourceKey(source);
  // 同 path/内容只保留上一份 source 引用，父级重渲染不再触发 PreviewPane 重拉。
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 故意用语义 key，不用对象引用
  const stableSource = useMemo(() => source, [sourceKey]);
  // 访问器按 thread 建（thread_id 沙箱解析），会话切换即重建。
  const partialServices = useMemo(
    () => createEvoflowPartialServices(threadId ?? ""),
    [threadId],
  );
  return (
    <ZCodeIntlProvider initialLocale="zh-CN">
      <StoreProvider broadcastService={NOOP_BROADCAST}>
        <PlatformProvider platform={evoflowStubPlatform}>
          <ServiceProvider services={partialServices}>
            {/* zcode-bridge-root：styles-bridge 的 token / 暗色主题 / 滚动条作用域都收窄在此容器，
                缺了它 @theme 变量解析不出来（面包屑、代码块、diff 背景会整块发黑），
                同时 applyTheme 也靠它定位挂载目标，避免把整站切成暗色。 */}
            <div className="zcode-bridge-root flex h-full min-h-0 flex-col">
              <PreviewPane
                source={stableSource}
                onClose={onClose}
                workspacePath={workspacePath}
                onOpenCodeViewer={onOpenCodeViewer}
              />
            </div>
          </ServiceProvider>
        </PlatformProvider>
      </StoreProvider>
    </ZCodeIntlProvider>
  );
}
