/**
 * 设置：外观 / 主题（本版本不暴露未接入面板的代理、npm 源等项）
 */
import { toast } from '../components/toast.js'
import { showChoice, showConfirm } from '../components/modal.js'
import { getThemePreference, setThemePreference } from '../lib/theme.js'
import { FONT_SIZE_EVENT, getFontScalePreference, previewFontScale, setFontScalePreference } from '../lib/font-size.js'
import {
  ACCENT_PALETTES,
  ACCENT_THEME_EVENT,
  applyAccentThemePreference,
  getAccentCustomPreference,
  getAccentPalettePreference,
  setAccentCustomPreference,
  setAccentPalettePreference,
  previewAccentCustom,
} from '../lib/accent-theme.js'
import {
  BACKGROUND_EVENT,
  applyBackgroundPreference,
  clearBackgroundImagePreference,
  getBackgroundImagePreference,
  getBackgroundOpacityPreference,
  hasCustomBackground,
  isVideoBackgroundPreference,
  isVideoMediaUrl,
  previewBackgroundOpacity,
  resolveBackgroundImageUrl,
  setBackgroundMediaFromBlob,
  setBackgroundOpacityPreference,
} from '../lib/appearance-background.js'
import {
  LIQUID_GLASS_EVENT,
  LIQUID_GLASS_PRESETS,
  getLiquidGlassBlurPreference,
  getLiquidGlassEnabled,
  getLiquidGlassFlowSpeedPreference,
  getLiquidGlassPresetPreference,
  getLiquidGlassReadabilityDimPreference,
  previewLiquidGlassBlur,
  previewLiquidGlassReadabilityDim,
  setLiquidGlassBlurPreference,
  setLiquidGlassEnabled,
  setLiquidGlassFlowSpeedPreference,
  setLiquidGlassPresetPreference,
  setLiquidGlassReadabilityDimPreference,
  MIN_LIQUID_GLASS_BLUR,
  MAX_LIQUID_GLASS_BLUR,
  MIN_LIQUID_GLASS_FLOW,
  MAX_LIQUID_GLASS_FLOW,
  MIN_LIQUID_GLASS_READABILITY_DIM,
  MAX_LIQUID_GLASS_READABILITY_DIM,
} from '../lib/liquid-glass/index.js'
import { getUseVirtualPaths, setUseVirtualPaths } from '../lib/path-mode.js'
import { getPanelSetting, patchPanelSettings } from '../lib/panel-settings.js'
import { api } from '../lib/tauri-api.js'
import { mountEnvContentInto, cleanup as cleanupEnv } from './settings/env.js'
import {
  formatShortcutDisplay,
  getShortcutBinding,
} from '../lib/keyboard-shortcuts.js'

const THEME_PREF_EVENT = 'evopanel-theme-pref-changed'

function isTauriDesktop() {
  return !!(window.__TAURI_INTERNALS__ || window.__TAURI__)
}

function clearLocalChatCachesForWorkspaceSwitch() {
  const keys = [
    // ws-client
    'evoflow-chat-session-map-v1',
    'evopanel_workspace_history_by_session_v1',
    'evopanel_workspace_history_global_v1',
    'evopanel_local_workspace_root',
    'evopanel_local_workspace_history',
    // ChatApp
    'evopanel-chat-session-meta',
    'evopanel-chat-session-names',
    'evopanel-chat-selected-session',
    // legacy
    'evopanel-chat-session-names',
  ]
  for (const k of keys) {
    try { localStorage.removeItem(k) } catch { /* ignore */ }
  }
  try { sessionStorage.removeItem('evopanel_shell_sidebar_sync') } catch { /* ignore */ }
}

let _themeListener = null
let _panelSettingsListener = null

export function cleanup() {
  if (_themeListener) {
    window.removeEventListener(THEME_PREF_EVENT, _themeListener)
    window.removeEventListener(FONT_SIZE_EVENT, _themeListener)
    window.removeEventListener(ACCENT_THEME_EVENT, _themeListener)
    window.removeEventListener(BACKGROUND_EVENT, _themeListener)
    window.removeEventListener(LIQUID_GLASS_EVENT, _themeListener)
    _themeListener = null
  }
  if (_panelSettingsListener) {
    window.removeEventListener('evopanel:panel-settings-loaded', _panelSettingsListener)
    window.removeEventListener('evopanel:panel-settings-changed', _panelSettingsListener)
    _panelSettingsListener = null
  }
  cleanupEnv()
}

