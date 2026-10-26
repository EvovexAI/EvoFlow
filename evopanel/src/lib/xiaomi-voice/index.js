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
  stopXiaomiFrameLocalPlayback,
  bargeInXiaomiFrame,
  stopXiaomiFrameSession,
} from './session-client.js'

export {
  startXiaomiFramePipeline,
  stopXiaomiFramePipeline,
  toggleXiaomiFramePipeline,
  isXiaomiFramePipelineActive,
  feedXiaomiFrameAssistant,
  stashXiaomiFrameAssistantPending,
  resetXiaomiFrameAssistantFeed,
  interruptXiaomiFrame,
} from './pipeline-client.js'

export {
  voiceFeLog,
  voiceFeMirror,
  voicePlaybackMark,
  flushVoiceFeLog,
  noteVoiceLogPathOnce,
  noteVoicePanelDisplay,
  noteVoicePanelSend,
  noteVoiceUiState,
  formatVoiceLocalTs,
  getLastVoicePanelSnapshot,
  getLastVoiceUiStateLabel,
  beginVoiceTrace,
  adoptVoiceTrace,
  getVoiceTrace,
  getVoiceSid,
  setVoiceSid,
} from './voice-file-log.js'
