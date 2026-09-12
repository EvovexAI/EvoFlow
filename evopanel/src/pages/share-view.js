/**
 * Read-only shared chat snapshot viewer: #/share/:token
 */
import { api } from '../lib/tauri-api.js'
import { renderMarkdown } from '../lib/markdown.js'

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function roleLabel(msg) {
  const role = String(msg?.role || '').toLowerCase()
  const type = String(msg?.type || '').toLowerCase()
  if (role === 'tool' || type === 'tool') {
    return `工具 · ${esc(msg?.name || 'tool')}`
  }
  if (role === 'user' || role === 'human' || type === 'human') return '用户'
  return '助手'
}

function roleClass(msg) {
  const role = String(msg?.role || '').toLowerCase()
  const type = String(msg?.type || '').toLowerCase()
  if (role === 'tool' || type === 'tool') return 'is-tool'
  if (role === 'user' || role === 'human' || type === 'human') return 'is-user'
  return 'is-assistant'
}

function parseShareTokenFromHash() {
  const hash = window.location.hash.slice(1) || ''
  const path = hash.split('?')[0]
  const m = path.match(/^\/share\/([^/]+)$/)
  return m ? decodeURIComponent(m[1]) : ''
}

function errorDetail(err) {
  const msg = String(err?.message || err || '').trim()
  if (/410|撤销|revok/i.test(msg)) return '分享已撤销或不可用'
  if (/过期|expir/i.test(msg)) return '分享已过期'
  if (/404|not found|不存在/i.test(msg)) return '分享不存在或已失效'
  return msg || '分享不可用'
}

export async function render() {
  const page = document.createElement('div')
  page.className = 'share-view-page'
  page.innerHTML = `
    <div class="share-view-card">
      <div class="share-view-loading">加载分享内容…</div>
    </div>
  `
  const card = page.querySelector('.share-view-card')
  const token = parseShareTokenFromHash()

  if (!token) {
    card.innerHTML = `
      <h1 class="share-view-title">无效链接</h1>
      <p class="share-view-error">缺少分享 token。</p>
    `
    return page
  }

  try {
    const data = await api.shareGet(token)
    const title = String(data?.title || '未命名会话').trim() || '未命名会话'
    const messages = Array.isArray(data?.messages) ? data.messages : []
    const metaBits = []
    if (data?.created_at) metaBits.push(`创建于 ${esc(data.created_at)}`)
    if (data?.expires_at) metaBits.push(`过期 ${esc(data.expires_at)}`)
    else metaBits.push('不过期')
    metaBits.push(`${messages.length} 条消息`)

    const body = messages
      .map((msg) => {
        const text = String(msg?.content || '').trim()
        if (!text) return ''
        let html
        try {
          html = renderMarkdown(text)
        } catch {
          html = esc(text).replace(/\n/g, '<br>')
        }
        return `
          <article class="share-view-msg ${roleClass(msg)}">
            <div class="share-view-msg-role">${roleLabel(msg)}</div>
            <div class="share-view-msg-body">${html}</div>
          </article>
        `
      })
      .filter(Boolean)
      .join('')

    card.innerHTML = `
      <header class="share-view-header">
        <p class="share-view-kicker">只读分享</p>
        <h1 class="share-view-title">${esc(title)}</h1>
        <p class="share-view-meta">${metaBits.join(' · ')}</p>
      </header>
      <div class="share-view-thread">
        ${body || '<p class="share-view-empty">暂无消息</p>'}
      </div>
    `
  } catch (e) {
    card.innerHTML = `
      <h1 class="share-view-title">无法打开分享</h1>
      <p class="share-view-error">${esc(errorDetail(e))}</p>
    `
  }

  return page
}