const GENERAL_INNER_HTML = `
  <div class="settings-group">
    <div class="settings-group-header">
      <div class="settings-group-title">外观与显示</div>
      <div class="settings-group-desc">主题、色卡、背景图与字体大小，立即应用到整个客户端</div>
    </div>
    <div class="config-section">
      <div class="config-section-title">外观</div>
      <div id="general-appearance-bar"><div class="stat-card loading-placeholder" style="height:44px"></div></div>
    </div>
    <div class="config-section">
      <div class="config-section-title">小V 悬浮球</div>
      <label class="switch-row">
        <span class="switch-label">显示小V 悬浮球</span>
        <input id="general-xiaomi-fab-toggle" type="checkbox" />
        <span class="switch-slider"></span>
      </label>
      <p class="form-hint">关闭后右下角紫色 V 球会隐藏。可随时在此重新打开，或按 Ctrl+Shift+M（可在「快捷键」页修改）。</p>
    </div>
  </div>

  <div class="settings-group">
    <div class="settings-group-header">
      <div class="settings-group-title">智能体行为</div>
      <div class="settings-group-desc">记忆、思维导图与视觉模型的默认策略</div>
    </div>
    <div class="config-section">
      <div class="config-section-title">记忆与上下文</div>
      <label class="switch-row">
        <span class="switch-label">默认启用记忆</span>
        <input id="general-memory-default-toggle" type="checkbox" />
        <span class="switch-slider"></span>
      </label>
      <p class="form-hint">关闭后，新会话仍可在聊天输入栏旁单独打开记忆；已打开会话的开关存在本机会话列表中。</p>
    </div>
    <div class="config-section">
      <div class="config-section-title">思维导图</div>
      <label class="switch-row">
        <span class="switch-label">启用思维导图</span>
        <input id="general-knowledge-map-toggle" type="checkbox" />
        <span class="switch-slider"></span>
      </label>
      <p class="form-hint">开启后，智能体会随任务进展整理思维导图，聊天页可查看；关闭后不再自动维护，顶栏入口也会隐藏。已有导图会保留，重新开启后可继续查看。</p>
    </div>
    <div class="config-section">
      <div class="config-section-title">默认视觉识别模型</div>
      <div id="general-vision-model-row"><div class="stat-card loading-placeholder" style="height:44px"></div></div>
      <p class="form-hint">当当前会话模型不支持视觉（图片识别）时，图片分析工具将自动使用此处选择的模型。请先在「模型」页配置并开启模型的视觉能力。</p>
    </div>
  </div>

  <div class="settings-group">
    <div class="settings-group-header">
      <div class="settings-group-title">文件与工作空间</div>
      <div class="settings-group-desc">文件系统模式与数据目录配置</div>
    </div>
    <div class="config-section">
      <div class="config-section-title">文件系统模式</div>
      <label class="switch-row">
        <span class="switch-label">启用虚拟/沙箱路径（/mnt/user-data）</span>
        <input id="general-virtual-path-toggle" type="checkbox" />
        <span class="switch-slider"></span>
      </label>
      <p class="form-hint">关闭后，智能体会优先使用你本机路径和当前终端语法（例如 Windows PowerShell）。</p>
    </div>
    <div class="config-section">
      <div class="config-section-title">默认项目目录</div>
      <div class="general-data-workspace-row">
        <input id="general-default-project-root" class="cron-input general-data-workspace-input" placeholder="留空 = 未绑定时写到应用数据目录；例如：D:\\work\\my-project" />
        <button type="button" class="cron-btn general-data-workspace-pick-btn" id="general-default-project-pick">选择目录</button>
      </div>
      <p class="form-hint">
        新对话若未单独绑定工作空间，将默认在此目录读写文件。<strong>不会</strong>更换模型配置或会话库。
        也可随时在聊天页底部「工作空间」切换。
      </p>
    </div>
    <div class="config-section">
      <div class="config-section-title">当前生效的应用数据目录</div>
      <div class="general-runtime-data-row" id="general-runtime-data-flash">
        <code id="general-runtime-data-dir" class="general-runtime-data-path">加载中…</code>
        <button type="button" class="cron-btn sm" id="general-runtime-data-copy" title="复制路径">复制</button>
        <button type="button" class="cron-btn sm" id="general-runtime-data-open" title="在访达 / 资源管理器中打开">打开</button>
      </div>
      <p class="form-hint" id="general-data-path-compare">对照：配置根（configuredRoot）与运行时数据目录（runtimeDataDir）如下。</p>
      <p class="form-hint">未绑定项目目录、也未设「默认项目目录」时，AI 产出默认写在这里（Mac 上为隐藏目录，可用「打开」直接进入）。</p>
    </div>
    <div class="config-section">
      <div class="config-section-title">用户数据目录（应用数据根 · 高级/搬家）</div>
      <div class="general-data-workspace-row">
        <input id="general-data-workspace-root" class="cron-input general-data-workspace-input" placeholder="留空 = 默认 ~/.evoflow；例如：/Users/你/evo-data" />
        <button type="button" class="cron-btn general-data-workspace-pick-btn" id="general-data-workspace-pick">选择目录</button>
      </div>
      <p class="form-hint general-data-mismatch" id="general-data-mismatch" hidden></p>
      <p class="form-hint">
        这不是「项目文件夹」。填写并<strong>应用</strong>后会在该目录下使用 <code>data/</code> 作为应用数据根；
        默认会把当前会话/模型/智能体等<strong>复制迁移</strong>过去（旧目录保留）。也可选「仅切换」从空库开始。
        日常只需指定 AI 读写的文件夹时，请用上方「默认项目目录」或聊天页底部「工作空间」。
      </p>
    </div>
  </div>

  <div class="settings-group">
    <div class="settings-group-header">
      <div class="settings-group-title">维护</div>
      <div class="settings-group-desc">缓存清理与故障恢复</div>
    </div>
    <div class="config-section">
      <div class="config-section-title">缓存清理</div>
      <p class="form-hint">当对话记录过多导致页面卡顿/无响应时，可以清理本地缓存并重载。</p>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px">
        <button type="button" class="cron-btn sm danger" id="general-clear-chat-cache">
          清理对话缓存并重载
        </button>
      </div>
    </div>
  </div>
`

