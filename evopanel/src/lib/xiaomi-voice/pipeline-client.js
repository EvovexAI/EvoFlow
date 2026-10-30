/**
 * High-level Xiaomi Frame voice loop: mic → session → turn_end → sendXiaomiChat → assistant_delta.
 */

import {
  bargeInXiaomiFrame,
  connectXiaomiFrameSession,
  duckXiaomiFramePlayback,
  flushXiaomiAsr,
  isXiaomiFramePlaying,
  isXiaomiFrameSessionActive,
  isXiaomiPcmUplinkHeld,
  sendXiaomiAssistantBegin,
  sendXiaomiAssistantDelta,
  sendXiaomiAssistantEnd,
  sendXiaomiPcm,
  setXiaomiPcmUplinkHold,
  setXiaomiFirstLocalPlayHandler,
  setXiaomiFrameEventHandler,
  setXiaomiPlaybackIdleHandler,
  setXiaomiDeferClientListening,
  flushXiaomiClientListeningIfIdle,
  sendXiaomiClientListening,
  sendXiaomiClientPhase,
  forceXiaomiOpenMic,
  adoptXiaomiFrameSocket,
  isXiaomiFrameSoftPaused,
  pauseXiaomiFrameLocalPlayback,
  resumeXiaomiFrameLocalPlayback,
  stopXiaomiFrameSession,
  unduckXiaomiFramePlayback,
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
import {
  getSpeechPriorDebug,
  isSpeechPriorHot,
  resetSpeechPrior,
  updateSpeechPrior,
} from './speech-prior.js'

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

/**
 * 用户语音录入队列：把连续 turn_end（ASR 越听越长）收成一句再发，
 * 思考/播报中禁止「延长句」打断 → 避免 RUN_ERROR / AI 回复没声。
 */
/** @type {ReturnType<typeof setTimeout> | 0} */
let _coalesceTimer = 0
/** 合并窗口内最新定稿 */
let _coalesceText = ''
/** 上次真正发出去的用户句 */
let _lastCommittedTurn = ''
let _lastCommittedAtMs = 0
/** 「在呢」播完前 / 刚播完的宽限期，丢弃回声 turn_end */
let _wakeAckUntilMs = 0
/** ASR 连推间隔内合并（ms） */
const USER_TURN_COALESCE_MS = 900
/** 已发问后，延长/近义句静默窗口（ms） */
const USER_TURN_DEDUP_MS = 12000

function _normUserTurn(text) {
  return String(text || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、,.!?;；：:"""''（）()【】\[\]…—\-]/g, '')
    .toLowerCase()
}

/** 同轮 ASR 变体：相等 / 互相包含 / 前缀延长 */
function _isSameOrExtendedTurn(a, b) {
  const x = _normUserTurn(a)
  const y = _normUserTurn(b)
  if (!x || !y) return false
  if (x === y) return true
  if (x.includes(y) || y.includes(x)) return true
  const shorter = x.length <= y.length ? x : y
  const longer = x.length <= y.length ? y : x
  if (shorter.length >= 4 && longer.startsWith(shorter)) return true
  let i = 0
  while (i < shorter.length && shorter[i] === longer[i]) i += 1
  return i >= 8 && i >= Math.floor(shorter.length * 0.55)
}

/**
 * 火山同会话 ASR 常把「上一句定稿」粘在新 interim 前面（日志第二轮上屏越叠越长）。
 * 若能匹配已发送句前缀，只留下新增尾巴；纯回声 → 空串。
 */
function _peelCommittedAsrPrefix(text) {
  let t = String(text || '').trim()
  if (!t) return t
  // 纯确认短句回声（整句「好的 / 收到」）
  if (_isAckEchoText(t)) return ''
  const prev = String(_lastCommittedTurn || '').trim()
  if (!prev) {
    // 短应声不再按 endsWith 剥尾——「…好的」会误伤正常句
    return t
  }
  const np = _normUserTurn(prev)
  const nt = _normUserTurn(t)
  if (!np) return t
  if (!nt || nt === np || (np.includes(nt) && nt.length >= 4 && nt.length <= np.length)) {
    return ''
  }
  if (!nt.startsWith(np) || nt.length <= np.length) {
    // 「确认回声 + 新话」：短应声须有标点边界（「好的，…」），避免「收到了吗」被剥前缀
    for (const ack of _TURN_ACK_ECHO) {
      if (nt.startsWith(ack) && nt.length > ack.length) {
        let i = 0
        let ai = 0
        const noise = /[\s\u3000，。！？、,.!?;；：:"""''“”‘’（）()【】[\]…—\-]/
        while (i < t.length && ai < ack.length) {
          const ch = t[i]
          if (noise.test(ch)) {
            i += 1
            continue
          }
          if (ch.toLowerCase() === ack[ai]) {
            i += 1
            ai += 1
            continue
          }
          break
        }
        if (ai < ack.length) continue
        const boundary = /[，。！？、,.!?;；：:\s\u3000]/
        let j = i
        let sawBoundary = false
        while (j < t.length && boundary.test(t[j])) {
          sawBoundary = true
          j += 1
        }
        if (!sawBoundary) continue
        t = t.slice(j).trim()
        return _isAckEchoText(t) ? '' : t
      }
    }
    return t
  }
  // 按规范化前缀在原文上跳过对应可读字符
  let ni = 0
  let i = 0
  const noise = /[\s\u3000，。！？、,.!?;；：:"""''“”‘’（）()【】[\]…—\-]/
  while (i < t.length && ni < np.length) {
    const ch = t[i]
    if (noise.test(ch)) {
      i += 1
      continue
    }
    if (ch.toLowerCase() === np[ni]) {
      i += 1
      ni += 1
      continue
    }
    break
  }
  if (ni < Math.floor(np.length * 0.85)) return t
  t = t.slice(i).replace(/^[，。！？、,.!?\s]+/, '').trim()
  if (_isAckEchoText(t)) return ''
  return t
}

/** 思考/播报中不应再改「你」区；仅允许空串清屏 */
function _shouldHoldUserCaption() {
  // 软打断探测窗：需要看见 ASR 才能确认是真抢话还是误触
  if (_softBargeProbing) return false
  if (_sending || _awaitingReply) return true
  const phase = getVoicePhase()
  if (phase === 'thinking' || phase === 'speaking') return true
  if (_tray === 'processing' || _tray === 'speaking') return true
  return false
}

function _clearUserCaption(source = '清用户句') {
  _partial = ''
  void import('../background-voice-bridge.js')
    .then((b) => {
      b.updateVoicePartialText?.('')
      b.clearPendingVoiceSend?.()
    })
    .catch(() => {})
  noteVoicePanelDisplay('', { immediate: true, source })
}

function _isWakeAckEcho(text) {
  const n = _normUserTurn(text)
  return n === '在呢' || n === '我在' || n === '嗯请说' || n === '请说'
}

function _clearCoalesce() {
  if (_coalesceTimer) {
    window.clearTimeout(_coalesceTimer)
    _coalesceTimer = 0
  }
  _coalesceText = ''
}

function _drainPendingAfterIdle(reason) {
  const next = _pendingTurns.length ? String(_pendingTurns[_pendingTurns.length - 1] || '').trim() : ''
  _pendingTurns.length = 0
  if (!next) {
    _refreshTray()
    return
  }
  voiceFeLog('用户输入', `录入队列出队（${reason}）→「${next.slice(0, 60)}」`)
  void _sendTurn(next)
}

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

  // 整轮等回复 / 放麦宽限：一律勿 unmute（确认句播完≠可听；正文 TTS 未到更不能听）
  setXiaomiDeferClientListening(
    () => _awaitingReply || _inListenGrace() || !canUnmuteStt(),
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
    // 本地开播即停上行：喇叭声不进 ASR；打断改本地音量 duck（见 _onLocalBargePeak）
    setXiaomiPcmUplinkHold(true, 'first_local_play')
    _localBargeSpeakSince = Date.now()
    _resetLocalBarge()
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
    // 互斥：仍等本轮回复时不回「正常聆听」。
    // 旧条件 `_awaitingReply && !_assistantEnded` 会在「确认句播完 + 模型已 end、正文 TTS 未到」
    // 时误开聆听（日志 17:17:35 speaking→listening → 回声确认句进 ASR）。
    // 但仍需 exit_listen 放麦：否则思考期喊「退出/停止」ASR 全哑。
    if (_awaitingReply && (!_assistantEnded || !_heardBodySpeak)) {
      voiceDecisionLog('idle_keep_awaiting', {
        awaitingReply: true,
        assistantEnded: !!_assistantEnded,
        heardBodySpeak: !!_heardBodySpeak,
        playing: isXiaomiFramePlaying(),
      })
      _refreshTray()
      // 确认句已播完、正文未到：需放行 PCM 才能听「退出/停止」
      setXiaomiPcmUplinkHold(false, 'playback_idle_awaiting_exit_listen')
      _armExitListenWhileThinking('playback_idle_awaiting')
      return
    }
    _awaitingReply = false
    // 本轮播完回聆听：清空「你」区旧稿，避免下一轮开口前仍挂着上轮用户句
    _clearUserCaption('播完回聆听清空')
    // 思考期积压的下一句：播完再发，避免打断导致 AI 回复没声
    if (_pendingTurns.length) {
      _drainPendingAfterIdle('playback_idle')
      return
    }
    // 先进入放麦宽限，再切 listening，避免 _refreshTray 立刻 flush client_listening
    _scheduleListenUnmute('playback_idle')
    _refreshTray()
  })

  setXiaomiFrameEventHandler((m) => {
    const type = String(m?.type || '')
    if (type === 'partial' || (type === 'final' && !m.turn)) {
      const raw = String(m.text || '')
      // 思考/播报：拒绝迟到 ASR 回灌（日志 17:08:03 开播清后又上屏旧句）
      if (_shouldHoldUserCaption()) {
        if (!raw.trim()) _clearUserCaption('hold期空ASR清屏')
        return
      }
      const peeled = _peelCommittedAsrPrefix(raw)
      _partial = peeled
      // 「停止/退出」仅 2 字：旧门槛 ≥4 导致软打断永远确认不了
      if (peeled && peeled.trim().length >= 2) {
        if (_softBargeProbing || isXiaomiFrameSoftPaused()) {
          if (peeled.trim().length >= 4) _confirmSoftBargeWithUserSpeech(peeled)
          else _tryConfirmSoftBargeExitCommand(peeled)
        } else if (isXiaomiFramePlaying() || getVoicePhase() === 'speaking') {
          _tryConfirmSoftBargeExitCommand(peeled)
        }
      }
      // 上屏字 + 上屏时间走面板日志（updateVoicePartialText → noteVoicePanelDisplay）
      void import('../background-voice-bridge.js').then((b) => {
        b.updateVoicePartialText?.(peeled)
      })
    }
    if (type === 'turn_end') {
      const raw = String(m.text || _partial || '').trim()
      // 先剥上轮用户定稿，再剥助手播报前缀，尽量留下用户新话
      let text = _peelCommittedAsrPrefix(raw)
      if (text) {
        const afterBot = _peelAssistantEchoPrefix(text)
        if (afterBot !== text) {
          voiceFeLog(
            '用户输入',
            `ASR 剥助手播报前缀：「${text.slice(0, 36)}」→「${(afterBot || '').slice(0, 36)}」`,
          )
          text = afterBot
        }
      }
      _partial = ''
      if (_softBargeProbing && (text || raw)) {
        if (_confirmSoftBargeWithUserSpeech(text || raw)) {
          if (text) void _handleTurnEndLocalOrEnqueue(text)
          return
        }
      }
      if (raw && !text) {
        // 剥完变空：仍可能是粘连里夹了「退出/停止」——思考期靠这条才能停
        void import('../xiaomi-voice-close.js')
          .then(async (m) => {
            if (m.isXiaomiVoiceExitCommand?.(raw)) {
              voiceFeLog('用户输入', `回声剥空但仍命中退出口令 → 走闸门：「${raw.slice(0, 40)}」`)
              await _handleTurnEndLocalOrEnqueue(raw)
              return
            }
            noteVoicePanelDisplay('', { immediate: true, source: 'turn_end回声丢弃' })
            voiceFeLog('用户输入', `turn_end 丢弃纯回声：「${raw.slice(0, 60)}」`)
          })
          .catch(() => {
            noteVoicePanelDisplay('', { immediate: true, source: 'turn_end回声丢弃' })
            voiceFeLog('用户输入', `turn_end 丢弃纯回声：「${raw.slice(0, 60)}」`)
          })
      } else if (text) {
        // 仅「喇叭正在出声」时挡普通定稿（防自录）；宽限/思考中放行，交给录入队列
        const speakerHot = isXiaomiFramePlaying() || getVoicePhase() === 'speaking'
        if (speakerHot) {
          void import('../xiaomi-voice-close.js')
            .then(async (m) => {
              if (m.isXiaomiVoiceExitCommand?.(raw) || m.isXiaomiVoiceExitCommand?.(text)) {
                voiceFeLog('用户输入', `播报中命中退出口令 → 走闸门：「${text.slice(0, 40)}」`)
                await _handleTurnEndLocalOrEnqueue(text || raw)
                return
              }
              // 真打断：有实质用户尾巴则仍入队（_commitUserTurn 会 barge）
              if (text.trim().length >= 6) {
                voiceFeLog('用户输入', `播报中用户抢话 → 入队/打断：「${text.slice(0, 40)}」`)
                await _handleTurnEndLocalOrEnqueue(text)
                return
              }
              noteVoicePanelDisplay('', { immediate: true, source: 'turn_end播报短回声丢弃' })
              voiceFeLog('用户输入', `turn_end 丢弃播报短回声：「${text.slice(0, 40)}」`)
            })
            .catch(() => {
              void _handleTurnEndLocalOrEnqueue(text)
            })
          return
        }
        const tid =
          String(m.trace_id || '').trim() ||
          getVoiceTrace() ||
          beginVoiceTrace({ reason: 'turn_end→发问' })
        if (m.trace_id) adoptVoiceTrace(String(m.trace_id), { reason: 'turn_end' })
        _turnEndAt = performance.now()
        _turnEndWall = formatVoiceLocalTs()
        _turnAwaitingPlay = text
        noteVoicePanelDisplay(text, { immediate: true, source: 'turn_end定稿' })
        void import('../background-voice-bridge.js').then((b) => {
          b.updateVoicePartialText?.(text)
        })
        _logDialogue(`用户说完定稿：「${text}」 定稿于=${_turnEndWall} TRACE=${tid}`)
        void _handleTurnEndLocalOrEnqueue(text)
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
      // assistant_end 之后的首包 = 正文（确认短句一定在 end 之前）
      if (_assistantEnded) {
        _heardBodySpeak = true
      }
      // 开播再清一次（发送时已清；防迟到 ASR 在思考窗又灌回来）
      _clearUserCaption('开播清用户句')
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
      // wire 完后端进入 pending_unmute；本地往往还在播 → 停上行，避免尾音灌进 mute 回灌缓冲
      if (isXiaomiFramePlaying() || getVoicePhase() === 'speaking') {
        setXiaomiPcmUplinkHold(true, 'tts_end_local_still_playing')
      }
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
        _heardBodySpeak = false
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
        _scheduleListenUnmute('stopall')
        _refreshTray()
        return
      }
      // 后端已停合成；前端同时丢弃迟到的正文增量，避免旧回复回流成语音。
      resetXiaomiFrameAssistantFeed()
      _awaitingReply = false
      _heardBodySpeak = false
      _scheduleListenUnmute('interrupted')
      _refreshTray()
      if (reason === 'client_barge_in' || reason === 'local-soft-barge-confirm') {
        // 前端主动 barge / 软打断确认：勿再 abort（调用方已编排）
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
        // 对话麦开轻量 AEC，压外放回声；唤醒耳仍关 AEC（见 wake-word-native）。
        // 采麦经 gain=0 哑接 destination，避免「麦进喇叭 + AEC → 输入被吃光」。
        echoCancellation: true,
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
    _lastMicPeak = peak
    try {
      updateSpeechPrior(input, _actx?.sampleRate || 16000)
    } catch {
      /* ignore */
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
    // 播报期本地 duck/打断（上行 hold 时后端 VAD 听不见）
    try {
      _onLocalBargePeak(peak)
    } catch {
      /* ignore */
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
  // 宽限期覆盖「在呢」整段 + 收尾回声，避免把应答听进去当用户发问
  _wakeAckUntilMs = Date.now() + 3500
  try {
    voiceFeLog('会话', '播放唤醒应答「在呢」…')
    const { playWakeChime } = await import('../wake-ack.js')
    await playWakeChime?.()
    const { playFixedVoiceSfx } = await import('../voice-fixed-sfx.js')
    await playFixedVoiceSfx('在呢')
    voiceFeLog('会话', '唤醒应答「在呢」播放完成')
  } catch (e) {
    voiceFeLog('会话', `唤醒应答「在呢」失败：${e?.message || e}`)
  } finally {
    _wakeAckUntilMs = Math.max(_wakeAckUntilMs, Date.now() + 800)
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

/**
 * Frame ASR 定稿：先走本地口令（停止/退出/停播报），命中则中断任务且不 chatSend。
 * @param {string} text
 */
async function _handleTurnEndLocalOrEnqueue(text) {
  const t = String(text || '').trim()
  if (!t) return
  try {
    const { tryHandleXiaomiVoiceLocalCommand } = await import('../xiaomi-voice-close.js')
    const handled = await tryHandleXiaomiVoiceLocalCommand(t, { source: 'frame-turn_end' })
    if (handled === 'exited') {
      // 关舞台会 teardown 管线；清排队，防迟到 enqueue 再发问
      _pendingTurns.length = 0
      _sending = false
      _awaitingReply = false
      _turnAwaitingPlay = ''
      _logDialogue(`本地口令退出（不经模型）：「${t}」`)
      return
    }
    if (handled === 'tts_stopped') {
      _logDialogue(`本地口令停播报（不经模型）：「${t}」`)
      _refreshTray()
      return
    }
  } catch (e) {
    voiceFeLog('打断', `本地口令闸失败，回退发问：${e?.message || e}`)
  }
  await _enqueueTurn(t)
}

async function _enqueueTurn(text) {
  const t = String(text || '').trim()
  if (!t) return
  // 双保险：排队迟到句若是退出口令，也绝不发给模型（避免绕过 turn_end 闸）
  try {
    const { isXiaomiVoiceExitCommand } = await import('../xiaomi-voice-close.js')
    const { isStopTtsOnlyCommand } = await import('../voice-listen-control.js')
    if (isXiaomiVoiceExitCommand(t) || isStopTtsOnlyCommand(t)) {
      voiceFeLog('用户输入', `排队句命中本地口令 → 改走闸门：「${t.slice(0, 40)}」`)
      _clearCoalesce()
      // 直接走闸门，勿再 _handleTurnEndLocalOrEnqueue→_enqueueTurn 递归
      const { tryHandleXiaomiVoiceLocalCommand } = await import('../xiaomi-voice-close.js')
      const handled = await tryHandleXiaomiVoiceLocalCommand(t, { source: 'frame-enqueue' })
      if (handled === 'exited') {
        _pendingTurns.length = 0
        _sending = false
        _awaitingReply = false
        _turnAwaitingPlay = ''
        return
      }
      if (handled === 'tts_stopped') {
        _refreshTray()
        return
      }
    }
  } catch {
    /* ignore — 下方正常发问 */
  }

  // 「在呢」回声 / 唤醒宽限期：绝不进模型
  if (_isWakeAckEcho(t) || Date.now() < _wakeAckUntilMs) {
    voiceFeLog(
      '用户输入',
      `录入队列丢弃（${_isWakeAckEcho(t) ? '唤醒回声' : '唤醒宽限期'}）：「${t.slice(0, 40)}」`,
    )
    return
  }

  // 合并窗口：ASR 越听越长只保留最新，900ms 静默后再 commit（用户录入队列）
  if (_coalesceText && !_isSameOrExtendedTurn(_coalesceText, t)) {
    // 明显新一句：先提交上一句，再开新窗口
    const prev = _coalesceText
    _clearCoalesce()
    voiceFeLog('用户输入', `录入队列切句：先提交「${prev.slice(0, 40)}」再听「${t.slice(0, 40)}」`)
    await _commitUserTurn(prev)
  }
  if (
    !_coalesceText ||
    _normUserTurn(t).length >= _normUserTurn(_coalesceText).length ||
    _isSameOrExtendedTurn(_coalesceText, t)
  ) {
    _coalesceText = t
  }
  if (_coalesceTimer) window.clearTimeout(_coalesceTimer)
  _coalesceTimer = window.setTimeout(() => {
    _coalesceTimer = 0
    const finalText = String(_coalesceText || '').trim()
    _coalesceText = ''
    if (finalText) void _commitUserTurn(finalText)
  }, USER_TURN_COALESCE_MS)
  voiceFeLog(
    '用户输入',
    `录入队列合并中（${USER_TURN_COALESCE_MS}ms）：「${t.slice(0, 60)}」`,
  )
  _refreshTray()
}

/**
 * 合并窗口结束后真正入队/发送。思考/播报中：延长句丢弃；真新句入队等播完。
 * @param {string} text
 */
async function _commitUserTurn(text) {
  const raw = String(text || '').trim()
  if (!raw) return
  // 剥掉上轮粘连前缀，避免过 dedup 窗后整段「旧+新」当新句发出（面板叠加同源）
  const peeled = _peelCommittedAsrPrefix(raw)
  const t = peeled || raw
  if (_lastCommittedTurn && !peeled && _isSameOrExtendedTurn(_lastCommittedTurn, raw)) {
    voiceFeLog('用户输入', `录入队列丢弃上轮 ASR 回声：「${raw.slice(0, 60)}」`)
    return
  }
  if (peeled && peeled !== raw) {
    voiceFeLog(
      '用户输入',
      `ASR 粘连已剥前缀：「${raw.slice(0, 40)}」→「${peeled.slice(0, 40)}」`,
    )
  }
  if (_isWakeAckEcho(t) || Date.now() < _wakeAckUntilMs) {
    voiceFeLog('用户输入', `录入队列 commit 丢弃唤醒回声：「${t.slice(0, 40)}」`)
    return
  }

  // 已发问后的 ASR 延长/近义：绝不打断（这是「AI 回复没声」主因）
  if (
    _lastCommittedTurn &&
    Date.now() - _lastCommittedAtMs < USER_TURN_DEDUP_MS &&
    _isSameOrExtendedTurn(_lastCommittedTurn, t)
  ) {
    voiceFeLog(
      '用户输入',
      `录入队列丢弃延长/近义（不打断回复）：「${t.slice(0, 60)}」距上次 ${Date.now() - _lastCommittedAtMs}ms`,
    )
    return
  }

  if (_sending) {
    _pendingTurns.length = 0
    _pendingTurns.push(t)
    voiceFeLog('用户输入', `上一轮仍在发送 → 覆盖排队为最新：「${t.slice(0, 60)}」`)
    _refreshTray()
    return
  }

  const playing = isXiaomiFramePlaying()
  const busy = _awaitingReply || playing
  if (busy) {
    if (_lastCommittedTurn && _isSameOrExtendedTurn(_lastCommittedTurn, t)) {
      voiceFeLog('用户输入', `思考/播报中丢弃 ASR 延长句：「${t.slice(0, 60)}」`)
      return
    }
    if (playing) {
      // 用户真打断播报：停播 + 取消模型，立刻发新句
      voiceFeLog('用户输入', `播报中真打断 →「${t.slice(0, 60)}」`)
      _pendingTurns.length = 0
      try {
        await bargeInXiaomiFrame('user_turn_barge')
      } catch {
        /* ignore */
      }
      await _abortModelRunForBargeIn()
      _awaitingReply = false
      await _sendTurn(t)
      return
    }
    // 思考中（模型还在跑、尚未开播）：入队等播完，不 abort → 保住本轮 TTS
    _pendingTurns.length = 0
    _pendingTurns.push(t)
    voiceFeLog(
      '用户输入',
      `思考中新句入队（等本轮播完再发，不打断）：「${t.slice(0, 60)}」`,
    )
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
  // 发送前最后一道：退出/停播报口令永不进模型
  try {
    const { tryHandleXiaomiVoiceLocalCommand } = await import('../xiaomi-voice-close.js')
    const handled = await tryHandleXiaomiVoiceLocalCommand(text, { source: 'frame-sendTurn' })
    if (handled === 'exited' || handled === 'tts_stopped') {
      _pendingTurns.length = 0
      _awaitingReply = false
      _refreshTray()
      return
    }
  } catch {
    /* ignore */
  }
  _sending = true
  _awaitingReply = true
  _assistantEnded = false
  _heardBodySpeak = false
  _listenGraceUntilMs = 0
  if (_listenUnmuteTimer) {
    window.clearTimeout(_listenUnmuteTimer)
    _listenUnmuteTimer = 0
  }
  _lastCommittedTurn = String(text || '').trim()
  _lastCommittedAtMs = Date.now()
  if (_endFlushTimer) {
    window.clearTimeout(_endFlushTimer)
    _endFlushTimer = 0
  }
  // 一进思考就清「你」区：勿等 tts_start；并挡住迟到 ASR 回灌
  _clearUserCaption('发送后进思考清用户句')
  _setTray('processing')
  // 等确认句/正文前也能喊退出（确认句开播后 TTS 会再 mute）
  _armExitListenWhileThinking('send_turn')
  let releasedSending = false
  const releaseSending = () => {
    if (releasedSending) return
    releasedSending = true
    _sending = false
    // 发送窗口内积压的延长句若与刚发出的同轮 → 丢掉；真新句等播完再出队
    if (_pendingTurns.length) {
      const next = String(_pendingTurns[_pendingTurns.length - 1] || '').trim()
      _pendingTurns.length = 0
      if (next && _isSameOrExtendedTurn(_lastCommittedTurn, next)) {
        voiceFeLog('用户输入', `发送后丢弃同轮延长排队：「${next.slice(0, 60)}」`)
        _refreshTray()
        return
      }
      if (next) {
        // 仍在等回复：继续压住，勿立刻连发
        if (_awaitingReply) {
          _pendingTurns.push(next)
          voiceFeLog('用户输入', `发送完成但仍在等回复 → 新句继续排队：「${next.slice(0, 60)}」`)
          _refreshTray()
          return
        }
        void _sendTurn(next)
        return
      }
    }
    _refreshTray()
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
  _clearCoalesce()
  _lastCommittedTurn = ''
  _lastCommittedAtMs = 0
  _wakeAckUntilMs = 0
  // 退出小微对话后不再 prefer 小V，避免迟到 ASR 仍标小V 或误路由
  void import('../background-voice-bridge.js')
    .then((m) => {
      m.setPreferXiaomiVoice?.(false)
      m.clearPendingVoiceSend?.()
      m.updateVoicePartialText?.('')
    })
    .catch(() => {})
  _awaitingReply = false
  _heardBodySpeak = false
  _listenGraceUntilMs = 0
  if (_listenUnmuteTimer) {
    window.clearTimeout(_listenUnmuteTimer)
    _listenUnmuteTimer = 0
  }
  setXiaomiPcmUplinkHold(false, 'pipeline_stop')
  _clearSoftBargeResumeTimer()
  _softBargeProbing = false
  _resetLocalBarge('pipeline_stop')
  resetSpeechPrior()
  _localBargeSpeakSince = 0
  _lastMicPeak = 0
  _localBargeBusy = false
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
/**
 * assistant_end 之后是否已收到正文 tts_start（非确认短句）。
 * 确认句本地播完时若模型已 end，旧逻辑会误回聆听→unmute→回声抢麦（日志 17:17:35）。
 */
let _heardBodySpeak = false
/** Frame session 尚未就绪时暂存的累计正文（避免回落 legacy 双播） */
let _stashBody = ''
let _stashFinal = false
/** 本轮已成功推给 Frame 的全部正文（跨多段累加），防 RUN_FINISHED 重喂已播段 */
let _assistantFedText = ''
/**
 * text-end 已对当前段发过 assistant_end。
 * RUN_FINISHED 再 feed(final) 时勿整段重推、勿二次 end（日志 vt-tnk9sn-2b66：工具后第二段播两遍）。
 */
let _assistantSegmentEndSent = false
/** 播完回聆听后短暂延后放麦，躲开喇叭尾音 */
let _listenUnmuteTimer = 0
/** @type {number} */
let _listenGraceUntilMs = 0
/**
 * 放麦：最短宽限 + 能量门控（麦峰落到回声基线下才 unmute），封顶避免拖死。
 * 宽限内仍 hold PCM 上行。
 */
const LISTEN_UNMUTE_MIN_MS = 1200
const LISTEN_UNMUTE_MAX_MS = 2800
const LISTEN_QUIET_PEAK = 0.045
const LISTEN_QUIET_NEED = 3

// ─── 播报期本地音量打断（PCM 上行 hold 时 VAD 听不见，改看麦峰） ───
const LOCAL_BARGE_THRESHOLD = 0.09
const LOCAL_BARGE_WARMUP_MS = 700
const LOCAL_BARGE_ECHO_MARGIN = 0.035
const LOCAL_BARGE_HARD_VOL = 0.2
const LOCAL_DUCK_TRIGGER = 3
/** duck 后立刻软暂停（旧值 10 帧常因先验变冷卡在「音量变小但不停」） */
const LOCAL_DUCK_SUSTAIN = 1
const LOCAL_DUCK_DECAY = 6
const LOCAL_DUCK_MAX_MS = 1500
/** 软打断后无有效 ASR → 续播（先验门控后假阳下降，缩短假暂停窗） */
const LOCAL_SOFT_BARGE_RESUME_MS = 3200

/** @type {number} */
let _lastMicPeak = 0
/** @type {number} */
let _ttsEchoFloor = 0
/** @type {number} */
let _localBargeSpeakSince = 0
let _localBargeFrames = 0
let _localDuckActive = false
let _localDuckHigh = 0
let _localDuckLow = 0
let _localDuckStart = 0
let _localBargeBusy = false
/** @type {ReturnType<typeof setTimeout> | null} */
let _softBargeResumeTimer = null
let _softBargeProbing = false

function _clearSoftBargeResumeTimer() {
  if (_softBargeResumeTimer) {
    clearTimeout(_softBargeResumeTimer)
    _softBargeResumeTimer = null
  }
}

function _resetLocalBarge(reason = '') {
  _localBargeFrames = 0
  _localDuckActive = false
  _localDuckHigh = 0
  _localDuckLow = 0
  _localDuckStart = 0
  _ttsEchoFloor = 0
  if (reason) {
    try {
      unduckXiaomiFramePlayback()
    } catch {
      /* ignore */
    }
  }
}

/**
 * 软打断探测期内出现有效用户话 → 真 barge_in + abort 模型（对齐 vad_barge）。
 * @param {string} [text]
 */
function _confirmSoftBargeWithUserSpeech(text = '') {
  if (!_softBargeProbing && !isXiaomiFrameSoftPaused()) return false
  const t = String(text || '').trim()
  if (t && t.length < 2) return false
  _clearSoftBargeResumeTimer()
  _softBargeProbing = false
  const prior = getSpeechPriorDebug()
  voiceFeLog(
    '打断',
    `软打断确认有用户话 → barge_in+abort「${t.slice(0, 40)}」 priorScore=${prior.score.toFixed(2)}`,
  )
  try {
    bargeInXiaomiFrame({ reason: 'local-soft-barge-confirm' })
  } catch {
    /* ignore */
  }
  // interrupted(client_barge_in) 不再二次 abort；此处主动停模型
  void _abortModelRunForBargeIn()
  _awaitingReply = false
  _heardBodySpeak = false
  // 「停止/退出」须走本地口令闸：否则只停播一下又继续生成/续播
  if (t) {
    void import('../xiaomi-voice-close.js')
      .then((m) => m.tryHandleXiaomiVoiceLocalCommand?.(t, { source: 'soft-barge-asr' }))
      .catch(() => {})
  }
  _scheduleListenUnmute('local_vol_barge_confirm')
  _refreshTray()
  return true
}

/**
 * 播报/软暂停探测期：短口令「停止/退出」立刻确认（不必等 ≥4 字 partial）。
 * @param {string} text
 * @returns {boolean}
 */
function _tryConfirmSoftBargeExitCommand(text = '') {
  const t = String(text || '').trim()
  if (!t) return false
  if (!_softBargeProbing && !isXiaomiFrameSoftPaused() && !isXiaomiFramePlaying()) return false
  // 动态 import 同步不了；用已加载的闭包检测会更好——此处先粗判再确认
  void Promise.all([
    import('../xiaomi-voice-close.js'),
    import('../voice-listen-control.js'),
  ])
    .then(([closeMod, listenMod]) => {
      const exit =
        closeMod.isXiaomiVoiceExitCommand?.(t) || listenMod.isStopTtsOnlyCommand?.(t)
      if (!exit) return
      if (!_softBargeProbing && !isXiaomiFrameSoftPaused()) {
        // 仍在 duck/播报：先软暂停再走口令
        try {
          pauseXiaomiFrameLocalPlayback({ reason: 'exit-cmd-heard' })
        } catch {
          /* ignore */
        }
        _softBargeProbing = true
      }
      voiceFeLog('打断', `播报期短口令确认 →「${t.slice(0, 40)}」`)
      _confirmSoftBargeWithUserSpeech(t)
    })
    .catch(() => {})
  return true
}

function _armSoftBargeResumeWatch() {
  _clearSoftBargeResumeTimer()
  _softBargeProbing = true
  _softBargeResumeTimer = setTimeout(() => {
    _softBargeResumeTimer = null
    if (!_softBargeProbing) return
    _softBargeProbing = false
    if (!isXiaomiFrameSoftPaused()) return
    voiceFeLog('打断', `软打断 ${LOCAL_SOFT_BARGE_RESUME_MS}ms 无 ASR → 续播`)
    try {
      resumeXiaomiFrameLocalPlayback({ reason: 'no-asr-resume' })
    } catch {
      /* ignore */
    }
    setXiaomiPcmUplinkHold(true, 'soft_barge_false_resume')
    _localBargeSpeakSince = Date.now()
    _refreshTray()
  }, LOCAL_SOFT_BARGE_RESUME_MS)
}

function _learnEchoFloor(peak, { force = false } = {}) {
  const raw = Math.max(0, Number(peak) || 0)
  if (!force && raw > LOCAL_BARGE_THRESHOLD) return
  const sample = Math.min(raw, LOCAL_BARGE_THRESHOLD)
  _ttsEchoFloor = _ttsEchoFloor ? _ttsEchoFloor * 0.9 + sample * 0.1 : sample
}

function _isLocalBargeCandidate(peak) {
  if (peak <= LOCAL_BARGE_THRESHOLD) return false
  const guard = Math.max(LOCAL_BARGE_THRESHOLD, _ttsEchoFloor + LOCAL_BARGE_ECHO_MARGIN)
  return peak >= LOCAL_BARGE_HARD_VOL || peak > guard
}

/**
 * 播报 + PCM hold 时：语音先验 + 音量 → duck → 软暂停（无 ASR 则续播；有用户话再真 barge）。
 * @param {number} peak 0–1
 */
function _onLocalBargePeak(peak) {
  if (!_running || _localBargeBusy || _softBargeProbing) return
  if (!isXiaomiFramePlaying() && getVoicePhase() !== 'speaking') {
    if (_localDuckActive) _resetLocalBarge('not_speaking')
    return
  }
  // 仅上行 hold 时走本地打断；已放麦则交给后端 VAD
  if (!isXiaomiPcmUplinkHeld()) {
    if (_localDuckActive) _resetLocalBarge('uplink_open')
    return
  }
  if (!_localBargeSpeakSince) _localBargeSpeakSince = Date.now()
  const warmed = Date.now() - _localBargeSpeakSince > LOCAL_BARGE_WARMUP_MS
  if (!warmed) {
    _learnEchoFloor(peak, { force: true })
    return
  }
  if (!_localDuckActive) _learnEchoFloor(peak)
  const priorHot = isSpeechPriorHot()
  const energyCand = _isLocalBargeCandidate(peak)
  // 能量候选但先验未热：只学 floor，不 duck（抑拍手/键盘假阳）
  const cand = energyCand && priorHot
  if (!_localDuckActive) {
    if (cand) {
      if (++_localBargeFrames >= LOCAL_DUCK_TRIGGER) {
        _localBargeFrames = 0
        const prior = getSpeechPriorDebug()
        // 旧路径：先 duck 再等 sustain → 常卡在「音量变小但不停」。
        // 现：先验热 + 能量够 → 直接软暂停并放麦听口令/抢话。
        _localBargeBusy = true
        _resetLocalBarge()
        duckXiaomiFramePlayback(0.22)
        voiceFeLog(
          '打断',
          `本地先验确认 → 软暂停探测 ASR peak=${peak.toFixed(3)} floor=${_ttsEchoFloor.toFixed(3)} priorScore=${prior.score.toFixed(2)} zcr=${prior.zcr.toFixed(3)}`,
        )
        try {
          pauseXiaomiFrameLocalPlayback({ reason: 'local-vol-soft-barge' })
        } catch {
          /* ignore */
        }
        setXiaomiPcmUplinkHold(false, 'soft_barge_probe')
        try {
          sendXiaomiClientListening({ force: true, purpose: 'exit_listen' })
        } catch {
          /* ignore */
        }
        _armSoftBargeResumeWatch()
        _refreshTray()
        _localBargeBusy = false
      }
    } else {
      _localBargeFrames = 0
    }
    return
  }
  // 兼容：若仍处 duck 态（旧路径残留），下一帧能量够就进软暂停
  const elapsed = Date.now() - _localDuckStart
  if (cand) {
    _localDuckHigh += 1
    _localDuckLow = 0
    if (_localDuckHigh >= LOCAL_DUCK_SUSTAIN) {
      _localBargeBusy = true
      _resetLocalBarge()
      const prior = getSpeechPriorDebug()
      voiceFeLog(
        '打断',
        `本地 duck 续确认 → 软暂停探测 ASR peak=${peak.toFixed(3)} priorScore=${prior.score.toFixed(2)}`,
      )
      try {
        pauseXiaomiFrameLocalPlayback({ reason: 'local-vol-soft-barge' })
      } catch {
        /* ignore */
      }
      setXiaomiPcmUplinkHold(false, 'soft_barge_probe')
      try {
        sendXiaomiClientListening({ force: true, purpose: 'exit_listen' })
      } catch {
        /* ignore */
      }
      _armSoftBargeResumeWatch()
      _refreshTray()
      _localBargeBusy = false
    }
    return
  }
  _localDuckLow += 1
  _localDuckHigh = 0
  if (_localDuckLow >= LOCAL_DUCK_DECAY || elapsed >= LOCAL_DUCK_MAX_MS) {
    voiceFeLog('打断', '本地 duck 消退 → 恢复音量（判为噪音/先验未热）')
    _resetLocalBarge('noise')
  }
}

/** 历史确认短句回声（应声已关；仍剥残留「好的/收到」） */
const _TURN_ACK_ECHO = ['好的', '收到']

function _isAckEchoText(text) {
  const n = _normUserTurn(text)
  if (!n) return false
  // 短应声只认整句（可带语气词）；endsWith「好的」会误杀正常尾句
  if (_TURN_ACK_ECHO.some((a) => n === a || n === `${a}啊` || n === `${a}呀` || n === `${a}呢` || n === `${a}哦`)) {
    return true
  }
  return n.length <= 6 && /^(嗯|啊|哦|呐)+$/.test(n)
}

/**
 * 粘连 ASR = 助手播报前缀 + 用户新话：只剥前缀，保留用户尾巴。
 * 旧逻辑整段当回声丢掉 → 正常长句被漏发（日志 17:30–17:32）。
 */
function _peelAssistantEchoPrefix(text) {
  const t = String(text || '').trim()
  const fed = String(_assistantFedText || _assistantPlain || '').trim()
  if (!t || !fed || fed.length < 10) return t
  const nf = _normUserTurn(fed)
  const nt = _normUserTurn(t)
  if (!nf || !nt || nt.length <= 4) return t
  // 整段就是助手原文（或更短子集）→ 空
  if (nf === nt || (nf.includes(nt) && nt.length >= 6 && nt.length <= nf.length)) return ''
  // 必须是前缀粘连才剥；句中偶然重合不动
  const head = Math.min(24, nf.length)
  if (head < 10 || !nt.startsWith(nf.slice(0, head))) return t
  let ni = 0
  let i = 0
  const noise = /[\s\u3000，。！？、,.!?;；：:"""''“”‘’（）()【】[\]…—\-]/
  while (i < t.length && ni < nf.length) {
    const ch = t[i]
    if (noise.test(ch)) {
      i += 1
      continue
    }
    if (ch.toLowerCase() === nf[ni]) {
      i += 1
      ni += 1
      continue
    }
    break
  }
  // 至少对齐助手一半，才认为前面是回声
  if (ni < Math.floor(Math.min(nf.length, 40) * 0.5)) return t
  const rest = t.slice(i).replace(/^[，。！？、,.!?\s]+/, '').trim()
  return rest
}

