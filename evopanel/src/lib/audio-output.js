/**
 * Audio output auto-routing for TTS playback.
 * Detects virtual audio devices (Steam, NVIDIA, VB-Audio, etc.) and automatically
 * routes TTS to the best available real hardware device, preventing "plays but can't hear" bugs.
 *
 * Adapted from the legacy voice module audio-output.js, adapted for EvoFlow speech-client architecture.
 */

// ── Virtual device name patterns (Steam, NVIDIA, VB-Audio, Oculus, etc.) ──
const VIRTUAL_PATTERNS = [
  /steam\s*stream/i,
  /steam/i,
  /nvidia\s*broadcast/i,
  /nvidia/i,
  /vb-audio/i,
  /vb\s*cable/i,
  /voicemeeter/i,
  /pico\s*vr/i,
  /oculus/i,
  /meta\s*quest/i,
  /virtual\s*(audio|cable|output|device|speaker)/i,
  /cable\s*input/i,
  /soundflower/i,
  /blackhole/i,
  /loopback/i,
  /capture/i,
  /screaming\s*be/i,
  /sonar/i,
  /wave\s*link/i,
  /elgato/i,
  /goXLR/i,
]

const REAL_HARDWARE_PATTERNS = [
  /realtek/i,
  /speakers?/i,
  /headphones?/i,
  /headset/i,
  /(主板|内置|扬声器|耳机)/i,
]

/**
 * Score an audio output device. Higher = more likely to be a real hardware device.
 * Real hardware speakers/headphones get high scores; virtual devices get negative scores.
 */
function scoreDevice(label) {
  const s = String(label || '').trim()
  if (!s) return 0

  // Virtual device penalties
  for (const pat of VIRTUAL_PATTERNS) {
    if (pat.test(s)) return -100
  }

  let score = 0

  // Real hardware bonuses
  for (const pat of REAL_HARDWARE_PATTERNS) {
    if (pat.test(s)) score += 20
  }

  // Default device hint from browser
  if (/default/i.test(s)) score += 10

  // "Communications" devices tend to be headset mics, not speakers
  if (/communications?/i.test(s)) score -= 5

  // Digital output (S/PDIF) is usually a real device
  if (/digital/i.test(s)) score += 5

  return score
}

/** @type {string | null} Cached best device ID */
let _bestDeviceId = null
/** @type {string | null} System default device ID (tracked for change detection) */
let _systemDefaultId = null
/** @type {boolean} Whether auto-routing is active */
let _routingActive = false
/** @type {((msg: string) => void) | null} Callback when virtual device is detected as default */
let _onVirtualDefaultCb = null
/** @type {number} Debounce timer for device change handler */
let _deviceChangeTimer = null

const DEVICE_CHANGE_DEBOUNCE_MS = 250

/**
 * Enumerate all audio output devices and pick the best real hardware device.
 * @returns {Promise<{ systemDefaultId: string | null, bestDeviceId: string | null, deviceCount: number, isVirtualDefault: boolean }>}
 */
export async function refreshAudioDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return { systemDefaultId: null, bestDeviceId: null, deviceCount: 0, isVirtualDefault: false }
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const outputs = devices.filter((d) => d.kind === 'audiooutput' && d.deviceId)

    if (!outputs.length) {
      return { systemDefaultId: null, bestDeviceId: null, deviceCount: 0, isVirtualDefault: false }
    }

    // The first audiooutput is usually the system default
    const systemDefault = outputs[0]
    _systemDefaultId = systemDefault.deviceId
    const isVirtualDefault = scoreDevice(systemDefault.label) < 0

    // Find the best real device
    let best = systemDefault
    let bestScore = scoreDevice(systemDefault.label)

    for (const d of outputs) {
      const s = scoreDevice(d.label)
      if (s > bestScore) {
        bestScore = s
        best = d
      }
    }

    if (bestScore > 0 && best.deviceId !== _bestDeviceId) {
      _bestDeviceId = best.deviceId
    } else if (bestScore <= 0) {
      _bestDeviceId = null
    }

    return {
      systemDefaultId: systemDefault.deviceId,
      bestDeviceId: _bestDeviceId,
      deviceCount: outputs.length,
      isVirtualDefault,
    }
  } catch (e) {
    console.warn('[audio-output] enumerate devices failed', e)
    return { systemDefaultId: null, bestDeviceId: null, deviceCount: 0, isVirtualDefault: false }
  }
}

/**
 * Apply the best available audio output device to an HTML Audio element.
 * Should be called before audio.play() to ensure correct routing.
 *
 * Only remaps sink when the **system default** looks like a virtual device
 * (Steam/VB-Cable/etc.). Otherwise keep the browser default — forcing another
 * "high score" device (unused HDMI / onboard speakers) causes silent TTS while
 * the user listens on their real default (e.g. Bluetooth headset).
 *
 * @param {HTMLAudioElement} audio
 * @returns {Promise<boolean>} true if routing was applied
 */
export async function routeAudioOutput(audio) {
  if (!audio || !audio.setSinkId) return false

  const info = await refreshAudioDevices()
  if (!info.isVirtualDefault) {
    // Trust OS/browser default — do not call setSinkId.
    return false
  }

  const targetId = info.bestDeviceId
  if (!targetId || targetId === info.systemDefaultId) {
    console.warn('[audio-output] default is virtual but no better sink found')
    return false
  }

  try {
    await audio.setSinkId(targetId)
    console.log('[audio-output] rerouted TTS from virtual default to', targetId)
    return true
  } catch (e) {
    console.warn('[audio-output] setSinkId failed', e?.message || e)
    _bestDeviceId = null
    return false
  }
}

/**
 * Initialize auto-routing and register device change listener.
 * @param {{ onVirtualDefault?: (msg: string) => void }} [opts]
 */
export async function initAudioRouting(opts = {}) {
  if (_routingActive) return
  _routingActive = true

  if (opts.onVirtualDefault) _onVirtualDefaultCb = opts.onVirtualDefault

  const { isVirtualDefault } = await refreshAudioDevices()

  if (isVirtualDefault && _onVirtualDefaultCb) {
    _onVirtualDefaultCb('检测到默认音频输出为虚拟设备，语音播报可能无声。点击切换至真实扬声器。')
  }

  // Listen for device changes (hot-plug / Bluetooth connect)
  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      if (_deviceChangeTimer) clearTimeout(_deviceChangeTimer)
      _deviceChangeTimer = setTimeout(() => {
        void refreshAudioDevices()
      }, DEVICE_CHANGE_DEBOUNCE_MS)
    })
  } else if (navigator.mediaDevices?.ondevicechange !== undefined) {
    navigator.mediaDevices.ondevicechange = () => {
      if (_deviceChangeTimer) clearTimeout(_deviceChangeTimer)
      _deviceChangeTimer = setTimeout(() => {
        void refreshAudioDevices()
      }, DEVICE_CHANGE_DEBOUNCE_MS)
    }
  }
}

/**
 * Get the currently selected best device ID for UI display.
 */
export function getBestDeviceId() {
  return _bestDeviceId
}

/**
 * Force route to a specific device ID (user manually picks from UI).
 * @param {string} deviceId
 */
export async function forceRouteToDevice(deviceId) {
  _bestDeviceId = deviceId
}

/**
 * Stop auto-routing (cleanup).
 */
export function stopAudioRouting() {
  _routingActive = false
  _onVirtualDefaultCb = null
  if (_deviceChangeTimer) {
    clearTimeout(_deviceChangeTimer)
    _deviceChangeTimer = null
  }
}
