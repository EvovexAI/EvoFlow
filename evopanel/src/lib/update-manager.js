/**
 * 统一更新编排：整包 / 前端热更 / 手动 exe 降级。
 */

import { api } from './tauri-api.js'
import { getPanelSetting } from './panel-settings.js'
import { checkFrontendHotUpdate, applyFrontendHotUpdate, isFrontendOnlyManifest } from './frontend-updater.js'
import {
  checkDesktopAppUpdate,
  downloadDesktopAppUpdate,
  installDownloadedDesktopUpdate,
  isDesktopUpdateReadyToInstall,
  getDesktopUpdateReadyVersion,
  isDesktopUpdateDownloadInProgress,
  notifyDesktopUpdateReady,
} from './desktop-updater.js'

const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

/**
 * @typedef {'full' | 'frontend-only' | 'manual'} UpdateOfferKind
 * @typedef {Object} UpdateOffer
 * @property {string} ver
 * @property {string} changelog
 * @property {string} manualUrl
 * @property {boolean} oneClick
 * @property {UpdateOfferKind} kind
 * @property {import('@tauri-apps/plugin-updater').Update | null} [update]
 * @property {Record<string, unknown>} [manifest]
 */

/** @returns {boolean} */
export function isAutoDownloadUpdatesEnabled() {
  const v = getPanelSetting('autoDownloadUpdates', true)
  return v !== false && v !== 'false' && v !== 0
}

/**
 * @param {Record<string, unknown> | null | undefined} manifest
 * @param {string} ver
 * @returns {UpdateOffer}
 */
function manualInstallerOffer(manifest, ver) {
  return {
    ver,
    changelog: String(manifest?.changelog || manifest?.notes || ''),
    manualUrl: String(manifest?.url || 'https://github.com/EvovexAI/EvoFlow/releases'),
    oneClick: false,
    kind: 'manual',
    update: null,
    manifest: manifest || undefined,
  }
}

/**
 * @returns {Promise<UpdateOffer | null>}
 */
export async function resolveUpdateOffer() {
  /** @type {{ hasUpdate?: boolean, latestVersion?: string, manifest?: Record<string, unknown> } | null} */
  let manifestRes = null
  try {
    manifestRes = await api.checkFrontendUpdate()
  } catch {
    manifestRes = null
  }

  const manifest = manifestRes?.manifest || null
  const hasManifestUpdate = Boolean(manifestRes?.hasUpdate)
  const verFromManifest = String(manifestRes?.latestVersion || manifest?.version || '')

  if (isTauri && hasManifestUpdate && isFrontendOnlyManifest(manifest)) {
    try {
      const hot = await checkFrontendHotUpdate()
      if (hot.available) {
        return {
          ver: hot.version || verFromManifest,
          changelog: hot.changelog || '',
          manualUrl: '',
          oneClick: true,
          kind: 'frontend-only',
          update: null,
          manifest: hot.manifest,
        }
      }
    } catch {
      /* fall through to full / manual */
    }
  }

  if (isTauri) {
    try {
      const desktop = await checkDesktopAppUpdate()
      if (desktop.available && desktop.update) {
        return {
          ver: desktop.version || verFromManifest,
          changelog: desktop.notes || String(manifest?.changelog || manifest?.notes || ''),
          manualUrl: String(manifest?.url || ''),
          oneClick: true,
          kind: 'full',
          update: desktop.update,
          manifest: manifest || undefined,
        }
      }
    } catch {
      /* no signed updater bundle — fall back to installer link */
    }
  }

  if (!hasManifestUpdate || !verFromManifest) return null

  if (isTauri && isFrontendOnlyManifest(manifest) && manifest?.frontendUrl) {
    return {
      ver: verFromManifest,
      changelog: String(manifest?.changelog || manifest?.notes || ''),
      manualUrl: '',
      oneClick: true,
      kind: 'frontend-only',
      update: null,
      manifest,
    }
  }

  return manualInstallerOffer(manifest, verFromManifest)
}

/**
 * @param {UpdateOffer} offer
 * @param {(p: import('./update-progress.js').formatUpdatePhaseText extends Function ? Parameters<typeof import('./desktop-updater.js').downloadDesktopAppUpdate>[1] extends infer F ? F extends (p: infer P) => void ? P : never : never : never) => void} [onProgress]
 */
export async function startBackgroundDownload(offer, onProgress) {
  if (!offer?.oneClick || offer.kind !== 'full' || !offer.update) {
    return { started: false }
  }
  if (isDesktopUpdateDownloadInProgress()) {
    return { started: false, reason: 'in_progress' }
  }
  if (isDesktopUpdateReadyToInstall() && getDesktopUpdateReadyVersion() === offer.ver) {
    onProgress?.({ phase: 'ready' })
    return { started: false, reason: 'already_ready' }
  }

  await downloadDesktopAppUpdate(offer.update, onProgress)
  await notifyDesktopUpdateReady(offer.ver)
  return { started: true, ready: true }
}

/**
 * @param {UpdateOffer} offer
 * @param {(p: { phase: string, downloaded?: number, total?: number, startedAt?: number, message?: string }) => void} onProgress
 * @param {{ forceRestart?: boolean }} [opts]
 */
export async function runUpdateInstall(offer, onProgress, opts = {}) {
  if (offer.kind === 'frontend-only' && offer.manifest) {
    await applyFrontendHotUpdate(offer.manifest, onProgress)
    return { ok: true }
  }

  if (offer.kind === 'full' && offer.update) {
    if (!isDesktopUpdateReadyToInstall() || getDesktopUpdateReadyVersion() !== offer.ver) {
      await downloadDesktopAppUpdate(offer.update, onProgress)
      await notifyDesktopUpdateReady(offer.ver)
    }
    const result = await installDownloadedDesktopUpdate(null, onProgress, {
      force: !!opts.forceRestart,
      deferIfBusy: !opts.forceRestart,
    })
    if (result?.deferred) {
      onProgress?.({ phase: 'ready', message: '当前有任务进行中，请稍后在横幅点「立即重启」' })
      return { ok: false, deferred: true }
    }
    return { ok: true }
  }

  throw new Error('当前更新需手动下载安装包')
}

/** @param {UpdateOffer} offer */
export function isUpdateReadyToInstall(offer) {
  if (offer?.kind === 'full') {
    return isDesktopUpdateReadyToInstall() && getDesktopUpdateReadyVersion() === offer.ver
  }
  return false
}

export {
  isDesktopUpdateDownloadInProgress,
  isDesktopUpdateReadyToInstall,
  getDesktopUpdateReadyVersion,
  downloadDesktopAppUpdate,
  installDownloadedDesktopUpdate,
  checkDesktopAppUpdate,
  applyFrontendHotUpdate,
}
