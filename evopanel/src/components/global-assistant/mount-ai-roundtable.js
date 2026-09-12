/**
 * 将 AIRoundtableRoom React UI 挂到小V根节点（全屏会议室）
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import AIRoundtableRoom from '../../react/components/AIRoundtableRoom.tsx'

/**
 * @param {HTMLElement} parent
 * @param {{
 *   onTopicChange: (v: string) => void
 *   onSend: (topic: string) => void
 *   onMention: (agentCodes: string[], topic: string) => void
 *   onStop: () => void
 *   onSelectParticipant: (agentCode: string) => void
 *   onClearMention: () => void
 *   onCollapse: () => void
 *   onClose: () => void
 *   onToggleCreator: () => void
 *   onToggleTranscript: () => void
 *   onToggleTts?: () => void
 * }} handlers
 */
export function mountAiRoundtableRoom(parent, handlers) {
  const host = document.createElement('div')
  host.className = 'ai-rt-host'
  host.setAttribute('data-ai-roundtable-host', '1')
  parent.appendChild(host)
  const root = createRoot(host)

  /** @type {object | null} */
  let lastState = null

  function normalizeTargets(raw) {
    if (Array.isArray(raw)) return raw.map((c) => String(c || '').trim()).filter(Boolean)
    const one = String(raw || '').trim()
    return one ? [one] : []
  }

  function render(st) {
    lastState = st
    root.render(
      createElement(AIRoundtableRoom, {
        participants: st.meetingParticipants || [],
        agents: st.agents || [],
        messages: st.meetingMessages || [],
        topicDraft: st.meetingTopic || '',
        currentTopic: st.meetingCurrentTopic || '',
        activeSpeaker: st.meetingActiveSpeaker || '',
        mentionTargets: normalizeTargets(st.meetingMentionTargets),
        sending: !!st.meetingSending,
        polling: !!st.meetingPolling,
        creatorMode: !!st.meetingCreatorMode,
        transcriptCollapsed: !!st.meetingTranscriptCollapsed,
        ttsMuted: st.meetingTtsMuted !== false,
        ...handlers,
      }),
    )
  }

  return {
    update(st) {
      render(st)
    },
    destroy() {
      lastState = null
      try {
        root.unmount()
      } catch {
        /* ignore */
      }
      host.remove()
    },
    get host() {
      return host
    },
    get lastState() {
      return lastState
    },
  }
}
