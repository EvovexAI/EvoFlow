/**
 * 知识库列表页
 * 卡片网格展示所有知识库，支持新建、删除、搜索、分页
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showConfirm, showModal } from '../components/modal.js'
import {
  bindListPager,
  paginateItems,
  readStoredPageSize,
  renderListPagerHtml,
  writeStoredPageSize,
} from '../components/list-pager.js'

const KB_PAGE_SIZE_KEY = 'evopanel_knowledge_page_size'

let _loadSeq = 0
let _listPollTimer = null
/** @type {any[]} */
let _kbItems = []
let _kbFilter = ''
let _kbPage = 1
let _kbPageSize = readStoredPageSize(KB_PAGE_SIZE_KEY)

function esc(str) {
  if (!str) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot')
}

function formatTime(ts) {
  if (!ts) return ''
  try {
    const d = new Date(ts)
    return d.toLocaleDateString('zh-CN') + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  } catch { return ts }
}

function publicKbStatus(status) {
  const s = String(status || '').trim().toLowerCase()
  if (s === 'processing' || s === 'pending' || s === 'parsing' || s === 'chunking' || s === 'embedding') {
    return 'processing'
  }
  if (s === 'error') return 'error'
  return 'ready'
}

function statusLabel(status) {
  const pub = publicKbStatus(status)
  const map = {
    ready: { text: '已就绪', cls: 'kb-st-ready' },
    processing: { text: '处理中', cls: 'kb-st-proc' },
    error: { text: '失败', cls: 'kb-st-err' },
  }
  const s = map[pub] || map.ready
  return `<span class="kb-status-badge ${s.cls}">${s.text}</span>`
}

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-header" style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px">
      <div>
        <h1 class="page-title">上传文档</h1>
        <p class="page-desc">管理上传文档知识库（RAG）。Obsidian Vault 请使用侧栏「Obsidian Vault」。</p>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0;margin-top:4px">
        <button type="button" class="btn btn-secondary" id="btn-goto-vaults" data-testid="goto-obsidian-vaults">Obsidian Vault</button>
        <button id="btn-new-kb">＋ 新建知识库</button>
      </div>
    </div>

    <div class="role-toolbar" style="margin-bottom:var(--space-sm);padding:0 0 18px">
      <div class="role-search-wrap" style="width:auto;flex:1;max-width:400px;min-width:200px">
        <svg class="role-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <input class="role-search-input" id="kb-filter-input" placeholder="搜索知识库...">
      </div>
      <span class="role-total" id="kb-count"></span>
    </div>

    <div id="kb-list" class="config-section">
      <div class="stat-card loading-placeholder" style="height:120px"></div>
    </div>
    <div class="kb-list-pager-wrap" id="kb-list-pager"></div>
  `

  bindEvents(page)
  loadList(page)
  void import('../lib/page-live-refresh.js').then(({ subscribePageLiveRefresh }) => {
    page._xmLiveUnsub = subscribePageLiveRefresh(() => void loadList(page), { domains: ['knowledge'] })
  })
  return page
}

function bindEvents(page) {
  page.querySelector('#btn-new-kb').addEventListener('click', () => showCreateModal(page))
  page.querySelector('#btn-goto-vaults')?.addEventListener('click', () => {
    window.location.hash = '#/knowledge/vaults'
  })
  page.querySelector('#kb-filter-input').addEventListener('input', (e) => {
    _kbFilter = e.target.value.trim().toLowerCase()
    _kbPage = 1
    paintKbList(page)
  })
}

function filteredKbItems() {
  const q = String(_kbFilter || '').trim().toLowerCase()
  if (!q) return _kbItems
  return _kbItems.filter((kb) => {
    const name = String(kb.name || kb.dataset_id || '').toLowerCase()
    const desc = String(kb.description || '').toLowerCase()
    return name.includes(q) || desc.includes(q)
  })
}

async function loadList(page) {
  const el = page.querySelector('#kb-list')
  if (!el) return
  const seq = ++_loadSeq

  el.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-tertiary)">正在加载知识库...</div>`
  const pagerWrap = page.querySelector('#kb-list-pager')
  if (pagerWrap) pagerWrap.innerHTML = ''

  try {
    const data = await api.listKnowledgeBases()
    if (seq !== _loadSeq) return
    _kbItems = data?.items || []
    paintKbList(page)
    if (_listPollTimer) clearTimeout(_listPollTimer)
    if (_kbItems.some((kb) => publicKbStatus(kb.status) === 'processing')) {
      _listPollTimer = setTimeout(() => loadList(page), 4000)
    }
  } catch (e) {
    if (seq !== _loadSeq) return
    el.innerHTML = `<div style="padding:20px">
      <div style="color:var(--error);margin-bottom:8px">加载失败: ${esc(e?.message || e)}</div>
      <button class="btn btn-secondary btn-sm" id="btn-kb-retry">重试</button>
    </div>`
    if (pagerWrap) pagerWrap.innerHTML = ''
    el.querySelector('#btn-kb-retry').onclick = () => loadList(page)
  }
}

