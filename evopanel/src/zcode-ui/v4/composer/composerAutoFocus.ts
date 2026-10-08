/**
 * composer 自动聚焦决策（纯函数，脱离 React/DOM 便于单测）。
 *
 * 新建任务（startDraft 递增 draftFocusVersion）/ 切换会话（sessionId→scope 变化）/ 挂载
 * 都会请求把光标交还输入框，但是否真的聚焦取决于三态：
 * - `skip`：未启用（竖切后台 pane，autoFocusEnabled=false）或移动端 viewport
 *   （自动聚焦会弹出软键盘，体验较扰）——不聚焦，也不暂存意图。
 * - `defer`：已启用但 composer 暂不可编辑（切到连接中会话时短暂 disabled）——聚焦意图
 *   暂存，待 disabled→false 可编辑后兑现一次。
 * - `focus-now`：已启用且可编辑，立即聚焦。
 */
type ComposerAutoFocusDecision = "focus-now" | "defer" | "skip";

export interface ComposerAutoFocusOptions {
  /** 宿主门控（SessionPane.focused）：仅焦点 pane 自动聚焦。 */
  autoFocusEnabled: boolean;
  /** composer 是否不可编辑（v4：sessionId 连接中）。 */
  disabled: boolean;
  /** 是否移动端文本输入 viewport。 */
  isMobileViewport: boolean;
}

export function resolveComposerAutoFocus({
  autoFocusEnabled,
  disabled,
  isMobileViewport,
}: ComposerAutoFocusOptions): ComposerAutoFocusDecision {
  if (!autoFocusEnabled || isMobileViewport) return "skip";
  if (disabled) return "defer";
  return "focus-now";
}