function _inListenGrace() {
  return Date.now() < _listenGraceUntilMs
}

/**
 * 思考期（等模型 / 确认句已播完、正文未到）专门放麦听「退出/停止」。
 * 不改 phase、不开正常聆听；后端 purpose=exit_listen，播报中仍 mute。
 */
function _armExitListenWhileThinking(reason = 'think') {
  if (!_running || !_awaitingReply) return
  if (isXiaomiFramePlaying() || getVoicePhase() === 'speaking') return
  voiceFeLog('管线', `思考期放麦听退出（${reason}）`)
  voiceDecisionLog('exit_listen_arm', {
    reason: String(reason || '-'),
    awaitingReply: true,
    assistantEnded: !!_assistantEnded,
    heardBodySpeak: !!_heardBodySpeak,
    phase: getVoicePhase(),
  })
  sendXiaomiClientListening({ force: true, purpose: 'exit_listen' })
}

function _finishListenUnmute(reason = 'grace') {
  _listenUnmuteTimer = 0
  _listenGraceUntilMs = 0
  _resetLocalBarge('unmute')
  if (!_running || _awaitingReply || isXiaomiFramePlaying()) return
  if (!canUnmuteStt()) return
  setXiaomiPcmUplinkHold(false, `listen_unmute:${reason}`)
  voiceFeLog(
    '管线',
    `放麦（${reason}）peak=${_lastMicPeak.toFixed(3)} floor=${_ttsEchoFloor.toFixed(3)} → client_listening`,
  )
  flushXiaomiClientListeningIfIdle()
}

