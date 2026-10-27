/**
 * High-level Xiaomi Frame voice loop: mic → session → turn_end → sendXiaomiChat → assistant_delta.
 */

import {
  bargeInXiaomiFrame,
  connectXiaomiFrameSession,
  flushXiaomiAsr,
  isXiaomiFramePlaying,
  isXiaomiFrameSessionActive,
  sendXiaomiAssistantBegin,
  sendXiaomiAssistantDelta,
  sendXiaomiAssistantEnd,
  sendXiaomiPcm,
  setXiaomiFirstLocalPlayHandler,
  setXiaomiFrameEventHandler,
  setXiaomiPlaybackIdleHandler,
  setXiaomiDeferClientListening,
  flushXiaomiClientListeningIfIdle,
  sendXiaomiClientPhase,
  forceXiaomiOpenMic,
  adoptXiaomiFrameSocket,
  stopXiaomiFrameSession,
} from './session-client.js'
import {
  noteVoiceLogPathOnce,
  voiceFeLog,
  voicePlaybackMark,
  voiceDecisionLog,
  noteWakeMilestone,
  flushVoiceFeLog,
  beginVoiceTrace,
  adoptVoiceTrace,
  getVoiceTrace,
  noteVoicePanelDisplay,
  noteVoicePanelSend,
  noteVoiceUiState,
  formatVoiceLocalTs,
} from './voice-file-log.js'
import {
  canAcceptVadBarge,
  canUnmuteStt,
  deriveVoicePhase,
  getVoicePhase,
  installVoiceVisibilityTerminal,
  resetVoicePhase,
  setVoicePhase,
  subscribeVoicePhase,
} from './voice-phase.js'

function _logDialogue(message, opts = {}) {
  voiceFeLog('对话', message, opts)
  void flushVoiceFeLog()
}

/**
 * 前端唯一 tray 状态（给 XiaomiVoiceStage）：
 *   recording  = 聆听中（可说话）
 *   processing = 已发送 / 等模型或首包音频
 *   speaking   = 本地正在播报
 * 禁止用 tts_end（wire 合成完）切回 recording —— 那不等于听完。
 */

/** @type {AudioContext | null} */
let _actx = null
/** @type {MediaStream | null} */
let _stream = null
/** @type {ScriptProcessorNode | AudioWorkletNode | null} */
let _node = null
/** @type {boolean} */
let _running = false
/** 防止 enterXw 重入 / 双 rAF 并行 start 把共享 WS 掐死（日志 readyState=-1） */
/** @type {Promise<boolean> | null} */
let _startLock = null
/** @type {((s: string) => void) | null} */
let _onTray = null
/** @type {'recording'|'processing'|'speaking'|''} */
let _tray = ''
/** @type {string} */
let _partial = ''
let _sending = false
/** 已发问、还在等回复播报 */
let _awaitingReply = false
/** @type {string[]} */
const _pendingTurns = []
/** performance.now() when turn_end received — for local latency */
let _turnEndAt = 0
/** wall-clock ISO when user finished speaking */
let _turnEndWall = ''
/** text of the turn awaiting first playback */
let _turnAwaitingPlay = ''
/** assistant_end 后等 TTS 入队的短延迟（正文常晚于 end 数百 ms） */
let _endFlushTimer = 0
/** @type {(() => void) | null} */
let _unsubVisibility = null
/** @type {(() => void) | null} */
let _unsubPhaseVis = null

export function isXiaomiFramePipelineActive() {
  return _running && isXiaomiFrameSessionActive()
}

export function isXiaomiFramePipelineStarting() {
  return !!_startLock
}

/** 已发问、仍等助手正文（确认短句可能已在播） */
export function isXiaomiFrameAwaitingReply() {
  return !!_awaitingReply
}

function _setTray(next) {
  const s = String(next || '')
  if (s === _tray) return
  _tray = s
  // 中文状态 + 时间点（播报/聆听/处理中…）
  noteVoiceUiState(s || 'idle', { source: 'Frame管线' })
  try {
    _onTray?.(s)
  } catch {
    /* ignore */
  }
}

