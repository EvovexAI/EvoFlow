/**
 * UI Extension registry — Tauri desktop persists under ~/.evoflow/ui-extensions;
 * Web falls back to localStorage (remote / none / external only).
 */
import {
  buildRemoteUiExtensionManifest,
  classifyUiExtensionIcon,
  parseUiExtensionManifest,
} from './ui-extension-manifest.js'

const LS_KEY = 'evoflow_ui_extensions_v1'
const CHANGE_EVENT = 'evoflow-ui-extensions-changed'

/** @type {((path: string) => string) | null} */
let _convertFileSrc = null
if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
  import('@tauri-apps/api/core')
    .then((m) => {
      _convertFileSrc = typeof m.convertFileSrc === 'function' ? m.convertFileSrc : null
    })
    .catch(() => {})
}

function isTauri() {
  return !!(typeof window !== 'undefined' && window.__TAURI_INTERNALS__)
}

/**
 * Resolve manifest.icon to an <img> src or emoji/glyph text.
 * Prefer backend-provided `iconSrc` (data URL) when available — works in Tauri without asset protocol.
 * @param {unknown} icon
 * @param {string} [installPath]
 * @param {string} [iconSrc] pre-resolved URL from desktop list API
 * @returns {{ kind: 'img', src: string } | { kind: 'glyph', text: string } | { kind: 'none' }}
 */
export function resolveUiExtensionIconSrc(icon, installPath = '', iconSrc = '') {
  const pre = String(iconSrc || '').trim()
  if (pre) return { kind: 'img', src: pre }

  const classified = classifyUiExtensionIcon(icon, installPath)
  if (classified.type === 'url') return { kind: 'img', src: classified.src }
  if (classified.type === 'glyph') return { kind: 'glyph', text: classified.text }
  if (classified.type === 'file') {
    const path = classified.path
    if (_convertFileSrc) {
      try {
        const src = _convertFileSrc(path)
        if (src) return { kind: 'img', src }
      } catch {
        /* fall through */
      }
    }
    const normalized = String(path).replace(/\\/g, '/')
    const src = /^[a-zA-Z]:/.test(normalized)
      ? `file:///${normalized}`
      : `file://${normalized.startsWith('/') ? '' : '/'}${normalized}`
    return { kind: 'img', src }
  }
  return { kind: 'none' }
}

async function invoke(cmd, args = {}) {
  const { invoke: inv } = await import('@tauri-apps/api/core')
  return inv(cmd, args)
}

function readLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function writeLocal(rows) {
  localStorage.setItem(LS_KEY, JSON.stringify(rows))
  notifyExtensionsChanged()
}

export function notifyExtensionsChanged() {
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
  } catch {
    /* ignore */
  }
}

export function onUiExtensionsChanged(handler) {
  window.addEventListener(CHANGE_EVENT, handler)
  return () => window.removeEventListener(CHANGE_EVENT, handler)
}

/**
 * @returns {Promise<object[]>}
 */
export async function listUiExtensions() {
  if (isTauri()) {
    try {
      const rows = await invoke('ui_extension_list')
      return Array.isArray(rows) ? rows : []
    } catch (e) {
      console.warn('ui_extension_list failed', e)
      return readLocal()
    }
  }
  return readLocal()
}

export async function listEnabledUiExtensions() {
  const rows = await listUiExtensions()
  return rows
    .filter((r) => r && r.enabled !== false)
    .filter((r) => r.kind !== 'suite' && String(r.manifest?.kind || '') !== 'suite')
    .filter((r) => {
      const entry = String(r.manifest?.ui?.entry || '').trim()
      return entry && entry !== 'about:blank'
    })
    .sort((a, b) => {
      const oa = Number(a.manifest?.nav?.order) || 100
      const ob = Number(b.manifest?.nav?.order) || 100
      if (oa !== ob) return oa - ob
      return String(a.id || '').localeCompare(String(b.id || ''))
    })
}

export async function getUiExtension(id) {
  const tid = String(id || '').trim()
  const rows = await listUiExtensions()
  return rows.find((r) => String(r.id) === tid) || null
}

/**
 * Install from a validated manifest object (remote / already-parsed).
 * @param {object} manifest
 * @param {{ installPath?: string, source?: string }} [opts]
 */
export async function installUiExtensionFromManifest(manifest, opts = {}) {
  const parsed = parseUiExtensionManifest(manifest)
  if (!parsed.ok) throw new Error(parsed.error)
  const m = parsed.manifest

  if (isTauri()) {
    const row = await invoke('ui_extension_install_manifest', {
      manifest: m,
      installPath: opts.installPath || null,
      source: opts.source || 'manifest',
    })
    notifyExtensionsChanged()
    return row
  }

  const rows = readLocal().filter((r) => r.id !== m.id)
  const row = {
    id: m.id,
    enabled: true,
    source: opts.source || 'remote',
    install_path: opts.installPath || '',
    installed_at: new Date().toISOString(),
    manifest: m,
  }
  rows.push(row)
  writeLocal(rows)
  return row
}

export async function installUiExtensionRemote({ id, name, entry }) {
  const parsed = buildRemoteUiExtensionManifest({ id, name, entry })
  if (!parsed.ok) throw new Error(parsed.error)
  return installUiExtensionFromManifest(parsed.manifest, { source: 'remote' })
}

