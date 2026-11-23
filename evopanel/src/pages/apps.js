/**
 * 工作流管理页面 - 可复用的自动化工作流
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showModal, showConfirm, showContentModal } from '../components/modal.js'
import { navigate } from '../router.js'
import {
  bindListPager,
  paginateItems,
  readStoredPageSize,
  renderListPagerHtml,
  writeStoredPageSize,
} from '../components/list-pager.js'
import { appGlyphSvg, appIconTileHtml } from '../lib/app-icon.js'

const APPS_PAGE_SIZE_KEY = 'evopanel_apps_page_size'

export async function render() {
  const page = document.createElement('div')
  page.className = 'page apps-page'

  page.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">工作流</h1>
        <p class="page-desc">把跑通的流程存成工作流，以后填参数就能直接跑，不用每次从头聊。</p>
      </div>
      <div class="page-actions">
        <div class="apps-new-dropdown">
          <button type="button" class="btn btn-primary btn-sm" id="btn-new-app">新建 ▾</button>
          <div class="apps-new-menu" hidden>
            <button type="button" class="apps-new-menu-item" data-act="folder">
              <span class="apps-new-menu-icon" aria-hidden="true">📁</span>
              <span>文件夹</span>
            </button>
            <button type="button" class="apps-new-menu-item" data-act="blank">
              <span class="apps-new-menu-icon">${appGlyphSvg('workflow', 16)}</span>
              <span>空白工作流</span>
            </button>
            <button type="button" class="apps-new-menu-item" data-act="template">
              <span class="apps-new-menu-icon">${appGlyphSvg('fileText', 16)}</span>
              <span>从模板创建</span>
            </button>
            <button type="button" class="apps-new-menu-item" data-act="from-task">
              <span class="apps-new-menu-icon">${appGlyphSvg('package', 16)}</span>
              <span>从任务沉淀</span>
            </button>
          </div>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" id="btn-refresh">刷新</button>
      </div>
    </div>

    <div class="page-content">
      <div class="apps-toolbar">
        <nav class="apps-folder-breadcrumb" id="apps-folder-breadcrumb" aria-label="当前位置"></nav>
        <input type="search" class="apps-filter-search" placeholder="搜索工作流…" aria-label="搜索工作流" />
      </div>

      <div id="apps-list" class="apps-grid">
        <div class="page-loader" style="grid-column:1/-1">
          <div class="page-loader-spinner"></div>
          <div class="page-loader-text">加载中…</div>
        </div>
      </div>
      <div class="kb-list-pager-wrap" id="apps-list-pager"></div>

      <div id="apps-empty" class="apps-empty-state" style="display:none">
        <div class="apps-empty-ico" aria-hidden="true">${appGlyphSvg('workflow', 30)}</div>
        <h3 data-role="empty-title">还没有工作流</h3>
        <p data-role="empty-desc">从模板快速创建，或从对话中沉淀</p>
        <div class="apps-empty-actions">
          <button type="button" class="btn btn-primary" id="btn-empty-new-app">创建空白工作流</button>
          <button type="button" class="btn btn-ghost" id="btn-empty-new-folder">新建文件夹</button>
          <button type="button" class="btn btn-ghost" id="btn-empty-template">从模板创建</button>
        </div>
      </div>
    </div>
  `

  let apps = []
  /** @type {Array<{folder_id:string,parent_id?:string,name?:string}>} */
  let folders = []
  /** 当前所在夹：'' = 根目录；其它 = 文件夹 id（点进去往下钻） */
  let selectedFolderId = ''
  let searchQuery = ''
  let listPage = 1
  let listPageSize = readStoredPageSize(APPS_PAGE_SIZE_KEY)

  function folderById(id) {
    const fid = String(id || '')
    return folders.find((f) => String(f.folder_id) === fid) || null
  }

  function folderChildren(parentId) {
    const pid = String(parentId || '')
    return folders
      .filter((f) => String(f.parent_id || '') === pid)
      .slice()
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh'))
  }

  function folderPath(folderId) {
    const parts = []
    let cur = String(folderId || '')
    const seen = new Set()
    while (cur && !seen.has(cur)) {
      seen.add(cur)
      const f = folderById(cur)
      if (!f) break
      parts.unshift({ id: f.folder_id, name: f.name || '未命名' })
      cur = String(f.parent_id || '')
    }
    return parts
  }

  function folderPathLabel(folderId) {
    const parts = folderPath(folderId)
    if (!parts.length) return '全部'
    return parts.map((p) => p.name).join(' / ')
  }

  function createTargetFolderId() {
    return String(selectedFolderId || '')
  }

  function enterFolder(folderId) {
    selectedFolderId = String(folderId || '')
    listPage = 1
    renderBreadcrumb()
    renderAppsList()
  }

  // 指针拖放：卡片本身 transform 跟手（不用 HTML5 DnD，避免 WebView「禁止」光标）。
  const DRAG_THRESHOLD_PX = 6
  let dragDidMove = false
  let dragBusy = false

  async function moveAppToFolder(appId, folderId) {
    const app = apps.find((a) => String(a.id) === String(appId))
    if (!app) return
    const next = String(folderId || '')
    if (String(app.folder_id || '') === next) return
    try {
      await api.updateApp(appId, { folder_id: next })
      toast.success('已移入')
      await loadApps()
    } catch (err) {
      toast.error('移动失败: ' + (err?.message || err))
    }
  }

  async function moveFolderToParent(folderId, parentId) {
    const fid = String(folderId || '')
    const nextParent = String(parentId || '')
    if (!fid) return
    if (fid === nextParent) return
    const f = folderById(fid)
    if (!f) return
    if (String(f.parent_id || '') === nextParent) return
    try {
      await api.updateAppFolder(fid, { parent_id: nextParent })
      toast.success('文件夹已移动')
      await loadApps()
    } catch (err) {
      toast.error('移动失败: ' + (err?.message || err))
    }
  }

  function clearDropHighlights() {
    page.querySelectorAll('.is-drop-target').forEach((n) => n.classList.remove('is-drop-target'))
  }

  function resolveDropFolderIdFromPoint(clientX, clientY, dragEl, dragKind, dragId) {
    const stack = document.elementsFromPoint(clientX, clientY) || []
    for (const node of stack) {
      if (!(node instanceof Element)) continue
      if (dragEl && (node === dragEl || dragEl.contains(node))) continue
      const hit = node.closest('[data-drop-folder]')
      if (!hit || !page.contains(hit)) continue
      if (
        dragKind === 'folder' &&
        hit.classList.contains('app-card--folder') &&
        String(hit.dataset.folderId || '') === String(dragId)
      ) {
        continue
      }
      return String(hit.getAttribute('data-drop-folder') ?? '')
    }
    return null
  }

  function highlightDropAtPoint(clientX, clientY, dragEl, dragKind, dragId) {
    clearDropHighlights()
    const stack = document.elementsFromPoint(clientX, clientY) || []
    for (const node of stack) {
      if (!(node instanceof Element)) continue
      if (dragEl && (node === dragEl || dragEl.contains(node))) continue
      const hit = node.closest('[data-drop-folder]')
      if (!hit || !page.contains(hit)) continue
      if (
        dragKind === 'folder' &&
        hit.classList.contains('app-card--folder') &&
        String(hit.dataset.folderId || '') === String(dragId)
      ) {
        continue
      }
      hit.classList.add('is-drop-target')
      return hit
    }
    return null
  }

  function bindCardDrag(el, payload) {
    if (!el) return
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      if (e.target.closest('.app-card-more') || e.target.closest('.app-card-menu')) return
      if (dragBusy) return

      const pointerId = e.pointerId
      const startX = e.clientX
      const startY = e.clientY
      let started = false
      /** @type {HTMLElement | null} */
      let ghost = null
      dragDidMove = false
      dragBusy = true

      // 立刻捕获，离开卡片后仍能收到 move
      try {
        el.setPointerCapture(pointerId)
      } catch {
        /* ignore */
      }

      const cleanupVisual = () => {
        el.classList.remove('is-dragging')
        el.style.transform = ''
        el.style.zIndex = ''
        el.style.transition = ''
        el.style.willChange = ''
        page.classList.remove('apps-is-dragging')
        if (ghost?.parentNode) ghost.parentNode.removeChild(ghost)
        ghost = null
        clearDropHighlights()
      }

      /** 按下时卡片左上角（用于幽灵跟手） */
      let baseLeft = 0
      let baseTop = 0

      const onMove = (ev) => {
        if (ev.pointerId !== pointerId) return
        const dx = ev.clientX - startX
        const dy = ev.clientY - startY
        if (!started) {
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
          started = true
          dragDidMove = true
          const rect = el.getBoundingClientRect()
          baseLeft = rect.left
          baseTop = rect.top

          el.classList.add('is-dragging')
          el.style.willChange = 'transform'
          el.style.transition = 'none'
          el.style.zIndex = '40'
          page.classList.add('apps-is-dragging')

          ghost = /** @type {HTMLElement} */ (el.cloneNode(true))
          ghost.classList.add('app-card-drag-ghost')
          ghost.querySelectorAll('.app-card-menu, .app-card-more').forEach((n) => n.remove())
          ghost.setAttribute('aria-hidden', 'true')
          ghost.style.cssText = [
            'position:fixed',
            `left:${baseLeft}px`,
            `top:${baseTop}px`,
            `width:${rect.width}px`,
            `height:${rect.height}px`,
            'margin:0',
            'z-index:10000',
            'pointer-events:none',
            'opacity:0.95',
            'transform:scale(1.03)',
            'box-shadow:0 18px 40px rgba(0,0,0,0.22)',
            'border-radius:14px',
          ].join(';')
          document.body.appendChild(ghost)
        }

        // 原卡跟手（用户要的「能动起来」）
        el.style.transform = `translate(${dx}px, ${dy}px)`
        if (ghost) {
          ghost.style.left = `${baseLeft + dx}px`
          ghost.style.top = `${baseTop + dy}px`
        }

        highlightDropAtPoint(ev.clientX, ev.clientY, el, payload.kind, payload.id)
        ev.preventDefault()
      }

      const finish = (ev, commit) => {
        if (ev.pointerId !== pointerId) return
        el.removeEventListener('pointermove', onMove)
        el.removeEventListener('pointerup', onUp)
        el.removeEventListener('pointercancel', onCancel)
        try {
          el.releasePointerCapture(pointerId)
        } catch {
          /* ignore */
        }

        const x = ev.clientX
        const y = ev.clientY
        const didDrag = started
        cleanupVisual()
        dragBusy = false

        if (!didDrag) return

        dragDidMove = true
        if (commit) {
          const targetFolderId = resolveDropFolderIdFromPoint(x, y, el, payload.kind, payload.id)
          if (targetFolderId != null) {
            if (payload.kind === 'app') void moveAppToFolder(payload.id, targetFolderId)
            else if (payload.kind === 'folder') void moveFolderToParent(payload.id, targetFolderId)
          }
        }
        setTimeout(() => {
          dragDidMove = false
        }, 0)
      }

      const onUp = (ev) => finish(ev, true)
      const onCancel = (ev) => finish(ev, false)

      el.addEventListener('pointermove', onMove)
      el.addEventListener('pointerup', onUp)
      el.addEventListener('pointercancel', onCancel)
    })
  }

  async function loadFolders() {
    try {
      folders = await api.listAppFolders()
      if (!Array.isArray(folders)) folders = []
    } catch (e) {
      folders = []
      toast.error('加载文件夹失败: ' + (e?.message || e))
    }
    renderBreadcrumb()
  }

  async function loadApps() {
    const listEl = page.querySelector('#apps-list')
    try {
      const { takeNavWarm } = await import('../lib/nav-panel-prefetch.js')
      const warm = takeNavWarm('apps:list')
      apps = Array.isArray(warm) ? warm : await api.listApps()
      await loadFolders()
      renderAppsList()
    } catch (e) {
      toast.error('加载工作流列表失败: ' + e.message)
      listEl.innerHTML = ''
    }
  }

  function appStepCount(app) {
    const n = Number(app?.step_count)
    if (Number.isFinite(n) && n >= 0) return n
    const steps = app?.plan?.steps || app?.steps
    return Array.isArray(steps) ? steps.length : 0
  }

  function appParamCount(app) {
    const n = Number(app?.parameter_count)
    if (Number.isFinite(n) && n >= 0) return n
    return Array.isArray(app?.parameters) ? app.parameters.length : 0
  }

  function formatAppTime(ts) {
    if (!ts) return ''
    const d = new Date(ts)
    if (Number.isNaN(d.getTime())) return ''
    const now = new Date()
    const sameDay = d.toDateString() === now.toDateString()
    if (sameDay) {
      return `今天 ${d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`
    }
    const yesterday = new Date(now)
    yesterday.setDate(now.getDate() - 1)
    if (d.toDateString() === yesterday.toDateString()) {
      return `昨天 ${d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`
    }
    return d.toLocaleString('zh-CN', {
      year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  }

  function appSortTime(app) {
    const raw = app?.updated_at || app?.created_at
    const t = new Date(raw).getTime()
    return Number.isFinite(t) ? t : 0
  }

  function visibleApps() {
    // 不展示归档：要去掉就删，不再用「活跃/已归档」分栏
    let result = apps.filter((a) => String(a.status || '').toLowerCase() !== 'archived')
    const q = searchQuery.trim().toLowerCase()
    if (q) {
      result = result.filter((a) => {
        const name = String(a.name || '').toLowerCase()
        const desc = String(a.description || '').toLowerCase()
        return name.includes(q) || desc.includes(q)
      })
    } else {
      const fid = String(selectedFolderId || '')
      result = result.filter((a) => String(a.folder_id || '') === fid)
    }
    return [...result].sort((a, b) => appSortTime(b) - appSortTime(a))
  }

  function renderBreadcrumb() {
    const el = page.querySelector('#apps-folder-breadcrumb')
    if (!el) return
    const parts = [{ id: '__root__', name: '全部' }, ...folderPath(selectedFolderId)]
    el.innerHTML = parts
      .map((p, i) => {
        const last = i === parts.length - 1
        const dropId = p.id === '__root__' ? '' : p.id
        if (last) {
          return `<span class="apps-bc-current apps-bc-drop" data-drop-folder="${escHtml(dropId)}">${escHtml(p.name)}</span>`
        }
        return `<button type="button" class="apps-bc-link apps-bc-drop" data-folder-id="${escHtml(p.id)}" data-drop-folder="${escHtml(dropId)}">${escHtml(p.name)}</button><span class="apps-bc-sep" aria-hidden="true">/</span>`
      })
      .join('')
    el.querySelectorAll('.apps-bc-link').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (dragDidMove) return
        const raw = String(btn.dataset.folderId || '')
        enterFolder(raw === '__root__' ? '' : raw)
      })
    })
  }

  async function promptNewFolder(parentId) {
    const parent = parentId == null ? createTargetFolderId() : String(parentId || '')
    showModal({
      title: '新建文件夹',
      fields: [{ name: 'name', label: '文件夹名称', value: '', placeholder: '例如：又又相关' }],
      onConfirm: async (result) => {
        const name = (result.name || '').trim()
        if (!name) {
          toast.warning('请输入文件夹名称')
          return
        }
        try {
          await api.createAppFolder({ name, parent_id: parent })
          toast.success('文件夹已创建')
          // 留在当前层，新文件夹出现在本层网格里（像 GPT）
          await loadFolders()
          renderAppsList()
        } catch (err) {
          toast.error('创建失败: ' + (err?.message || err))
        }
      },
    })
  }

  async function promptRenameFolder(folderId) {
    const f = folderById(folderId)
    if (!f) return
    showModal({
      title: '重命名文件夹',
      fields: [{ name: 'name', label: '文件夹名称', value: f.name || '', placeholder: '文件夹名称' }],
      onConfirm: async (result) => {
        const name = (result.name || '').trim()
        if (!name) {
          toast.warning('请输入文件夹名称')
          return
        }
        try {
          await api.updateAppFolder(folderId, { name })
          toast.success('已重命名')
          await loadFolders()
          renderAppsList()
        } catch (err) {
          toast.error('重命名失败: ' + (err?.message || err))
        }
      },
    })
  }

  async function deleteFolderConfirm(folderId) {
    const f = folderById(folderId)
    if (!f) return
    if (folderChildren(folderId).length) {
      toast.warning('请先删除或移走子文件夹')
      return
    }
    const ok = await showConfirm(
      `删除文件夹「${f.name || '未命名'}」？\n夹内工作流会移回上一级，不会删除工作流。`,
    )
    if (!ok) return
    try {
      await api.deleteAppFolder(folderId)
      toast.success('文件夹已删除')
      if (selectedFolderId === String(folderId)) {
        selectedFolderId = String(f.parent_id || '') || ''
      }
      await loadApps()
    } catch (err) {
      toast.error('删除失败: ' + (err?.message || err))
    }
  }

  function showMoveToFolderModal(app) {
    const options = [
      { id: '', label: '全部（顶层）' },
      ...folders.map((f) => ({
        id: String(f.folder_id),
        label: folderPathLabel(f.folder_id),
      })),
    ]
    const current = String(app.folder_id || '')
    showModal({
      title: `移动「${app.name || '未命名'}」`,
      fields: [
        {
          name: 'folder_id',
          label: '目标文件夹',
          type: 'select',
          value: current,
          options: options.map((o) => ({ value: o.id, label: o.label })),
        },
      ],
      onConfirm: async (result) => {
        const next = String(result.folder_id ?? '')
        if (next === current) return
        try {
          await api.updateApp(app.id, { folder_id: next })
          toast.success('已移动')
          await loadApps()
        } catch (err) {
          toast.error('移动失败: ' + (err?.message || err))
        }
      },
    })
  }

  function renderAppsList() {
    const listEl = page.querySelector('#apps-list')
    const emptyEl = page.querySelector('#apps-empty')
    const pagerWrap = page.querySelector('#apps-list-pager')
    const shown = visibleApps()
    const searching = Boolean(searchQuery.trim())
    const childFolders = !searching ? folderChildren(selectedFolderId) : []

    if (shown.length === 0 && childFolders.length === 0) {
      listEl.style.display = 'none'
      emptyEl.style.display = 'block'
      if (pagerWrap) pagerWrap.innerHTML = ''
      const title = emptyEl.querySelector('[data-role="empty-title"]')
      const desc = emptyEl.querySelector('[data-role="empty-desc"]')
      const emptyBtn = emptyEl.querySelector('#btn-empty-new-app')
      const emptyFolderBtn = emptyEl.querySelector('#btn-empty-new-folder')
      if (searching) {
        if (title) title.textContent = '没有匹配的工作流'
        if (desc) desc.textContent = '换个关键词试试，或清空搜索看当前文件夹。'
        if (emptyBtn) emptyBtn.style.display = 'none'
        if (emptyFolderBtn) emptyFolderBtn.style.display = 'none'
      } else if (selectedFolderId) {
        if (title) title.textContent = '这个文件夹是空的'
        if (desc) desc.textContent = '点「新建」可以加文件夹或工作流。'
        if (emptyBtn) emptyBtn.style.display = ''
        if (emptyFolderBtn) emptyFolderBtn.style.display = ''
      } else {
        if (title) title.textContent = '还没有内容'
        if (desc) {
          desc.textContent = '点「新建」建文件夹或工作流；工作流编排满意后再发布。'
        }
        if (emptyBtn) emptyBtn.style.display = ''
        if (emptyFolderBtn) emptyFolderBtn.style.display = ''
      }
      return
    }

    listEl.style.display = 'grid'
    emptyEl.style.display = 'none'

    const folderCardsHtml = childFolders
      .map((f) => {
        const subFolders = folderChildren(f.folder_id).length
        const appCount = apps.filter(
          (a) =>
            String(a.folder_id || '') === String(f.folder_id) &&
            String(a.status || '').toLowerCase() !== 'archived',
        ).length
        const meta =
          subFolders && appCount
            ? `${subFolders} 个文件夹 · ${appCount} 个工作流`
            : subFolders
              ? `${subFolders} 个文件夹`
              : appCount
                ? `${appCount} 个工作流`
                : '空文件夹'
        return `
        <article class="app-card app-card--folder" data-folder-id="${escHtml(f.folder_id)}" data-drop-folder="${escHtml(f.folder_id)}" tabindex="0" title="拖到这里可放入；拖动此卡可嵌套到其他文件夹">
          <button type="button" class="app-card-more" data-folder-id="${escHtml(f.folder_id)}" aria-label="更多操作" title="更多">
            <span aria-hidden="true">···</span>
          </button>
          <div class="app-card-menu" hidden data-menu-for-folder="${escHtml(f.folder_id)}">
            <button type="button" class="app-card-menu-item" data-act="rename-folder">重命名</button>
            <button type="button" class="app-card-menu-item app-card-menu-item--danger" data-act="delete-folder">删除</button>
          </div>
          <div class="app-card-top">
            <div class="app-ico-tile app-ico-tile--folder" aria-hidden="true">📁</div>
            <div class="app-card-heading">
              <div class="app-card-title-row">
                <h3 class="app-card-name" title="${escHtml(f.name || '未命名')}">${escHtml(f.name || '未命名')}</h3>
                <span class="app-card-status is-folder">文件夹</span>
              </div>
              <p class="app-card-meta">${escHtml(meta)}</p>
            </div>
          </div>
        </article>`
      })
      .join('')

    const paged = paginateItems(shown, listPage, listPageSize)
    listPage = paged.page
    listPageSize = paged.pageSize

    const appCardsHtml = paged.items.map(app => {
      const st = String(app.status || 'draft').toLowerCase()
      const published = st === 'published'
      const badgeClass = published ? 'is-published' : 'is-draft'
      const badgeLabel = published ? '已发布' : '草稿'
      const stepN = appStepCount(app)
      const paramN = appParamCount(app)
      const pathHint =
        searching && app.folder_id
          ? folderPathLabel(app.folder_id)
          : searching
            ? '全部'
            : ''
      // 元信息一行放下：步数/参数 + 更新时间，卡片不再另设底栏，做减法。
      const metaBits = [
        pathHint || null,
        stepN && paramN ? `${stepN} 步 · ${paramN} 参数` : stepN ? `${stepN} 步` : paramN ? `${paramN} 参数` : null,
        formatAppTime(app.updated_at || app.created_at) || null,
      ].filter(Boolean)
      return `
        <article class="app-card" data-app-id="${escHtml(app.id)}" data-status="${escHtml(st)}" tabindex="0" title="拖到文件夹可归类">
          <button type="button" class="app-card-more" data-app-id="${escHtml(app.id)}" aria-label="更多操作" title="更多">
            <span aria-hidden="true">···</span>
          </button>
          <div class="app-card-menu" hidden data-menu-for="${escHtml(app.id)}">
            <button type="button" class="app-card-menu-item" data-act="edit">编辑信息</button>
            <button type="button" class="app-card-menu-item" data-act="move">移到文件夹…</button>
            <button type="button" class="app-card-menu-item app-card-menu-item--danger" data-act="delete">删除</button>
          </div>
          <div class="app-card-top">
            ${appIconTileHtml(app)}
            <div class="app-card-heading">
              <div class="app-card-title-row">
                <h3 class="app-card-name" title="${escHtml(app.name || '未命名工作流')}">${escHtml(app.name || '未命名工作流')}</h3>
                <span class="app-card-status ${badgeClass}" title="${escHtml(badgeLabel)}"><i class="app-card-status-dot" aria-hidden="true"></i>${badgeLabel}</span>
              </div>
              <p class="app-card-meta">${escHtml(metaBits.join(' · '))}</p>
            </div>
          </div>
        </article>
      `
    }).join('')

    listEl.innerHTML = folderCardsHtml + appCardsHtml

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
          listPage = next
          renderAppsList()
        },
        onPageSize: (nextSize) => {
          listPageSize = nextSize
          listPage = 1
          writeStoredPageSize(APPS_PAGE_SIZE_KEY, nextSize)
          renderAppsList()
        },
      })
    }

    const closeAllMenus = () => {
      listEl.querySelectorAll('.app-card-menu').forEach((m) => {
        m.hidden = true
      })
      listEl.querySelectorAll('.app-card-more.is-open').forEach((b) => b.classList.remove('is-open'))
    }

    listEl.querySelectorAll('.app-card--folder').forEach((card) => {
      const fid = String(card.dataset.folderId || '')
      bindCardDrag(card, { kind: 'folder', id: fid })
      const openFolder = () => enterFolder(fid)
      card.addEventListener('click', (e) => {
        if (dragDidMove) return
        if (e.target.closest('.app-card-more') || e.target.closest('.app-card-menu')) return
        closeAllMenus()
        openFolder()
      })
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          if (e.target.closest('.app-card-more') || e.target.closest('.app-card-menu')) return
          e.preventDefault()
          openFolder()
        }
      })
    })

    listEl.querySelectorAll('.app-card--folder .app-card-more').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const card = btn.closest('.app-card')
        const menu = card?.querySelector('.app-card-menu')
        if (!menu) return
        const willOpen = menu.hidden
        closeAllMenus()
        if (willOpen) {
          menu.hidden = false
          btn.classList.add('is-open')
        }
      })
    })

    listEl.querySelectorAll('[data-menu-for-folder]').forEach((menu) => {
      menu.addEventListener('click', async (e) => {
        e.stopPropagation()
        const item = e.target.closest('[data-act]')
        if (!item) return
        const fid = String(menu.dataset.menuForFolder || '')
        closeAllMenus()
        if (item.dataset.act === 'rename-folder') await promptRenameFolder(fid)
        else if (item.dataset.act === 'delete-folder') await deleteFolderConfirm(fid)
      })
    })

    listEl.querySelectorAll('.app-card:not(.app-card--folder)').forEach(card => {
      const appId = String(card.dataset.appId || '').trim()
      bindCardDrag(card, { kind: 'app', id: appId })
      const warmDetail = () => {
        if (!appId) return
        void import('../lib/nav-panel-prefetch.js').then((m) => {
          m.warmNavKey?.(`apps:detail:${appId}`, () => api.getApp(appId))
        })
        void import('../components/app-workflow-canvas.js').then((m) => {
          m.preloadAppWorkflowCanvas?.()
        })
      }
      const open = () => {
        warmDetail()
        navigate(`/apps/${appId}`)
      }
      card.addEventListener('pointerenter', warmDetail)
      card.addEventListener('click', (e) => {
        if (dragDidMove) return
        if (e.target.closest('.app-card-more') || e.target.closest('.app-card-menu')) return
        closeAllMenus()
        open()
      })
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          if (e.target.closest('.app-card-more') || e.target.closest('.app-card-menu')) return
          e.preventDefault()
          open()
        }
      })
    })

    listEl.querySelectorAll('.app-card:not(.app-card--folder) .app-card-more').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const card = btn.closest('.app-card')
        const menu = card?.querySelector('.app-card-menu')
        if (!menu) return
        const willOpen = menu.hidden
        closeAllMenus()
        if (willOpen) {
          menu.hidden = false
          btn.classList.add('is-open')
        }
      })
    })

    listEl.querySelectorAll('.app-card-menu[data-menu-for]').forEach((menu) => {
      menu.addEventListener('click', async (e) => {
        e.stopPropagation()
        const item = e.target.closest('[data-act]')
        if (!item) return
        const appId = menu.dataset.menuFor
        const app = apps.find((a) => String(a.id) === String(appId))
        closeAllMenus()
        if (!app) return
        if (item.dataset.act === 'run') {
          navigate(`/apps/${app.id}/run`)
        } else if (item.dataset.act === 'edit') {
          showEditAppModal(app)
        } else if (item.dataset.act === 'move') {
          showMoveToFolderModal(app)
        } else if (item.dataset.act === 'delete') {
          await deleteAppConfirm(app)
        }
      })
    })

    // 点空白关闭菜单（绑一次即可）
    if (!page._appsMenuOutsideBound) {
      page._appsMenuOutsideBound = true
      document.addEventListener(
        'click',
        (e) => {
          if (!page.isConnected) return
          if (e.target.closest('.app-card-more') || e.target.closest('.app-card-menu')) return
          const root = page.querySelector('#apps-list')
          root?.querySelectorAll('.app-card-menu').forEach((m) => {
            m.hidden = true
          })
          root?.querySelectorAll('.app-card-more.is-open').forEach((b) => b.classList.remove('is-open'))
        },
        true,
      )
    }
  }

  function showEditAppModal(app) {
    showModal({
      title: '编辑工作流信息',
      fields: [
        { name: 'name', label: '工作流名称', value: app.name || '', placeholder: '例如：竞品分析工作流' },
        {
          name: 'description',
          label: '描述',
          type: 'textarea',
          value: app.description || '',
          placeholder: '简要描述这个工作流的用途',
          rows: 3,
        },
      ],
      onConfirm: async (result) => {
        const name = (result.name || '').trim()
        if (!name) {
          toast.warning('请输入工作流名称')
          return
        }
        try {
          await api.updateApp(app.id, {
            name,
            description: (result.description || '').trim(),
            execution_mode: 'workflow',
          })
          toast.success('已更新')
          await loadApps()
        } catch (err) {
          toast.error('更新失败: ' + (err?.message || err))
        }
      },
    })
  }

  async function deleteAppConfirm(app) {
    const ok = await showConfirm(`确定删除工作流「${app.name || '未命名'}」？\n删除后不可恢复。`)
    if (!ok) return
    try {
      await api.deleteApp(app.id)
      toast.success('已删除')
      await loadApps()
    } catch (err) {
      toast.error('删除失败: ' + (err?.message || err))
    }
  }

  // 新建按钮下拉菜单
  const newBtn = page.querySelector('#btn-new-app')
  const newMenu = page.querySelector('.apps-new-menu')
  if (newBtn && newMenu) {
    newBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      newMenu.hidden = !newMenu.hidden
    })
    // 点击菜单项
    newMenu.querySelectorAll('.apps-new-menu-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation()
        const act = item.dataset.act
        newMenu.hidden = true
        if (act === 'folder') {
          promptNewFolder()
        } else if (act === 'blank') {
          showNewAppModal()
        } else if (act === 'template') {
          showTemplateModal()
        } else if (act === 'from-task') {
          showFromTaskModal()
        }
      })
    })
    // 点击空白关闭菜单
    document.addEventListener('click', () => {
      newMenu.hidden = true
    })
  }

  page.querySelector('#btn-empty-new-app').addEventListener('click', () => showNewAppModal())
  page.querySelector('#btn-empty-new-folder')?.addEventListener('click', () => promptNewFolder())
  page.querySelector('#btn-empty-template')?.addEventListener('click', () => showTemplateModal())
  page.querySelector('#btn-refresh').addEventListener('click', loadApps)
  // 搜索框事件
  const searchInput = page.querySelector('.apps-filter-search')
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value
      listPage = 1
      renderAppsList()
    })
  }


  // 创建工作流弹窗
  function showNewAppModal() {
    showModal({
      title: '新建工作流',
      fields: [
        { name: 'name', label: '工作流名称', value: '', placeholder: '例如：竞品分析' },
        {
          name: 'description',
          label: '描述（可选）',
          type: 'textarea',
          value: '',
          placeholder: '一句话说清这个工作流做什么',
          rows: 3,
        },
      ],
      onConfirm: async (result) => {
        const name = (result.name || '').trim()
        const description = (result.description || '').trim()
        const execution_mode = 'workflow'

        if (!name) {
          toast.warning('请输入工作流名称')
          return
        }

        try {
          const created = await api.createApp({
            name,
            description,
            execution_mode,
            folder_id: createTargetFolderId(),
            plan: {
              goal: description || name,
              steps: [
                {
                  ref: '1',
                  name: '第一步',
                  goal: '用白话写这一步要完成的事',
                  assigned_agent: 'general-purpose',
                  depends_on: [],
                },
              ],
            },
            parameters: [],
          })
          toast.success('工作流创建成功')
          const newId = created?.id || created?.app_id || created?.appId
          if (!newId) {
            toast.warning('已创建，但未返回工作流 ID，请在列表中打开')
            await loadApps()
            return
          }
          navigate(`/apps/${newId}`)
        } catch (e) {
          toast.error('创建失败: ' + e.message)
        }
      },
    })
  }

  // 模板选择弹窗
  function showTemplateModal() {
    const templates = [
      {
        id: 'competitive-analysis',
        name: '竞品分析报告',
        desc: '联网调研指定领域的竞品，对比分析后输出 Word 报告',
        goal: '针对「{{topic}}」做竞品调研、对比分析，并输出一份可下载的 Word 报告',
        skills: 'deep-research,md2word',
        parameters: [
          { name: 'topic', label: '分析主题', type: 'text', required: true, description: '要调研的领域或产品方向，如「在线协作文档」' },
        ],
        steps: [
          {
            ref: '1',
            name: '联网调研竞品',
            goal: '围绕「{{topic}}」用联网搜索与深度研究，找出 3~5 个主要竞品，整理各自定位、核心功能、定价、优劣势',
            skills: 'deep-research',
            assigned_agent: 'general-purpose',
            depends_on: [],
          },
          {
            ref: '2',
            name: '对比分析',
            goal: '把上一步的调研结果整理成对比维度表（功能、价格、易用性、生态），提炼差异化结论与机会点',
            skills: 'deep-research',
            assigned_agent: 'general-purpose',
            depends_on: ['1'],
          },
          {
            ref: '3',
            name: '生成 Word 报告',
            goal: '把对比分析结论写成结构完整的竞品分析报告，导出为 Word 文档，并在结尾给出可执行建议',
            skills: 'md2word,summarize',
            assigned_agent: 'general-purpose',
            depends_on: ['2'],
          },
        ],
      },
      {
        id: 'code-review',
        name: '代码审查',
        desc: '对指定仓库/目录做质量检查，输出问题清单与修复建议',
        goal: '对「{{repo}}」做代码质量检查，识别潜在问题，输出审查报告与修复建议',
        skills: 'coding-agent,github',
        parameters: [
          { name: 'repo', label: '仓库或目录', type: 'text', required: true, description: '要审查的仓库地址或本地项目路径' },
        ],
        steps: [
          {
            ref: '1',
            name: '读取代码结构',
            goal: '浏览「{{repo}}」的目录结构与核心模块，弄清项目技术栈与关键代码位置',
            skills: 'coding-agent,github',
            assigned_agent: 'general-purpose',
            depends_on: [],
          },
          {
            ref: '2',
            name: '质量审查',
            goal: '从代码规范、潜在 bug、安全风险、可维护性四个维度审查，逐条列出问题并标注严重程度',
            skills: 'coding-agent',
            assigned_agent: 'general-purpose',
            depends_on: ['1'],
          },
          {
            ref: '3',
            name: '输出审查报告',
            goal: '汇总问题清单，按严重程度排序，给出可落地的修复建议与最佳实践，生成审查报告文档',
            skills: 'md2word,summarize',
            assigned_agent: 'general-purpose',
            depends_on: ['2'],
          },
        ],
      },
      {
        id: 'weekly-report',
        name: '周报生成',
        desc: '汇总本周工作要点，提炼成果并规划下周，生成结构化周报',
        goal: '把「{{highlights}}」汇总提炼成一份结构化周报，含本周成果、数据亮点、下周计划',
        skills: 'summarize,md2word',
        parameters: [
          { name: 'highlights', label: '本周要点', type: 'textarea', required: true, description: '随手记本周做的事、数据、进展，越碎越好，AI 帮你整理' },
        ],
        steps: [
          {
            ref: '1',
            name: '提炼本周成果',
            goal: '把「{{highlights}}」里零散的记录归类、去重、提炼成 3~5 条本周核心成果，量化关键数据',
            skills: 'summarize',
            assigned_agent: 'general-purpose',
            depends_on: [],
          },
          {
            ref: '2',
            name: '生成周报文档',
            goal: '按「本周成果 / 数据亮点 / 问题与风险 / 下周计划」结构生成正式周报，导出 Word 文档',
            skills: 'md2word',
            assigned_agent: 'general-purpose',
            depends_on: ['1'],
          },
        ],
      },
    ]

    const content = `
      <div class="apps-template-list">
        ${templates
          .map(
            (t) => `
          <div class="apps-template-card" data-template="${t.id}">
            ${appIconTileHtml({ id: t.id, name: t.name })}
            <div class="apps-template-info">
              <h4>${t.name}</h4>
              <p>${t.desc}</p>
            </div>
          </div>
        `,
          )
          .join('')}
      </div>
    `

    const modal = showContentModal({
      title: '从模板创建',
      content,
      buttons: [],
      width: 640,
    })

    modal.querySelectorAll('.apps-template-card').forEach((card) => {
      card.addEventListener('click', async () => {
        const templateId = card.dataset.template
        const template = templates.find((t) => t.id === templateId)
        if (!template) return

        try {
          const created = await api.createApp({
            name: template.name,
            description: template.desc,
            execution_mode: 'workflow',
            folder_id: createTargetFolderId(),
            plan: {
              goal: template.goal,
              steps: template.steps,
            },
            parameters: template.parameters,
          })
          toast.success('模板工作流创建成功')
          modal.close()
          const newId = created?.id || created?.app_id || created?.appId
          if (!newId) {
            toast.warning('已创建，但未返回工作流 ID，请在列表中打开')
            await loadApps()
            return
          }
          navigate(`/apps/${newId}`)
        } catch (e) {
          toast.error('创建失败: ' + e.message)
        }
      })
    })
  }

  // 从任务沉淀弹窗
  async function showFromTaskModal() {
    const content = `
      <div class="apps-from-task">
        <p class="apps-from-task-hint">选择一个已完成的任务，将其流程沉淀为可复用的工作流</p>
        <div class="apps-from-task-loading">加载中…</div>
        <div class="apps-from-task-list" style="display:none"></div>
      </div>
    `

    const modal = showContentModal({
      title: '从任务沉淀',
      content,
      buttons: [],
      width: 640,
    })

    const loadingEl = modal.querySelector('.apps-from-task-loading')
    const listEl = modal.querySelector('.apps-from-task-list')

    try {
      const tasks = await api.listAllTasks({ status: 'completed', limit: 50 })
      loadingEl.style.display = 'none'
      listEl.style.display = 'block'

      if (!tasks || tasks.length === 0) {
        listEl.innerHTML = '<div class="apps-from-task-empty">暂无已完成的任务</div>'
        return
      }

      listEl.innerHTML = tasks
        .map((task) => {
          const name = task.name || task.title || '未命名任务'
          const desc = task.description || ''
          const id = task.id
          return `
            <div class="apps-from-task-card" data-task-id="${id}">
              <div class="apps-from-task-info">
                <h4>${escHtml(name)}</h4>
                <p>${escHtml(desc)}</p>
              </div>
              <button type="button" class="btn btn-sm btn-primary">选择</button>
            </div>
          `
        })
        .join('')

      listEl.querySelectorAll('.apps-from-task-card').forEach((card) => {
        card.addEventListener('click', async () => {
          const taskId = card.dataset.taskId
          const task = tasks.find((t) => t.id === taskId)
          if (!task) return

          try {
            toast.info('正在从任务创建工作流…')
            // 必须走 /tasks/{id}/save-as-app：带 auto_extract 的计划抽取只在那里实现；
            // 走 POST /apps 会建出只有占位步骤的空壳（CreateAppRequest 不收 auto_extract）。
            const created = await api.saveTaskAsApp(taskId, {
              name: (task.name || task.title || '从任务沉淀') + ' - 工作流',
              execution_mode: 'workflow',
              auto_extract: true,
            })
            toast.success('工作流创建成功')
            modal.close()
            const newId = created?.id || created?.app_id || created?.appId
            if (!newId) {
              toast.warning('已创建，但未返回工作流 ID，请在列表中打开')
              await loadApps()
              return
            }
            navigate(`/apps/${newId}`)
          } catch (e) {
            toast.error('创建失败: ' + e.message)
          }
        })
      })
    } catch (e) {
      loadingEl.textContent = '加载失败: ' + e.message
    }
  }

  // 初始加载
  loadApps()

  try {
    if (sessionStorage.getItem('evopanel_pending_app_create') === '1') {
      sessionStorage.removeItem('evopanel_pending_app_create')
      // 等首屏挂载后再弹创建（避免与列表加载抢焦点）
      queueMicrotask(() => showNewAppModal())
    }
  } catch {
    /* ignore */
  }

  void import('../lib/page-live-refresh.js').then(({ subscribePageLiveRefresh }) => {
    const unsub = subscribePageLiveRefresh(() => void loadApps(), { domains: ['workflow', 'apps'] })
    page._xmLiveUnsub = unsub
  })

  return page
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