/** tray + VoicePhase 同步；相位是 unmute/barge 唯一门控 */
function _syncPhase(reason = 'refresh') {
  const next = deriveVoicePhase({
    running: _running,
    playing: isXiaomiFramePlaying(),
    awaitingReply: _awaitingReply,
    sending: _sending,
    pending: _pendingTurns.length,
  })
  const changed = setVoicePhase(next, reason)
  sendXiaomiClientPhase(getVoicePhase())
  // 回到聆听且可 unmute → 补发（确认句 defer 解除后）
  if (changed && next === 'listening' && canUnmuteStt()) {
    flushXiaomiClientListeningIfIdle()
  }
  return next
}

/** 按优先级重算：播报 > 思考(等模型/排队) > 聆听。三态对齐舞台文案。 */
function _refreshTray() {
  if (!_running) {
    _setTray('')
    _syncPhase('stopped')
    return
  }
  if (isXiaomiFramePlaying()) {
    _setTray('speaking')
    _syncPhase('playing')
    return
  }
  // 排队里还有待发句时保持 processing，避免 finally 里先闪回 recording 再进思考
  if (_sending || _awaitingReply || _pendingTurns.length > 0) {
    // 仅在「本会本该回聆听却被摁住」时打决策，避免每次 refresh 刷屏
    if (_tray === 'recording' || _tray === 'speaking' || _tray === '') {
      voiceDecisionLog('keep_think', {
        sending: _sending,
        awaitingReply: _awaitingReply,
        pending: _pendingTurns.length,
        assistantEnded: _assistantEnded,
        prevTray: _tray || 'empty',
        phase: getVoicePhase(),
      })
    }
    _setTray('processing')
    _syncPhase('awaiting')
    return
  }
  _setTray('recording')
  _syncPhase('idle_listen')
}

/**
 * @param {{ onTrayState?: (s: string) => void }} [opts]
 */
export async function startXiaomiFramePipeline(opts = {}) {
  if (_running) return true
  if (_startLock) {
    voiceFeLog('会话', 'Frame 管线启动中 → 等待已有 start（防并行掐 WS）')
    return _startLock
  }
  _startLock = _startXiaomiFramePipelineInner(opts).finally(() => {
    _startLock = null
  })
  return _startLock
}

/**
 * @param {{ onTrayState?: (s: string) => void }} [opts]
 */