/** Desktop: pick folder containing evoflow.suite.json */
export async function installUiExtensionSuiteFromFolder() {
  if (!isTauri()) {
    throw new Error('安装套件仅桌面版支持')
  }
  const out = await invoke('ui_extension_install_suite')
  notifyExtensionsChanged()
  return out
}

/** Desktop: one-click install builtin 内容创作 suite */
export async function installContentCreatorSuite() {
  if (!isTauri()) {
    throw new Error('一键安装套件仅桌面版支持')
  }
  const out = await invoke('ui_extension_install_content_creator')
  notifyExtensionsChanged()
  return out
}

/** Desktop: pick folder containing evoflow.extension.json */
export async function installUiExtensionFromFolder() {
  if (!isTauri()) {
    throw new Error('选择本地文件夹仅桌面版支持；Web 请用「远程入口」')
  }
  const row = await invoke('ui_extension_install_folder')
  notifyExtensionsChanged()
  return row
}

/** Desktop: pick zip */
export async function installUiExtensionFromZip() {
  if (!isTauri()) {
    throw new Error('导入 zip 仅桌面版支持')
  }
  const row = await invoke('ui_extension_install_zip')
  notifyExtensionsChanged()
  return row
}

export async function setUiExtensionEnabled(id, enabled) {
  if (isTauri()) {
    const row = await invoke('ui_extension_set_enabled', { id, enabled: !!enabled })
    notifyExtensionsChanged()
    return row
  }
  const rows = readLocal()
  const hit = rows.find((r) => r.id === id)
  if (!hit) throw new Error('扩展不存在')
  hit.enabled = !!enabled
  writeLocal(rows)
  return hit
}

export async function uninstallUiExtension(id) {
  if (isTauri()) {
    await invoke('ui_extension_uninstall', { id })
    notifyExtensionsChanged()
    return
  }
  writeLocal(readLocal().filter((r) => r.id !== id))
}

export async function revealUiExtensionDir(id) {
  if (!isTauri()) throw new Error('仅桌面版支持打开目录')
  return invoke('ui_extension_reveal', { id })
}

export async function uiExtensionServiceStatus(id) {
  if (!isTauri()) {
    const row = await getUiExtension(id)
    const mode = row?.manifest?.service?.mode || 'none'
    return {
      id,
      state: mode === 'none' ? 'none' : 'external_unknown',
      mode,
      pid: null,
      ports: row?.manifest?.service?.ports || [],
      log_tail: '',
      message: mode === 'managed' ? 'Web 客户端不托管本地进程' : '',
    }
  }
  return invoke('ui_extension_service_status', { id })
}

export async function uiExtensionServiceStart(id) {
  if (!isTauri()) throw new Error('启动本地服务仅桌面版支持')
  const out = await invoke('ui_extension_service_start', { id })
  notifyExtensionsChanged()
  return out
}

export async function uiExtensionServiceStop(id) {
  if (!isTauri()) throw new Error('停止本地服务仅桌面版支持')
  const out = await invoke('ui_extension_service_stop', { id })
  notifyExtensionsChanged()
  return out
}

export async function uiExtensionServiceLogs(id) {
  if (!isTauri()) return { log: '' }
  return invoke('ui_extension_service_logs', { id })
}

/** Ensure managed service is healthy before embedding (no-op for none). */
export async function ensureUiExtensionReady(id) {
  const row = await getUiExtension(id)
  if (!row) throw new Error('扩展未安装')
  if (row.enabled === false) throw new Error('扩展已禁用')
  const mode = row.manifest?.service?.mode || 'none'
  if (mode === 'none') {
    return { ok: true, entry: row.manifest.ui.entry, state: 'none' }
  }
  if (!isTauri()) {
    if (mode === 'external') {
      const url = row.manifest?.service?.healthcheck?.url || row.manifest?.ui?.entry
      if (url && /^https?:/i.test(url)) {
        try {
          await fetch(url, { method: 'GET', mode: 'no-cors' })
        } catch {
          /* no-cors opaque ok */
        }
      }
      return { ok: true, entry: row.manifest.ui.entry, state: 'external' }
    }
    throw new Error(row.manifest?.service?.hint || '请在桌面客户端启动该扩展服务')
  }
  const st = await uiExtensionServiceStatus(id)
  if (st.state === 'running' || st.state === 'external') {
    return { ok: true, entry: row.manifest.ui.entry, state: st.state, status: st }
  }
  // 已在启动中：短轮询等待，避免再次 spawn
  if (st.state === 'starting') {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250))
      const cur = await uiExtensionServiceStatus(id).catch(() => null)
      if (cur?.state === 'running') {
        return { ok: true, entry: row.manifest.ui.entry, state: 'running', status: cur }
      }
      if (cur?.state === 'failed') {
        throw new Error(cur.message || '扩展服务启动失败')
      }
    }
    throw new Error('等待扩展服务启动超时')
  }
  const started = await uiExtensionServiceStart(id)
  return { ok: true, entry: row.manifest.ui.entry, state: started.state || 'running', status: started }
}
