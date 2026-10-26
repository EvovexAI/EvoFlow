/**
 * 客户端全局插件目录：统一走 Gateway GET /api/plugins/overview，
 * 进程内缓存 + 并发去重。工作台「+」面板、主对话「+」面板共用。
 */
import { gatewayProxy } from './tauri-api.js'

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   label: string,
 *   description: string,
 *   version?: string,
 *   marketplace: string,
 *   componentTypes?: string[],
 *   iconUrl?: string,
 *   enabled: boolean,
 * }} PluginCatalogEntry
 */

/** @type {PluginCatalogEntry[] | null} */
let _cached = null
/** @type {Promise<PluginCatalogEntry[]> | null} */
let _inflight = null
/** @type {Set<(rows: PluginCatalogEntry[]) => void>} */
const _listeners = new Set()

/**
 * @param {Record<string, unknown>} row
 * @returns {PluginCatalogEntry | null}
 */
function normalizePluginRow(row) {
  const id = String(row?.id || '').trim()
  const name = String(row?.name || '').trim()
  if (!id && !name) return null
  const listing = row?.listing && typeof row.listing === 'object' ? row.listing : null
  return {
    id: id || name,
    name: name || id,
    label: String(listing?.displayName || name || id).trim() || id,
    description: String(row?.description || '').trim(),
    version: row?.version != null ? String(row.version) : undefined,
    marketplace: String(row?.marketplace || '').trim(),
    componentTypes: Array.isArray(row?.componentTypes)
      ? row.componentTypes.map((t) => String(t))
      : undefined,
    iconUrl: listing?.icon
      ? String(listing.icon)
      : name
        ? `/api/plugins/icon/${name}`
        : undefined,
    enabled: row?.enabled !== false,
  }
}

/** @param {PluginCatalogEntry[]} rows */
function notifyListeners(rows) {
  for (const fn of _listeners) {
    try {
      fn(rows)
    } catch {
      /* ignore subscriber errors */
    }
  }
}

/** @param {PluginCatalogEntry[]} rows */
function commitCache(rows) {
  _cached = rows
  _inflight = null
  notifyListeners(rows)
  return rows
}

/** 安装/卸载/启停后调用，使下次 load 重新拉取。 */
export function invalidatePluginCatalog() {
  _cached = null
  _inflight = null
}

/** 订阅目录变更（缓存刷新后通知 React 等 UI）。 */
export function subscribePluginCatalog(listener) {
  _listeners.add(listener)
  if (_cached) listener(_cached)
  return () => _listeners.delete(listener)
}

/**
 * 用设置页 overview 结果直接灌入缓存（避免再打一轮 /overview）。
 * @param {Array<Record<string, unknown>> | null | undefined} installedPlugins
 */
export function seedPluginCatalogFromOverview(installedPlugins) {
  const rows = (Array.isArray(installedPlugins) ? installedPlugins : [])
    .map(normalizePluginRow)
    .filter(Boolean)
  commitCache(rows)
  return rows
}

/**
 * 加载已安装插件目录（全局缓存，并发去重）。
 * @param {{ force?: boolean, enabledOnly?: boolean }} [opts]
 * @returns {Promise<PluginCatalogEntry[]>}
 */
export async function loadPluginCatalog(opts = {}) {
  const { force = false, enabledOnly = false } = opts

  if (!force && _cached) {
    return enabledOnly ? _cached.filter((p) => p.enabled) : _cached.slice()
  }

  if (!force && _inflight) {
    const rows = await _inflight
    return enabledOnly ? rows.filter((p) => p.enabled) : rows.slice()
  }

  _inflight = (async () => {
    try {
      const body = await gatewayProxy('GET', '/api/plugins/overview')
      const raw = Array.isArray(body?.installedPlugins) ? body.installedPlugins : []
      const rows = raw.map(normalizePluginRow).filter(Boolean)
      return commitCache(rows)
    } catch (e) {
      // Non-admin / transient gateway errors must not surface as Uncaught —
      // chat 「+」 and home prefetch share this path on every session open.
      _inflight = null
      console.warn('[plugin-catalog] overview failed:', e?.message || e)
      return commitCache([])
    }
  })()

  const rows = await _inflight
  return enabledOnly ? rows.filter((p) => p.enabled) : rows.slice()
}

/** 应用启动或进入工作台时可预拉取，避免首次点「+」才请求。 */
export function prefetchPluginCatalog() {
  if (_cached || _inflight) return _inflight
  return loadPluginCatalog().catch(() => [])
}

/** 强制刷新并返回最新目录（变更后 UI 主动 reload 用）。 */
export async function reloadPluginCatalog(opts = {}) {
  invalidatePluginCatalog()
  return loadPluginCatalog({ ...opts, force: true })
}

/** @returns {PluginCatalogEntry[] | null} */
export function getCachedPluginCatalog() {
  return _cached ? _cached.slice() : null
}
