/**
 * 统一读取调试开关（``EVOFLOW_DEBUG_*`` / ``evoflow-*-debug``），**默认全关**。
 *
 * 这些开关标的都是"每次请求 / 每帧 / 每个 chunk 打一行"的高频追踪日志。它们在开发时有用，
 * 但在正常使用中会把控制台刷爆，桌面端还会被 `console-file-log.js` 镜像进
 * `~/.evoflow/logs/frontend-*.log`，把日志文件一起撑大。
 *
 * 语义：
 *   - 只有显式写成 ``1`` / ``true`` / ``on`` / ``yes`` 才算打开；``0`` / ``false`` /
 *     ``off`` / ``no`` / 空字符串 / 缺省一律视为关。
 *   - 结果按 flag 名缓存（热路径不该每次都读 localStorage），``storage`` 事件会让缓存失效，
 *     所以在 DevTools 里改完开关**不用刷新**就能生效。
 *   - 单个 flag 读失败（隐私模式、SSR）当作关闭，不抛。
 *
 * 用法：
 *   import { isDebugOn } from './debug-flag.js'
 *   if (isDebugOn('EVOFLOW_DEBUG_SPEECH')) console.log('...')
 */

/** @type {Map<string, boolean>} */
const _cache = new Map()

const _TRUTHY = new Set(['1', 'true', 'on', 'yes', 'enabled'])
const _FALSY = new Set(['', '0', 'false', 'off', 'no', 'disabled', 'none', 'null', 'undefined'])

function _read(flag) {
  if (typeof localStorage === 'undefined') return false
  const raw = localStorage.getItem(flag)
  if (raw == null) return false
  const v = String(raw).trim().toLowerCase()
  if (_TRUTHY.has(v)) return true
  if (_FALSY.has(v)) return false
  // 未知取值保守处理：只把明显的真值当开，避免手滑写了个词就全量打日志。
  return false
}

/**
 * 调试开关是否打开。
 * @param {string} flag localStorage key，例如 ``EVOFLOW_DEBUG_SPEECH``
 * @returns {boolean}
 */
export function isDebugOn(flag) {
  const key = String(flag || '')
  if (!key) return false
  const cached = _cache.get(key)
  if (cached !== undefined) return cached
  let on = false
  try {
    on = _read(key)
  } catch {
    on = false
  }
  _cache.set(key, on)
  return on
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  // 其它标签页 / DevTools 改了开关 → 清缓存，下次调用即生效。
  window.addEventListener('storage', (e) => {
    if (e && e.key) _cache.delete(e.key)
    else _cache.clear()
  })
}

/** 仅供测试：清空开关缓存。 */
export function __resetDebugFlagCacheForTest() {
  _cache.clear()
}