/** 嵌入设置中心等容器（不含外层 .page） */
export async function mountGeneralInto(container) {
  cleanup()
  container.classList.add('settings-modal-pane--general')
  container.innerHTML = GENERAL_INNER_HTML
  const root = container
  _themeListener = () => renderAppearanceBar(root)
  window.addEventListener(THEME_PREF_EVENT, _themeListener)
  window.addEventListener(FONT_SIZE_EVENT, _themeListener)
  window.addEventListener(ACCENT_THEME_EVENT, _themeListener)
  window.addEventListener(BACKGROUND_EVENT, _themeListener)
  window.addEventListener(LIQUID_GLASS_EVENT, _themeListener)
  _panelSettingsListener = () => {
    renderPathMode(root)
    renderMemoryDefaultToggle(root)
    renderKnowledgeMapToggle(root)
  }
  window.addEventListener('evopanel:panel-settings-loaded', _panelSettingsListener)
  window.addEventListener('evopanel:panel-settings-changed', _panelSettingsListener)
  renderAppearanceBar(root)
  // 打开设置时自愈：若启动阶段色卡未应用到 DOM，按当前缓存再刷一次
  applyAccentThemePreference()
  applyBackgroundPreference()
  renderPathMode(root)
  renderMemoryDefaultToggle(root)
  renderKnowledgeMapToggle(root)
  void renderXiaomiFabToggle(root)
  void renderVisionModelSelector(root)
  await renderDataWorkspaceSettings(root)
  const envHost = root.querySelector('#general-env-content')
  if (envHost) {
    await mountEnvContentInto(envHost)
  }
  root.addEventListener('click', (e) => {
    const target = e.target
    if (!(target instanceof Element)) return
    if (target.closest('#general-clear-chat-cache')) {
      void handleEmergencyChatCleanup()
      return
    }
    if (target.closest('#general-data-workspace-pick')) {
      void pickDataWorkspaceRoot(root)
      return
    }
    if (target.closest('#general-default-project-pick')) {
      void pickDefaultProjectRoot(root)
      return
    }
    if (target.closest('#general-runtime-data-copy')) {
      void copyRuntimeDataDir(root)
      return
    }
    if (target.closest('#general-runtime-data-open')) {
      void openRuntimeDataDir(root)
      return
    }
    const themeBtn = target.closest('[data-action="set-theme-pref"]')
    if (themeBtn) {
      const pref = themeBtn.dataset.themePref
      if (pref === 'light' || pref === 'dark' || pref === 'system') {
        setThemePreference(pref)
        renderAppearanceBar(root)
        toast('外观已保存', 'success')
      }
      return
    }
    const accentBtn = target.closest('[data-action="set-accent-palette"]')
    if (accentBtn) {
      const id = String(accentBtn.dataset.accentPalette || 'default')
      setAccentPalettePreference(id)
      renderAppearanceBar(root)
      toast('色卡已保存', 'success')
      return
    }
    if (target.closest('[data-action="pick-background-image"]')) {
      void pickBackgroundImage(root)
      return
    }
    if (target.closest('[data-action="clear-background-image"]')) {
      clearBackgroundImagePreference()
      renderAppearanceBar(root)
      toast('已恢复默认背景', 'success')
      return
    }
    const lgPresetBtn = target.closest('[data-action="set-liquid-glass-preset"]')
    if (lgPresetBtn) {
      const preset = String(lgPresetBtn.dataset.liquidGlassPreset || 'aurora')
      setLiquidGlassPresetPreference(preset)
      renderAppearanceBar(root)
      toast('液态玻璃预设已保存', 'success')
      return
    }
  })
  root.addEventListener('input', (e) => {
    const t = e.target
    if (!(t instanceof HTMLInputElement)) return
    if (t.id === 'general-font-size-range') {
      previewFontScale(t.value)
      renderFontSizeRangeState(root)
      return
    }
    if (t.id === 'general-bg-opacity-range') {
      previewBackgroundOpacity(t.value)
      renderBgOpacityRangeState(root)
      return
    }
    if (t.id === 'general-lg-blur-range') {
      previewLiquidGlassBlur(t.value)
      renderLiquidGlassBlurRangeState(root)
      return
    }
    if (t.id === 'general-lg-readability-range') {
      previewLiquidGlassReadabilityDim(t.value)
      renderLiquidGlassReadabilityRangeState(root)
      return
    }
    if (t.id === 'general-accent-custom') {
      previewAccentCustom(t.value)
    }
  })
  root.addEventListener('change', (e) => {
    const t = e.target
    if (!(t instanceof HTMLInputElement)) return
    if (t.id === 'general-font-size-range') {
      setFontScalePreference(t.value)
      renderFontSizeRangeState(root)
      toast('字体大小已保存', 'success')
      return
    }
    if (t.id === 'general-bg-opacity-range') {
      setBackgroundOpacityPreference(t.value)
      renderBgOpacityRangeState(root)
      toast('背景不透明度已保存', 'success')
      return
    }
    if (t.id === 'general-lg-blur-range') {
      setLiquidGlassBlurPreference(t.value)
      renderLiquidGlassBlurRangeState(root)
      toast('玻璃模糊已保存', 'success')
      return
    }
    if (t.id === 'general-lg-flow-range') {
      setLiquidGlassFlowSpeedPreference(t.value)
      renderLiquidGlassFlowRangeState(root)
      toast('流体速度已保存', 'success')
      return
    }
    if (t.id === 'general-lg-readability-range') {
      setLiquidGlassReadabilityDimPreference(t.value)
      renderLiquidGlassReadabilityRangeState(root)
      toast('背景压暗已保存', 'success')
      return
    }
    if (t.id === 'general-accent-custom') {
      setAccentCustomPreference(t.value)
      renderAppearanceBar(root)
      toast('自定义色已保存', 'success')
      return
    }
    if (t.id === 'general-bg-file-input') {
      const file = t.files && t.files[0]
      t.value = ''
      if (!file) return
      void setBackgroundMediaFromBlob(file)
        .then((result) => {
          renderAppearanceBar(root)
          if (result?.kind === 'video' && result.persistent === false) {
            toast('视频背景已应用（本次会话有效，刷新后需重新选择）', 'success')
            return
          }
          toast(result?.kind === 'video' ? '视频背景已保存' : '背景图已保存', 'success')
        })
        .catch((err) => toast(String(err?.message || err || '设置背景失败'), 'error'))
      return
    }
    if (t.id === 'general-virtual-path-toggle') {
      setUseVirtualPaths(!!t.checked)
      toast('文件系统模式已保存', 'success')
      return
    }
    if (t.id === 'general-liquid-glass-toggle') {
      setLiquidGlassEnabled(!!t.checked)
      renderAppearanceBar(root)
      toast(t.checked ? '液态玻璃已开启' : '液态玻璃已关闭', 'success')
      return
    }
    if (t.id === 'general-memory-default-toggle') {
      void patchPanelSettings({ memoryEnabledDefault: !!t.checked }).then(() => {
        toast('记忆默认已保存', 'success')
      })
      return
    }
    if (t.id === 'general-knowledge-map-toggle') {
      void patchPanelSettings({ knowledgeMapEnabled: !!t.checked }).then(() => {
        toast(t.checked ? '已启用思维导图' : '已关闭思维导图', 'success')
      })
      return
    }
    if (t.id === 'general-xiaomi-fab-toggle') {
      void (async () => {
        try {
          const { setFabUserHidden } = await import('../components/global-assistant/assistant-store.js')
          setFabUserHidden(!t.checked)
          toast(t.checked ? '已显示小V 悬浮球' : '已隐藏小V 悬浮球', 'success')
          void renderXiaomiFabToggle(root)
        } catch (err) {
          toast(String(err?.message || err || '保存失败'), 'error')
          void renderXiaomiFabToggle(root)
        }
      })()
      return
    }
    if (t.id === 'general-vision-model-select') {
      void patchPanelSettings({ defaultVisionModel: t.value || '' }).then(() => {
        toast('默认视觉模型已保存', 'success')
      })
      return
    }
  })
}

