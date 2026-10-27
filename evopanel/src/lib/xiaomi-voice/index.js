/** Xiaomi Frame-runtime voice public API. */
export {
  getXiaomiAsrProvider,
  setXiaomiAsrProvider,
  getXiaomiTtsProvider,
  setXiaomiTtsProvider,
  getXiaomiTtsSpeaker,
  resolveXiaomiTtsSpeaker,
  setXiaomiTtsSpeaker,
  XIAOMI_DEFAULT_TTS_SPEAKER,
} from './config.js'

export {
  connectXiaomiFrameSession,
  isXiaomiFrameSessionActive,
  isXiaomiFrameSessionConnecting,
  isXiaomiFrameRuntimePreferred,
  isXiaomiFramePlaying,
  sendXiaomiAssistantBegin,
  sendXiaomiAssistantDelta,
  sendXiaomiAssistantEnd,
  sendXiaomiClientListening,
  sendXiaomiClientPhase,
  forceXiaomiOpenMic,
  stopXiaomiFrameLocalPlayback,
  bargeInXiaomiFrame,
  stopXiaomiFrameSession,
} from './session-client.js'

export {
  getVoicePhase,
  getVoicePhaseRaw,
  canUnmuteStt,
  canAcceptVadBarge,
  deriveVoicePhase,
  setVoicePhase,
  subscribeVoicePhase,
} from './voice-phase.js'

export {
  startXiaomiFramePipeline,
  stopXiaomiFramePipeline,
  toggleXiaomiFramePipeline,
  isXiaomiFramePipelineActive,
  isXiaomiFramePipelineStarting,
  isXiaomiFrameAwaitingReply,
  feedXiaomiFrameAssistant,
  flushXiaomiFrameAssistantSegment,
  flushXiaomiFrameAssistantStash,
  stashXiaomiFrameAssistantPending,
  resetXiaomiFrameAssistantFeed,
  interruptXiaomiFrame,
} from './pipeline-client.js'

export {
  voiceFeLog,
  voiceFeMirror,
  voicePlaybackMark,
  voiceDecisionLog,
  markWakeHitClock,
  noteWakeMilestone,
  flushVoiceFeLog,
  noteVoiceLogPathOnce,
  noteVoicePanelDisplay,
  noteVoicePanelSend,
  noteVoiceUiState,
  noteVoiceModeGate,
  formatVoiceLocalTs,
  getLastVoicePanelSnapshot,
  getLastVoiceUiStateLabel,
  getVoiceModeGate,
  beginVoiceTrace,
  adoptVoiceTrace,
  getVoiceTrace,
  getVoiceSid,
  setVoiceSid,
} from './voice-file-log.js'