function _scheduleListenUnmute(reason = 'grace') {
  const startedAt = Date.now()
  _listenGraceUntilMs = startedAt + LISTEN_UNMUTE_MAX_MS
  setXiaomiPcmUplinkHold(true, `listen_grace:${reason}`)
  // 保留 _ttsEchoFloor 给能量门控；只清 duck 状态
  _localBargeFrames = 0
  _localDuckActive = false
  _localDuckHigh = 0
  _localDuckLow = 0
  try {
    unduckXiaomiFramePlayback()
  } catch {
    /* ignore */
  }
  if (_listenUnmuteTimer) {
    window.clearTimeout(_listenUnmuteTimer)
    _listenUnmuteTimer = 0
  }
  let quietStreak = 0
  const tick = () => {
    _listenUnmuteTimer = 0
    if (!_running || _awaitingReply || isXiaomiFramePlaying()) return
    if (!canUnmuteStt()) return
    const elapsed = Date.now() - startedAt
    // 宽限内继续学一点地板，避免绝对阈值过松/过紧
    _learnEchoFloor(_lastMicPeak, { force: _lastMicPeak < LOCAL_BARGE_THRESHOLD })
    const quietCeil = Math.max(LISTEN_QUIET_PEAK, (_ttsEchoFloor || 0) + 0.02)
    const quiet = _lastMicPeak <= quietCeil
    if (elapsed >= LISTEN_UNMUTE_MIN_MS) {
      if (quiet) quietStreak += 1
      else quietStreak = 0
      if (quietStreak >= LISTEN_QUIET_NEED || elapsed >= LISTEN_UNMUTE_MAX_MS) {
        _finishListenUnmute(
          quietStreak >= LISTEN_QUIET_NEED ? `${reason}+quiet` : `${reason}+max`,
        )
        return
      }
    }
    _listenUnmuteTimer = window.setTimeout(tick, 100)
  }
  // 最短宽限后再开始判静音 streak（此前只 hold）
  _listenUnmuteTimer = window.setTimeout(tick, Math.min(200, LISTEN_UNMUTE_MIN_MS))
}

