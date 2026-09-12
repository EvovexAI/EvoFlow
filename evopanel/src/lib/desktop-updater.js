/**
 * Windows 桌面端更新（Tauri plugin-updater）。
 * 支持：分步 download → install、就绪后重启、忙碌时 defer。
 */

const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

const LS_READY_VERSION = 'evopanel_desktop_update_ready_version'

/** @type {import('@tauri-apps/plugin-updater').Update | null} */
let _downloadedUpdate = null
/** @type {string} */
let _downloadedVersion = ''
let _downloadInProgress = false

/** @returns {Promise<boolean>} */
export function isDesktopOneClickUpdateSupported() {
  return isTauri
}

/** @returns {boolean} */
export function isDesktopUpdateDownloadInProgress() {
  return _downloadInProgress
}

/** @returns {boolean} */
export function isDesktopUpdateReadyToInstall() {
  return !!_downloadedUpdate
}

/** @returns {string} */
export function getDesktopUpdateReadyVersion() {
  return _downloadedVersion
}

/** 检测是否有会话在跑 Agent / 流式输出，安装重启前应 defer。 */
export async function isAppBusyForUpdateRestart() {
  try {
    const { listBusySessionKeys, listLiveSessionRuntimeKeys } = await import('../react/lib/session-runtime-store.ts')
    if (listBusySessionKeys().length > 0) return true
    if (listLiveSessionRuntimeKeys().length > 0) return true
  } catch {
    /* react store not loaded yet */
  }
  return false
}

/**
 * @returns {Promise<{
 *   available: boolean
 *   version?: string
 *   currentVersion?: string
 *   notes?: string
 *   date?: string
 *   update?: import('@tauri-apps/plugin-updater').Update
 *   error?: string
 * }>}
 */
export async function checkDesktopAppUpdate() {
  if (!isTauri) {
    return { available: false, error: 'not_tauri' }
  }
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (!update) {
      return { available: false }
    }
    return {
      available: true,
      version: update.version,
      currentVersion: update.currentVersion,
      notes: update.body || '',
      date: update.date || '',
      update,
    }
  } catch (err) {
    const msg = err?.message || String(err)
    return { available: false, error: msg }
  }
}

/**
 * @param {import('@tauri-apps/plugin-updater').Update} update
 * @param {(progress: { phase: string, downloaded?: number, total?: number, startedAt?: number }) => void} [onProgress]
 */
export async function downloadDesktopAppUpdate(update, onProgress) {
  if (!update) throw new Error('无待下载的更新')
  if (_downloadInProgress) throw new Error('已有下载任务进行中')

  _downloadInProgress = true
  let downloaded = 0
  let contentLength = 0
  const startedAt = Date.now()

  try {
    await update.download((event) => {
      switch (event.event) {
        case 'Started':
          contentLength = event.data.contentLength || 0
          onProgress?.({ phase: 'started', downloaded: 0, total: contentLength, startedAt })
          break
        case 'Progress':
          downloaded += event.data.chunkLength || 0
          onProgress?.({ phase: 'progress', downloaded, total: contentLength, startedAt })
          break
        case 'Finished':
          onProgress?.({ phase: 'finished', downloaded, total: contentLength, startedAt })
          break
        default:
          break
      }
    })
    _downloadedUpdate = update
    _downloadedVersion = update.version
    try {
      localStorage.setItem(LS_READY_VERSION, update.version)
    } catch {
      /* ignore */
    }
    onProgress?.({ phase: 'ready', downloaded, total: contentLength, startedAt })
    return update
  } finally {
    _downloadInProgress = false
  }
}

/**
 * @param {import('@tauri-apps/plugin-updater').Update} update
 * @param {(progress: { phase: string }) => void} [onProgress]
 * @param {{ force?: boolean, deferIfBusy?: boolean }} [opts]
 */
export async function installDownloadedDesktopUpdate(update, onProgress, opts = {}) {
  const pkg = update || _downloadedUpdate
  if (!pkg) throw new Error('请先下载更新')

  const deferIfBusy = opts.deferIfBusy !== false
  if (deferIfBusy && !opts.force) {
    const busy = await isAppBusyForUpdateRestart()
    if (busy) {
      return { deferred: true, reason: 'busy' }
    }
  }

  onProgress?.({ phase: 'installing' })
  await pkg.install()

  _downloadedUpdate = null
  _downloadedVersion = ''
  try {
    localStorage.removeItem(LS_READY_VERSION)
  } catch {
    /* ignore */
  }

  onProgress?.({ phase: 'relaunch' })
  const { relaunch } = await import('@tauri-apps/plugin-process')
  await relaunch()
  return { deferred: false }
}

/**
 * @param {import('@tauri-apps/plugin-updater').Update} update
 * @param {(progress: { phase: string, downloaded?: number, total?: number, startedAt?: number }) => void} [onProgress]
 * @param {{ deferIfBusy?: boolean, skipDownload?: boolean }} [opts]
 */
export async function installDesktopAppUpdate(update, onProgress, opts = {}) {
  if (!opts.skipDownload) {
    await downloadDesktopAppUpdate(update, onProgress)
  }
  const result = await installDownloadedDesktopUpdate(update, onProgress, opts)
  if (result?.deferred) {
    onProgress?.({ phase: 'ready' })
  }
}

/** 下载完成后发系统通知 */
export async function notifyDesktopUpdateReady(version) {
  try {
    const { notifyDesktopCompletion } = await import('./desktop-notification.js')
    await notifyDesktopCompletion({
      title: 'EvoFlow 更新已就绪',
      body: `v${version || ''} 已下载完成，点击横幅或设置 → 关于 → 立即重启以完成更新。`,
      tag: 'evoflow-update-ready',
    })
  } catch {
    /* ignore */
  }
}

export { formatDownloadProgress, formatUpdatePhaseText, applyUpdateProgressUi, renderUpdateProgressBlock } from './update-progress.js'
