/**
 * 兼容旧路径：实现已迁到 agent-tts-voices.js
 */
export {
  genderFromSpeakerId,
  readAgentTtsSpeaker,
  readAgentTtsSpeechRate,
  inferAgentTtsGender,
  inferMeetingAgentGender,
  resolveAgentTtsSpeaker,
  resolveMeetingAgentSpeaker,
  resolveAgentTtsSpeechRate,
  agentTtsVoiceLabel,
  meetingAgentVoiceLabel,
  DEFAULT_AGENT_TTS_SPEECH_RATE,
} from './agent-tts-voices.js'