function renderMemoryDefaultToggle(root) {
  const el = root.querySelector('#general-memory-default-toggle')
  if (!(el instanceof HTMLInputElement)) return
  el.checked = getPanelSetting('memoryEnabledDefault', true) !== false
}

function renderKnowledgeMapToggle(root) {
  const el = root.querySelector('#general-knowledge-map-toggle')
  if (!(el instanceof HTMLInputElement)) return
  el.checked = getPanelSetting('knowledgeMapEnabled', true) !== false
}

async function renderXiaomiFabToggle(root) {
  const el = root.querySelector('#general-xiaomi-fab-toggle')
  if (!(el instanceof HTMLInputElement)) return
  try {
    const { isFabUserHidden } = await import('../components/global-assistant/assistant-store.js')
    el.checked = !isFabUserHidden()
  } catch {
    el.checked = true
  }
  const hint = root.querySelector('#general-xiaomi-fab-toggle')?.closest('.config-section')?.querySelector('.form-hint')
  if (hint) {
    const shortcut = formatShortcutDisplay(getShortcutBinding('toggleXiaomiAssistant'))
    hint.textContent = `关闭后右下角紫色 V 球会隐藏。可随时在此重新打开，或按 ${shortcut}。`
  }
}

async function clearChatRuntimeCaches() {
  const keys = [
    // ws-client
    'evoflow-chat-session-map-v1',
    'evopanel_workspace_history_by_session_v1',
    'evopanel_workspace_history_global_v1',
    'evopanel_local_workspace_root',
    'evopanel_local_workspace_history',
    // ChatApp
    'evopanel-chat-session-meta',
    'evopanel-chat-session-names',
    'evopanel-chat-selected-session',
    // runtime
    'evoflow_tasks_cache',
    'evoflow_panel_state',
    'evoflow_event_stream_state',
    'evoflow_conversation_panels',
    // legacy
    'evopanel-chat-session-names',
  ]
  for (const k of keys) {
    try {
      localStorage.removeItem(k)
    } catch {
      /* ignore */
    }
  }
  try {
    sessionStorage.removeItem('evopanel_shell_sidebar_sync')
  } catch {
    /* ignore */
  }
  await new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase('evopanel-messages')
      req.onsuccess = () => resolve(null)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function handleEmergencyChatCleanup() {
  const yes = await showConfirm('将清理对话缓存并重载页面。未保存的对话/状态会丢失，是否继续？')
  if (!yes) return
  try {
    await clearChatRuntimeCaches()
  } finally {
    toast('已清理缓存，正在重载…', 'success')
    // 给 IndexedDB deleteDatabase 留足时间（可能被其他连接阻塞）
    setTimeout(() => {
      try {
        window.location.reload()
      } catch {
        /* ignore */
      }
    }, 2000)
  }
}

function _normalizePath(p) {
  return String(p || '').trim().replace(/[\\/]+$/, '')
}

function _isDefaultRuntimeDataDir(runtimeDataDir) {
  const p = _normalizePath(runtimeDataDir).replace(/\\/g, '/')
  // runtime_data_dir() without userWorkspaceRoot → ~/.evoflow (not .../data)
  return /\/\.evoflow$/i.test(p)
}

function flashRuntimeDataDir(root) {
  const row = root.querySelector('#general-runtime-data-flash')
  if (!row) return
  row.classList.remove('general-runtime-data-flash--on')
  // reflow so animation can restart
  void row.offsetWidth
  row.classList.add('general-runtime-data-flash--on')
  setTimeout(() => row.classList.remove('general-runtime-data-flash--on'), 2200)
}

async function refreshRuntimeDataDirDisplay(root) {
  const el = root.querySelector('#general-runtime-data-dir')
  const openBtn = root.querySelector('#general-runtime-data-open')
  const copyBtn = root.querySelector('#general-runtime-data-copy')
  const compareEl = root.querySelector('#general-data-path-compare')
  const mismatchEl = root.querySelector('#general-data-mismatch')
  const input = root.querySelector('#general-data-workspace-root')
  if (!el) return
  try {
    const info = await api.workspaceRuntimeInfo()
    const path = String(info?.runtimeDataDir || '').trim()
    const configuredRoot = String(info?.configuredRoot || '').trim()
    el.textContent = path || '（未能读取）'
    el.dataset.path = path
    el.dataset.configuredRoot = configuredRoot
    if (compareEl) {
      compareEl.innerHTML =
        `配置根 <code title="${escapeAttr(configuredRoot)}">${escapeAttr(configuredRoot || '（空 = 默认 ~/.evoflow）')}</code>` +
        ` → 生效 <code title="${escapeAttr(path)}">${escapeAttr(path || '（未能读取）')}</code>`
    }
    if (mismatchEl) {
      const inputVal = _normalizePath(input?.value || '')
      const cfgNorm = _normalizePath(configuredRoot)
      const warnings = []
      if (!inputVal && configuredRoot) {
        warnings.push(
          '输入框为空，但 evopanel.json 仍配置了自定义数据根；当前仍在使用自定义目录。请填写并应用，或清空配置后点「应用」恢复默认。',
        )
      }
      if (!inputVal && !configuredRoot && path && !_isDefaultRuntimeDataDir(path)) {
        warnings.push(
          '输入为空且配置根为空，但当前生效路径不是默认 ~/.evoflow。请检查环境变量 EVOFLOW_HOME 或重启面板。',
        )
      }
      if (inputVal && cfgNorm && inputVal !== cfgNorm) {
        warnings.push(
          `输入框与已保存配置不一致（已保存：${cfgNorm}）。失焦/回车会写入配置；换根还需在确认框中「应用」。`,
        )
      }
      if (inputVal && !cfgNorm) {
        warnings.push('输入框有路径但尚未写入生效配置（或未应用）。失焦保存后请在确认框中选择是否立即切换。')
      }
      if (warnings.length) {
        mismatchEl.hidden = false
        mismatchEl.textContent = warnings.join(' ')
        mismatchEl.classList.add('general-data-mismatch--warn')
      } else {
        mismatchEl.hidden = true
        mismatchEl.textContent = ''
        mismatchEl.classList.remove('general-data-mismatch--warn')
      }
    }
    // 有路径就允许点；无路径也不要“点了没反应”，交给 click 里 toast
    if (openBtn) openBtn.disabled = false
    if (copyBtn) copyBtn.disabled = false
  } catch {
    el.textContent = '（未能读取，请确认后端已启动）'
    el.dataset.path = ''
    el.dataset.configuredRoot = ''
    if (compareEl) compareEl.textContent = '对照：未能读取 configuredRoot / runtimeDataDir'
    if (mismatchEl) {
      mismatchEl.hidden = false
      mismatchEl.textContent = '无法读取运行时数据目录信息，请确认桌面版后端已启动。'
      mismatchEl.classList.add('general-data-mismatch--warn')
    }
    if (openBtn) openBtn.disabled = false
    if (copyBtn) copyBtn.disabled = false
  }
}

async function copyRuntimeDataDir(root) {
  const el = root.querySelector('#general-runtime-data-dir')
  const path = String(el?.dataset?.path || el?.textContent || '').trim()
  if (!path || path.startsWith('（')) {
    toast('没有可复制的路径', 'error')
    return
  }
  try {
    await navigator.clipboard.writeText(path)
    toast('已复制数据目录路径', 'success')
  } catch {
    toast('复制失败', 'error')
  }
}

async function openRuntimeDataDir(root) {
  const el = root.querySelector('#general-runtime-data-dir')
  let path = String(el?.dataset?.path || '').trim()
  if (!path) {
    // 再拉一次，避免首次显示失败后按钮永久空
    try {
      const info = await api.workspaceRuntimeInfo()
      path = String(info?.runtimeDataDir || '').trim()
      if (el && path) {
        el.textContent = path
        el.dataset.path = path
      }
    } catch {
      /* ignore */
    }
  }
  if (!path) {
    toast('没有可打开的路径，请确认面板后端已启动', 'error')
    return
  }
  try {
    await api.revealPathInFileManager(path)
    toast('已在文件管理器中打开', 'success')
  } catch (err) {
    const msg = String(err?.message || err)
    try {
      await navigator.clipboard.writeText(path)
      toast(`无法直接打开（${msg}）。路径已复制，请手动粘贴到访达/资源管理器`, 'error')
    } catch {
      toast(`打开失败：${msg}`, 'error')
    }
  }
}

async function renderDataWorkspaceSettings(root) {
  const input = root.querySelector('#general-data-workspace-root')
  const pickBtn = root.querySelector('#general-data-workspace-pick')
  const projectInput = root.querySelector('#general-default-project-root')
  void refreshRuntimeDataDirDisplay(root)

  if (projectInput) {
    projectInput.value = String(getPanelSetting('defaultProjectWorkspaceRoot', '') || '').trim()
    projectInput.addEventListener('blur', () => { void saveDefaultProjectRoot(root, true) })
    projectInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        void saveDefaultProjectRoot(root, false)
      }
    })
  }

  if (!input || !pickBtn) return

  if (!isTauriDesktop()) {
    input.disabled = true
    pickBtn.disabled = true
    input.title = '仅桌面版支持迁移应用数据目录'
    pickBtn.title = input.title
  } else {
    try {
      const cfg = await api.readPanelConfig()
      input.value = String(cfg?.userWorkspaceRoot || '').trim()
    } catch {
      input.value = ''
    }
    input.addEventListener('blur', () => { void refreshRuntimeDataDirDisplay(root) })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        void saveDataWorkspaceRoot(root, false)
      }
    })
  }
}

