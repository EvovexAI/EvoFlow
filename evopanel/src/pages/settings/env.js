/**
 * 设置 → 环境变量
 */
import { toast } from '../../components/toast.js'
import {
  fetchCustomEnvVars,
  saveCustomEnvVars,
  verifyCustomEnvVars,
} from '../../lib/custom-env-settings.js'

/** @type {HTMLElement | null} */
let _root = null

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function envRowHtml(key = '', value = '') {
  return `
    <tr>
      <td><input class="cron-input custom-env-key" type="text" placeholder="KEY" value="${escHtml(key)}" spellcheck="false" /></td>
      <td><input class="cron-input custom-env-value" type="password" placeholder="VALUE" value="${escHtml(value)}" spellcheck="false" autocomplete="off" /></td>
      <td class="custom-env-status" style="font-size:12px;color:var(--text-muted,#888)"></td>
      <td><button type="button" class="cron-btn sm" data-custom-env-remove title="删除">×</button></td>
    </tr>`
}

const ENV_INNER_HTML = `
  <div class="config-section">
    <p class="form-hint">为 Agent、terminal 与技能脚本注入持久化环境变量（KEY=VALUE）。技能文档要求什么变量名，在这里填什么即可；保存后立即生效，无需改 .env 或重启。</p>
    <p class="form-hint">仅检查变量是否已在本地填写并生效，不会调用外部 API。配对变量（如可灵 AK/SK、火山 TTS）需同时填写。</p>
    <div id="settings-custom-env-root"><div class="stat-card loading-placeholder" style="height:72px"></div></div>
  </div>
`

function collectCustomEnvFromForm(root) {
  const tbody = root.querySelector('#settings-custom-env-rows')
  if (!tbody) return []
  /** @type {{ key: string, value: string }[]} */
  const vars = []
  tbody.querySelectorAll('tr').forEach((row) => {
    const keyEl = row.querySelector('.custom-env-key')
    const valEl = row.querySelector('.custom-env-value')
    if (!(keyEl instanceof HTMLInputElement) || !(valEl instanceof HTMLInputElement)) return
    const key = keyEl.value.trim()
    if (!key) return
    vars.push({ key, value: valEl.value })
  })
  return vars
}

function applyVerifyResults(root, results) {
  const tbody = root.querySelector('#settings-custom-env-rows')
  if (!tbody) return
  const byKey = new Map(results.map((r) => [String(r.key || '').trim(), r]))
  tbody.querySelectorAll('tr').forEach((row) => {
    const keyEl = row.querySelector('.custom-env-key')
    const statusEl = row.querySelector('.custom-env-status')
    if (!(keyEl instanceof HTMLInputElement) || !(statusEl instanceof HTMLElement)) return
    const key = keyEl.value.trim()
    if (!key) {
      statusEl.textContent = ''
      return
    }
    const item = byKey.get(key)
    if (!item) {
      statusEl.textContent = ''
      return
    }
    if (item.skipped) {
      statusEl.style.color = 'var(--text-muted,#888)'
      statusEl.textContent = '已填写'
      return
    }
    if (item.ok) {
      statusEl.style.color = 'var(--success,#16a34a)'
      statusEl.textContent = item.message || '有效'
    } else {
      statusEl.style.color = 'var(--danger,#dc2626)'
      statusEl.textContent = item.message || '无效'
    }
  })
}

