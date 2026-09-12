export { mountGlobalAssistant, unmountGlobalAssistant, openGlobalAssistant, handleXiaomiVoiceTranscript } from './GlobalAssistant.js'
export {
  ensureXiaomiSession,
  sendXiaomiChat,
  stopXiaomiChat,
  startXiaomiNewRound,
  startXiaomiNewChat,
  switchXiaomiSession,
  refreshXiaomiSessionList,
  bindXiaomiStreamListener,
} from './assistant-session.js'
export { extractPageContext, shouldHideAssistant, isModuleGuideRoute, moduleGuideSuggestions, collectXiaomiPageSnapshot, edgeCoachTip } from './assistant-context.js'
export { isFabUserHidden, setFabUserHidden } from './assistant-store.js'
export {
  computeBadgeCount,
  greetingByHour,
  buildAttentionItems,
  detectChatIntent,
} from './assistant-rules.js'
