// 回放导出桶。
//
// 下游浏览器端回放页面要在**静态数据**上装配 run 详情页：board（WorkflowRunGraphSection）、只读
// SessionPane、折叠分区的表头栏，以及它们需要的 Provider 与数据层缝。这些组件本来
// 只在包内被 App 使用、不在 index 导出；这里集中放出一份，不改任何组件行为。
//
// 纪律：只 re-export，不定义任何东西。
//
// run 侧板的 Results / 事件日志 /
// Script 三节已从产品里撤走，对应的三个组件随之删除，这里的条目也一并去掉。事件行的纯
// 格式化器 `workflowRunEventLines` 与它那批 i18n 键**保留**：它不是被撤掉的那块 UI，
// 而是 journal 事件的展示规则，浏览器端回放仍在静态数据上用它。
export { SessionPane, type SessionPaneProps } from "./v4/SessionPane.js";
export {
  V4ConversationContext,
  type V4ConversationContextValue,
} from "./v4/V4ConversationContext.js";
export { SessionDataLayer, type SessionLease } from "./v4/sessionDataLayer.js";
export type { ConversationTransport, ConversationAttachmentReadParams } from "./v4/transport.js";
export { WorkflowRunPhaseList } from "./app-shell/WorkflowRunPhaseList.js";
export { WorkflowRunSectionToggle } from "./app-shell/WorkflowRunSectionToggle.js";
export {
  workflowRunEventLines,
  workflowRunResultView,
  type WorkflowActorInstance,
  type WorkflowRunEventItem,
  type WorkflowRunEventLine,
} from "./app-shell/workflowRunPanel.js";
export { WorkflowTimeline } from "./components/workflow-timeline/WorkflowTimeline.js";
export { buildWorkflowTimeline } from "./components/workflow-timeline/timeline-model.js";
export type { WorkflowCausalityGraphData } from "./components/workflow-graph/types.js";
export { workflowRunOverlay } from "./components/workflow-graph/run-status.js";
export { TooltipProvider } from "./components/ui/tooltip.js";
export { ServiceProvider } from "./hooks/useServices.js";
export { PlatformProvider } from "./hooks/usePlatform.js";
export { StoreProvider, useZCodeStore } from "./store/StoreProvider.js";
export { TabStoreProvider } from "./store/TabStoreProvider.js";
export { DiffsWorkerPoolProvider } from "./root/DiffsWorkerPoolProvider.js";
export { ZCodeIntlProvider, useZCodeIntl } from "./i18n/IntlProvider.js";
export { Button } from "./components/ui/button.js";
export { cn } from "./components/lib/utils.js";
