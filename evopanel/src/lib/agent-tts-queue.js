/**
 * 多岗定稿串行 TTS 泵（会议 / 部门群共用逻辑，各场景自建实例）。
 * 输入归一消息：{ id, agent_code, text, completed, error? }
 * 不持有 mute 存储键、不感知会议/部门 schema。
 */

import {
  fetchSpeechConfigured,
  stopAllAssistantSpeech,
  unlockSpeechPlayback,
  playAssistantSpeech,
  prefetchAssistantSpeech,
  waitForSpeechPlaybackIdle,
  isSpeechPlaybackBusy,
} from './speech-client.js'
import {
  resolveAgentTtsSpeaker,
  readAgentTtsSpeechRate,
} from './agent-tts-voices.js'

/**
 * @typedef {{
 *   id?: string
 *   agent_code?: string
 *   text?: string
 *   completed?: boolean
 *   error?: boolean
 * }} AgentTtsQueueMsg
 *
 * @typedef {{
 *   open?: boolean
 *   muted?: boolean
 *   messages?: AgentTtsQueueMsg[]
 *   agents?: unknown[]
 * }} AgentTtsQueueState
 *
 * @typedef {{ key: string, code: string, text: string } | null} AgentTtsUtterance
 *
 * @typedef {{
 *   key: string
 *   code: string
 *   text: string
 *   at: number
 *   status: 'played' | 'skipped' | 'stopped' | 'failed'
 *   reason?: string
 * }} AgentTtsTrailEntry
 */

/** 不播：占位 / 空 / 纯状态句 */
export function isAgentTtsSpeakableText(text) {
  const t = String(text || '').trim()
  if (!t) return false
  if (t === '(无回复)' || t === '（无回复）') return false
  if (t === '（回复未完成）' || t === '(回复未完成)') return false
  if (/^(排队|正在回复|回复中|正忙|重试中|…|\.{3}|…)$/.test(t)) return false
  if (/排队中|正在回复|回复未完成|持续忙碌|稍后再/.test(t) && t.length < 40) return false
  return true
}

/**
 * @param {{ logTag?: string, onTrail?: (e: AgentTtsTrailEntry) => void }} [opts]
 */
