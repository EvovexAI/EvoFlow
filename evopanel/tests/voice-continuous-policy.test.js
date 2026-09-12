/**
 * Voice continuous policy tests — adapted from the legacy voice module test-voice-continuous.js
 * Covers: auto-send timing, noise suppression, barge-in detection, echo learning.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { createContinuousPolicy } from '../src/lib/voice-continuous-policy.js'

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Create a mock harness that simulates the continuous policy deps */
function createHarness() {
  let getTextResult = ''
  let sentText = ''
  let sendCount = 0
  let ducked = false
  let ttsStopped = false
  let unducked = false
  let pttHolding = false

  return {
    // ── Mutable state ──
    setText: (v) => { getTextResult = v },
    setPttHolding: (v) => { pttHolding = v },

    // ── Callbacks tracked ──
    get sentText() { return sentText },
    get sendCount() { return sendCount },
    get ducked() { return ducked },
    get ttsStopped() { return ttsStopped },
    get unducked() { return unducked },

    // ── Deps injected into createContinuousPolicy ──
    getText: () => getTextResult,
    sendText: (text) => { sentText = text; sendCount++ },
    duckTTS: () => { ducked = true },
    unduckTTS: () => { unducked = true },
    stopTTS: () => { ttsStopped = true },
    isPttHolding: () => pttHolding,
  }
}

describe('voice-continuous-policy — auto-send', () => {
  /** @type {ReturnType<typeof createHarness>} */
  let h
  /** @type {ReturnType<typeof createContinuousPolicy>} */
  let policy

  beforeEach(() => {
    h = createHarness()
    policy = createContinuousPolicy({
      getText: h.getText,
      sendText: h.sendText,
      duckTTS: h.duckTTS,
      unduckTTS: h.unduckTTS,
      stopTTS: h.stopTTS,
      isPttHolding: h.isPttHolding,
    })
  })

  it('底噪（相同文本 + 音量）不重置自动发送计时', async () => {
    h.setText('你好')
    policy.onTranscript()
    policy.onFrame(0.08) // below barge-in threshold
    h.setText('你好')
    policy.onTranscript()

    await wait(900) // SILENCE_SEND_MS is 2000 by default, so 900ms should NOT fire

    expect(h.sendCount).toBe(0)
  })

  it('转录文本变更时重置自动发送计时', async () => {
    h.setText('你好')
    policy.onTranscript()

    await wait(500)
    h.setText('你好，小助手')
    policy.onTranscript() // new text → reset timer

    await wait(500)
    expect(h.sendCount).toBe(0) // timer reset, not fired yet

    await wait(1600) // total ~2100ms since last reset > 2000ms
    expect(h.sendCount).toBe(1)
    expect(h.sentText).toBe('你好，小助手')
  })

  it('转录文本到达后等待静默超时才自动发送', async () => {
    h.setText('帮我查一下')
    policy.onTranscript()

    await wait(500)
    expect(h.sendCount).toBe(0)
    // No new transcript → after SILENCE_SEND_MS (2000ms), should fire
    await wait(1600)
    expect(h.sendCount).toBe(1)
  })

  it('PTT 按住期间禁止自动发送', async () => {
    h.setPttHolding(true)
    h.setText('你好')
    policy.onTranscript()

    await wait(2100)
    expect(h.sendCount).toBe(0) // PTT holding, no auto-send
  })
})

describe('voice-continuous-policy — barge-in detection', () => {
  /** @type {ReturnType<typeof createHarness>} */
  let h
  /** @type {ReturnType<typeof createContinuousPolicy>} */
  let policy

  beforeEach(() => {
    h = createHarness()
    policy = createContinuousPolicy({
      getText: h.getText,
      sendText: h.sendText,
      duckTTS: h.duckTTS,
      unduckTTS: h.unduckTTS,
      stopTTS: h.stopTTS,
      isPttHolding: h.isPttHolding,
    })
    policy.onTTSStart()
  })

  it('TTS 播放前 600ms 暖机期内不触发打断', () => {
    // Within BARGEIN_WARMUP_MS (600ms), no barge-in
    for (let i = 0; i < 10; i++) {
      policy.onFrame(0.15) // above BARGEIN_THRESHOLD
    }
    expect(h.ducked).toBe(false)
    expect(h.ttsStopped).toBe(false)
  })

  it('连续 3 帧高振幅进入 Duck 模式', async () => {
    // Need to wait past warmup first
    await wait(650)

    // 3 frames above threshold → duck
    policy.onFrame(0.15)
    policy.onFrame(0.15)
    policy.onFrame(0.15)
    expect(h.ducked).toBe(true)
    expect(h.ttsStopped).toBe(false) // only duck, not stop
  })

  it('Duck 中持续 10 帧高振幅触发真正打断', async () => {
    await wait(650)

    // Enter duck
    for (let i = 0; i < 3; i++) policy.onFrame(0.15)
    expect(h.ducked).toBe(true)

    // Continue high amplitude for 10 more frames in duck → real barge-in
    for (let i = 0; i < 10; i++) policy.onFrame(0.15)
    expect(h.ttsStopped).toBe(true)
  })

  it('Duck 中快速消退判定为噪音 → 恢复音量', async () => {
    await wait(650)

    // Enter duck
    for (let i = 0; i < 3; i++) policy.onFrame(0.15)
    expect(h.ducked).toBe(true)

    // 6 frames of low amplitude → noise, recover
    for (let i = 0; i < 6; i++) policy.onFrame(0.02)
    expect(h.unducked).toBe(true)
  })

  it('背景音量低于阈值不触发打断', async () => {
    await wait(650)
    for (let i = 0; i < 20; i++) policy.onFrame(0.04) // below BARGEIN_THRESHOLD (0.09)
    expect(h.ducked).toBe(false)
  })

  it('TTS 停止后重置状态', async () => {
    await wait(650)

    // Enter duck
    for (let i = 0; i < 3; i++) policy.onFrame(0.15)
    expect(h.ducked).toBe(true)

    // Stop TTS
    policy.onTTSStop()
    expect(policy.ttsActive).toBe(false)

    // After stop, new frames should not trigger anything
    policy.onFrame(0.15)
    expect(h.ttsStopped).toBe(false)
  })
})

describe('voice-continuous-policy — echo learning', () => {
  let h
  let policy

  beforeEach(() => {
    h = createHarness()
    policy = createContinuousPolicy({
      getText: h.getText,
      sendText: h.sendText,
      duckTTS: h.duckTTS,
      unduckTTS: h.unduckTTS,
      stopTTS: h.stopTTS,
      isPttHolding: h.isPttHolding,
    })
  })

  it('TTS 开始后回声基线随背景噪音缓慢上升', async () => {
    policy.onTTSStart()
    await wait(650)

    // Feed consistent mid-level noise — echo baseline should learn this
    for (let i = 0; i < 50; i++) policy.onFrame(0.06)

    // Now a volume just above BARGEIN_THRESHOLD but BELOW echo+margin should NOT trigger
    policy.onFrame(0.10)
    policy.onFrame(0.10)
    policy.onFrame(0.10)
    // Should not duck because echo baseline has been learned
    expect(h.ducked).toBe(false)
  })
})
