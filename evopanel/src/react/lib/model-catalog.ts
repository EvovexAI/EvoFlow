import { PROVIDER_PRESETS } from '../../lib/model-presets.js'
import { isEmbeddingModel } from '../../lib/model-classification.js'
import type { ChatSceneId } from './session-mode.js'

/** Gateway /api/models 条目：name 对应 config.yaml models[].name；可选 scene 表示该模型绑定的模式 */
export type ModelCatalogEntry = {
  name: string
  displayName?: string
  supportsVision: boolean
  supportsThinking?: boolean
  supportedLevels?: string[]
  scene?: ChatSceneId
  contextLength?: number
  vendor?: string
  availabilityStatus?: 'available' | 'unavailable'
  unavailableReason?: string
}

/** 优先返回 display_name，为空时回退到 name */
export function modelDisplayLabel(entry: { name: string; displayName?: string } | undefined | null): string {
  if (!entry) return ''
  const dn = (entry.displayName || '').trim()
  return dn || entry.name
}

/** vendor key → 中文厂商标签（复用 model-presets 的 PROVIDER_PRESETS） */
const VENDOR_LABEL_MAP: Record<string, string> = (() => {
  const m: Record<string, string> = {}
  for (const p of PROVIDER_PRESETS) {
    if (p.key) m[p.key] = p.label || p.key
  }
  return m
})()

/** 取 vendor 的厂商根 key：volcengine-2 → volcengine；volcengine → volcengine */
export function vendorRootKey(vendor: string): string {
  const v = (vendor || '').trim()
  const m = v.match(/^(.+)[-_](\d+)$/)
  return m && Number(m[2]) >= 2 ? m[1] : v
}

/** vendor key → 厂商品牌中文名（仅品牌，不含连接序号） */
export function vendorBrandLabel(vendor?: string): string {
  const v = (vendor || '').trim()
  if (!v) return '其他'
  if (VENDOR_LABEL_MAP[v]) return VENDOR_LABEL_MAP[v]
  const base = vendorRootKey(v)
  if (VENDOR_LABEL_MAP[base]) return VENDOR_LABEL_MAP[base]
  return v.charAt(0).toUpperCase() + v.slice(1)
}

/**
 * 按 vendor（即连接 key）分组 catalog；保持首次出现顺序，无 vendor 归入「其他」。
 * label 优先级：连接自定义名(connNameMap) > 品牌·连接N(同品牌多套时) > 品牌。
 */
export function groupModelCatalogByVendor(
  catalog: ModelCatalogEntry[],
  connNameMap?: Record<string, string>,
): { vendor: string; label: string; rows: ModelCatalogEntry[] }[] {
  const order: string[] = []
  const bucket: Record<string, ModelCatalogEntry[]> = {}
  for (const row of catalog) {
    const v = (row.vendor || '').trim() || '__other__'
    if (!bucket[v]) {
      bucket[v] = []
      order.push(v)
    }
    bucket[v].push(row)
  }
  const rootCount: Record<string, number> = {}
  for (const v of order) {
    if (v === '__other__') continue
    const root = vendorRootKey(v)
    rootCount[root] = (rootCount[root] || 0) + 1
  }
  return order.map((v) => {
    let label: string
    if (v === '__other__') {
      label = '其他'
    } else {
      const connName = (connNameMap?.[v] || '').trim()
      const brand = vendorBrandLabel(v)
      const root = vendorRootKey(v)
      const suffix = v !== root ? v.slice(root.length).replace(/^[-_]/, '') : ''
      if (connName) {
        label = connName
      } else if (rootCount[root] > 1) {
        label = suffix && /^\d+$/.test(suffix) ? `${brand} · 连接 ${suffix}` : `${brand} · 默认`
      } else {
        label = brand
      }
    }
    return { vendor: v, label, rows: bucket[v] }
  })
}

type SceneParser = (item: unknown) => ChatSceneId | undefined

