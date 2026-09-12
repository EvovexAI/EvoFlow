/**
 * EvoPanel UI 设置：持久化在 SQLite ``evoflow_app_settings``（key ``panel.ui``）。
 * 启动时从 ``GET /api/settings/panel`` 加载；变更走 PATCH。
 */

import { gatewayProxy } from './tauri-api.js'
import { isVoiceReplyEnabled } from './voice-reply-mode.js'

const API_PANEL = '/settings/panel'

export const DEFAULT_PANEL_SETTINGS = {
  theme: 'system',
  useVirtualPaths: false,
  memoryEnabledDefault: true,
  knowledgeMapEnabled: true,
  voiceReplyEnabledDefault: false,
  /** @deprecated 兼容旧客户端；以 voiceReplyEnabledDefault 为准 */
  voiceReplyMode: 'off',
  voiceWakeEnabled: true,
  shellAsideCollapsed: false,
  sidebarCollapsed: false,
  goalProposeAction: 'ask',
  fontSize: 'medium',
  fontScale: 1,
  locale: '',
  lastSelectedModel: '',
  email: {},
  userWorkspaceRoot: '',
  /** 新会话默认项目目录（只影响文件读写，不搬 EVOFLOW_HOME） */
  defaultProjectWorkspaceRoot: '',
  workspaceIndexWatchEnabled: false,
  defaultVisionModel: '',
  keyboardShortcuts: {},
  /** 用户已选择「本版本不再提示」的版本号；匹配时不再弹出更新横幅 */
  dismissedUpdateVersion: '',
  /** 检测到新版本后自动后台下载（不自动安装/重启） */
  autoDownloadUpdates: true,
  /** write 工具右侧流：off | always（默认不自动拉开；incremental-only 兼容为 always） */
  writeStreamMode: 'off',
  /** 强调色色卡：default | blue | cyan | ... | custom */
  accentPalette: 'default',
  /** 自定义强调色（accentPalette === custom） */
  accentCustom: '#6366f1',
  /** 自定义背景图：本地路径 / __local__ / 空=默认 */
  backgroundImage: '',
  /** 背景图不透明度 0.05–1 */
  backgroundOpacity: 0.35,
  /** 液态玻璃：动态流体背景 + 分层磨砂 */
  liquidGlassEnabled: false,
  liquidGlassPreset: 'aurora',
  liquidGlassBlur: 14,
  liquidGlassFlowSpeed: 0.55,
  /** 液态玻璃背景压暗 0–90，提升文字可读性 */
  liquidGlassReadabilityDim: 36,
}

const LS_MIGRATION_FLAG = 'evopanel_panel_settings_migrated_v1'
/** 产品改为默认不自动拉开写入侧栏：旧 always 一次性降为 off */
const LS_WRITE_PREVIEW_OFF_FLAG = 'evopanel_write_stream_default_off_v1'
const LS_ACCENT_PALETTE = 'evopanel-accent-palette'
const LS_ACCENT_CUSTOM = 'evopanel-accent-custom'

/** 静默 PATCH 回写后若这些字段变化，仍需通知外观模块重新应用 */
const APPEARANCE_KEYS = [
  'theme',
  'fontSize',
  'fontScale',
  'accentPalette',
  'accentCustom',
  'backgroundImage',
  'backgroundOpacity',
  'liquidGlassEnabled',
  'liquidGlassPreset',
  'liquidGlassBlur',
  'liquidGlassFlowSpeed',
  'liquidGlassReadabilityDim',
]

/** @type {Record<string, unknown> | null} */
let _cache = null
/** @type {Promise<void> | null} */
let _loadPromise = null
/** 最近一次从服务端加载是否成功（失败时允许后端就绪后重试） */
let _loadFromServerOk = false
/** 加载代次：reload 后丢弃过期的 in-flight 结果 */
let _loadSeq = 0

function appearanceFieldsChanged(prev, next) {
  if (!prev || !next) return true
  return APPEARANCE_KEYS.some((k) => prev[k] !== next[k])
}