function _noteFed(delta) {
  const d = String(delta || '')
  if (d) _assistantFedText += d
}

/** 忽略空白差异后比较正文是否已覆盖（防 text-end 后再 final 整段重推） */
function _normSpeechBody(s) {
  return String(s || '').replace(/\s+/g, '')
}

/**
 * @param {string} fed
 * @param {string} body
 * @returns {boolean}
 */
function _fedCoversBody(fed, body) {
  const f = String(fed || '')
  const b = String(body || '')
  if (!b) return true
  if (!f) return false
  if (f === b || f.endsWith(b) || b.endsWith(f) || f.includes(b)) return true
  const nf = _normSpeechBody(f)
  const nb = _normSpeechBody(b)
  if (!nb) return true
  return nf === nb || nf.endsWith(nb) || nb.endsWith(nf) || nf.includes(nb)
}

/**
 * 同轮多段正文（工具调用之间）：冲刷上一段去 TTS，再开闸接下一段。
 * 不置 _assistantEnded，语音 pending 继续；也不拆掉上一段本地播放队列。
 */
export function flushXiaomiFrameAssistantSegment(reason = 'segment') {
  if (!isXiaomiFrameSessionActive()) return false
  if (_assistantEnded) return false
  const plain = String(_assistantPlain || '').trim()
  if (plain) {
    voicePlaybackMark(
      '流式正文',
      plain.slice(0, 120),
      `段落冲刷→播报 reason=${reason}（${plain.length} 字）`,
    )
    sendXiaomiAssistantEnd()
    _assistantPlain = ''
    if (reason === 'text-end') _assistantSegmentEndSent = true
  } else if (reason === 'text-end') {
    // 空段 text-end：无字可冲；勿误开 begin
    return false
  }
  // text-end = 本段正文结束，只 end 去 TTS。再 begin 会 +turn，且曾与确认短句后的
  // 正文 TTSSpeak 竞态（合成完无首包下发）。下一段由 tool-start / non-prefix 开闸；
  // 整轮收尾由 feed(final) 收口（若 text-end 已 end，则不再二次 end / 重推）。
  if (reason === 'text-end') {
    _awaitingReply = true
    _assistantEnded = false
    _refreshTray()
    return true
  }
  // tool-start / non-prefix：下一段开闸，保留本段已在播/排队的音频
  _assistantSegmentEndSent = false
  sendXiaomiAssistantBegin({ preservePlayback: true })
  _awaitingReply = true
  _assistantEnded = false
  _refreshTray()
  return true
}

