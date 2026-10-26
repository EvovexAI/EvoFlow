/**
 * High-level Xiaomi Frame voice loop: mic → session → turn_end → sendXiaomiChat → assistant_delta.
 */

import {
  bargeInXiaomiFrame,
  connectXiaomiFrameSession,
  flushXiaomiAsr,
  isXiaomiFrameSessionActive,
  sendXiaomiAssistantBegin,
  sendXiaomiAssistantDelta,
  sendXiaomiAssistantEnd,
  sendXiaomiPcm,
  setXiaomiFrameEventHandler,
  stopXiaomiFrameSession,
} from './session-client.js'
import {
  noteVoiceLogPathOnce,
  voiceFeLog,
  voicePlaybackMark,
  beginVoiceTrace,
  adoptVoiceTrace,
  getVoiceTrace,
} from './voice-file-log.js'

/** @type {AudioContext | null} */
let _actx = null
/** @type {MediaStream | null} */
let _stream = null
/** @type {ScriptProcessorNode | AudioWorkletNode | null} */
let _node = null
/** @type {boolean} */
let _running = false
/** @type {((s: string) => void) | null} */
let _onTray = null
/** @type {string} */
let _partial = ''
let _sending = false

export function isXiaomiFramePipelineActive() {
  return _running && isXiaomiFrameSessionActive()
}

/**
 * @param {{ onTrayState?: (s: string) => void }} [opts]
 */
export async function startXiaomiFramePipeline(opts = {}) {
  if (_running) return true
  _onTray = opts.onTrayState || null
  _assistantPlain = ''
  void noteVoiceLogPathOnce()
  voiceFeLog('会话', '前端开始启动语音管线（采麦 → Frame session）')
  const ws = await connectXiaomiFrameSession()
  if (!ws) {
    voiceFeLog('会话', '连接 Frame session 失败，管线未启动')
    return false
  }

  setXiaomiFrameEventHandler((m) => {
    const type = String(m?.type || '')
    if (type === 'partial' || (type === 'final' && !m.turn)) {
      _partial = String(m.text || '')
      if (type === 'final' || _partial.length >= 4) {
        voiceFeLog(
          '语音转文字',
          `${type === 'final' ? '最终' : '中间'}识别：「${_partial}」`,
        )
      }
      void import('../background-voice-bridge.js').then((b) => {
        b.updateVoicePartialText?.(_partial)
      })
    }
    if (type === 'turn_end') {
      const text = String(m.text || _partial || '').trim()
      _partial = ''
      if (text) {
        const tid =
          String(m.trace_id || '').trim() ||
          getVoiceTrace() ||
          beginVoiceTrace({ reason: 'turn_end→发问' })
        if (m.trace_id) adoptVoiceTrace(String(m.trace_id), { reason: 'turn_end' })
        voiceFeLog('用户输入', `一轮说完，准备发给小V：「${text}」 TRACE=${tid}`)
        void _sendTurn(text)
      }
    }
    if (type === 'tts_start') {
      const playText = String(m.text || '').trim()
      voicePlaybackMark(
        '语音播放',
        playText,
        `Frame tts_start seq=${m.seq ?? ''}（后端流式音频到前端）`,
      )
      _onTray?.('speaking')
    }
    if (type === 'tts_end') {
      const playText = String(m.text || '').trim()
      voicePlaybackMark(
        '播放结束',
        playText,
        `Frame tts_end seq=${m.seq ?? ''}${m.cancelled ? '（已取消）' : ''}`,
      )
      if (_running) _onTray?.('recording')
    }
    if (type === 'interrupted') {
      const reason = String(m.reason || '')
      voiceFeLog('打断', `前端收到 interrupted（reason=${reason}），已停播`)
      // 后端已停合成；前端同时丢弃迟到的正文增量，避免旧回复回流成语音。
      resetXiaomiFrameAssistantFeed()
      if (_running) _onTray?.('recording')
      if (reason === 'client_barge_in') {
        // 前端自己发起的打断：模型推理已经在 interruptXiaomiFrame() 里取消过，
        // 这里再取消一次会误伤「打断后刚开始的新一轮」。
        return
      }
      // VAD 触发的打断来自后端，前端不知道 → 这里补上「取消模型推理」，
      // 否则旧回复会继续流式生成（Pipecat 里由 InterruptionFrame 取消 LLM 推理）。
      void _abortModelRunForBargeIn()
    }
    if (type === 'metrics') {
      voiceFeLog('延迟', `用户说完→开口约 ${m.user_to_bot_ms} ms`)
      console.info('[xiaomi-frame] user_to_bot_ms=', m.user_to_bot_ms)
    }
    if (type === 'error') {
      voiceFeLog('错误', String(m.message || '未知错误'))
      console.warn('[xiaomi-frame]', m.message)
    }
  })

  try {
    _stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
        channelCount: 1,
      },
    })
  } catch (e) {
    voiceFeLog('会话', `麦克风权限/采麦失败：${e?.message || e}`)
    console.warn('[xiaomi-frame] mic failed', e)
    stopXiaomiFrameSession()
    return false
  }

  _actx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 })
  const src = _actx.createMediaStreamSource(_stream)
  // ScriptProcessor fallback (widely available); 4096 ≈ 256ms @16k
  const proc = _actx.createScriptProcessor(4096, 1, 1)
  proc.onaudioprocess = (ev) => {
    if (!_running) return
    const input = ev.inputBuffer.getChannelData(0)
    const i16 = new Int16Array(input.length)
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]))
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    sendXiaomiPcm(i16.buffer)
  }
  src.connect(proc)
  proc.connect(_actx.destination)
  _node = proc
  _running = true
  voiceFeLog('会话', '采麦已启动，正在向后端推送 PCM')
  _flushStashedAssistant()
  _onTray?.('recording')
  return true
}

