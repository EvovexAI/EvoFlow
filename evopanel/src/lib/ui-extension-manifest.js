/**
 * EvoFlow UI Extension Manifest v1 — parse & validate (lightweight, no AJV).
 */

const ID_RE = /^[a-z][a-z0-9-]{1,63}$/
const ALLOWED_PERMS = new Set(['embed', 'context.read', 'tasks.dispatch', 'tasks.open'])
const SERVICE_MODES = new Set(['none', 'managed', 'external'])

/**
 * @param {unknown} raw
 * @returns {{ ok: true, manifest: object } | { ok: false, error: string }}
 */
export function parseUiExtensionManifest(raw) {
  let obj = raw
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw)
    } catch {
      return { ok: false, error: 'Manifest 不是合法 JSON' }
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: 'Manifest 必须是对象' }
  }
  if (Number(obj.schema) !== 1) {
    return { ok: false, error: '仅支持 schema=1' }
  }
  const id = String(obj.id || '').trim()
  if (!ID_RE.test(id)) {
    return { ok: false, error: 'id 须为 kebab-case（小写字母开头）' }
  }
  const name = String(obj.name || '').trim()
  if (!name) return { ok: false, error: 'name 必填' }
  const version = String(obj.version || '').trim()
  if (!version) return { ok: false, error: 'version 必填' }
  const ui = obj.ui
  if (!ui || typeof ui !== 'object') return { ok: false, error: 'ui 必填' }
  if (String(ui.kind || '') !== 'webview') {
    return { ok: false, error: 'ui.kind 须为 webview' }
  }
  const entry = String(ui.entry || '').trim()
  if (!entry) return { ok: false, error: 'ui.entry 必填' }

  const permissions = Array.isArray(obj.permissions)
    ? [...new Set(obj.permissions.map((p) => String(p || '').trim()).filter(Boolean))]
    : ['embed']
  for (const p of permissions) {
    if (!ALLOWED_PERMS.has(p)) {
      return { ok: false, error: `未知 permission: ${p}` }
    }
  }

  const serviceIn = obj.service && typeof obj.service === 'object' ? obj.service : {}
  const mode = String(serviceIn.mode || 'none').trim() || 'none'
  if (!SERVICE_MODES.has(mode)) {
    return { ok: false, error: `service.mode 无效: ${mode}` }
  }

  const navIn = obj.nav && typeof obj.nav === 'object' ? obj.nav : {}
  const bridgeIn = obj.bridge && typeof obj.bridge === 'object' ? obj.bridge : {}
  const runtimeIn = obj.runtime && typeof obj.runtime === 'object' ? obj.runtime : null
  const suite = String(obj.suite || '').trim()

  const manifest = {
    schema: 1,
    id,
    name,
    version,
    description: String(obj.description || '').trim(),
    icon: String(obj.icon || '').trim(),
    nav: {
      title: String(navIn.title || name).trim() || name,
      group: 'extensions',
      order: Number.isFinite(Number(navIn.order)) ? Number(navIn.order) : 100,
    },
    ui: {
      kind: 'webview',
      entry,
      path_prefix: String(ui.path_prefix || '/').trim() || '/',
      sandbox: Array.isArray(ui.sandbox)
        ? ui.sandbox.map((s) => String(s))
        : ['allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-popups'],
    },
    permissions,
    service: {
      mode,
      cwd: String(serviceIn.cwd || '.').trim() || '.',
      hint: String(serviceIn.hint || '').trim(),
      start: serviceIn.start && typeof serviceIn.start === 'object' ? serviceIn.start : {},
      healthcheck: {
        url: String(serviceIn.healthcheck?.url || '').trim(),
        timeout_ms: Math.max(1000, Number(serviceIn.healthcheck?.timeout_ms) || 90000),
      },
      stop: String(serviceIn.stop || 'process').trim() || 'process',
      ports: Array.isArray(serviceIn.ports)
        ? serviceIn.ports.map((n) => Number(n)).filter((n) => n > 0 && n <= 65535)
        : [],
      link: serviceIn.link === true,
      sharedKey: String(serviceIn.sharedKey || '').trim(),
    },
    bridge: {
      origin_allowlist: Array.isArray(bridgeIn.origin_allowlist)
        ? bridgeIn.origin_allowlist.map((o) => String(o || '').trim()).filter(Boolean)
        : [],
    },
  }

  if (suite) manifest.suite = suite
  if (runtimeIn) {
    const runtimeId = String(runtimeIn.id || '').trim()
    const sharedKey = String(runtimeIn.sharedKey || '').trim()
    const mcpServer = String(runtimeIn.mcpServer || '').trim()
    if (runtimeId || sharedKey || mcpServer) {
      manifest.runtime = {}
      if (runtimeId) manifest.runtime.id = runtimeId
      if (sharedKey) manifest.runtime.sharedKey = sharedKey
      if (mcpServer) manifest.runtime.mcpServer = mcpServer
    }
  }

  if (manifest.service.mode === 'managed') {
    const start = manifest.service.start || {}
    const hasCmd = Object.values(start).some((v) => Array.isArray(v) && v.length > 0)
    if (!hasCmd) {
      return { ok: false, error: 'managed 模式须声明 service.start' }
    }
  }

  return { ok: true, manifest }
}

