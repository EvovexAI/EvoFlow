/** Xiaomi Frame-runtime voice public API. */
export {
  getXiaomiAsrProvider,
  setXiaomiAsrProvider,
  getXiaomiTtsProvider,
  setXiaomiTtsProvider,
  getXiaomiTtsSpeaker,
  setXiaomiTtsSpeaker,
} from './config.js'

export {
  connectXiaomiFrameSession,
  isXiaomiFrameSessionActive,
  isXiaomiFrameSessionConnecting,
  isXiaomiFrameRuntimePreferred,
  sendXiaomiAssistantBegin,
  sendXiaomiAssistantDelta,
  sendXiaomiAssistantEnd,
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
  beginVoiceTrace,
  adoptVoiceTrace,
  getVoiceTrace,
  getVoiceSid,
  setVoiceSid,
} from './voice-file-log.js'