function paintKbList(page) {
  const el = page.querySelector('#kb-list')
  if (!el) return
  const filtered = filteredKbItems()
  renderList(page, el, filtered)
}

function renderList(page, el, items) {
  const countEl = page.querySelector('#kb-count')
  const pagerWrap = page.querySelector('#kb-list-pager')
  if (countEl) {
    const totalAll = _kbItems.length
    countEl.textContent =
      _kbFilter && items.length !== totalAll
        ? `${items.length} / ${totalAll} 个知识库`
        : `${items.length} 个知识库`
  }

  if (items.length === 0) {
    el.innerHTML = `
      <div class="kb-empty-state">
        <div class="kb-empty-icon">📚</div>
        <div class="kb-empty-text">${
          _kbFilter ? '没有匹配的知识库' : '还没有知识库，创建一个开始管理文档'
        }</div>
        ${
          _kbFilter
            ? ''
            : '<button id="btn-empty-create">＋ 新建知识库</button>'
        }
      </div>`
    el.querySelector('#btn-empty-create')?.addEventListener('click', () => showCreateModal(page))
    if (pagerWrap) pagerWrap.innerHTML = ''
    return
  }

  const paged = paginateItems(items, _kbPage, _kbPageSize)
  _kbPage = paged.page
  _kbPageSize = paged.pageSize

  el.innerHTML = `<div class="kb-list-grid">${paged.items.map(renderCard).join('')}</div>`

  el.querySelectorAll('.kb-card').forEach((card) => {
    const id = card.dataset.id
    card.addEventListener('click', (e) => {
      if (e.target.closest('.kb-card-delete')) return
      window.location.hash = `#/knowledge/${id}`
    })
    const delBtn = card.querySelector('.kb-card-delete')
    if (delBtn) {
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation()
        const name = card.dataset.name
        const ok = await showConfirm(`确定删除知识库「${name}」？所有文档和向量将被永久删除。`)
        if (!ok) return
        try {
          await api.deleteKnowledgeBase(id)
          toast('删除成功')
          loadList(page)
        } catch (err) {
          toast('删除失败: ' + (err?.message || err), 'error')
        }
      })
    }
  })

  if (pagerWrap) {
    pagerWrap.innerHTML = renderListPagerHtml({
      total: paged.total,
      page: paged.page,
      pageCount: paged.pageCount,
      pageSize: paged.pageSize,
      from: paged.from,
      to: paged.to,
      unit: '个',
    })
    bindListPager(pagerWrap, {
      page: paged.page,
      pageCount: paged.pageCount,
      onPage: (next) => {
        _kbPage = next
        paintKbList(page)
      },
      onPageSize: (nextSize) => {
        _kbPageSize = nextSize
        _kbPage = 1
        writeStoredPageSize(KB_PAGE_SIZE_KEY, nextSize)
        paintKbList(page)
      },
    })
  }
}