/** Cancel the in-flight model run (barge-in must stop generation, not just playback). */
async function _abortModelRunForBargeIn() {
  try {
    const { stopXiaomiChat } = await import('../../components/global-assistant/assistant-session.js')
    await stopXiaomiChat()
    voiceFeLog('打断', '已取消小V 本轮模型推理（barge-in abort run）')
  } catch (e) {
    voiceFeLog('打断', `取消模型推理失败：${e?.message || e}`)
  }
}

async function _sendTurn(text) {
  if (_sending) return
  _sending = true
  _onTray?.('processing')
  try {
    const { setPreferXiaomiVoice } = await import('../background-voice-bridge.js')
    setPreferXiaomiVoice(true)
    voiceFeLog('用户输入', `调用 sendXiaomiChat（语音发起）：「${text}」`)
    const { sendXiaomiChat } = await import('../../components/global-assistant/assistant-session.js')
    await sendXiaomiChat(text, { voiceInitiated: true })
  } catch (e) {
    voiceFeLog('错误', `发送用户轮次失败：${e?.message || e}`)
    console.warn('[xiaomi-frame] send turn failed', e)
  } finally {
    _sending = false
    if (_running) _onTray?.('recording')
  }
}

export function stopXiaomiFramePipeline() {
  if (_running) voiceFeLog('会话', '前端停止语音管线')
  _running = false
  try {
    flushXiaomiAsr()
  } catch {
    /* ignore */
  }
  try {
    _node?.disconnect()
  } catch {
    /* ignore */
  }
  _node = null
  try {
    _stream?.getTracks().forEach((t) => t.stop())
  } catch {
    /* ignore */
  }
  _stream = null
  try {
    void _actx?.close()
  } catch {
    /* ignore */
  }
  _actx = null
  stopXiaomiFrameSession()
  setXiaomiFrameEventHandler(null)
  _onTray?.('')
  _onTray = null
}

/**
 * @param {{ onTrayState?: (s: string) => void }} [opts]
 */
export async function toggleXiaomiFramePipeline(opts = {}) {
  if (_running) {
    stopXiaomiFramePipeline()
    return false
  }
  return startXiaomiFramePipeline(opts)
}

/** @type {string} */
let _assistantPlain = ''
/** 本轮已 assistant_end：禁止再推全文（否则会整段重播一遍） */
let _assistantEnded = false
/** Frame session 尚未就绪时暂存的累计正文（避免回落 legacy 双播） */
let _stashBody = ''
let _stashFinal = false

