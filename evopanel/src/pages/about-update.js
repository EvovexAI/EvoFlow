/**
 * 关于页：检查更新、后台下载、就绪后重启 / 界面热更新
 */
import { api } from '../lib/tauri-api.js'
import { renderUpdateProgressBlock } from '../lib/update-progress.js'
import { applyUpdateProgressUi } from '../lib/update-progress.js'

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * @param {HTMLElement} container
 * @param {{ resultEl: HTMLElement, btn: HTMLButtonElement }} ui
 */
export async function runAboutUpdateCheck(container, { resultEl, btn }) {
  btn.disabled = true
  btn.textContent = '检查中…'
  resultEl.innerHTML = ''

  try {
    const { resolveUpdateOffer, isUpdateReadyToInstall } = await import('../lib/update-manager.js')
    const offer = await resolveUpdateOffer()

    if (!offer) {
      let currentVersion = ''
      try {
        const res = await api.checkFrontendUpdate()
        currentVersion = res.currentVersion || ''
      } catch {
        /* ignore */
      }
      resultEl.innerHTML = `<p class="up-to-date">已是最新版本${currentVersion ? `（当前 ${escapeHtml(currentVersion)}）` : ''}</p>`
      return
    }

    const ready = isUpdateReadyToInstall(offer)
    const isFrontend = offer.kind === 'frontend-only'
    const primaryLabel = ready
      ? (isFrontend ? '立即应用界面更新' : '立即重启以完成更新')
      : (isFrontend ? '下载并应用界面更新' : '一键更新并重启')

    resultEl.innerHTML = `
      <div class="about-update-available">
        <span class="update-badge">${ready ? '更新已就绪' : '有可用更新'}</span>
        <p>最新版本：${escapeHtml(offer.ver)}</p>
        ${offer.changelog ? `<p class="update-hint">${escapeHtml(offer.changelog)}</p>` : ''}
        ${ready && !isFrontend ? '<p class="update-hint">安装包已下载，重启后生效。</p>' : ''}
        <div id="about-update-progress">${renderUpdateProgressBlock({ visible: false, text: '', pct: 0 })}</div>
        ${offer.oneClick
    ? `<button type="button" class="about-check-btn" id="about-install-update">${primaryLabel}</button>`
    : `<button type="button" class="about-check-btn" id="about-download-update">下载安装包</button>`}
        <a class="about-link" href="https://github.com/EvovexAI/EvoFlow/releases" target="_blank" rel="noopener" style="display:inline-block;margin-top:8px">查看更新说明</a>
      </div>
    `

    const progressRoot = resultEl.querySelector('#about-update-progress .update-progress-wrap')

    if (offer.oneClick) {
      container.querySelector('#about-install-update')?.addEventListener('click', () => {
        void runAboutInstall(container, offer, progressRoot)
      })
    } else {
      container.querySelector('#about-download-update')?.addEventListener('click', () => {
        window.open(offer.manualUrl || 'https://github.com/EvovexAI/EvoFlow/releases', '_blank')
      })
    }
  } catch (err) {
    const msg = err?.message || String(err)
    resultEl.innerHTML = `<p class="update-error">检查失败：${escapeHtml(msg)}</p><p class="update-hint">请前往 <a href="https://github.com/EvovexAI/EvoFlow/releases" target="_blank" rel="noopener">GitHub Releases</a> 查看最新版本</p>`
  } finally {
    btn.disabled = false
    btn.textContent = '检查更新'
  }
}

/**
 * @param {HTMLElement} container
 * @param {import('../lib/update-manager.js').UpdateOffer} offer
 * @param {HTMLElement | null} progressRoot
 */
async function runAboutInstall(container, offer, progressRoot) {
  const btn = container.querySelector('#about-install-update')
  if (btn) {
    btn.disabled = true
    btn.textContent = '正在更新…'
  }

  const onProgress = (p) => {
    if (!progressRoot) return
    progressRoot.classList.remove('update-progress-hidden')
    applyUpdateProgressUi(progressRoot, p)
  }

  try {
    const { runUpdateInstall } = await import('../lib/update-manager.js')
    const result = await runUpdateInstall(offer, onProgress)
    if (result?.deferred) {
      onProgress({ phase: 'ready', message: '当前有任务进行中，请稍后再试「立即重启」' })
      if (btn) {
        btn.disabled = false
        btn.textContent = '立即重启以完成更新'
      }
    }
  } catch (err) {
    if (progressRoot) {
      progressRoot.classList.remove('update-progress-hidden')
      applyUpdateProgressUi(progressRoot, { message: `更新失败：${err?.message || err}。可改用手动下载安装包。` })
    }
    if (btn) {
      btn.disabled = false
      btn.textContent = '重试一键更新'
    }
  }
}