async function pickDefaultProjectRoot(root) {
  const input = root.querySelector('#general-default-project-root')
  if (!input) return
  if (isTauriDesktop()) {
    try {
      const dlg = await import('@tauri-apps/plugin-dialog')
      const picked = await dlg.open({
        directory: true,
        multiple: false,
        title: '选择默认项目目录',
      })
      const p = Array.isArray(picked) ? picked[0] : picked
      if (!p) return
      input.value = _normalizePath(String(p))
      await saveDefaultProjectRoot(root, false)
    } catch (err) {
      toast(`选择目录失败：${String(err?.message || err)}`, 'error')
    }
    return
  }
  const next = window.prompt('请输入默认项目目录绝对路径', input.value || '')
  if (next == null) return
  input.value = _normalizePath(next)
  await saveDefaultProjectRoot(root, false)
}

async function saveDefaultProjectRoot(root, silent = false) {
  const input = root.querySelector('#general-default-project-root')
  if (!input) return
  const value = _normalizePath(input.value)
  try {
    await patchPanelSettings({ defaultProjectWorkspaceRoot: value || '' })
    if (!silent) toast(value ? '默认项目目录已保存' : '已清除默认项目目录', 'success')
  } catch (err) {
    toast(`保存失败：${String(err?.message || err)}`, 'error')
  }
}

async function pickDataWorkspaceRoot(root) {
  if (!isTauriDesktop()) return
  try {
    const dlg = await import('@tauri-apps/plugin-dialog')
    const picked = await dlg.open({
      directory: true,
      multiple: false,
      title: '选择应用数据根目录（不是项目文件夹）',
    })
    const p = Array.isArray(picked) ? picked[0] : picked
    if (!p) return
    const input = root.querySelector('#general-data-workspace-root')
    if (!input) return
    input.value = _normalizePath(String(p))
    await saveDataWorkspaceRoot(root, false)
  } catch (err) {
    toast(`选择目录失败：${String(err?.message || err)}`, 'error')
  }
}

