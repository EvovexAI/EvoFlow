import { renderChatAppView } from './chat-app/view/chat-app-view.js'
import { useChatAppController } from './chat-app/use-chat-app-controller.js'
import { hideRightStageIfKind } from '../lib/right-stage/right-stage-store.js'
import { ensureRightStageKindsRegistered } from './right-stage/register-kinds.js'

ensureRightStageKindsRegistered()
hideRightStageIfKind('artifacts')

export default function ChatApp() {
  return renderChatAppView(useChatAppController())
}

/**
 * HMR 自我保护：controller 体量巨大且内部有大量 useCallback/闭包，
 * Vite react-refresh 部分热替换时旧闭包可能引用正在重新初始化的顶层 const（TDZ），
 * 导致一次性 `Cannot access 'xxx' before initialization` 崩溃白屏。
 * 显式 accept 整模块：热更新时整体重渲染，避免部分热替换的闭包残留。
 */
if (import.meta.hot) {
  import.meta.hot.accept()
}