function readLegacyLocal() {
  const out = { ...DEFAULT_PANEL_SETTINGS }
  try {
    const theme = localStorage.getItem('evopanel-theme')
    if (theme === 'light' || theme === 'dark' || theme === 'system') out.theme = theme
    const accentPalette = localStorage.getItem(LS_ACCENT_PALETTE)
    if (accentPalette) out.accentPalette = String(accentPalette).trim() || 'default'
    const accentCustom = localStorage.getItem(LS_ACCENT_CUSTOM)
    if (accentCustom) out.accentCustom = String(accentCustom).trim() || DEFAULT_PANEL_SETTINGS.accentCustom
    const vp = localStorage.getItem('evopanel_use_virtual_paths')
    if (vp != null) out.useVirtualPaths = vp !== 'false'
    const mem = localStorage.getItem('evopanel_memory_enabled_default')
    if (mem != null) out.memoryEnabledDefault = mem !== '0' && mem !== 'false'
    if (localStorage.getItem('evopanel_shell_aside_collapsed') === '1') out.shellAsideCollapsed = true
    if (localStorage.getItem('evopanel_sidebar_collapsed') === '1') out.sidebarCollapsed = true
    const goalPropose = localStorage.getItem('evopanel_goal_propose_action')
      || localStorage.getItem('evopanel_hosted_propose_action')
    if (goalPropose) out.goalProposeAction = String(goalPropose).trim() || 'ask'
    const locale = localStorage.getItem('evopanel_lang') || localStorage.getItem('evopanel-locale')
    if (locale) out.locale = String(locale).trim()
    const model = localStorage.getItem('evopanel-chat-selected-model')
    if (model) out.lastSelectedModel = String(model).trim()
    const mailRaw = localStorage.getItem('evopanel-email-config-v1')
    if (mailRaw) {
      try {
        const e = JSON.parse(mailRaw)
        if (e && typeof e === 'object') out.email = e
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return out
}

/** 色卡同步到 localStorage，供冷启动 / 后端未就绪时的早期渲染 */
export function mirrorAccentToLocalStorage(paletteId, customHex) {
  try {
    if (paletteId != null) localStorage.setItem(LS_ACCENT_PALETTE, String(paletteId))
    if (customHex != null) localStorage.setItem(LS_ACCENT_CUSTOM, String(customHex))
  } catch {
    /* ignore */
  }
}

function mergeSettings(base, patch) {
  const next = { ...base, ...(patch || {}) }
  if (patch?.email && typeof patch.email === 'object') {
    next.email = { ...(base.email || {}), ...patch.email }
  }
  return next
}

function normalizePanelSettings(settings) {
  const next = mergeSettings({ ...DEFAULT_PANEL_SETTINGS }, settings || {})
  if (!next.goalProposeAction && next.hostedProposeAction) {
    next.goalProposeAction = next.hostedProposeAction
  }
  delete next.hostedProposeAction
  // 旧 incremental-only：与 always 同属「可自动打开」
  const wsm = String(next.writeStreamMode || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
  if (wsm === 'incremental-only' || wsm === 'incremental' || wsm === 'incrementalonly') {
    next.writeStreamMode = 'always'
  }
  // 语音播报：以布尔为准；旧 voiceReplyMode 仅作兼容推断
  next.voiceReplyEnabledDefault = isVoiceReplyEnabled(
    next.voiceReplyMode,
    next.voiceReplyEnabledDefault,
  )
  next.voiceReplyMode = next.voiceReplyEnabledDefault ? 'always' : 'off'
  return next
}

async function fetchPanelSettings() {
  const data = await gatewayProxy('GET', API_PANEL)
  return normalizePanelSettings(data?.settings || {})
}

async function migrateLocalToServerIfNeeded(serverSettings) {
  if (typeof localStorage === 'undefined') return serverSettings
  if (localStorage.getItem(LS_MIGRATION_FLAG) === '1') return serverSettings
  const legacy = readLegacyLocal()
  const patch = {}
  for (const k of Object.keys(DEFAULT_PANEL_SETTINGS)) {
    if (k === 'email') continue
    if (legacy[k] !== DEFAULT_PANEL_SETTINGS[k] && legacy[k] !== serverSettings[k]) {
      patch[k] = legacy[k]
    }
  }
  if (legacy.email && Object.keys(legacy.email).length) {
    patch.email = legacy.email
  }
  let merged = serverSettings
  if (Object.keys(patch).length) {
    try {
      const data = await gatewayProxy('PATCH', API_PANEL, { settings: patch })
      merged = normalizePanelSettings(data?.settings || {})
    } catch {
      /* keep serverSettings if migration PATCH fails */
    }
  }
  try {
    localStorage.setItem(LS_MIGRATION_FLAG, '1')
  } catch {
    /* ignore */
  }
  return merged
}

/** 启动时调用一次（main.js）；失败后可用 reloadPanelSettings 在后端就绪后重试 */
export function initPanelSettings() {
  if (_loadPromise) return _loadPromise
  const seq = ++_loadSeq
  _loadPromise = (async () => {
    try {
      const data = await gatewayProxy('GET', API_PANEL)
      if (seq !== _loadSeq) return
      const rawMode = String(data?.settings?.writeStreamMode || '')
        .trim()
        .toLowerCase()
        .replace(/_/g, '-')
      let settings = normalizePanelSettings(data?.settings || {})
      settings = await migrateLocalToServerIfNeeded(settings)
      if (seq !== _loadSeq) return
      // 旧版默认 always：一次性改为 off（改文件不再自动拉开侧栏）
      const needOffMigrate =
        typeof localStorage !== 'undefined' &&
        localStorage.getItem(LS_WRITE_PREVIEW_OFF_FLAG) !== '1' &&
        (rawMode === 'always' ||
          rawMode === 'incremental-only' ||
          rawMode === 'incremental' ||
          rawMode === 'incrementalonly' ||
          !rawMode)
      if (needOffMigrate) {
        try {
          const patched = await gatewayProxy('PATCH', API_PANEL, { settings: { writeStreamMode: 'off' } })
          if (seq !== _loadSeq) return
          settings = normalizePanelSettings(patched?.settings || { ...settings, writeStreamMode: 'off' })
        } catch {
          settings = { ...settings, writeStreamMode: 'off' }
        }
        try {
          localStorage.setItem(LS_WRITE_PREVIEW_OFF_FLAG, '1')
        } catch {
          /* ignore */
        }
      }
      _cache = settings
      _loadFromServerOk = true
      try {
        mirrorAccentToLocalStorage(settings.accentPalette, settings.accentCustom)
      } catch {
        /* ignore */
      }
    } catch {
      if (seq !== _loadSeq) return
      _loadFromServerOk = false
      _cache = readLegacyLocal()
      _cache = normalizePanelSettings(_cache)
    }
    if (seq !== _loadSeq) return
    window.dispatchEvent(new CustomEvent('evopanel:panel-settings-loaded', { detail: _cache }))
  })()
  return _loadPromise
}

/** 后端就绪后强制重新拉取；若首次已成功则直接返回 */
export function reloadPanelSettings(opts = {}) {
  const force = !!opts?.force
  if (_loadFromServerOk && !force) return initPanelSettings()
  _loadPromise = null
  _loadFromServerOk = false
  return initPanelSettings()
}

/** 取消未刷出的本地 PATCH，避免 agent 写入后被旧队列覆盖。 */
export function cancelPendingPanelSettingsPatch() {
  if (_patchTimer) {
    clearTimeout(_patchTimer)
    _patchTimer = null
  }
  _patchPending = null
  _patchPendingNonSilent = false
}

/**
 * 远端已写入 panel.ui（如 platform appearance.patch）后，合并到本地缓存并触发外观重应用。
 * 不再 PATCH 回服务端。
 */
export function applyPanelSettingsFromRemote(settings) {
  cancelPendingPanelSettingsPatch()
  if (!settings || typeof settings !== 'object') return getPanelSettingsSync()
  const prev = getPanelSettingsSync()
  _cache = normalizePanelSettings(mergeSettings(prev, settings))
  try {
    mirrorAccentToLocalStorage(_cache.accentPalette, _cache.accentCustom)
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent('evopanel:panel-settings-changed', { detail: _cache }))
  return _cache
}

export function didPanelSettingsLoadFromServer() {
  return _loadFromServerOk
}

export function getPanelSettingsSync() {
  if (_cache) return { ..._cache }
  return readLegacyLocal()
}

export function getPanelSetting(key, fallback = undefined) {
  const s = getPanelSettingsSync()
  if (key === 'goalProposeAction' && !(key in s) && 'hostedProposeAction' in s) {
    return s.hostedProposeAction
  }
  if (key in s) return s[key]
  return fallback !== undefined ? fallback : DEFAULT_PANEL_SETTINGS[key]
}

/**
 * @returns {boolean}
 */
export function getVoiceReplyEnabled() {
  const s = getPanelSettingsSync()
  return isVoiceReplyEnabled(s.voiceReplyMode, s.voiceReplyEnabledDefault)
}

/** @deprecated 使用 getVoiceReplyEnabled */
export function getVoiceReplyMode() {
  return getVoiceReplyEnabled() ? 'always' : 'off'
}

/** @type {Promise<void> | null} */
let _patchFlushPromise = null
/** @type {ReturnType<typeof setTimeout> | null} */
let _patchTimer = null
/** @type {Record<string, unknown> | null} */
let _patchPending = null
let _patchPendingNonSilent = false
const PATCH_DEBOUNCE_MS = 400

async function flushPanelSettingsPatch() {
  const patch = _patchPending
  const shouldDispatch = _patchPendingNonSilent
  _patchPending = null
  _patchPendingNonSilent = false
  _patchTimer = null
  if (!patch || !Object.keys(patch).length) return
  const before = _cache ? { ..._cache } : null
  try {
    const data = await gatewayProxy('PATCH', API_PANEL, { settings: patch })
    _cache = normalizePanelSettings(data?.settings || _cache)
    // 静默 PATCH（如侧栏折叠）也会带回完整 panel.ui；若外观字段相对乐观缓存有变，
    // 必须通知主题/色卡重新应用，否则会出现「设置里是对的色，界面仍是默认皮」
    if (shouldDispatch || appearanceFieldsChanged(before, _cache)) {
      window.dispatchEvent(new CustomEvent('evopanel:panel-settings-changed', { detail: _cache }))
    }
  } catch {
    /* keep optimistic cache */
  }
}

/** 页面关闭前尽量刷出未完成的 PATCH，避免刚改色卡就重启丢写 */
export function flushPanelSettingsNow() {
  if (_patchTimer) {
    clearTimeout(_patchTimer)
    _patchTimer = null
  }
  if (!_patchPending || !Object.keys(_patchPending).length) {
    return _patchFlushPromise || Promise.resolve()
  }
  _patchFlushPromise = flushPanelSettingsPatch().finally(() => {
    _patchFlushPromise = null
  })
  return _patchFlushPromise
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    void flushPanelSettingsNow()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushPanelSettingsNow()
  })
}

function schedulePanelSettingsPatch(patch, silent) {
  _patchPending = mergeSettings(_patchPending || {}, patch)
  if (!silent) _patchPendingNonSilent = true
  if (_patchTimer) clearTimeout(_patchTimer)
  _patchTimer = setTimeout(() => {
    _patchFlushPromise = flushPanelSettingsPatch().finally(() => {
      _patchFlushPromise = null
    })
  }, PATCH_DEBOUNCE_MS)
}

export async function patchPanelSettings(patch, opts) {
  const silent = !!opts?.silent
  if (!patch || typeof patch !== 'object') return getPanelSettingsSync()
  const prev = getPanelSettingsSync()
  const optimistic = mergeSettings(prev, patch)
  _cache = optimistic
  if (!silent) {
    window.dispatchEvent(new CustomEvent('evopanel:panel-settings-changed', { detail: _cache }))
  }
  schedulePanelSettingsPatch(patch, silent)
  return _cache
}