async function _startXiaomiFramePipelineInner(opts = {}) {
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

  // 确认短句「行」播完仍等正文：勿 client_listening（与 VoicePhase.thinking 双保险）
  setXiaomiDeferClientListening(
    () => (_awaitingReply && !_assistantEnded) || !canUnmuteStt(),
  )
  _unsubVisibility = installVoiceVisibilityTerminal()
  // 切后台/回前台：重算 tray + 补发 listening（hidden hold 解除后）
  _unsubPhaseVis = subscribeVoicePhase((_n, _p, reason) => {
    if (String(reason || '').startsWith('document_') && _running) {
      _refreshTray()
    }
  })

  setXiaomiFirstLocalPlayHandler(({ seq, at }) => {
    // 确认句开播 ≠ 正文结束：保持 _awaitingReply，tray 进播报
    _setTray('speaking')
    _syncPhase('first_local_play')
    // Frame 本地开播时挂起 continuous ASR，避免回声触发 legacy watchdog stall
    void import('../background-voice.js')
      .then((m) => m.notifyTTSStarted?.())
      .catch(() => {})
    if (!_turnEndAt || !_turnAwaitingPlay) return
    const ms = Math.round(at - _turnEndAt)
    voiceFeLog(
      '时效',
      `用户说完→本地播报开始 ${ms} ms（「${_turnAwaitingPlay}」→ seq=${seq}）` +
        (_turnEndWall ? ` turn_end_at=${_turnEndWall}` : ''),
    )
    console.info('[xiaomi-frame] user_stop→local_play_ms=', ms)
    _turnAwaitingPlay = ''
  })

  setXiaomiPlaybackIdleHandler((idle) => {
    if (!idle) {
      _setTray('speaking')
      _syncPhase('playback_active')
      return
    }
    // 本地听完 → 才回聆听；恢复 continuous ASR（若仍开着）
    void import('../background-voice.js')
      .then((m) => m.notifyTTSStopped?.())
      .catch(() => {})
    // 确认句播完但模型/正文未结束：保持「思考」，勿闪回聆听
    if (_awaitingReply && !_assistantEnded) {
      voiceDecisionLog('idle_keep_awaiting', {
        awaitingReply: true,
        assistantEnded: false,
        playing: isXiaomiFramePlaying(),
      })
      _refreshTray()
      return
    }
    _awaitingReply = false
    // 本轮播完回聆听：清空「你」区旧稿，避免下一轮开口前仍挂着上轮用户句
    _partial = ''
    void import('../background-voice-bridge.js')
      .then((b) => {
        b.updateVoicePartialText?.('')
        b.clearPendingVoiceSend?.()
      })
      .catch(() => {})
    noteVoicePanelDisplay('', { immediate: true, source: '播完回聆听清空' })
    _refreshTray()
  })

  setXiaomiFrameEventHandler((m) => {
    const type = String(m?.type || '')
    if (type === 'partial' || (type === 'final' && !m.turn)) {
      _partial = String(m.text || '')
      // 上屏字 + 上屏时间走面板日志（updateVoicePartialText → noteVoicePanelDisplay）
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
        _turnEndAt = performance.now()
        _turnEndWall = formatVoiceLocalTs()
        _turnAwaitingPlay = text
        // 定稿上屏（立即落盘，不等 120ms 合并）
        noteVoicePanelDisplay(text, { immediate: true, source: 'turn_end定稿' })
        void import('../background-voice-bridge.js').then((b) => {
          b.updateVoicePartialText?.(text)
        })
        _logDialogue(`用户说完定稿：「${text}」 定稿于=${_turnEndWall} TRACE=${tid}`)
        void _enqueueTurn(text)
      } else {
        noteVoicePanelDisplay('', { immediate: true, source: 'turn_end空' })
        _logDialogue('用户输入为空（turn_end 无文本）→ 本轮不发送')
      }
    }
    if (type === 'tts_start') {
      const playText = String(m.text || '').trim()
      const wall = new Date().toISOString()
      voicePlaybackMark(
        '语音播放',
        playText,
        `Frame tts_start seq=${m.seq ?? ''} at=${wall}（后端音频到前端，尚未本地 play）`,
      )
      // 正文 TTS 已到：取消 assistant_end 后的安全 flush，避免误 unmute
      if (_endFlushTimer) {
        window.clearTimeout(_endFlushTimer)
        _endFlushTimer = 0
      }
      // 开播即清「你」区上一轮用户句，舞台空出来等本轮播报/下一轮听写
      _partial = ''
      void import('../background-voice-bridge.js')
        .then((b) => {
          b.updateVoicePartialText?.('')
          b.clearPendingVoiceSend?.()
        })
        .catch(() => {})
      noteVoicePanelDisplay('', { immediate: true, source: '开播清用户句' })
      // 勿清 _awaitingReply：确认短句 tts_start 之后模型往往还要跑几十秒
      _setTray('speaking')
      _syncPhase('tts_start')
    }
    if (type === 'tts_end') {
      const playText = String(m.text || '').trim()
      voicePlaybackMark(
        '播放结束',
        playText,
        `Frame tts_end seq=${m.seq ?? ''}${m.cancelled ? '（已取消）' : ''}（wire 完，未必本地听完）`,
      )
      // 不在这里切 recording —— 等本地播完 idle
      _refreshTray()
    }
    if (type === 'interrupted') {
      const reason = String(m.reason || '')
      voiceFeLog('打断', `前端收到 interrupted（reason=${reason}），已停播`)
      // 相位门控：非 speaking 的 vad_barge 一律忽略（思考/聆听误触不 abort）
      const phaseBlockVad =
        reason === 'vad_barge_in' && !canAcceptVadBarge()
      if (phaseBlockVad) {
        voiceDecisionLog('ignore_vad_barge', {
          reason,
          phase: getVoicePhase(),
          playing: isXiaomiFramePlaying(),
          awaitingReply: _awaitingReply,
          sending: _sending,
          assistantEnded: _assistantEnded,
        })
        voiceFeLog(
          '打断',
          `忽略 vad_barge（phase=${getVoicePhase()}，仅 speaking 可抢话）`,
        )
        _refreshTray()
        return
      }
      // stopAll / wake：本地队列已被 teardown，若仍 keep awaiting + reset(assistant_begin)
      // → 舞台卡「思考」、后端空开 turn（日志 18:19:29 turn=5/6）。播完/停播应收口回聆听。
      if (reason === 'stopAllAssistantSpeech' || reason === 'wake-word-hit') {
        const wasAwaiting = _awaitingReply
        _awaitingReply = false
        // 只清增量状态，不要 sendXiaomiAssistantBegin（那会空开一轮）
        _assistantPlain = ''
        _assistantEnded = false
        _stashBody = ''
        _stashFinal = false
        voiceDecisionLog('stopall_release_think', {
          reason,
          wasAwaiting,
          sending: _sending,
          playing: isXiaomiFramePlaying(),
        })
        voiceFeLog('打断', `stopAll/wake 停播 → 释放思考态回聆听（不清模型 run）`)
        _refreshTray()
        return
      }
      // 后端已停合成；前端同时丢弃迟到的正文增量，避免旧回复回流成语音。
      resetXiaomiFrameAssistantFeed()
      _awaitingReply = false
      _refreshTray()
      if (reason === 'client_barge_in') {
        // 前端主动 barge：勿再 abort（调用方已编排）
        return
      }
      // VAD 真打断（正在播报）：取消模型推理
      voiceDecisionLog('abort_on_vad_barge', {
        reason,
        playing: isXiaomiFramePlaying(),
        awaitingReply: _awaitingReply,
        sending: _sending,
      })
      void _abortModelRunForBargeIn()
    }
    if (type === 'metrics') {
      const anchor = String(m.anchor || 'vad_silence→bot_started')
      voiceFeLog(
        '延迟',
        `Pipecat ${anchor} ${m.user_to_bot_ms} ms（后端 wire 开口；本地听感见「时效」）`,
      )
      console.info('[xiaomi-frame] user_to_bot_ms=', m.user_to_bot_ms, anchor)
    }
    if (type === 'error') {
      voiceFeLog('错误', String(m.message || '未知错误'))
      console.warn('[xiaomi-frame]', m.message)
    }
  })

  // Frame 管线自采麦：整套关掉 continuous（含 policy/mode 标志），否则 ASR glitch + 误 barge
  try {
    const { stopContinuousListeningForFrame, pauseWakeEarForVoiceSession } = await import(
      '../background-voice.js',
    )
    if (typeof stopContinuousListeningForFrame === 'function') {
      await stopContinuousListeningForFrame()
    } else {
      const { stopContinuousCapture, isContinuousCaptureActive } = await import(
        '../voice-capture-service.js',
      )
      if (isContinuousCaptureActive?.()) await stopContinuousCapture()
    }
    await pauseWakeEarForVoiceSession()
    voiceFeLog('会话', 'Frame 管线接管麦克风 → 已停 continuous + 唤醒耳')
    noteWakeMilestone('frame_mic_taken')
  } catch {
    /* ignore */
  }

  try {
    // Frame 只上行 PCM、不听本地返送：关 AEC，避免浏览器把输入压成近静音（peak≈0.007）
    _stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    })
  } catch (e) {
    voiceFeLog('会话', `麦克风权限/采麦失败：${e?.message || e}`)
    console.warn('[xiaomi-frame] mic failed', e)
    // 勿 stopXiaomiFrameSession：并行/重试 start 可能共用同一 WS，掐掉会 readyState=-1
    return false
  }

  _actx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 })
  const src = _actx.createMediaStreamSource(_stream)
  // ScriptProcessor fallback (widely available); 4096 ≈ 256ms @16k
  const proc = _actx.createScriptProcessor(4096, 1, 1)
  let _pcmChunks = 0
  let _pcmPeak = 0
  proc.onaudioprocess = (ev) => {
    if (!_running) return
    const input = ev.inputBuffer.getChannelData(0)
    const i16 = new Int16Array(input.length)
    let peak = 0
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]))
      if (Math.abs(s) > peak) peak = Math.abs(s)
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    _pcmChunks += 1
    if (peak > _pcmPeak) _pcmPeak = peak
    // 约每 2s 打一次能量，确认不是「推了全零 PCM」
    if (_pcmChunks === 8 || _pcmChunks % 50 === 0) {
      voiceFeLog(
        '会话',
        `PCM 能量 chunks=${_pcmChunks} peak=${_pcmPeak.toFixed(4)}（<0.01 基本是静音/AEC 吃掉）`,
      )
      _pcmPeak = 0
    }
    sendXiaomiPcm(i16.buffer)
  }
  src.connect(proc)
  // 关键：绝不能 proc→destination。麦声进喇叭 + echoCancellation → 输入被消成接近 0 → 后端聋。
  // ScriptProcessor 仍需挂到图上才会回调：经 gain=0 哑接。
  const sink = _actx.createGain()
  sink.gain.value = 0
  proc.connect(sink)
  sink.connect(_actx.destination)
  _node = proc
  _running = true
  _awaitingReply = false
  // connect 返回的 ws 仍 OPEN 时，即使模块 _ws 被 onclose 清掉也要挂回
  adoptXiaomiFrameSocket(ws)
  voiceFeLog('会话', '采麦已启动，正在向后端推送 PCM（哑接 destination，防 AEC 吞麦）')
  noteWakeMilestone('frame_pcm_ready')
  _flushStashedAssistant()
  _setTray('recording')
  _syncPhase('pipeline_ready')
  let opened = forceXiaomiOpenMic('pipeline_ready', ws)
  if (!opened) {
    voiceFeLog(
      '会话',
      `开麦失败 hintState=${ws?.readyState ?? -1} → 重连 Frame session 并重试`,
    )
    try {
      stopXiaomiFrameSession()
    } catch {
      /* ignore */
    }
    const ws2 = await connectXiaomiFrameSession()
    if (ws2) {
      await new Promise((r) => setTimeout(r, 500))
      adoptXiaomiFrameSocket(ws2)
      opened = forceXiaomiOpenMic('pipeline_ready_retry', ws2)
    }
  }
  voiceDecisionLog('pipeline_ready_open_mic', {
    phase: getVoicePhase(),
    canUnmute: canUnmuteStt() ? 1 : 0,
    opened: opened ? 1 : 0,
    ws: isXiaomiFrameSessionActive() ? 1 : 0,
    hintState: ws?.readyState ?? -1,
  })
  // 口头「在呢」：等开麦成功后用 HTTP 固定句，不走 speech-session、不 notifyTTS（防抢麦）
  if (opened) {
    void _playWakeAckSafe()
  } else {
    voiceFeLog('会话', '开麦仍失败 → 跳过口头「在呢」（会话未就绪）')
  }
  return true
}