async function renderCustomEnvSettings(root) {
  const host = root.querySelector('#settings-custom-env-root')
  if (!host) return
  host.innerHTML = '<div class="stat-card loading-placeholder" style="height:72px"></div>'
  try {
    const vars = await fetchCustomEnvVars()
    const rows = vars.length ? vars.map((v) => envRowHtml(v.key, v.value)).join('') : envRowHtml()
    host.innerHTML = `
      <table class="custom-env-table" style="width:100%;border-collapse:collapse;margin-top:8px">
        <thead>
          <tr>
            <th style="text-align:left;padding:4px 8px 4px 0;width:32%">变量名 (KEY)</th>
            <th style="text-align:left;padding:4px 8px;width:38%">值 (VALUE)</th>
            <th style="text-align:left;padding:4px 8px;width:22%">校验</th>
            <th style="width:8%"></th>
          </tr>
        </thead>
        <tbody id="settings-custom-env-rows">${rows}</tbody>
      </table>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <button type="button" class="cron-btn sm" id="settings-custom-env-add">添加一行</button>
        <button type="button" class="cron-btn sm" id="settings-custom-env-verify">验证环境变量</button>
        <button type="button" class="cron-btn sm primary" id="settings-custom-env-save">保存环境变量</button>
      </div>`
  } catch (err) {
    host.innerHTML = `<p class="form-hint" style="color:var(--danger)">加载失败：${escHtml(err?.message || err)}</p>`
  }
}

function addCustomEnvRow(root) {
  const tbody = root.querySelector('#settings-custom-env-rows')
  if (!tbody) return
  tbody.insertAdjacentHTML('beforeend', envRowHtml())
}

async function saveCustomEnvFromForm(root) {
  const vars = collectCustomEnvFromForm(root)
  try {
    await saveCustomEnvVars(vars)
    toast('环境变量已保存并生效', 'success')
    await renderCustomEnvSettings(root)
  } catch (err) {
    toast(String(err?.message || err) || '保存失败', 'error')
  }
}

async function verifyCustomEnvFromForm(root) {
  const vars = collectCustomEnvFromForm(root)
  if (!vars.length) {
    toast('请先填写至少一个环境变量', 'warning')
    return
  }
  const btn = root.querySelector('#settings-custom-env-verify')
  if (btn instanceof HTMLButtonElement) {
    btn.disabled = true
    btn.textContent = '验证中…'
  }
  try {
    const results = await verifyCustomEnvVars(vars)
    applyVerifyResults(root, results)
    const failed = results.filter((r) => !r.ok && !r.skipped)
    if (failed.length) {
      toast(`${failed.length} 项验证未通过`, 'error')
    } else {
      toast('验证完成', 'success')
    }
  } catch (err) {
    toast(String(err?.message || err) || '验证失败', 'error')
  } finally {
    if (btn instanceof HTMLButtonElement) {
      btn.disabled = false
      btn.textContent = '验证环境变量'
    }
  }
}

function bindClicks(root) {
  root.addEventListener('click', (e) => {
    const target = e.target
    if (!(target instanceof Element)) return
    if (target.closest('#settings-custom-env-add')) {
      addCustomEnvRow(root)
      return
    }
    if (target.closest('#settings-custom-env-save')) {
      void saveCustomEnvFromForm(root)
      return
    }
    if (target.closest('#settings-custom-env-verify')) {
      void verifyCustomEnvFromForm(root)
      return
    }
    const removeBtn = target.closest('[data-custom-env-remove]')
    if (removeBtn) {
      removeBtn.closest('tr')?.remove()
    }
  })
}

export function cleanup() {
  _root = null
}

/** @param {HTMLElement} container */
export async function mountEnvInto(container) {
  cleanup()
  _root = container
  container.classList.add('settings-modal-pane--env', 'settings-embed-wrap')
  container.innerHTML = ENV_INNER_HTML
  bindClicks(container)
  await renderCustomEnvSettings(container)
}

const ENV_CONTENT_HTML = `
  <div id="settings-custom-env-root"><div class="stat-card loading-placeholder" style="height:72px"></div></div>
`

/** 嵌入通用设置页：仅渲染环境变量表格区域（不含 config-section 外壳） */
export async function mountEnvContentInto(container) {
  _root = container
  container.innerHTML = ENV_CONTENT_HTML
  bindClicks(container)
  await renderCustomEnvSettings(container)
}