export function createAgentTtsQueue(opts = {}) {
  const logTag = String(opts.logTag || 'agent-tts').trim() || 'agent-tts'
  /** @type {((e: AgentTtsTrailEntry) => void) | null} */
  const onTrail = typeof opts.onTrail === 'function' ? opts.onTrail : null

  /** @type {Set<string>} */
  const spokenCompleted = new Set()
  /** 瞬时失败（no supported sources）重试计数，避免死循环 */
  /** @type {Map<string, number>} */
  const transientFails = new Map()
  const TRANSIENT_RETRY_MAX = 2
  /** @type {boolean | null} */
  let configured = null
  /** @type {AgentTtsQueueState | null} */
  let latestSt = null
  let pumpRunning = false
  let playingKey = ''
  /** 用户点停止：打断当前句，已 mark spoken 的不重播 */
  let stopRequested = false
  /** @type {AgentTtsUtterance} */
  let utterance = null
  /** @type {Set<(u: AgentTtsUtterance) => void>} */
  const utteranceListeners = new Set()

  function msgKey(m) {
    return String(m?.id || `${m?.agent_code || ''}:${String(m?.text || '').slice(0, 24)}`)
  }

  /**
   * @param {unknown[]} agents
   * @param {string} code
   */
  function findAgent(agents, code) {
    const key = String(code || '')
      .trim()
      .toLowerCase()
    if (!key) return null
    for (const a of agents || []) {
      const row = /** @type {any} */ (a)
      const c = String(row?.agent_code || row?.name || '')
        .trim()
        .toLowerCase()
      if (c === key) return a
    }
    return null
  }

  /** @param {AgentTtsTrailEntry} entry */
  function pushTrail(entry) {
    try {
      onTrail?.(entry)
    } catch {
      /* ignore */
    }
  }

  /** @param {AgentTtsUtterance} next */
  function setUtterance(next) {
    const a = utterance
    const b = next
    const same =
      (!a && !b) ||
      (!!a && !!b && a.key === b.key && a.code === b.code && a.text === b.text)
    if (same) return
    utterance = next
    for (const cb of utteranceListeners) {
      try {
        cb(utterance)
      } catch {
        /* ignore */
      }
    }
  }

  function getUtterance() {
    return utterance
  }

  /**
   * @param {(u: AgentTtsUtterance) => void} cb
   * @returns {() => void}
   */
  function subscribeUtterance(cb) {
    if (typeof cb !== 'function') return () => {}
    utteranceListeners.add(cb)
    try {
      cb(utterance)
    } catch {
      /* ignore */
    }
    return () => utteranceListeners.delete(cb)
  }

  function stop() {
    stopRequested = true
    stopAllAssistantSpeech({ reason: `${logTag}-stop` })
    const cur = utterance
    if (cur?.key) {
      spokenCompleted.add(cur.key)
      pushTrail({
        key: cur.key,
        code: cur.code,
        text: cur.text,
        at: Date.now(),
        status: 'stopped',
        reason: 'user_stop',
      })
    }
    playingKey = ''
    setUtterance(null)
  }

  function reset() {
    stop()
    spokenCompleted.clear()
    transientFails.clear()
    latestSt = null
    stopRequested = false
  }

  /**
   * 把已定稿消息标为已播（进群追平 / 开麦追平），避免历史重播。
   * @param {AgentTtsQueueMsg[]} msgs
   * @param {{ reason?: string }} [opt]
   * @returns {number} 新标记条数
   */
  function seedSpoken(msgs, opt = {}) {
    const reason = String(opt.reason || 'seed').trim() || 'seed'
    let n = 0
    for (const m of Array.isArray(msgs) ? msgs : []) {
      if (!m?.completed || m.error) continue
      const text = String(m.text || '').trim()
      const key = msgKey(m)
      if (!key || spokenCompleted.has(key)) continue
      spokenCompleted.add(key)
      n += 1
      if (!isAgentTtsSpeakableText(text)) {
        pushTrail({
          key,
          code: String(m.agent_code || ''),
          text,
          at: Date.now(),
          status: 'skipped',
          reason: 'not_speakable',
        })
        continue
      }
      pushTrail({
        key,
        code: String(m.agent_code || ''),
        text,
        at: Date.now(),
        status: 'skipped',
        reason,
      })
    }
    if (spokenCompleted.size > 400) {
      const keep = [...spokenCompleted].slice(-300)
      spokenCompleted.clear()
      for (const k of keep) spokenCompleted.add(k)
    }
    return n
  }

  /** @param {Iterable<string>} keys */
  function markSpokenKeys(keys) {
    for (const k of keys || []) {
      const key = String(k || '').trim()
      if (key) spokenCompleted.add(key)
    }
  }

  function getSpokenKeys() {
    return [...spokenCompleted]
  }

  async function ensureConfigured() {
    // false 也允许再探一次：Gateway 冷启动时首探失败不应永久禁播
    if (configured === true) return true
    try {
      configured = await fetchSpeechConfigured()
    } catch {
      configured = false
    }
    if (!configured) {
      console.warn(`[${logTag}] TTS 未配置，播报不可用`)
    }
    return configured
  }

  /**
   * @param {AgentTtsQueueMsg[]} msgs
   */
  function nextPendingCompleted(msgs) {
    for (const m of msgs) {
      if (!m?.completed || m.error) continue
      const text = String(m.text || '').trim()
      const key = msgKey(m)
      if (spokenCompleted.has(key)) continue
      if (playingKey && key === playingKey) continue
      if (!isAgentTtsSpeakableText(text)) {
        spokenCompleted.add(key)
        pushTrail({
          key,
          code: String(m.agent_code || ''),
          text,
          at: Date.now(),
          status: 'skipped',
          reason: 'not_speakable',
        })
        continue
      }
      return m
    }
    return null
  }

  /**
   * @param {AgentTtsQueueState} st
   * @param {string} afterKey
   */
  function prefetchFollowing(st, afterKey) {
    const msgs = Array.isArray(st.messages) ? st.messages : []
    let passed = !afterKey
    let n = 0
    for (const m of msgs) {
      if (!m?.completed || m.error) continue
      const text = String(m.text || '').trim()
      if (!isAgentTtsSpeakableText(text)) continue
      const key = msgKey(m)
      if (!passed) {
        if (key === afterKey) passed = true
        continue
      }
      if (spokenCompleted.has(key) || key === playingKey) continue
      const code = String(m.agent_code || '').trim()
      if (!code) continue
      const agent = findAgent(st.agents, code)
      const speaker = resolveAgentTtsSpeaker(code, agent)
      const speechRate = readAgentTtsSpeechRate(agent)
      void prefetchAssistantSpeech(
        text,
        speechRate === null ? { speaker } : { speaker, speechRate },
      )
      n += 1
      if (n >= 2) break
    }
  }

  /**
   * @param {AgentTtsQueueState} st
   */
  async function playPendingQueue(st) {
    if (!st?.open || st.muted) return
    if (!(await ensureConfigured())) return
    stopRequested = false

    const msgs = Array.isArray(st.messages) ? st.messages : []

    while (!st.muted && st.open && !stopRequested) {
      if (isSpeechPlaybackBusy()) {
        await waitForSpeechPlaybackIdle({ timeoutMs: 180000 })
        if (_shouldAbort(st)) return
      }

      const liveMsgs = Array.isArray(latestSt?.messages) ? latestSt.messages : st.messages || msgs
      const next = nextPendingCompleted(liveMsgs)
      if (!next) return

      const code = String(next.agent_code || '').trim()
      const text = String(next.text || '').trim()
      const key = msgKey(next)
      if (!code || !text) {
        spokenCompleted.add(key)
        continue
      }

      // playingKey 防重入；成功/永久失败再写入 spoken（瞬时 no-supported 可下一轮重试）
      playingKey = key

      const agent = findAgent(st.agents, code)
      const speaker = resolveAgentTtsSpeaker(code, agent)
      const speechRate = readAgentTtsSpeechRate(agent)
      const playOpts =
        speechRate === null ? { speaker } : { speaker, speechRate }

      setUtterance({ key, code, text })
      prefetchFollowing(latestSt || st, key)

      try {
        console.log(`[${logTag}] play`, code, speaker, speechRate, text.slice(0, 40))
        await playAssistantSpeech(text, playOpts)
        spokenCompleted.add(key)
        transientFails.delete(key)
        if (spokenCompleted.size > 400) {
          const keep = [...spokenCompleted].slice(-300)
          spokenCompleted.clear()
          for (const k of keep) spokenCompleted.add(k)
        }
        if (stopRequested) {
          pushTrail({
            key,
            code,
            text,
            at: Date.now(),
            status: 'stopped',
            reason: 'user_stop',
          })
        } else {
          await waitForSpeechPlaybackIdle({ timeoutMs: 30000 })
          await new Promise((r) => setTimeout(r, 220))
          pushTrail({
            key,
            code,
            text,
            at: Date.now(),
            status: 'played',
          })
        }
      } catch (e) {
        const reason = String(/** @type {any} */ (e)?.message || e || 'error')
        const transient =
          /** @type {any} */ (e)?.name === 'NotSupportedError' ||
          /no supported sources/i.test(reason)
        console.warn(`[${logTag}] play failed`, e)
        let willRetry = false
        if (transient) {
          const n = (transientFails.get(key) || 0) + 1
          if (n > TRANSIENT_RETRY_MAX) {
            spokenCompleted.add(key)
            transientFails.delete(key)
          } else {
            transientFails.set(key, n)
            willRetry = true
          }
        } else {
          // 永久失败占 spoken，避免同一句死磕
          spokenCompleted.add(key)
          transientFails.delete(key)
        }
        pushTrail({
          key,
          code,
          text,
          at: Date.now(),
          status: 'failed',
          reason,
        })
        if (willRetry) {
          await new Promise((r) => setTimeout(r, 400))
        }
      } finally {
        if (playingKey === key) playingKey = ''
        if (utterance?.key === key) setUtterance(null)
      }

      if (stopRequested) return

      if (latestSt) {
        st = latestSt
        latestSt = null
        prefetchFollowing(st, '')
      }
    }
  }

  /** @param {AgentTtsQueueState} st */
  function _shouldAbort(st) {
    return !!(st.muted || !st.open || stopRequested)
  }

  async function pump() {
    if (pumpRunning) return
    pumpRunning = true
    try {
      while (latestSt) {
        const st = latestSt
        latestSt = null
        if (!st?.open) {
          stop()
          continue
        }
        if (st.muted) {
          setUtterance(null)
          continue
        }
        prefetchFollowing(st, playingKey || '')
        await playPendingQueue(st)
      }
    } catch (e) {
      console.warn(`[${logTag}] pump error`, e)
    } finally {
      pumpRunning = false
      if (latestSt && !latestSt.muted && !stopRequested) void pump()
    }
  }

  /**
   * @param {AgentTtsQueueState} st
   */
  function sync(st) {
    latestSt = st
    stopRequested = false
    if (!st?.open) {
      stop()
      return Promise.resolve()
    }
    if (st.muted) {
      setUtterance(null)
      return Promise.resolve()
    }
    prefetchFollowing(st, playingKey || '')
    return pump()
  }

  return {
    sync,
    stop,
    reset,
    seedSpoken,
    markSpokenKeys,
    getSpokenKeys,
    msgKey,
    getUtterance,
    subscribeUtterance,
    unlockPlayback: () => void unlockSpeechPlayback(),
  }
}
