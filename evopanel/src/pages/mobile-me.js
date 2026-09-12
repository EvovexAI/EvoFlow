/**
 * 手机端「我的」：次要入口聚合页（设置 / 员工 / 工作流等）
 * 仅窄屏主路径使用；桌面仍走原侧栏，不改业务逻辑。
 */
import { navigate } from '../router.js'
import {
  isJwtSession,
  logoutToLocalAdmin,
  navigateSwitchUser,
  refreshMe,
  sessionHint,
  sessionLabel,
  userAvatarHtml,
} from '../lib/account-session.js'
import { getGatewayBaseUrl } from '../lib/tauri-api.js'

const LINKS = [
  { path: '/settings', title: '设置', desc: '外观、模型、远程访问等' },
  { path: '/proactive', title: '智能体员工', desc: '值班岗位与工作日志' },
  { path: '/apps', title: '工作流', desc: '编排与填参运行' },
  { path: '/expert', title: '智能体', desc: '角色与专家能力' },
  { path: '/cron', title: '自动化', desc: '定时与规则' },
  { path: '/extensions', title: '扩展应用', desc: '安装的扩展入口' },
  { path: '/models', title: '模型', desc: '模型目录与连接' },
  { path: '/assets', title: '资产中心', desc: '画像 / 记忆 / 经验 / 反思 / 专长' },
  { path: '/memory', title: '记忆', desc: '用户偏好记忆' },
  { path: '/skills', title: '技能', desc: '技能目录' },
  { path: '/tools', title: '工具', desc: '工具与 MCP' },
]

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
}

function accountCardHtml(me, gatewayBase = '') {
  const label = sessionLabel(me)
  const hint = sessionHint(me)
  const jwt = isJwtSession()
  return `
    <section class="mobile-me-account">
      <div class="mobile-me-account-main">
        ${userAvatarHtml(me, { gatewayBase, size: 18, className: 'mobile-me-account-avatar' })}
        <div class="mobile-me-account-text">
          <div class="mobile-me-account-name">${esc(label)}</div>
          <div class="mobile-me-account-hint">${esc(hint)}</div>
        </div>
      </div>
      <div class="mobile-me-account-actions">
        <button type="button" class="mobile-me-account-btn" data-me-act="switch">切换用户</button>
        ${
          jwt
            ? '<button type="button" class="mobile-me-account-btn mobile-me-account-btn--ghost" data-me-act="logout">退出账号</button>'
            : ''
        }
      </div>
    </section>`
}

export async function render() {
  const el = document.createElement('div')
  el.className = 'page mobile-me-page'
  const me = await refreshMe()
  let gatewayBase = ''
  try {
    gatewayBase = (await getGatewayBaseUrl()) || ''
  } catch {
    gatewayBase = ''
  }
  el.innerHTML = `
    <header class="mobile-me-head">
      <h1 class="mobile-me-title">我的</h1>
      <p class="mobile-me-desc">设置与其它功能入口。对话、任务、知识库请用底部导航。</p>
    </header>
    ${accountCardHtml(me, gatewayBase)}
    <ul class="mobile-me-list" role="list">
      ${LINKS.map(
        (item) => `
        <li>
          <button type="button" class="mobile-me-item" data-me-nav="${esc(item.path)}">
            <span class="mobile-me-item-text">
              <span class="mobile-me-item-title">${esc(item.title)}</span>
              <span class="mobile-me-item-desc">${esc(item.desc)}</span>
            </span>
            <span class="mobile-me-item-chev" aria-hidden="true">›</span>
          </button>
        </li>`,
      ).join('')}
    </ul>
  `
  el.addEventListener('click', (e) => {
    const actBtn = e.target.closest('[data-me-act]')
    if (actBtn) {
      const act = actBtn.getAttribute('data-me-act')
      if (act === 'switch') {
        navigateSwitchUser('/me')
        return
      }
      if (act === 'logout') {
        logoutToLocalAdmin()
        return
      }
    }
    const btn = e.target.closest('[data-me-nav]')
    if (!btn) return
    const path = btn.getAttribute('data-me-nav')
    if (path) navigate(path)
  })
  return el
}

export function cleanup() {}
