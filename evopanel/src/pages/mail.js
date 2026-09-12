/**
 * 邮箱 / SMTP 设置：写入 evopanel.json 的 email 字段（Web 模式写入 localStorage 备份）
 */
import { api } from '../lib/tauri-api.js'
import { getPanelSetting, patchPanelSettings } from '../lib/panel-settings.js'
import { toast } from '../components/toast.js'

const isTauri = !!window.__TAURI_INTERNALS__
const LS_EMAIL = 'evopanel-email-config-v1'

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function defaultEmail() {
  return {
    enabled: false,
    host: '',
    port: 587,
    secure: 'starttls',
    username: '',
    password: '',
    fromName: '',
    fromAddress: '',
  }
}

async function loadEmailState() {
  if (isTauri) {
    try {
      const cfg = await api.readPanelConfig()
      const e = cfg?.email && typeof cfg.email === 'object' ? cfg.email : {}
      return { ...defaultEmail(), ...e }
    } catch {
      return defaultEmail()
    }
  }
  const e = getPanelSetting('email', {})
  return { ...defaultEmail(), ...(e && typeof e === 'object' ? e : {}) }
}

async function saveEmailState(email) {
  if (isTauri) {
    const cfg = await api.readPanelConfig()
    cfg.email = email
    await api.writePanelConfig(cfg)
  }
  await patchPanelSettings({ email })
}

function bindMailSave(root) {
  root.querySelector('#mail-btn-save').onclick = async () => {
    const prev = await loadEmailState()
    const pwdInput = root.querySelector('#mail-password')
    const pwdVal = (pwdInput?.value || '').trim()
    const portRaw = root.querySelector('#mail-port')?.value
    const port = Math.min(65535, Math.max(1, parseInt(portRaw, 10) || 587))

    const next = {
      enabled: root.querySelector('#mail-enabled')?.checked || false,
      host: (root.querySelector('#mail-host')?.value || '').trim(),
      port,
      secure: root.querySelector('#mail-secure')?.value || 'starttls',
      username: (root.querySelector('#mail-user')?.value || '').trim(),
      password: pwdVal || (prev.password || ''),
      fromName: (root.querySelector('#mail-from-name')?.value || '').trim(),
      fromAddress: (root.querySelector('#mail-from-addr')?.value || '').trim(),
    }

    if (next.enabled) {
      if (!next.host) {
        toast('请填写 SMTP 主机', 'error')
        return
      }
      if (!next.fromAddress) {
        toast('请填写发件人邮箱', 'error')
        return
      }
    }

    try {
      await saveEmailState(next)
      toast('邮箱配置已保存', 'success')
      pwdInput.value = ''
      pwdInput.placeholder = next.password ? '已保存，留空则不修改' : ''
    } catch (e) {
      toast(String(e), 'error')
    }
  }
}

/** 嵌入设置中心等容器 */
export async function mountMailInto(container) {
  const state = await loadEmailState()
  const hasStoredPassword = !!(state.password && String(state.password).length > 0)

  container.innerHTML = `
      ${!isTauri ? `<p class="form-hint" style="margin-bottom:var(--space-md)">Web 模式下配置保存在浏览器 localStorage，仅作开发预览；桌面版写入本机 evopanel.json。</p>` : ''}
      <div class="config-section">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:var(--font-size-sm)">
          <input type="checkbox" id="mail-enabled" ${state.enabled ? 'checked' : ''}>
          启用 SMTP
        </label>
      </div>
      <div class="config-section">
        <div class="config-section-title">服务器</div>
        <div style="display:flex;flex-wrap:wrap;gap:var(--space-sm);align-items:flex-end">
          <div>
            <label class="form-hint" for="mail-host">主机</label>
            <input class="form-input" id="mail-host" placeholder="smtp.example.com" value="${esc(state.host)}" style="min-width:220px">
          </div>
          <div>
            <label class="form-hint" for="mail-port">端口</label>
            <input class="form-input" id="mail-port" type="number" min="1" max="65535" value="${esc(String(state.port || 587))}" style="width:100px">
          </div>
          <div>
            <label class="form-hint" for="mail-secure">加密</label>
            <select class="form-input" id="mail-secure" style="min-width:140px">
              <option value="starttls" ${state.secure === 'starttls' ? 'selected' : ''}>STARTTLS（常见 587）</option>
              <option value="ssl" ${state.secure === 'ssl' ? 'selected' : ''}>SSL/TLS（常见 465）</option>
              <option value="none" ${state.secure === 'none' ? 'selected' : ''}>无（内网/测试）</option>
            </select>
          </div>
        </div>
      </div>
      <div class="config-section">
        <div class="config-section-title">认证</div>
        <div style="display:flex;flex-direction:column;gap:var(--space-sm);max-width:400px">
          <div>
            <label class="form-hint" for="mail-user">用户名</label>
            <input class="form-input" id="mail-user" autocomplete="username" value="${esc(state.username)}" style="width:100%">
          </div>
          <div>
            <label class="form-hint" for="mail-password">密码 / 应用专用密码</label>
            <input class="form-input" id="mail-password" type="password" autocomplete="current-password" placeholder="${hasStoredPassword ? '已保存，留空则不修改' : ''}" style="width:100%">
          </div>
        </div>
      </div>
      <div class="config-section">
        <div class="config-section-title">发件人</div>
        <div style="display:flex;flex-direction:column;gap:var(--space-sm);max-width:400px">
          <div>
            <label class="form-hint" for="mail-from-name">显示名称</label>
            <input class="form-input" id="mail-from-name" value="${esc(state.fromName)}" style="width:100%">
          </div>
          <div>
            <label class="form-hint" for="mail-from-addr">邮箱地址</label>
            <input class="form-input" id="mail-from-addr" type="email" placeholder="noreply@example.com" value="${esc(state.fromAddress)}" style="width:100%">
          </div>
        </div>
      </div>
      <div class="config-section">
        <button type="button" class="btn btn-primary" id="mail-btn-save">保存</button>
        <p class="form-hint" style="margin-top:var(--space-sm)">请勿将含密码的配置提交到版本库；生产环境建议使用环境变量或密钥管理服务。</p>
      </div>
  `

  bindMailSave(container)
}

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">邮箱 / SMTP</h1>
        <p class="page-desc">配置发信参数，供后续通知、告警等功能读取；当前由面板保存配置，实际发信需服务端实现对应逻辑。</p>
      </div>
    </div>
    <div class="page-content" style="max-width:640px" id="mail-standalone-root"></div>
  `

  await mountMailInto(page.querySelector('#mail-standalone-root'))
  return page
}
