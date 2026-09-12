/**
 * 无麦克风时的语音 HUD 演示模式（模拟频谱 + 假识别文字）。
 */

/** @type {boolean} */
let demoActive = false
/** @type {ReturnType<typeof setInterval> | null} */
let demoTimer = null
let demoTick = 0

const DEMO_LINES = [
  '',
  '你',
  '你好',
  '你好，',
  '你好，帮我',
  '你好，帮我整理',
  '你好，帮我整理会议纪要',
]

/**
 * @param {{ onPartial?: (text: string) => void, onLevel?: (levels: number[]) => void }} [opts]
 */
export function startVoiceDemo(opts = {}) {
  stopVoiceDemo()
  demoActive = true
  demoTick = 0
  const onPartial = typeof opts.onPartial === 'function' ? opts.onPartial : null
  const onLevel = typeof opts.onLevel === 'function' ? opts.onLevel : null

  onPartial?.('演示模式 · 无麦克风')
  onLevel?.(makeDemoLevels(0))

  demoTimer = setInterval(() => {
    if (!demoActive) return
    demoTick += 1
    const phase = demoTick * 0.05
    onLevel?.(makeDemoLevels(phase))

    const lineIdx = Math.min(DEMO_LINES.length - 1, Math.floor(demoTick / 18))
    const line = DEMO_LINES[lineIdx]
    if (line) {
      onPartial?.(line)
    } else if (demoTick < 12) {
      onPartial?.('演示模式 · 无麦克风')
    }
  }, 33)
}

/** @param {number} phase */
export function makeDemoLevels(phase) {
  const barCount = 24
  const talk = Math.max(0, Math.sin(phase * 2.2) * 0.85 + 0.15)
  const burst = 0.65 + 0.35 * Math.sin(phase * 0.55)
  const swell = 0.5 + 0.5 * Math.sin(phase * 0.9 + 1.2)
  const levels = []
  for (let i = 0; i < barCount; i++) {
    const wave = Math.max(0, 0.35 + 0.65 * Math.sin(i * 0.55 + phase * 4.2))
    const ripple = Math.max(0, 0.4 + 0.6 * Math.sin(i * 0.28 - phase * 2.8))
    const spike = i % 5 === 0 ? 1.2 : 1
    levels.push(Math.min(1, talk * burst * swell * wave * ripple * spike * 0.95))
  }
  return levels
}

export function isVoiceDemoActive() {
  return demoActive
}

export function stopVoiceDemo() {
  demoActive = false
  if (demoTimer) {
    clearInterval(demoTimer)
    demoTimer = null
  }
  demoTick = 0
}

/** 演示模式松开后的示例识别结果 */
export function demoTranscriptResult() {
  return DEMO_LINES[DEMO_LINES.length - 1]
}