async function _playWakeAckSafe() {
  try {
    voiceFeLog('会话', '播放唤醒应答「在呢」…')
    const { playWakeChime } = await import('../wake-ack.js')
    await playWakeChime?.()
    const { playFixedVoiceSfx } = await import('../voice-fixed-sfx.js')
    await playFixedVoiceSfx('在呢')
    voiceFeLog('会话', '唤醒应答「在呢」播放完成')
  } catch (e) {
    voiceFeLog('会话', `唤醒应答「在呢」失败：${e?.message || e}`)
  }
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

async function _enqueueTurn(text) {
  const t = String(text || '').trim()
  if (!t) return
  if (_sending) {
    // ASR 定稿会连推近义句：只保留最新一句，别堆成队列=5 连发
    _pendingTurns.length = 0
    _pendingTurns.push(t)
    voiceFeLog('用户输入', `上一轮仍在发送 → 覆盖排队为最新：「${t.slice(0, 60)}」`)
    _refreshTray()
    return
  }
  await _sendTurn(t)
}

async function _sendTurn(text) {
  if (_sending) {
    _pendingTurns.length = 0
    _pendingTurns.push(text)
    return
  }
  _sending = true
  _awaitingReply = true
  _assistantEnded = false
  if (_endFlushTimer) {
    window.clearTimeout(_endFlushTimer)
    _endFlushTimer = 0
  }
  _setTray('processing')
  let releasedSending = false
  const releaseSending = () => {
    if (releasedSending) return
    releasedSending = true
    _sending = false
    const next = _pendingTurns.pop()
    _pendingTurns.length = 0
    if (next) {
      void _sendTurn(next)
    } else {
      _refreshTray()
    }
  }
  try {
    const { setPreferXiaomiVoice } = await import('../background-voice-bridge.js')
    setPreferXiaomiVoice(true)
    // 发送字 + 发送于/上屏于 由 sendXiaomiChat → noteVoicePanelSend 统一落盘
    noteVoicePanelSend(text, { source: 'Frame发问', detail: 'voiceInitiated=true' })
    const { sendXiaomiChat } = await import('../../components/global-assistant/assistant-session.js')
    // onSubmitted：prep 完立刻释放 _sending，勿等 chatSend 整轮 stream（曾卡 13s+）
    await sendXiaomiChat(text, {
      voiceInitiated: true,
      onSubmitted: () => releaseSending(),
    })
    _logDialogue(`用户发送完成 完成于=${formatVoiceLocalTs()}：「${text}」`)
  } catch (e) {
    _logDialogue(`用户发送失败 于=${formatVoiceLocalTs()}：${e?.message || e}｜「${text}」`)
    console.warn('[xiaomi-frame] send turn failed', e)
    _awaitingReply = false
  } finally {
    releaseSending()
  }
}

export function stopXiaomiFramePipeline() {
  if (_running) voiceFeLog('会话', '前端停止语音管线')
  _running = false
  _pendingTurns.length = 0
  _sending = false
  // 退出小微对话后不再 prefer 小V，避免迟到 ASR 仍标小V 或误路由
  void import('../background-voice-bridge.js')
    .then((m) => {
      m.setPreferXiaomiVoice?.(false)
      m.clearPendingVoiceSend?.()
      m.updateVoicePartialText?.('')
    })
    .catch(() => {})
  _awaitingReply = false
  _turnEndAt = 0
  _turnEndWall = ''
  _turnAwaitingPlay = ''
  if (_endFlushTimer) {
    window.clearTimeout(_endFlushTimer)
    _endFlushTimer = 0
  }
  setXiaomiFirstLocalPlayHandler(null)
  setXiaomiPlaybackIdleHandler(null)
  setXiaomiDeferClientListening(null)
  if (_unsubVisibility) {
    try {
      _unsubVisibility()
    } catch {
      /* ignore */
    }
    _unsubVisibility = null
  }
  if (_unsubPhaseVis) {
    try {
      _unsubPhaseVis()
    } catch {
      /* ignore */
    }
    _unsubPhaseVis = null
  }
  resetVoicePhase('pipeline_stop')
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
  // 释放麦后恢复唤醒耳（语音舞台关掉时）
  void import('../background-voice.js')
    .then((m) => m.resumeWakeEarAfterVoiceSession?.())
    .catch(() => {})
  _setTray('')
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
    const plain = String(_assistantPlain || '').trim()
    _logDialogue(
      plain
        ? `助手回复：「${plain.slice(0, 800)}${plain.length > 800 ? '…' : ''}」`
        : '助手回复：（空）',
      { detail: `len=${plain.length}` },
    )
    voicePlaybackMark(
      '流式正文',
      plain.slice(0, 400),
      `本轮结束累计 ${plain.length} 字，冲刷残句`,
    )
    sendXiaomiAssistantEnd()
    // 正文 end 后 TTS 常晚 1–2s（火山 ttfb）；旧 1.2s 就 flush → 误 unmute →
    // 回声 stopAll → 只播一句（日志 18:30:23→25）。等 tts_start 取消；仅超久无播才兜底。
    if (_endFlushTimer) window.clearTimeout(_endFlushTimer)
    _endFlushTimer = window.setTimeout(() => {
      _endFlushTimer = 0
      if (!_running || !_assistantEnded) return
      if (isXiaomiFramePlaying()) return
      voiceDecisionLog('end_flush_timeout', {
        awaitingReply: _awaitingReply,
        playing: false,
      })
      voiceFeLog('管线', '正文结束已久仍无本地播报 → 释放思考并 client_listening')
      _awaitingReply = false
      _refreshTray()
      flushXiaomiClientListeningIfIdle()
    }, 8000)
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