/** Feed assistant stream into Frame SentenceAgg (skips frontend cut). */
export function feedXiaomiFrameAssistant(fullText, { final = false } = {}) {
  if (!isXiaomiFrameSessionActive()) return false
  // final 已发过：忽略迟到的 sync FINAL / 重复 clear（日志里曾整段重推 → 三句播两遍）
  if (_assistantEnded) {
    return true
  }
  const body = String(fullText || '')
  const wasEmpty = !_assistantPlain
  if (body.length > _assistantPlain.length && body.startsWith(_assistantPlain)) {
    const delta = body.slice(_assistantPlain.length)
    _assistantPlain = body
    if (delta) {
      // 细粒度增量由后端记；前端记首包与较长块，避免刷屏
      if (wasEmpty || delta.length >= 24) {
        voicePlaybackMark('流式正文', delta, '推送 Frame（增量）')
      }
      sendXiaomiAssistantDelta(delta)
    }
  } else if (body && body !== _assistantPlain) {
    // 已有前缀时禁止把整段当「非前缀」重推（清 plain 后的二次 final 曾走这里）
    if (!_assistantPlain) {
      _assistantPlain = body
      voicePlaybackMark('流式正文', body.slice(0, 80), '推送 Frame（首包整段）')
      sendXiaomiAssistantDelta(body)
    } else {
      voicePlaybackMark(
        '流式正文',
        body.slice(0, 40),
        `忽略非前缀更新（已有 ${_assistantPlain.length} 字）`,
      )
    }
  }
  if (final) {
    _assistantEnded = true
    voicePlaybackMark(
      '流式正文',
      _assistantPlain.slice(0, 400),
      `本轮结束累计 ${_assistantPlain.length} 字，冲刷残句`,
    )
    sendXiaomiAssistantEnd()
    // 注意：不要清空 _assistantPlain。清空后若再进 feed，会把全文当 delta 再推一遍。
  }
  return true
}

/**
 * Frame 未连上时暂存累计正文；session ready 后由 startXiaomiFramePipeline 冲刷。
 * @param {string} fullText
 * @param {{ final?: boolean }} [opts]
 */
export function stashXiaomiFrameAssistantPending(fullText, { final = false } = {}) {
  const prevLen = _stashBody.length
  _stashBody = String(fullText || '')
  _stashFinal = !!final
  // 避免每个 token 刷一行；首包 / 明显增长 / final 才记
  if (
    _stashFinal ||
    prevLen === 0 ||
    _stashBody.length - prevLen >= 24 ||
    _stashBody.length - prevLen < 0
  ) {
    if (_stashBody || _stashFinal) {
      voicePlaybackMark(
        '流式正文',
        _stashBody.slice(0, 120),
        `Frame 连接中暂存 ${_stashBody.length} 字${_stashFinal ? '（已 final）' : ''}`,
      )
    }
  }
}

function _flushStashedAssistant() {
  if (!_stashBody && !_stashFinal) return
  const body = _stashBody
  const final = _stashFinal
  _stashBody = ''
  _stashFinal = false
  if (!isXiaomiFrameSessionActive()) return
  voicePlaybackMark('流式正文', body.slice(0, 120), `Frame 已就绪，冲刷暂存 ${body.length} 字`)
  // arm 时 session 可能尚未连上，begin 没发出；冲刷前补一次开闸
  sendXiaomiAssistantBegin()
  feedXiaomiFrameAssistant(body, { final })
}

export function resetXiaomiFrameAssistantFeed() {
  _assistantPlain = ''
  _assistantEnded = false
  _stashBody = ''
  _stashFinal = false
  // 通知后端开闸抬轮次（键盘提问没有 UserTurnComplete）
  if (isXiaomiFrameSessionActive()) {
    sendXiaomiAssistantBegin()
  }
}

/**
 * Barge-in 编排（对齐 Pipecat InterruptionFrame 语义）：
 * 1) 停本地播报队列 + 通知后端打断（TTS 合成、待播句）
 * 2) 取消正在跑的模型推理（abort chat run）→ 不再产生新的正文
 * 3) 清空正文喂给 Frame 的增量状态 → 迟到片段不会回流成语音
 */
export async function interruptXiaomiFrame() {
  voiceFeLog('打断', '前端主动 barge-in：停播 + 取消模型推理')
  try {
    bargeInXiaomiFrame()
  } catch {
    /* ignore */
  }
  resetXiaomiFrameAssistantFeed()
  try {
    const { clearXiaomiVoiceReply } = await import(
      '../../components/global-assistant/assistant-session.js'
    )
    clearXiaomiVoiceReply?.()
  } catch {
    /* ignore */
  }
  try {
    const { stopXiaomiChat } = await import(
      '../../components/global-assistant/assistant-session.js'
    )
    await stopXiaomiChat()
    voiceFeLog('打断', '已取消小V 本轮模型推理（abort run）')
  } catch (e) {
    voiceFeLog('打断', `取消模型推理失败：${e?.message || e}`)
  }
}