/** Build a remote-only lightweight manifest from form fields. */
export function buildRemoteUiExtensionManifest({ id, name, entry }) {
  return parseUiExtensionManifest({
    schema: 1,
    id,
    name: name || id,
    version: '0.0.0',
    ui: { kind: 'webview', entry },
    permissions: ['embed'],
    service: { mode: 'none' },
    bridge: {
      origin_allowlist: (() => {
        try {
          return [new URL(String(entry || '')).origin]
        } catch {
          return []
        }
      })(),
    },
  })
}

export function manifestHasSensitivePermissions(manifest) {
  const perms = manifest?.permissions || []
  return perms.includes('tasks.dispatch') || perms.includes('tasks.open')
}

export function resolveEntryUrl(manifest, installPath = '') {
  const entry = String(manifest?.ui?.entry || '').trim()
  if (!entry) return ''
  if (/^https?:\/\//i.test(entry)) return entry
  if (/^file:/i.test(entry)) return entry
  const base = String(installPath || '').replace(/\\/g, '/').replace(/\/$/, '')
  const rel = entry.replace(/^\.\//, '')
  if (!base) return entry
  // Desktop may serve via file:// — callers can also rewrite.
  return `file:///${base}/${rel}`.replace(/\\/g, '/')
}

function joinInstallPath(base, rel) {
  const b = String(base || '').replace(/[/\\]+$/, '')
  const r = String(rel || '')
    .replace(/^\.[/\\]/, '')
    .replace(/^[/\\]+/, '')
  if (!b || !r) return b || ''
  if (/^[a-zA-Z]:/.test(b) || b.includes('\\')) {
    return `${b}\\${r.replace(/\//g, '\\')}`
  }
  return `${b}/${r.replace(/\\/g, '/')}`
}

function fileUrlToPath(url) {
  let s = String(url || '').replace(/^file:\/\/*/i, '')
  try {
    s = decodeURIComponent(s)
  } catch {
    /* keep raw */
  }
  // file:///C:/foo → C:/foo ; file:///Users/... → /Users/...
  if (/^[a-zA-Z]:/.test(s)) return s.replace(/\//g, '\\')
  if (!s.startsWith('/')) s = `/${s}`
  return s
}

/**
 * Classify manifest.icon for UI rendering.
 * Relative paths (e.g. `./icon.svg`) resolve against install_path.
 *
 * @param {unknown} icon
 * @param {string} [installPath]
 * @returns {{ type: 'url', src: string } | { type: 'file', path: string } | { type: 'glyph', text: string } | { type: 'none' }}
 */
export function classifyUiExtensionIcon(icon, installPath = '') {
  const raw = String(icon || '').trim()
  if (!raw) return { type: 'none' }

  if (
    /^https?:\/\//i.test(raw) ||
    /^data:/i.test(raw) ||
    /^blob:/i.test(raw) ||
    /^asset:/i.test(raw)
  ) {
    return { type: 'url', src: raw }
  }

  const looksLikePath =
    /^file:/i.test(raw) ||
    /[/\\]/.test(raw) ||
    /\.(svg|png|jpe?g|webp|gif|ico)$/i.test(raw)

  if (!looksLikePath) {
    return { type: 'glyph', text: raw }
  }

  if (/^file:/i.test(raw)) {
    const path = fileUrlToPath(raw)
    return path ? { type: 'file', path } : { type: 'none' }
  }

  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) {
    return { type: 'file', path: raw }
  }

  // Unix absolute (not relative ./icon.svg)
  if (raw.startsWith('/') && !raw.startsWith('./')) {
    return { type: 'file', path: raw }
  }

  const path = joinInstallPath(installPath, raw)
  if (!path) return { type: 'none' }
  return { type: 'file', path }
}