async function saveDataWorkspaceRoot(root, silent = false) {
  if (!isTauriDesktop()) return
  const input = root.querySelector('#general-data-workspace-root')
  if (!input) return
  const value = _normalizePath(input.value)
  const projectInput = root.querySelector('#general-default-project-root')

  // blur 静默：只刷新对照，避免误把项目路径写入应用数据根
  if (silent) {
    await refreshRuntimeDataDirDisplay(root)
    return
  }

  try {
    const infoBefore = await api.workspaceRuntimeInfo().catch(() => null)
    const oldRuntime = String(infoBefore?.runtimeDataDir || '').trim()
    const oldConfigured = String(infoBefore?.configuredRoot || '').trim()

    if (value) {
      const choice = await showChoice(
        [
          '你填写的是「用户数据目录（应用数据根）」。',
          '',
          `路径：${value}`,
          '',
          '若只想让 AI 在某文件夹里读写文件，请选「其实我只要项目文件夹」——不会换会话/模型库。',
          '若要把当前应用数据（会话、模型、智能体等）搬到新目录，选「继续换应用数据根」。',
        ].join('\n'),
        [
          { id: 'cancel', label: '取消', variant: 'secondary' },
          { id: 'project', label: '其实我只要项目文件夹', variant: 'primary', default: true },
          { id: 'root', label: '继续换应用数据根', variant: 'danger' },
        ],
        { title: '确认意图' },
      )
      if (!choice || choice === 'cancel') {
        try {
          const cfg = await api.readPanelConfig()
          input.value = String(cfg?.userWorkspaceRoot || '').trim()
        } catch {
          /* ignore */
        }
        await refreshRuntimeDataDirDisplay(root)
        return
      }
      if (choice === 'project') {
        if (projectInput) projectInput.value = value
        await patchPanelSettings({ defaultProjectWorkspaceRoot: value })
        input.value = oldConfigured
        toast('已改写为默认项目目录（未更换应用数据根，会话保留）', 'success')
        await refreshRuntimeDataDirDisplay(root)
        return
      }
    }

    const cfg = await api.readPanelConfig()
    const next = { ...(cfg || {}) }
    if (value) next.userWorkspaceRoot = value
    else delete next.userWorkspaceRoot
    await api.writePanelConfig(next)
    await patchPanelSettings({ userWorkspaceRoot: value || '' })
    toast(value ? '用户数据目录已写入配置（尚未切换）' : '已清除用户数据目录配置（尚未切换）', 'success')
    await refreshRuntimeDataDirDisplay(root)

    const newRuntimeHint = value
      ? (/[/\\]data$/i.test(value.replace(/[\\/]+$/, ''))
          ? value.replace(/[\\/]+$/, '')
          : `${value.replace(/[\\/]+$/, '')}/data`)
      : '~/.evoflow'
    const applyChoice = await showChoice(
      value
        ? [
            '切换应用数据根',
            '',
            `从：${oldRuntime || '（未知）'}`,
            `到：${newRuntimeHint}`,
            '',
            '推荐「复制迁移并切换」：把当前会话/模型/智能体等复制到新目录（旧目录保留不删）。',
            '「仅切换（空库）」：新目录从空开始，看起来像新客户端。',
            '「取消」：只保留已写入的配置，不重启切换。',
          ].join('\n')
        : [
            '恢复默认应用数据根（~/.evoflow）',
            '',
            `从：${oldRuntime || '（未知）'}`,
            '到：~/.evoflow',
            '',
            '推荐「复制迁移并切换」：把当前数据复制回默认目录。',
            '「仅切换」：直接改回默认根（若默认目录里已有旧数据会继续用那份）。',
            '「取消」：只保留已写入的配置，不重启切换。',
          ].join('\n'),
      [
        { id: 'cancel', label: '取消', variant: 'secondary' },
        { id: 'empty', label: '仅切换（空库）', variant: 'danger' },
        { id: 'migrate', label: '复制迁移并切换', variant: 'primary', default: true },
      ],
      { title: '应用数据根' },
    )
    if (!applyChoice || applyChoice === 'cancel') {
      await refreshRuntimeDataDirDisplay(root)
      toast('已保存配置，未立即切换。需要时可再次回车并确认应用。', 'success')
      return
    }
    try {
      toast(applyChoice === 'migrate' ? '正在复制迁移并切换…' : '正在切换应用数据根…', 'success')
      const result = await api.applyWorkspaceSettings(
        applyChoice === 'migrate' ? oldRuntime : null,
      )
      clearLocalChatCachesForWorkspaceSwitch()
      await refreshRuntimeDataDirDisplay(root)
      flashRuntimeDataDir(root)
      const migrated = Boolean(result?.migrated)
      toast(
        migrated
          ? `已迁移并切换到：${result?.runtimeDataDir || newRuntimeHint}`
          : `已切换到：${result?.runtimeDataDir || newRuntimeHint}`,
        'success',
      )
      setTimeout(() => {
        try { window.location.reload() } catch { /* ignore */ }
      }, 250)
    } catch (applyErr) {
      toast(`切换失败：${String(applyErr?.message || applyErr)}`, 'error')
      await refreshRuntimeDataDirDisplay(root)
    }
  } catch (err) {
    toast(`保存失败：${String(err?.message || err)}`, 'error')
  }
}

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-content" style="max-width:720px" id="general-standalone-root"></div>
  `

  await mountGeneralInto(page.querySelector('#general-standalone-root'))
  return page
}

async function renderVisionModelSelector(root) {
  const container = root.querySelector('#general-vision-model-row')
  if (!container) return

  const current = getPanelSetting('defaultVisionModel', '')

  try {
    const list = await api.listModels()
    const models = Array.isArray(list?.models) ? list.models : []
    const visionModels = models.filter((m) => m?.supports_vision)

    if (!visionModels.length) {
      container.innerHTML = '<p class="form-hint" style="margin:0">暂无支持视觉的模型，请先在「模型」页添加并开启视觉能力。</p>'
      return
    }

    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const options = ['<option value="">不指定（自动选择首个视觉模型）</option>']
    for (const m of visionModels) {
      const name = String(m?.name || '')
      const display = String(m?.display_name || name)
      const selected = name === current ? ' selected' : ''
      options.push(`<option value="${esc(name)}"${selected}>${esc(display)}</option>`)
    }

    container.innerHTML = `<select id="general-vision-model-select" class="form-input" style="max-width:400px">${options.join('')}</select>`
  } catch (e) {
    container.innerHTML = '<p class="form-hint" style="margin:0;color:var(--error)">加载模型列表失败</p>'
  }
}

function renderPathMode(page) {
  const toggle = page.querySelector('#general-virtual-path-toggle')
  if (!toggle) return
  toggle.checked = getUseVirtualPaths()
}

function renderFontScaleValue(scale) {
  return `${Math.round(Number(scale || 1) * 100)}%`
}

function renderOpacityValue(opacity) {
  return `${Math.round(Number(opacity || 0) * 100)}%`
}

function renderFontSizeRangeState(root) {
  const input = root.querySelector('#general-font-size-range')
  const value = root.querySelector('#general-font-size-value')
  if (!(input instanceof HTMLInputElement) || !value) return
  value.textContent = renderFontScaleValue(input.value)
}

function renderBgOpacityRangeState(root) {
  const input = root.querySelector('#general-bg-opacity-range')
  const value = root.querySelector('#general-bg-opacity-value')
  if (!(input instanceof HTMLInputElement) || !value) return
  value.textContent = renderOpacityValue(input.value)
}

function renderLiquidGlassBlurRangeState(root) {
  const input = root.querySelector('#general-lg-blur-range')
  const value = root.querySelector('#general-lg-blur-value')
  if (!(input instanceof HTMLInputElement) || !value) return
  value.textContent = `${Math.round(Number(input.value))}px`
}

function renderLiquidGlassReadabilityRangeState(root) {
  const input = root.querySelector('#general-lg-readability-range')
  const value = root.querySelector('#general-lg-readability-value')
  if (!(input instanceof HTMLInputElement) || !value) return
  value.textContent = `${Math.round(Number(input.value))}%`
}

function renderLiquidGlassFlowRangeState(root) {
  const input = root.querySelector('#general-lg-flow-range')
  const value = root.querySelector('#general-lg-flow-value')
  if (!(input instanceof HTMLInputElement) || !value) return
  value.textContent = `${Number(input.value).toFixed(1)}×`
}

function escapeAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
}

async function pickBackgroundImage(root) {
  const input = root.querySelector('#general-bg-file-input')
  if (input instanceof HTMLInputElement) {
    input.click()
    return
  }
  toast('无法打开文件选择', 'error')
}

export function renderAppearanceBar(page) {
  const bar = page.querySelector('#general-appearance-bar')
  if (!bar) return
  const p = getThemePreference()
  const fontScale = getFontScalePreference()
  const accentId = getAccentPalettePreference()
  const accentCustom = getAccentCustomPreference()
  const bgOpacity = getBackgroundOpacityPreference()
  const bgStored = getBackgroundImagePreference()
  const hasBg = hasCustomBackground()
  const lgEnabled = getLiquidGlassEnabled()
  const lgPreset = getLiquidGlassPresetPreference()
  const lgBlur = getLiquidGlassBlurPreference()
  const lgFlow = getLiquidGlassFlowSpeedPreference()
  const lgReadability = getLiquidGlassReadabilityDimPreference()
  const labels = { light: '浅色', dark: '深色', system: '跟随系统' }
  const keys = ['light', 'dark', 'system']
  const bgHint = !hasBg
    ? '未设置自定义背景（使用液态玻璃预设）'
    : bgStored === '__local__'
      ? '已设置本地图片'
      : bgStored === '__local_video__'
        ? '已设置本地视频'
        : bgStored === '__local_video_session__'
          ? '已设置视频（仅本次会话）'
          : isVideoBackgroundPreference(bgStored) || isVideoMediaUrl(resolveBackgroundImageUrl(bgStored))
            ? '已设置自定义视频'
            : `已设置：${bgStored.length > 42 ? `…${bgStored.slice(-40)}` : bgStored}`

  bar.innerHTML = `
    <div class="settings-appearance-group">
      <div class="settings-appearance-label">主题</div>
      <div class="settings-theme-row" role="group" aria-label="主题">
        ${keys
          .map(
            (key) => `
          <button type="button" class="settings-theme-btn${p === key ? ' settings-theme-btn--active' : ''}"
            data-action="set-theme-pref" data-theme-pref="${key}">${labels[key]}</button>`
          )
          .join('')}
      </div>
    </div>
    <div class="settings-appearance-group settings-appearance-group--top">
      <div class="settings-appearance-label">色卡</div>
      <div class="settings-accent-wrap">
        <div class="settings-accent-row" role="group" aria-label="色彩风格">
          ${ACCENT_PALETTES.map((item) => {
            const swatch = item.id === 'default' ? '#6366f1' : item.light
            const active = accentId === item.id ? ' settings-accent-swatch--active' : ''
            return `
            <button type="button" class="settings-accent-swatch${active}"
              data-action="set-accent-palette" data-accent-palette="${item.id}"
              title="${escapeAttr(item.label)}" aria-label="${escapeAttr(item.label)}"
              style="--swatch:${swatch}">
              <span class="settings-accent-swatch-dot"></span>
            </button>`
          }).join('')}
          <label class="settings-accent-swatch settings-accent-swatch--custom${accentId === 'custom' ? ' settings-accent-swatch--active' : ''}"
            title="自定义颜色" aria-label="自定义颜色"
            style="--swatch:${escapeAttr(accentCustom)}">
            <input id="general-accent-custom" type="color" value="${escapeAttr(accentCustom)}" />
            <span class="settings-accent-swatch-dot"></span>
          </label>
        </div>
        <p class="form-hint settings-appearance-inline-hint">选择色卡后，按钮强调色与背景面板氛围会一起变化。</p>
      </div>
    </div>
    <div class="settings-appearance-group settings-appearance-group--top">
      <div class="settings-appearance-label">背景</div>
      <div class="settings-bg-wrap">
        <div class="settings-bg-actions">
          <button type="button" class="settings-theme-btn" data-action="pick-background-image">选择图片/视频</button>
          <button type="button" class="settings-theme-btn${hasBg ? '' : ' is-disabled'}" data-action="clear-background-image" ${hasBg ? '' : 'disabled'}>恢复默认</button>
          <input id="general-bg-file-input" type="file" accept="image/*,video/mp4,video/webm,video/quicktime" hidden />
        </div>
        <p class="form-hint settings-appearance-inline-hint" title="${escapeAttr(bgHint)}">${escapeAttr(bgHint)}</p>
        <div class="settings-font-size-control" style="margin-top:8px">
          <div class="settings-appearance-sublabel">不透明度</div>
          <div class="settings-font-size-row">
            <input
              id="general-bg-opacity-range"
              class="settings-font-size-range"
              type="range"
              min="0.05"
              max="1"
              step="0.01"
              value="${bgOpacity}"
              aria-label="背景不透明度"
            />
            <span id="general-bg-opacity-value" class="settings-font-size-value">${renderOpacityValue(bgOpacity)}</span>
          </div>
          <div class="settings-font-size-ticks" aria-hidden="true">
            <span>淡</span>
            <span>适中</span>
            <span>浓</span>
          </div>
        </div>
      </div>
    </div>
    <div class="settings-appearance-group settings-appearance-group--top">
      <div class="settings-appearance-label">液态玻璃</div>
      <div class="settings-bg-wrap">
        <label class="form-row" style="display:flex;align-items:center;gap:10px;margin:0">
          <input id="general-liquid-glass-toggle" type="checkbox" ${lgEnabled ? 'checked' : ''} />
          <span>启用动态流体背景与分层磨砂</span>
        </label>
        <p class="form-hint settings-appearance-inline-hint">开启后使用 studio 级壁纸 + WebGL 折射。推荐预设「极简」「深海」或「游鱼」（动态视频）；也可在上方背景区上传自己的 MP4/WebM。</p>
        <div class="settings-theme-row" role="group" aria-label="液态玻璃预设" style="margin-top:10px${lgEnabled ? '' : ';opacity:0.45;pointer-events:none'}">
          ${LIQUID_GLASS_PRESETS.map((item) => `
            <button type="button" class="settings-theme-btn${lgPreset === item.id ? ' settings-theme-btn--active' : ''}"
              data-action="set-liquid-glass-preset" data-liquid-glass-preset="${item.id}"
              ${lgEnabled ? '' : 'disabled'}>${escapeAttr(item.label)}</button>`).join('')}
        </div>
        <div class="settings-font-size-control" style="margin-top:8px${lgEnabled ? '' : ';opacity:0.45'}">
          <div class="settings-appearance-sublabel">磨砂强度</div>
          <div class="settings-font-size-row">
            <input id="general-lg-blur-range" class="settings-font-size-range" type="range"
              min="${MIN_LIQUID_GLASS_BLUR}" max="${MAX_LIQUID_GLASS_BLUR}" step="1"
              value="${lgBlur}" aria-label="玻璃模糊" ${lgEnabled ? '' : 'disabled'} />
            <span id="general-lg-blur-value" class="settings-font-size-value">${Math.round(lgBlur)}px</span>
          </div>
        </div>
        <div class="settings-font-size-control" style="margin-top:6px${lgEnabled ? '' : ';opacity:0.45'}">
          <div class="settings-appearance-sublabel">流体速度</div>
          <div class="settings-font-size-row">
            <input id="general-lg-flow-range" class="settings-font-size-range" type="range"
              min="${MIN_LIQUID_GLASS_FLOW}" max="${MAX_LIQUID_GLASS_FLOW}" step="0.1"
              value="${lgFlow}" aria-label="流体速度" ${lgEnabled ? '' : 'disabled'} />
            <span id="general-lg-flow-value" class="settings-font-size-value">${Number(lgFlow).toFixed(1)}×</span>
          </div>
        </div>
        <div class="settings-font-size-control" style="margin-top:6px${lgEnabled ? '' : ';opacity:0.45'}">
          <div class="settings-appearance-sublabel">背景压暗（可读性）</div>
          <div class="settings-font-size-row">
            <input id="general-lg-readability-range" class="settings-font-size-range" type="range"
              min="${MIN_LIQUID_GLASS_READABILITY_DIM}" max="${MAX_LIQUID_GLASS_READABILITY_DIM}" step="1"
              value="${lgReadability}" aria-label="背景压暗" ${lgEnabled ? '' : 'disabled'} />
            <span id="general-lg-readability-value" class="settings-font-size-value">${Math.round(lgReadability)}%</span>
          </div>
          <p class="form-hint settings-appearance-inline-hint" style="margin-top:4px">视频背景会自动加强压暗；字仍看不清时可拉到 60–75%。</p>
        </div>
      </div>
    </div>
    <div class="settings-appearance-group settings-appearance-group--range">
      <div class="settings-appearance-label">字体大小</div>
      <div class="settings-font-size-control">
        <div class="settings-font-size-row">
          <input
            id="general-font-size-range"
            class="settings-font-size-range"
            type="range"
            min="0.85"
            max="1.5"
            step="0.01"
            value="${fontScale}"
            aria-label="字体大小"
          />
          <span id="general-font-size-value" class="settings-font-size-value">${renderFontScaleValue(fontScale)}</span>
        </div>
        <div class="settings-font-size-ticks" aria-hidden="true">
          <span>小</span>
          <span>标准</span>
          <span>大</span>
        </div>
      </div>
    </div>
    <p class="form-hint" style="margin-top:var(--space-xs)">外观设置会保存为你的偏好，并立即应用到整个客户端。</p>
  `
}
