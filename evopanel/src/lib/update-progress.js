/**
 * 共享更新进度 UI：文字 + 条形进度 + ETA。
 */

/** @param {number} n */
function mb(n) {
  return (n / (1024 * 1024)).toFixed(1)
}

/**
 * @param {number} downloaded
 * @param {number} total
 * @param {number} [startedAt]
 */
export function formatDownloadProgress(downloaded, total, startedAt) {
  if (!total || total <= 0) {
    return '正在下载…'
  }
  const pct = Math.min(100, Math.round((downloaded / total) * 100))
  let eta = ''
  if (startedAt && downloaded > 0 && downloaded < total) {
    const elapsed = (Date.now() - startedAt) / 1000
    const speed = downloaded / Math.max(elapsed, 0.5)
    const remain = (total - downloaded) / Math.max(speed, 1)
    if (remain < 3600) {
      const mins = Math.floor(remain / 60)
      const secs = Math.max(1, Math.round(remain % 60))
      eta = mins > 0 ? ` · 约剩 ${mins} 分 ${secs} 秒` : ` · 约剩 ${secs} 秒`
    }
  }
  return `正在下载 ${pct}%（${mb(downloaded)} / ${mb(total)} MB）${eta}`
}

/** @param {{ phase?: string, downloaded?: number, total?: number, startedAt?: number, message?: string }} p */
export function formatUpdatePhaseText(p) {
  if (p.message) return p.message
  switch (p.phase) {
    case 'started':
      return '准备下载…'
    case 'progress':
      return formatDownloadProgress(p.downloaded || 0, p.total || 0, p.startedAt)
    case 'finished':
      return '下载完成，准备安装…'
    case 'installing':
      return '正在安装，请稍候…'
    case 'ready':
      return '更新已下载，重启后生效'
    case 'relaunch':
      return '正在重启应用…'
    case 'frontend-applying':
      return '正在应用界面更新…'
    case 'frontend-reload':
      return '正在刷新界面…'
    default:
      return ''
  }
}

/**
 * @param {{ pct?: number, text?: string, visible?: boolean }} opts
 */
export function renderUpdateProgressBlock(opts = {}) {
  const visible = opts.visible !== false
  const pct = Math.min(100, Math.max(0, Math.round(opts.pct || 0)))
  const text = opts.text || ''
  return `
    <div class="update-progress-wrap${visible ? '' : ' update-progress-hidden'}">
      <div class="update-progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
        <div class="update-progress-bar-fill" style="width:${pct}%"></div>
      </div>
      <span class="update-progress-text">${text}</span>
    </div>
  `
}

/**
 * @param {HTMLElement | null | undefined} root
 * @param {{ phase?: string, downloaded?: number, total?: number, startedAt?: number, message?: string, pct?: number }} progress
 */
export function applyUpdateProgressUi(root, progress) {
  if (!root) return
  const wrap = root.classList?.contains('update-progress-wrap')
    ? root
    : root.querySelector?.('.update-progress-wrap')
  if (!wrap) return

  const text = formatUpdatePhaseText(progress)
  const textEl = wrap.querySelector('.update-progress-text')
  if (textEl) textEl.textContent = text

  let pct = progress.pct
  if (pct == null && progress.total && progress.total > 0) {
    pct = Math.round(((progress.downloaded || 0) / progress.total) * 100)
  }
  if (progress.phase === 'finished' || progress.phase === 'installing') pct = 100
  if (progress.phase === 'ready' || progress.phase === 'relaunch') pct = 100

  const bar = wrap.querySelector('.update-progress-bar')
  const fill = wrap.querySelector('.update-progress-bar-fill')
  if (fill) fill.style.width = `${Math.min(100, Math.max(0, pct || 0))}%`
  if (bar) bar.setAttribute('aria-valuenow', String(Math.min(100, Math.max(0, pct || 0))))

  wrap.classList.toggle('update-progress-hidden', !text && !(pct > 0))
}