/** Feed assistant stream into Frame SentenceAgg (skips frontend cut). */
export function feedXiaomiFrameAssistant(fullText, { final = false } = {}) {
  if (!isXiaomiFrameSessionActive()) return false
  // final 已发过：忽略迟到的 sync FINAL / 重复 clear（日志里曾整段重推 → 三句播两遍）
  if (_assistantEnded) {
    return true
  }
  const body = String(fullText || '')
  const wasEmpty = !_assistantPlain
  const fed = String(_assistantFedText || '')

  // text-end 已冲刷 / RUN_FINISHED 重带全文：已喂过的正文一律不重推
  if (fed && body && _fedCoversBody(fed, body)) {
    if (wasEmpty || final) {
      voicePlaybackMark('流式正文', body.slice(0, 40), '跳过已推送正文（text-end/已喂）')
    }
  } else if (final && fed && body && body.startsWith(fed)) {
    const rest = body.slice(fed.length)
    if (rest) {
      voicePlaybackMark('流式正文', rest.slice(0, 80), '收尾补推未播尾巴')
      sendXiaomiAssistantDelta(rest)
      _noteFed(rest)
      _assistantPlain = body
      _assistantSegmentEndSent = false
    }
  } else if (body.length > _assistantPlain.length && body.startsWith(_assistantPlain)) {
    const delta = body.slice(_assistantPlain.length)
    _assistantPlain = body
    if (delta) {
      // 细粒度增量由后端记；前端记首包与较长块，避免刷屏
      if (wasEmpty || delta.length >= 24) {
        voicePlaybackMark('流式正文', delta, '推送 Frame（增量）')
      }
      sendXiaomiAssistantDelta(delta)
      _noteFed(delta)
      _assistantSegmentEndSent = false
    }
  } else if (body && body !== _assistantPlain) {
    if (!_assistantPlain) {
      // 若 body 其实是已喂内容的子集/重复，跳过
      if (fed && _fedCoversBody(fed, body)) {
        voicePlaybackMark('流式正文', body.slice(0, 40), '跳过已推送正文')
      } else if (fed && body.startsWith(fed)) {
        const rest = body.slice(fed.length)
        _assistantPlain = body
        if (rest) {
          voicePlaybackMark('流式正文', rest.slice(0, 80), '推送 Frame（续写）')
          sendXiaomiAssistantDelta(rest)
          _noteFed(rest)
          _assistantSegmentEndSent = false
        }
      } else {
        _assistantPlain = body
        voicePlaybackMark('流式正文', body.slice(0, 80), '推送 Frame（首包整段）')
        sendXiaomiAssistantDelta(body)
        _noteFed(body)
        _assistantSegmentEndSent = false
      }
    } else {
      // 工具后新开的正文块（openText 不再以前缀延续）→ 先播上一段，再喂本段
      voicePlaybackMark(
        '流式正文',
        body.slice(0, 80),
        `非前缀新段（上段 ${_assistantPlain.length} 字）→ 冲刷后接新段`,
      )
      flushXiaomiFrameAssistantSegment('non-prefix')
      _assistantPlain = body
      sendXiaomiAssistantDelta(body)
      _noteFed(body)
      _assistantSegmentEndSent = false
    }
  }
  if (final) {
    _assistantEnded = true
    const plain = String(_assistantFedText || _assistantPlain || '').trim()
    _logDialogue(
      plain
        ? `助手回复：「${plain.slice(0, 800)}${plain.length > 800 ? '…' : ''}」`
        : '助手回复：（空）',
      { detail: `len=${plain.length}` },
    )
    voicePlaybackMark(
      '流式正文',
      plain.slice(0, 400),
      `本轮结束累计 ${plain.length} 字${_assistantSegmentEndSent ? '（text-end 已冲，跳过二次 end）' : '，冲刷残句'}`,
    )
    // text-end 已 end 过本段：再 end 会让后端把同一段再合成一遍（vt-tnk9sn-2b66 seq=2/3）
    if (!_assistantSegmentEndSent) {
      sendXiaomiAssistantEnd()
    }
    _assistantSegmentEndSent = false
    // 正文 TTS 可能还要等几秒：这段窗口也要能喊退出
    _armExitListenWhileThinking('assistant_end')
    // 正文 end 后 TTS 常晚 1–2s（火山 ttfb）；旧 1.2s 就 flush → 误 unmute →
    // 回声 stopAll → 只播一句（日志 18:30:23→25）。等 tts_start 取消；仅超久无播才兜底。
    if (_endFlushTimer) window.clearTimeout(_endFlushTimer)
    _endFlushTimer = window.setTimeout(() => {
      _endFlushTimer = 0
      if (!_running || !_assistantEnded) return
      if (isXiaomiFramePlaying()) return
      if (_heardBodySpeak) return
      voiceDecisionLog('end_flush_timeout', {
        awaitingReply: _awaitingReply,
        heardBodySpeak: false,
        playing: false,
      })
      voiceFeLog('管线', '正文结束已久仍无本地播报 → 释放思考并 client_listening')
      _awaitingReply = false
      if (_pendingTurns.length) {
        _drainPendingAfterIdle('end_flush_no_tts')
      } else {
        _refreshTray()
        _scheduleListenUnmute('end_flush_timeout')
      }
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
  if (!isXiaomiFrameSessionActive()) {
    // 连上前又断了：写回暂存，等下次 flush
    _stashBody = body
    _stashFinal = final
    voiceFeLog('流式正文', `冲刷暂存失败（Frame 未活跃）保留 ${_stashBody.length} 字`)
    return
  }
  voicePlaybackMark('流式正文', body.slice(0, 120), `Frame 已就绪，冲刷暂存 ${body.length} 字`)
  // arm 时 session 可能尚未连上，begin 没发出；冲刷前补一次开闸
  sendXiaomiAssistantBegin()
  feedXiaomiFrameAssistant(body, { final })
}

/** Frame WS 连上后由 session-client / sync 调用：把「连接中暂存」推进 TTS。 */
export function flushXiaomiFrameAssistantStash() {
  _flushStashedAssistant()
}

export function resetXiaomiFrameAssistantFeed() {
  _assistantPlain = ''
  _assistantEnded = false
  _assistantFedText = ''
  _assistantSegmentEndSent = false
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
