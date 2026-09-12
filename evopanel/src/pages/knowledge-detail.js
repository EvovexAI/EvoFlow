/**
 * 知识库详情页
 * 三个 Tab：文档 | 检索测试 | 设置
 * 路由：/knowledge/:id
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showConfirm, showModal } from '../components/modal.js'

let _loadSeq = 0

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

function statusBadge(status) {
  const map = {
    ready: { text: '已就绪', cls: 'kb-st-ready' },
    processing: { text: '处理中', cls: 'kb-st-proc' },
    error: { text: '失败', cls: 'kb-st-err' },
  }
  const s = map[status] || map.ready
  return `<span class="kb-status-badge ${s.cls}">${s.text}</span>`
}

function getKbId() {
  const hash = window.location.hash || ''
  const m = hash.match(/#\/knowledge\/([^/?#]+)/)
  return m ? decodeURIComponent(m[1]).trim() : ''
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

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'
  const kbId = getKbId()

  if (!kbId) {
    page.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-tertiary)">无效的知识库 ID</div>'
    return page
  }

  page.innerHTML = `
    <div class="kb-detail-header">
      <button type="button" id="kb-back" class="kb-detail-back" title="返回列表">←</button>
      <div class="kb-detail-head-main">
        <div class="kb-detail-title-row">
          <h1 class="page-title kb-detail-title" id="kb-title">加载中...</h1>
          <span id="kb-status-badge"></span>
        </div>
        <div class="kb-detail-stats" id="kb-stats"></div>
      </div>
    </div>

    <div class="tab-bar kb-detail-tabs" id="kb-tabs">
      <div class="tab active" data-tab="docs">📄 文档</div>
      <div class="tab" data-tab="search">🔍 检索测试</div>
      <div class="tab" data-tab="settings">⚙️ 设置</div>
    </div>

    <div id="kb-tab-docs" class="config-section kb-detail-panel"></div>
    <div id="kb-tab-search" class="config-section kb-detail-panel" style="display:none"></div>
    <div id="kb-tab-settings" class="config-section kb-detail-panel" style="display:none"></div>
  `

  bindEvents(page, kbId)
  loadDetail(page, kbId)
  loadFiles(page, kbId)
  return page
}

function bindEvents(page, kbId) {
  page.querySelector('#kb-back').addEventListener('click', () => {
    window.location.hash = '#/knowledge'
  })

  // Tab switching
  page.querySelectorAll('#kb-tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      page.querySelectorAll('#kb-tabs .tab').forEach(t => t.classList.remove('active'))
      tab.classList.add('active')
      const target = tab.dataset.tab
      page.querySelector('#kb-tab-docs').style.display = target === 'docs' ? '' : 'none'
      page.querySelector('#kb-tab-search').style.display = target === 'search' ? '' : 'none'
      page.querySelector('#kb-tab-settings').style.display = target === 'settings' ? '' : 'none'
      if (target === 'search') initSearchTab(page, kbId)
      if (target === 'settings') loadSettings(page, kbId)
    })
  })
}

// ---------------------------------------------------------------------------
// Detail header
// ---------------------------------------------------------------------------

async function loadDetail(page, kbId) {
  const seq = ++_loadSeq
  try {
    const ds = await api.getKnowledgeBase(kbId)
    if (seq !== _loadSeq) return
    if (!ds) {
      page.querySelector('#kb-title').textContent = '知识库不存在'
      return
    }
    page.querySelector('#kb-title').textContent = ds.name || kbId
    page.querySelector('#kb-stats').innerHTML =
      `📄 ${ds.file_count || 0} 篇文档 · 🤖 ${esc(ds.embedding_model || 'N/A')}` +
      (ds.local_source_path ? ` · 📁 本地目录` : '')
    const badgeEl = page.querySelector('#kb-status-badge')
    if (badgeEl) badgeEl.innerHTML = statusBadge(ds.status || 'ready')
    page.dataset.kbName = ds.name || ''
    page.dataset.kbDesc = ds.description || ''
  } catch (e) {
    page.querySelector('#kb-title').textContent = '加载失败'
  }
}

// ---------------------------------------------------------------------------
// Tab: Documents
// ---------------------------------------------------------------------------

let _pollTimer = null
let _selectedFolderId = null
let _foldersCache = []

async function loadFiles(page, kbId) {
  const el = page.querySelector('#kb-tab-docs')
  el.innerHTML = `
    <div class="kb-wiki-layout">
      <aside class="kb-wiki-toc">
        <div class="kb-wiki-toc-head">
          <span class="kb-wiki-toc-title">目录</span>
          <button type="button" class="btn btn-secondary btn-sm" id="kb-new-folder" title="新建目录">＋</button>
        </div>
        <div id="kb-folder-tree" class="kb-wiki-tree"></div>
      </aside>
      <main class="kb-wiki-main">
        <div class="kb-wiki-toolbar">
          <div class="kb-wiki-toolbar-title" id="kb-current-folder-label">全部文档</div>
          <div class="kb-wiki-toolbar-actions">
            <label class="btn btn-sm" style="cursor:pointer">
              上传文档
              <input type="file" id="kb-file-input" style="display:none" multiple accept=".txt,.md,.pdf,.docx,.doc,.pptx,.xlsx,.csv,.json">
            </label>
            <label class="btn btn-secondary btn-sm" style="cursor:pointer">
              上传文件夹
              <input type="file" id="kb-folder-input" style="display:none" webkitdirectory directory multiple>
            </label>
          </div>
        </div>
        <div id="kb-files-list" class="kb-wiki-files"></div>
      </main>
    </div>
  `

  el.querySelector('#kb-file-input').addEventListener('change', (e) => {
    handleUpload(page, kbId, e.target.files, { folderId: _selectedFolderId })
    e.target.value = ''
  })
  el.querySelector('#kb-folder-input').addEventListener('change', (e) => {
    handleFolderUpload(page, kbId, e.target.files)
    e.target.value = ''
  })
  el.querySelector('#kb-new-folder').addEventListener('click', () => promptNewFolder(page, kbId))

  await refreshFolders(page, kbId)
  await refreshFiles(page, kbId)
}

function buildFolderTree(folders) {
  const byId = new Map()
  for (const f of folders || []) {
    byId.set(f.folder_id, { ...f, children: [] })
  }
  const roots = []
  for (const f of folders || []) {
    const node = byId.get(f.folder_id)
    if (f.parent_id && byId.has(f.parent_id)) {
      byId.get(f.parent_id).children.push(node)
    } else {
      roots.push(node)
    }
  }
  return roots
}

function renderFolderNodes(nodes, depth = 0) {
  return (nodes || []).map((node) => {
    const active = node.folder_id === _selectedFolderId ? ' active' : ''
    const pad = 8 + depth * 14
    const children = node.children?.length
      ? `<div class="kb-wiki-tree-children">${renderFolderNodes(node.children, depth + 1)}</div>`
      : ''
    return `
      <button type="button" class="kb-wiki-tree-item${active}" data-folder-id="${esc(node.folder_id)}" style="padding-left:${pad}px">
        <span class="kb-wiki-tree-icon">📁</span>
        <span class="kb-wiki-tree-label">${esc(node.name || '目录')}</span>
      </button>
      ${children}
    `
  }).join('')
}

async function refreshFolders(page, kbId) {
  const treeEl = page.querySelector('#kb-folder-tree')
  if (!treeEl) return
  try {
    const data = await api.listKnowledgeFolders(kbId)
    _foldersCache = data?.items || []
    if (!_selectedFolderId) {
      const root = _foldersCache.find((f) => String(f.folder_id || '').startsWith('folder_root_'))
      _selectedFolderId = root?.folder_id || _foldersCache[0]?.folder_id || null
    }
    const tree = buildFolderTree(_foldersCache)
    treeEl.innerHTML = renderFolderNodes(tree)
    treeEl.querySelectorAll('[data-folder-id]').forEach((btn) => {
      btn.onclick = async () => {
        _selectedFolderId = btn.dataset.folderId
        const folder = _foldersCache.find((f) => f.folder_id === _selectedFolderId)
        const label = page.querySelector('#kb-current-folder-label')
        if (label) label.textContent = folder?.name || '目录'
        await refreshFolders(page, kbId)
        await refreshFiles(page, kbId)
      }
    })
    const folder = _foldersCache.find((f) => f.folder_id === _selectedFolderId)
    const label = page.querySelector('#kb-current-folder-label')
    if (label) label.textContent = folder?.name || '全部文档'
  } catch (e) {
    treeEl.innerHTML = `<div class="kb-wiki-tree-error">${esc(e?.message || e)}</div>`
  }
}

function promptNewFolder(page, kbId) {
  const datasetId = String(kbId || getKbId() || '').trim()
  if (!datasetId) {
    toast('无效的知识库 ID', 'error')
    return
  }
  showModal({
    title: '新建目录',
    width: 420,
    fields: [
      { name: 'name', label: '目录名称', type: 'text', placeholder: '如：产品手册', required: true },
    ],
    onConfirm: async (values) => {
      const name = values.name?.trim()
      if (!name) {
        toast('请输入目录名称', 'error')
        return false
      }
      try {
        await api.createKnowledgeFolder(datasetId, {
          name,
          parent_id: _selectedFolderId || undefined,
        })
        toast('目录已创建')
        await refreshFolders(page, datasetId)
        return true
      } catch (e) {
        toast('创建失败: ' + (e?.message || e), 'error')
        return false
      }
    },
  })
}

async function refreshFiles(page, kbId) {
  const listEl = page.querySelector('#kb-files-list')
  if (!listEl) return
  listEl.innerHTML = '<div class="kb-wiki-empty">加载中...</div>'

  try {
    const data = await api.listKnowledgeFiles(kbId, _selectedFolderId)
    const files = data?.items || []
    if (files.length === 0) {
      listEl.innerHTML = '<div class="kb-wiki-empty">当前目录还没有文档，点击上方按钮上传</div>'
      return
    }

    listEl.innerHTML = files.map(f => `
      <div class="kb-wiki-doc-card">
        <div class="kb-wiki-doc-main">
          <div class="kb-wiki-doc-title">${esc(f.name || f.file_id)}</div>
          ${f.summary_index ? `<div class="kb-wiki-doc-summary">${esc(f.summary_index)}</div>` : ''}
          <div class="kb-wiki-doc-meta">
            ${statusBadge(f.status)} · ${formatTime(f.created_at)} · ${(f.size_bytes / 1024).toFixed(1)} KB
          </div>
        </div>
        <button type="button" class="btn btn-secondary btn-sm kb-file-del" data-fid="${esc(f.file_id)}">删除</button>
      </div>
    `).join('')

    listEl.querySelectorAll('.kb-file-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ok = await showConfirm('确定删除该文档？')
        if (!ok) return
        try {
          await api.deleteKnowledgeFile(kbId, btn.dataset.fid)
          toast('删除成功')
          refreshFiles(page, kbId)
          loadDetail(page, kbId)
        } catch (e) { toast('删除失败: ' + (e?.message || e), 'error') }
      })
    })

    if (files.some(f => f.status === 'processing')) {
      if (_pollTimer) clearTimeout(_pollTimer)
      _pollTimer = setTimeout(() => {
        refreshFiles(page, kbId)
        loadDetail(page, kbId)
      }, 4000)
    }
  } catch (e) {
    listEl.innerHTML = `<div class="kb-wiki-empty kb-wiki-empty--error">加载失败: ${esc(e?.message || e)}</div>`
  }
}

async function handleUpload(page, kbId, files, { folderId } = {}) {
  if (!files || files.length === 0) return
  for (const file of files) {
    try {
      toast(`正在上传 ${file.name}...`)
      await api.uploadKnowledgeFile(kbId, file, { folderId })
    } catch (e) {
      toast(`${file.name} 上传失败: ${e?.message || e}`, 'error')
    }
  }
  toast('上传完成，正在后台建立索引')
  refreshFiles(page, kbId)
  loadDetail(page, kbId)
}

async function handleFolderUpload(page, kbId, files) {
  if (!files || files.length === 0) return
  for (const file of files) {
    const rel = file.webkitRelativePath || file.name
    try {
      await api.uploadKnowledgeFile(kbId, file, {
        folderId: _selectedFolderId,
        relativePath: rel,
      })
    } catch (e) {
      toast(`${rel} 上传失败: ${e?.message || e}`, 'error')
    }
  }
  toast('文件夹上传完成，正在后台建立索引')
  refreshFiles(page, kbId)
  loadDetail(page, kbId)
}

// ---------------------------------------------------------------------------
// Tab: Search
// ---------------------------------------------------------------------------

// Render search tab lazily on first click
function initSearchTab(page, kbId) {
  const el = page.querySelector('#kb-tab-search')
  if (el.dataset.init) return
  el.dataset.init = '1'

  el.innerHTML = `
    <div class="kb-search-panel">
      <div class="kb-search-bar">
        <input class="form-input" id="kb-search-input" placeholder="输入检索文本..." autofocus>
        <button id="kb-search-btn">检索</button>
      </div>
      <div class="kb-search-options">
        Top-K: <input type="number" id="kb-search-topk" value="5" min="1" max="20">
      </div>
      <div id="kb-search-results" class="kb-search-results"></div>
    </div>
  `

  const doSearch = async () => {
    const query = el.querySelector('#kb-search-input').value.trim()
    if (!query) return
    const topK = parseInt(el.querySelector('#kb-search-topk').value) || 5
    const resultsEl = el.querySelector('#kb-search-results')
    resultsEl.innerHTML = '<div style="padding:12px;color:var(--text-tertiary)">检索中...</div>'

    try {
      const data = await api.searchKnowledge(kbId, query, topK)
      const items = data?.items || []
      if (items.length === 0) {
        resultsEl.innerHTML = '<div style="padding:12px;color:var(--text-tertiary)">无匹配结果</div>'
        return
      }
      resultsEl.innerHTML = items.map((r, i) => {
        const scoreCls = r.score > 0.7 ? 'is-high' : r.score > 0.4 ? 'is-mid' : 'is-low'
        return `
        <div class="kb-search-hit">
          <div class="kb-search-hit-head">
            <span class="kb-search-hit-meta">#${i + 1} · ${esc(r.file_name || '')}${r.heading_path ? ' · ' + esc(r.heading_path) : ''}</span>
            <span class="kb-search-hit-score ${scoreCls}">${(r.score * 100).toFixed(1)}%</span>
          </div>
          ${r.index_text ? `<div class="kb-search-hit-index">${esc(r.index_text)}</div>` : ''}
          <div class="kb-search-hit-content">${esc(r.content)}</div>
        </div>
      `
      }).join('')
    } catch (e) {
      resultsEl.innerHTML = `<div style="padding:12px;color:var(--error)">检索失败: ${esc(e?.message || e)}</div>`
    }
  }

  el.querySelector('#kb-search-btn').addEventListener('click', doSearch)
  el.querySelector('#kb-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch()
  })
}

// ---------------------------------------------------------------------------
// Tab: Settings
// ---------------------------------------------------------------------------

async function loadSettings(page, kbId) {
  const el = page.querySelector('#kb-tab-settings')

  el.innerHTML = '<div style="padding:12px;color:var(--text-tertiary)">加载中...</div>'

  try {
    const ds = await api.getKnowledgeBase(kbId)
    if (!ds) { el.innerHTML = '<div style="color:var(--error)">知识库不存在</div>'; return }

    // Parse settings from metadata (internal defaults only; not shown in UI)
    try { JSON.parse(ds.metadata_json || '{}') } catch {}

    el.innerHTML = `
      <div class="kb-settings-card">
        <div class="kb-settings-title">基本信息</div>
        <div style="display:grid;gap:12px">
          <div>
            <label style="font-size:12px;color:var(--text-tertiary)">名称</label>
            <input class="form-input" id="kb-set-name" value="${esc(ds.name || '')}" style="width:100%;margin-top:4px">
          </div>
          <div>
            <label style="font-size:12px;color:var(--text-tertiary)">描述（可选）</label>
            <textarea class="form-input" id="kb-set-desc" rows="2" style="width:100%;margin-top:4px">${esc(ds.description || '')}</textarea>
          </div>
        </div>
      </div>

      <div class="kb-settings-card">
        <div class="kb-settings-title">本地目录</div>
        <div style="display:grid;gap:10px">
          <div>
            <label style="font-size:12px;color:var(--text-tertiary)">文件夹路径</label>
            <input class="form-input" id="kb-set-local-path" value="${esc(ds.local_source_path || '')}" placeholder="留空则仅手动上传" style="width:100%;margin-top:4px;font-family:var(--font-mono,monospace);font-size:12px">
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn btn-secondary btn-sm" id="kb-set-pick-folder">选择文件夹…</button>
            <button type="button" class="btn btn-secondary btn-sm" id="kb-set-sync-local">重新扫描</button>
            <button type="button" class="btn btn-secondary btn-sm" id="kb-set-sync-force">强制全量重建</button>
          </div>
          <div class="form-hint">绑定后直接在原目录读取文件，自动分块并向量化；本地改文件后点「重新扫描」即可增量更新。</div>
        </div>
      </div>

      <div class="kb-settings-card">
        <div class="kb-settings-title">索引选项</div>
        <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-size:13px">
          <input type="checkbox" id="kb-set-llm-index" ${ds.llm_index_enabled !== false ? 'checked' : ''} style="margin-top:3px">
          <span>
            <strong>LLM 智能索引</strong>
            <div class="form-hint" style="margin-top:4px">语义分块 + 文档/段落摘要；关闭后仅用规则分块（更快、不消耗对话模型）</div>
          </span>
        </label>
      </div>

      <div style="display:flex;gap:8px;margin-bottom:20px">
        <button id="kb-set-save">保存</button>
      </div>

      <div class="kb-settings-card kb-settings-danger">
        <div class="kb-settings-title" style="color:var(--error)">⚠️ 危险操作</div>
        <button class="btn btn-secondary" id="kb-set-delete" style="color:var(--error)">删除知识库</button>
      </div>
    `

    el.querySelector('#kb-set-pick-folder').addEventListener('click', async () => {
      const path = await pickLocalFolderPath()
      if (path) el.querySelector('#kb-set-local-path').value = path
    })

    const runLocalSync = async (force) => {
      try {
        toast(force ? '正在强制全量重建索引…' : '正在扫描本地目录…')
        const stats = await api.syncKnowledgeLocal(kbId, force)
        toast(`扫描完成：新增/更新 ${stats.indexed || 0}，跳过 ${stats.skipped || 0}，失败 ${stats.errors || 0}`)
        refreshFiles(page, kbId)
        refreshFolders(page, kbId)
        loadDetail(page, kbId)
      } catch (e) {
        toast('扫描失败: ' + (e?.message || e), 'error')
      }
    }
    el.querySelector('#kb-set-sync-local').addEventListener('click', () => runLocalSync(false))
    el.querySelector('#kb-set-sync-force').addEventListener('click', async () => {
      const ok = await showConfirm('强制全量重建会重新处理所有文件（更慢）。继续？')
      if (!ok) return
      await runLocalSync(true)
    })

    el.querySelector('#kb-set-save').addEventListener('click', async () => {
      try {
        const prevPath = String(ds.local_source_path || '').trim()
        const nextPath = el.querySelector('#kb-set-local-path').value.trim()
        await api.updateKnowledgeBase(kbId, {
          name: el.querySelector('#kb-set-name').value.trim(),
          description: el.querySelector('#kb-set-desc').value.trim(),
          local_source_path: nextPath,
          llm_index_enabled: !!el.querySelector('#kb-set-llm-index').checked,
        })
        toast('保存成功')
        loadDetail(page, kbId)
        if (nextPath && nextPath !== prevPath) {
          toast('正在扫描新绑定的本地目录…')
          await api.syncKnowledgeLocal(kbId, false)
          refreshFiles(page, kbId)
          refreshFolders(page, kbId)
        }
      } catch (e) { toast('保存失败: ' + (e?.message || e), 'error') }
    })

    el.querySelector('#kb-set-delete').addEventListener('click', async () => {
      const name = page.dataset.kbName || kbId
      const ok = await showConfirm(`确定删除知识库「${name}」？此操作不可恢复，所有文档和向量将被永久删除。`)
      if (!ok) return
      try {
        await api.deleteKnowledgeBase(kbId)
        toast('删除成功')
        window.location.hash = '#/knowledge'
      } catch (e) { toast('删除失败: ' + (e?.message || e), 'error') }
    })

  } catch (e) {
    el.innerHTML = `<div style="padding:12px;color:var(--error)">加载失败: ${esc(e?.message || e)}</div>`
  }
}