/** 将 /api/models 原始列表规范为聊天模型 catalog（过滤 embedding） */
export function normalizeModelCatalogRows(
  rows: unknown[],
  parseScene?: SceneParser,
): ModelCatalogEntry[] {
  const seen = new Set<string>()
  const next: ModelCatalogEntry[] = []
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    if (isEmbeddingModel(row)) continue
    const name = typeof row.name === 'string' ? row.name.trim() : ''
    if (!name || seen.has(name)) continue
    seen.add(name)
    const scene = parseScene?.(row)
    const ctxLen = Number(row.context_length)
    const displayName =
      typeof row.display_name === 'string' ? row.display_name.trim() : ''
    const vendorRaw = typeof row.vendor === 'string' ? row.vendor.trim() : ''
    const entry: ModelCatalogEntry = {
      name,
      supportsVision: Boolean(row.supports_vision),
    }
    if (vendorRaw) entry.vendor = vendorRaw
    if (row.supports_thinking) entry.supportsThinking = true
    const thinkingCfg = row.thinking
    if (thinkingCfg && typeof thinkingCfg === 'object') {
      const levels =
        (thinkingCfg as { supported_levels?: unknown; supportedLevels?: unknown }).supported_levels ||
        (thinkingCfg as { supportedLevels?: unknown }).supportedLevels
      if (Array.isArray(levels) && levels.length) entry.supportedLevels = levels.map(String)
    }
    if (displayName) entry.displayName = displayName
    if (scene) entry.scene = scene
    if (Number.isFinite(ctxLen) && ctxLen > 0) entry.contextLength = ctxLen
    const statusRaw = String(row.availability_status || '').trim().toLowerCase()
    if (statusRaw === 'unavailable') {
      entry.availabilityStatus = 'unavailable'
      const reason = typeof row.unavailable_reason === 'string' ? row.unavailable_reason.trim() : ''
      if (reason) entry.unavailableReason = reason
    } else {
      entry.availabilityStatus = 'available'
    }
    next.push(entry)
  }
  return next
}

/** 连接自定义显示名：API display_name + localStorage 覆盖 */
export function buildModelConnNameMap(
  connections: unknown[],
  localStorageKey = 'evoflow-provider-display-names-v1',
): Record<string, string> {
  const connNameMap: Record<string, string> = {}
  for (const c of connections) {
    if (!c || typeof c !== 'object') continue
    const row = c as Record<string, unknown>
    const k = String(row.key || '').trim()
    if (!k) continue
    const dn = String(row.display_name || '').trim()
    if (dn) connNameMap[k] = dn
  }
  try {
    const raw = localStorage.getItem(localStorageKey)
    const stored = raw ? JSON.parse(raw) : {}
    for (const [k, v] of Object.entries(stored)) {
      const val = String(v || '').trim()
      if (val) connNameMap[String(k).trim()] = val
    }
  } catch {
    /* ignore */
  }
  return connNameMap
}

export function resolveSessionModelName(
  catalog: ModelCatalogEntry[],
  options: {
    sessionContextModel?: string | null
    userPillModel?: string
    primaryModel?: string
    fromSessionSwitch?: boolean
  },
): string {
  const inCatalog = (n: string) => !!(n && catalog.some((e) => e.name === n))
  const fallback = () => {
    const primary = (options.primaryModel || '').trim()
    if (inCatalog(primary)) return primary
    return catalog[0]?.name || ''
  }

  if (options.fromSessionSwitch) {
    const ctx = (options.sessionContextModel || '').trim()
    if (inCatalog(ctx)) return ctx
    return fallback()
  }

  const pill = (options.userPillModel || '').trim()
  if (inCatalog(pill)) return pill
  const ctx = (options.sessionContextModel || '').trim()
  if (inCatalog(ctx)) return ctx
  return fallback()
}

export function defaultModelFromCatalog(
  catalog: ModelCatalogEntry[],
  primaryModel?: string | null,
): string {
  return resolveSessionModelName(catalog, {
    primaryModel: primaryModel || '',
    fromSessionSwitch: true,
    sessionContextModel: '',
  })
}
