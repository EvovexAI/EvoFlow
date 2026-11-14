/**
 * 部门群成员卡：本岗 TTS 音色 + 语速。
 * 音色用设置页同款全屏弹窗（可搜索 + 行内试听），不用窄侧栏原生 select。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../../lib/tauri-api.js'
import { toast } from '../../../components/toast.js'
import {
  VOLCENGINE_TTS_SPEAKER_PRESETS,
  VOLCENGINE_TTS_SPEAKER_TRIAL_URL,
} from '../../../lib/volcengine-tts-speakers.js'
import { openTtsSpeakerPicker, stopTtsSpeakerPreview } from '../../../components/tts-speaker-picker.js'
import {
  fetchSpeechConfigured,
  previewSpeechTts,
  stopAllAssistantSpeech,
} from '../../../lib/speech-client.js'
import {
  DEFAULT_AGENT_TTS_SPEECH_RATE,
  resolveAgentTtsSpeaker,
} from '../../../lib/agent-tts-voices.js'
import { notifyDeptGroupTtsAgentsChanged } from '../../lib/dept-group-tts-agents.js'

type Props = {
  agentCode: string
  roleName?: string
}

const RATE_MIN = -20
const RATE_MAX = 40

function rateLabel(rate: number) {
  if (rate === 0) return '原速'
  if (rate > 0) return `约 ${(1 + rate / 100).toFixed(2)}x`
  return `约 ${(1 + rate / 100).toFixed(2)}x`
}

function speakerDisplay(presets: Array<{ value: string; label: string }>, value: string) {
  const hit = presets.find((p) => p.value === value)
  if (hit) return { label: hit.label, id: hit.value, isCustom: false }
  if (value) return { label: '自定义音色', id: value, isCustom: true }
  return { label: '未选择', id: '', isCustom: true }
}

function previewLine(label: string, voiceType: string) {
  const name = String(label || '')
    .replace(/（.*?）/g, '')
    .replace(/\s*2\.0/g, '')
    .trim()
  const v = String(voiceType || '').toLowerCase()
  if (v.startsWith('en_') || v.includes('_en_')) {
    return name
      ? `Hello, this is ${name}. Welcome to the voice preview.`
      : 'Hello, welcome to the voice preview.'
  }
  return name ? `你好，我是${name}，欢迎试听豆包语音合成效果。` : '你好，欢迎试听豆包语音合成效果。'
}

export function DeptGroupVoiceSettings({ agentCode, roleName }: Props) {
  const code = String(agentCode || '').trim()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [speaker, setSpeaker] = useState('')
  const [speechRate, setSpeechRate] = useState(DEFAULT_AGENT_TTS_SPEECH_RATE)
  const [hasAgent, setHasAgent] = useState(true)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const genRef = useRef(0)

  const presets = useMemo(() => VOLCENGINE_TTS_SPEAKER_PRESETS, [])
  const disp = useMemo(() => speakerDisplay(presets, speaker), [presets, speaker])

  const stopLocalPreview = useCallback(() => {
    genRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    setPlaying(false)
  }, [])

  useEffect(() => () => {
    stopLocalPreview()
    stopTtsSpeakerPreview()
  }, [stopLocalPreview])

  const reload = useCallback(async () => {
    if (!code) return
    setLoading(true)
    try {
      const agent = await api.getAgent(code)
      setHasAgent(true)
      const resolved = resolveAgentTtsSpeaker(code, agent)
      setSpeaker(String(agent?.tts_speaker || resolved || '').trim())
      const raw = agent?.tts_speech_rate
      setSpeechRate(
        raw === null || raw === undefined || raw === ''
          ? DEFAULT_AGENT_TTS_SPEECH_RATE
          : Math.max(-50, Math.min(100, Math.round(Number(raw)))),
      )
    } catch {
      setHasAgent(false)
      setSpeaker(resolveAgentTtsSpeaker(code, { agent_code: code, role_name: roleName }))
      setSpeechRate(DEFAULT_AGENT_TTS_SPEECH_RATE)
    } finally {
      setLoading(false)
    }
  }, [code, roleName])

  useEffect(() => {
    void reload()
  }, [reload])

  const save = useCallback(
    async (patch: { tts_speaker?: string | null; tts_speech_rate?: number | null }) => {
      if (!code || !hasAgent) return
      setSaving(true)
      try {
        await api.updateAgent(code, patch)
        notifyDeptGroupTtsAgentsChanged({ agentCode: code })
        toast('已保存声线', 'success')
      } catch (e) {
        toast(String((e as Error)?.message || e || '保存失败'), 'error')
        void reload()
      } finally {
        setSaving(false)
      }
    },
    [code, hasAgent, reload],
  )

  const openPicker = useCallback(() => {
    if (loading || saving || !hasAgent) return
    stopLocalPreview()
    openTtsSpeakerPicker({
      presets,
      currentValue: speaker || presets[0]?.value || '',
      title: roleName ? `${roleName} · 选择音色` : '选择 TTS 音色',
      onSelect: (value: string) => {
        const next = String(value || '').trim()
        setSpeaker(next)
        void save({ tts_speaker: next || null })
      },
    })
  }, [loading, saving, hasAgent, presets, speaker, roleName, save, stopLocalPreview])

  const onPreview = useCallback(async () => {
    if (!speaker || disp.isCustom) return
    if (playing) {
      stopLocalPreview()
      return
    }
    stopTtsSpeakerPreview()
    stopAllAssistantSpeech({ reason: 'dept_voice_preview' })
    stopLocalPreview()
    const gen = genRef.current
    const ac = new AbortController()
    abortRef.current = ac
    setPlaying(true)
    try {
      const configured = await fetchSpeechConfigured()
      if (gen !== genRef.current) return
      if (!configured) {
        stopLocalPreview()
        toast('请先在设置中配置火山 TTS API Key，或前往豆包语音控制台试听', 'info')
        window.open(VOLCENGINE_TTS_SPEAKER_TRIAL_URL, '_blank', 'noopener,noreferrer')
        return
      }
      const { audio } = await previewSpeechTts(previewLine(disp.label, speaker), speaker, {
        signal: ac.signal,
      })
      if (gen !== genRef.current) {
        audio.pause()
        return
      }
      audioRef.current = audio
      audio.onended = () => {
        if (audioRef.current === audio) stopLocalPreview()
      }
      audio.onerror = () => {
        if (audioRef.current === audio) stopLocalPreview()
      }
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return
      stopLocalPreview()
      toast(String((e as Error)?.message || e), 'error')
    }
  }, [speaker, disp.isCustom, disp.label, playing, stopLocalPreview])

  if (!code) return null

  return (
    <div className="dept-voice-settings" aria-label="语音播报设置">
      <div className="dept-voice-settings__title">语音播报</div>
      {!hasAgent ? (
        <p className="dept-voice-settings__hint">无独立智能体配置，暂用默认声线</p>
      ) : null}
      <div className="dept-voice-settings__field">
        <span className="dept-voice-settings__label">音色</span>
        <div className="dept-voice-settings__speaker-row">
          <button
            type="button"
            className="dept-voice-settings__speaker-trigger"
            disabled={loading || saving || !hasAgent}
            onClick={openPicker}
            title={disp.id || undefined}
          >
            <span className="dept-voice-settings__speaker-main">
              <span className="dept-voice-settings__speaker-label">{disp.label}</span>
              {disp.id ? (
                <code className="dept-voice-settings__speaker-id">{disp.id}</code>
              ) : null}
            </span>
            <svg
              className="dept-voice-settings__speaker-chevron"
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          <button
            type="button"
            className={`dept-voice-settings__preview-btn${playing ? ' is-playing' : ''}`}
            disabled={loading || saving || !speaker || disp.isCustom}
            onClick={() => void onPreview()}
            title={playing ? '停止试听' : '试听当前音色'}
            aria-label={playing ? '停止试听' : '试听当前音色'}
          >
            {playing ? (
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                <path d="M6 6h12v12H6z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>
        </div>
        <p className="dept-voice-settings__hint">点开全屏选音色；列表里每条都可 ▶ 试听</p>
      </div>
      <label className="dept-voice-settings__field">
        <span className="dept-voice-settings__label">
          语速
          <em>{rateLabel(speechRate)}</em>
        </span>
        <input
          type="range"
          className="dept-voice-settings__range"
          min={RATE_MIN}
          max={RATE_MAX}
          step={5}
          value={speechRate}
          disabled={loading || saving || !hasAgent}
          onChange={(e) => setSpeechRate(Number(e.target.value))}
          onMouseUp={(e) => {
            const v = Number((e.target as HTMLInputElement).value)
            void save({ tts_speech_rate: v })
          }}
          onTouchEnd={(e) => {
            const v = Number((e.target as HTMLInputElement).value)
            void save({ tts_speech_rate: v })
          }}
          onKeyUp={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
              void save({ tts_speech_rate: speechRate })
            }
          }}
        />
      </label>
    </div>
  )
}