function renderCard(kb) {
  const name = esc(kb.name || kb.dataset_id)
  const desc = esc(kb.description || '')
  const fileCount = kb.file_count || 0
  const status = kb.status || 'ready'
  const model = esc(kb.embedding_model || 'text-embedding-3-small')
  const time = formatTime(kb.created_at)

  return `
    <div class="kb-card stat-card stat-card-clickable" data-id="${esc(kb.dataset_id)}" data-name="${name}" data-desc="${desc}">
      <button type="button" class="kb-card-delete" title="删除">×</button>
      <div class="kb-card-header">
        <span class="kb-card-icon">📚</span>
        <div class="kb-card-title-row">
          <div class="kb-card-title">${name}</div>
          ${statusLabel(status)}
        </div>
      </div>
      ${desc ? `<div class="kb-card-desc">${desc}</div>` : ''}
      <div class="kb-card-meta">
        <span class="kb-card-meta-item">📄 ${fileCount} 篇文档</span>
        <span class="kb-card-meta-item">🤖 ${model}</span>
        ${kb.local_source_path ? '<span class="kb-card-meta-item">📁 本地目录</span>' : ''}
      </div>
      <div class="kb-card-time">${time}</div>
    </div>
  `
}

function showCreateModal(page) {
  void openCreateModal(page)
}

async function pickLocalFolderPath() {
  try {
    if (window.__TAURI__?.dialog?.open) {
      const selected = await window.__TAURI__.dialog.open({ directory: true, multiple: false })
      return selected ? String(selected) : ''
    }
  } catch { /* ignore */ }
  return ''
}

function attachFolderBrowseButton() {
  const input = document.querySelector('.modal-overlay [data-name="local_source_path"]')
  if (!input || input.dataset.kbBrowseBound) return
  input.dataset.kbBrowseBound = '1'
  const wrap = document.createElement('div')
  wrap.style.display = 'flex'
  wrap.style.gap = '8px'
  wrap.style.marginTop = '4px'
  const browseBtn = document.createElement('button')
  browseBtn.type = 'button'
  browseBtn.className = 'btn btn-secondary btn-sm'
  browseBtn.textContent = '选择文件夹…'
  browseBtn.onclick = async (e) => {
    e.preventDefault()
    const path = await pickLocalFolderPath()
    if (path) input.value = path
  }
  input.parentElement?.insertBefore(wrap, input.nextSibling)
  wrap.appendChild(browseBtn)
}

async function openCreateModal(page) {
  let embeddingOptions
  try {
    const list = await api.listModels()
    const models = Array.isArray(list?.models) ? list.models : []
    embeddingOptions = collectEmbeddingModelOptions(models)
  } catch (e) {
    toast('加载向量模型失败: ' + (e?.message || e), 'error')
    return
  }

  if (!embeddingOptions.length) {
    toast('请先在 设置 → 模型 → 向量模型 中添加向量模型', 'warning')
    return
  }

  showModal({
    title: '新建知识库',
    width: 480,
    fields: [
      { name: 'name', label: '名称', type: 'text', placeholder: '如：产品文档', required: true },
      {
        name: 'embedding_model',
        label: '向量模型',
        type: 'select',
        options: embeddingOptions,
        value: embeddingOptions[0].value,
      },
      {
        name: 'local_source_path',
        label: '本地文件夹（可选）',
        type: 'text',
        placeholder: '绑定后自动扫描，无需手动上传',
        hint: '桌面端可点下方按钮选择；文档在原位置读取，只做向量化与分块',
      },
      {
        name: 'llm_index_enabled',
        label: 'LLM 智能索引',
        type: 'checkbox',
        value: true,
        hint: '开启：语义分块 + 摘要/索引；关闭：规则分块 + 向量化（更快）',
      },
    ],
    onConfirm: async (values) => {
      if (!values.name?.trim()) {
        toast('请输入知识库名称', 'error')
        return false
      }
      if (!values.embedding_model?.trim()) {
        toast('请选择向量模型', 'error')
        return false
      }
      const localPath = String(values.local_source_path || '').trim()
      try {
        await api.createKnowledgeBase({
          name: values.name.trim(),
          embedding_model: values.embedding_model.trim(),
          local_source_path: localPath,
          llm_index_enabled: !!values.llm_index_enabled,
        })
        toast(localPath ? '创建成功，正在后台扫描本地目录…' : '创建成功')
        loadList(page)
        return true
      } catch (e) {
        toast('创建失败: ' + (e?.message || e), 'error')
        return false
      }
    },
  })
  setTimeout(attachFolderBrowseButton, 0)
}

import { collectEmbeddingModelOptions } from '../lib/model-classification.js'
