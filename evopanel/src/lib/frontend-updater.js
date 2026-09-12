/**
 * EvoPanel 前端热更新：下载 zip 到 ~/.evoflow/evopanel/web-update/，刷新 WebView 生效。
 * 仅 Tauri；manifest.updateKind === 'frontend-only' 时使用。
 */

import { api } from './tauri-api.js'

const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

/**
 * @typedef {Object} FrontendUpdateManifest
 * @property {string} [version]
 * @property {string} [updateKind]
 * @property {string} [frontendUrl]
 * @property {string} [frontendHash]
 * @property {string} [changelog]
 * @property {string} [notes]
 */

/**
 * @param {Record<string, unknown> | null | undefined} manifest
 */
export function isFrontendOnlyManifest(manifest) {
  const kind = String(manifest?.updateKind || manifest?.assetKind || '').trim().toLowerCase()
  return kind === 'frontend-only' || kind === 'frontend'
}

/**
 * @returns {Promise<{
 *   available: boolean
 *   version?: string
 *   changelog?: string
 *   manifest?: FrontendUpdateManifest
 *   error?: string
 * }>}
 */
export async function checkFrontendHotUpdate() {
  if (!isTauri) {
    return { available: false, error: 'not_tauri' }
  }
  try {
    const res = await api.checkFrontendUpdate()
    const manifest = /** @type {FrontendUpdateManifest} */ (res?.manifest || {})
    if (!res?.hasUpdate) {
      return { available: false }
    }
    if (!isFrontendOnlyManifest(manifest)) {
      return { available: false, error: 'not_frontend_only' }
    }
    const url = String(manifest.frontendUrl || '').trim()
    if (!url) {
      return { available: false, error: 'missing_frontend_url' }
    }
    return {
      available: true,
      version: res.latestVersion || manifest.version || '',
      changelog: manifest.changelog || manifest.notes || '',
      manifest,
    }
  } catch (err) {
    return { available: false, error: err?.message || String(err) }
  }
}

/**
 * @param {FrontendUpdateManifest} manifest
 * @param {(p: { phase: string }) => void} [onProgress]
 */
export async function applyFrontendHotUpdate(manifest, onProgress) {
  if (!isTauri) throw new Error('仅桌面端支持界面热更新')
  const url = String(manifest?.frontendUrl || '').trim()
  if (!url) throw new Error('缺少 frontendUrl')
  const hash = String(manifest?.frontendHash || manifest?.hash || '').trim()

  onProgress?.({ phase: 'frontend-applying' })
  await api.downloadFrontendUpdate(url, hash)

  onProgress?.({ phase: 'frontend-reload' })
  window.location.reload()
}
