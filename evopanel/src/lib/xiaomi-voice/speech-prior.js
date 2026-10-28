/**
 * Lightweight client speech prior for Frame soft-barge gating.
 * No WASM / no deps: RMS + ZCR + mid-band energy ratio (≈300–3400 Hz).
 */

const DEFAULT_SAMPLE_RATE = 16000

/** Consecutive ok frames before isSpeechPriorHot() */
const HOT_STREAK = 2

/** RMS floor — below this is silence / tiny noise */
const RMS_MIN = 0.012

/** Peak floor — align with local barge energy scale */
const PEAK_MIN = 0.04

/**
 * ZCR (zero-crossings / sample). Speech typically mid-range;
 * very low ≈ hum/boom, very high ≈ hiss/clicks.
 */
const ZCR_MIN = 0.02
const ZCR_MAX = 0.35

/** Mid-band (≈300–3400 Hz) energy / total; speech usually significant mid */
const MID_RATIO_MIN = 0.22

let _streak = 0
/** @type {{ ok: boolean, score: number, zcr: number, rms: number, midRatio: number, peak: number }} */
let _last = { ok: false, score: 0, zcr: 0, rms: 0, midRatio: 0, peak: 0 }

/**
 * One-pole LPF coeff for cutoff Hz at sampleRate.
 * @param {number} cutoffHz
 * @param {number} sampleRate
 */
function _lpAlpha(cutoffHz, sampleRate) {
  const x = Math.exp((-2 * Math.PI * cutoffHz) / sampleRate)
  return Number.isFinite(x) ? x : 0.9
}

/**
 * @param {Float32Array | ArrayLike<number>} samples
 * @param {number} [sampleRate=16000]
 * @returns {{ ok: boolean, score: number, zcr: number, rms: number, midRatio: number, peak: number }}
 */
export function updateSpeechPrior(samples, sampleRate = DEFAULT_SAMPLE_RATE) {
  const n = samples?.length || 0
  if (!n) {
    _streak = 0
    _last = { ok: false, score: 0, zcr: 0, rms: 0, midRatio: 0, peak: 0 }
    return _last
  }

  const a300 = _lpAlpha(300, sampleRate)
  const a3400 = _lpAlpha(3400, sampleRate)
  let lp300 = 0
  let lp3400 = 0
  let sumSq = 0
  let midSq = 0
  let peak = 0
  let zc = 0
  let prev = samples[0]

  for (let i = 0; i < n; i++) {
    const x = Number(samples[i]) || 0
    const ax = Math.abs(x)
    if (ax > peak) peak = ax
    sumSq += x * x
    lp300 = a300 * lp300 + (1 - a300) * x
    lp3400 = a3400 * lp3400 + (1 - a3400) * x
    const mid = lp3400 - lp300
    midSq += mid * mid
    if (i > 0 && ((prev >= 0 && x < 0) || (prev < 0 && x >= 0))) zc += 1
    prev = x
  }

  const rms = Math.sqrt(sumSq / n)
  const zcr = zc / n
  const midRatio = sumSq > 1e-12 ? midSq / sumSq : 0

  const energyOk = rms >= RMS_MIN && peak >= PEAK_MIN
  const zcrOk = zcr >= ZCR_MIN && zcr <= ZCR_MAX
  const midOk = midRatio >= MID_RATIO_MIN
  const ok = energyOk && zcrOk && midOk

  // Soft score 0–1 for logs (not a hard threshold itself)
  const rmsPart = Math.min(1, rms / 0.08)
  const peakPart = Math.min(1, peak / 0.2)
  const zcrPart = zcrOk ? 1 : Math.max(0, 1 - Math.abs(zcr - 0.12) / 0.25)
  const midPart = Math.min(1, midRatio / 0.5)
  const score = Math.max(0, Math.min(1, 0.3 * rmsPart + 0.25 * peakPart + 0.2 * zcrPart + 0.25 * midPart))

  if (ok) _streak += 1
  else _streak = 0

  _last = { ok, score, zcr, rms, midRatio, peak }
  return _last
}

/** True when enough consecutive frames looked like speech. */
export function isSpeechPriorHot() {
  return _streak >= HOT_STREAK
}

export function getSpeechPriorDebug() {
  return { ..._last, streak: _streak, hot: isSpeechPriorHot() }
}

export function resetSpeechPrior() {
  _streak = 0
  _last = { ok: false, score: 0, zcr: 0, rms: 0, midRatio: 0, peak: 0 }
}
