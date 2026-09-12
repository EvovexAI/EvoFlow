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
          <button type="button" class="btn btn-primary" id="btn-new-app">新建工作流 ▾</button>
          <div class="apps-new-menu" hidden>
            <button type="button" class="apps-new-menu-item" data-act="blank">
              <span class="apps-new-menu-icon">◇</span>
              <span>空白工作流</span>
            </button>
            <button type="button" class="apps-new-menu-item" data-act="template">
              <span class="apps-new-menu-icon">📋</span>
              <span>从模板创建</span>
            </button>
            <button type="button" class="apps-new-menu-item" data-act="from-task">
              <span class="apps-new-menu-icon">📦</span>
              <span>从任务沉淀</span>
            </button>
          </div>
        </div>
        <button type="button" class="btn btn-ghost" id="btn-refresh">刷新</button>
      </div>
    </div>

    <div class="page-content">
      <div class="apps-tip">
        <span class="apps-tip-dot" aria-hidden="true"></span>
        <div class="apps-tip-content">
          <div class="apps-tip-main">
            <strong>什么时候用？</strong>同一类活隔三差五就要干，流程已经固定，每次只是换换参数。
          </div>
          <div class="apps-tip-detail">
            <strong>怎么用？</strong>① 点卡片进画布编排流程 → ② 发布 → ③ 点「···」→「填参运行」。
          </div>
        </div>
      </div>

      <div class="apps-filter" role="tablist" aria-label="工作流筛选">
        <button type="button" class="apps-filter-btn is-active" data-filter="active">活跃</button>
        <button type="button" class="apps-filter-btn" data-filter="archived">已归档</button>
        <button type="button" class="apps-filter-btn" data-filter="all">全部</button>
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
        <div class="apps-empty-ico" aria-hidden="true">◇</div>
        <h3 data-role="empty-title">还没有工作流</h3>
        <p data-role="empty-desc">从模板快速创建，或从对话中沉淀</p>
        <div class="apps-empty-actions">
          <button type="button" class="btn btn-primary" id="btn-empty-new-app">创建空白工作流</button>
          <button type="button" class="btn btn-ghost" id="btn-empty-template">从模板创建</button>
        </div>
      </div>
    </div>
  `

  let apps = []
  /** @type {'active' | 'archived' | 'all'} */
  let listFilter = 'active'
  let searchQuery = ''
  let listPage = 1
  let listPageSize = readStoredPageSize(APPS_PAGE_SIZE_KEY)

  async function loadApps() {
    const listEl = page.querySelector('#apps-list')
    try {
      apps = await api.listApps()
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
    let result = apps
    if (listFilter === 'archived') {
      result = result.filter((a) => String(a.status || '').toLowerCase() === 'archived')
    } else if (listFilter === 'active') {
      result = result.filter((a) => String(a.status || '').toLowerCase() !== 'archived')
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter((a) => {
        const name = String(a.name || '').toLowerCase()
        const desc = String(a.description || '').toLowerCase()
        return name.includes(q) || desc.includes(q)
      })
    }
    // 按最近修改时间倒序（最新在前）
    return [...result].sort((a, b) => appSortTime(b) - appSortTime(a))
  }

  function renderAppsList() {
    const listEl = page.querySelector('#apps-list')
    const emptyEl = page.querySelector('#apps-empty')
    const pagerWrap = page.querySelector('#apps-list-pager')
    const shown = visibleApps()

    page.querySelectorAll('.apps-filter-btn').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.filter === listFilter)
    })

    if (shown.length === 0) {
      listEl.style.display = 'none'
      emptyEl.style.display = 'block'
      if (pagerWrap) pagerWrap.innerHTML = ''
      const title = emptyEl.querySelector('[data-role="empty-title"]')
      const desc = emptyEl.querySelector('[data-role="empty-desc"]')
      const emptyBtn = emptyEl.querySelector('#btn-empty-new-app')
      if (listFilter === 'archived') {
        if (title) title.textContent = '没有已归档工作流'
        if (desc) desc.textContent = '归档后的工作流会出现在这里；可恢复为草稿后重新发布。'
        if (emptyBtn) emptyBtn.style.display = 'none'
      } else if (apps.length > 0) {
        if (title) title.textContent = '当前筛选下没有工作流'
        if (desc) desc.textContent = '可切换到「全部」或「已归档」查看。'
        if (emptyBtn) emptyBtn.style.display = 'none'
      } else {
        if (title) title.textContent = '还没有工作流'
        if (desc) {
          desc.textContent =
            '点下方创建 → 在画布选智能体、写步骤 → 点「调试」试跑 → 满意再发布。'
        }
        if (emptyBtn) emptyBtn.style.display = ''
      }
      return
    }

    listEl.style.display = 'grid'
    emptyEl.style.display = 'none'

    const paged = paginateItems(shown, listPage, listPageSize)
    listPage = paged.page
    listPageSize = paged.pageSize

    listEl.innerHTML = paged.items.map(app => {
      const st = String(app.status || 'draft').toLowerCase()
      const published = st === 'published'
      const archived = st === 'archived'
      const badgeClass = published ? 'is-published' : archived ? 'is-archived' : 'is-draft'
      const badgeLabel = published ? '已发布' : archived ? '已归档' : '草稿'
      const stepN = appStepCount(app)
      const paramN = appParamCount(app)
      const metaBits = [
        stepN && paramN ? `${stepN} 步 · ${paramN} 参数` : stepN ? `${stepN} 步` : paramN ? `${paramN} 参数` : null,
      ].filter(Boolean)
      const desc = String(app.description || '').trim()
      const descFallback = archived
        ? '点击查看编排；菜单可恢复为草稿'
        : '点击打开画布编排'
      const updatedAt = formatAppTime(app.updated_at || app.created_at)
      const menuRun = published
        ? `<button type="button" class="app-card-menu-item" data-act="run">填参运行</button>`
        : ''
      const menuArchive = archived
        ? `<button type="button" class="app-card-menu-item" data-act="unarchive">恢复为草稿</button>`
        : `<button type="button" class="app-card-menu-item" data-act="archive">归档</button>`
      return `
        <article class="app-card${archived ? ' is-archived' : ''}" data-app-id="${escHtml(app.id)}" data-status="${escHtml(st)}" tabindex="0">
          <button type="button" class="app-card-more" data-app-id="${escHtml(app.id)}" aria-label="更多操作" title="更多">
            <span aria-hidden="true">···</span>
          </button>
          <div class="app-card-menu" hidden data-menu-for="${escHtml(app.id)}">
            ${menuRun}
            <button type="button" class="app-card-menu-item" data-act="edit">编辑信息</button>
            ${menuArchive}
            <button type="button" class="app-card-menu-item app-card-menu-item--danger" data-act="delete">删除</button>
          </div>
          <div class="app-card-top">
            <div class="app-card-icon" aria-hidden="true">${app.icon || '◇'}</div>
            <div class="app-card-heading">
              <div class="app-card-title-row">
                <h3 class="app-card-name">${escHtml(app.name || '未命名工作流')}</h3>
                <span class="app-card-badge ${badgeClass}">${badgeLabel}</span>
              </div>
              <p class="app-card-meta">${escHtml(metaBits.join(' · '))}</p>
            </div>
          </div>
          <p class="app-card-desc">${escHtml(desc || descFallback)}</p>
          ${
            published
              ? `<div class="app-card-actions">
                  <button type="button" class="btn btn-primary btn-sm app-card-run-btn" data-act="run">▶ 运行</button>
                  <button type="button" class="btn btn-ghost btn-sm app-card-edit-btn" data-act="edit-flow">编辑流程</button>
                </div>`
              : ''
          }
          ${updatedAt ? `<div class="app-card-footer"><time class="app-card-time">${escHtml(updatedAt)}</time></div>` : ''}
        </article>
      `
    }).join('')

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

    listEl.querySelectorAll('.app-card').forEach(card => {
      const open = () => navigate(`/apps/${card.dataset.appId}`)
      card.addEventListener('click', (e) => {
        if (
          e.target.closest('.app-card-more') ||
          e.target.closest('.app-card-menu') ||
          e.target.closest('.app-card-actions')
        )
          return
        closeAllMenus()
        open()
      })
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          if (
            e.target.closest('.app-card-more') ||
            e.target.closest('.app-card-menu') ||
            e.target.closest('.app-card-actions')
          )
            return
          e.preventDefault()
          open()
        }
      })
    })

    // 卡片底部主操作：运行 / 编辑流程（不触发卡片整卡点击）
    listEl.querySelectorAll('.app-card-actions [data-act]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const card = btn.closest('.app-card')
        const appId = card?.dataset.appId
        if (!appId) return
        if (btn.dataset.act === 'run') {
          navigate(`/apps/${appId}/run`)
        } else if (btn.dataset.act === 'edit-flow') {
          navigate(`/apps/${appId}`)
        }
      })
    })

    listEl.querySelectorAll('.app-card-more').forEach((btn) => {
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

    listEl.querySelectorAll('.app-card-menu').forEach((menu) => {
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
        } else if (item.dataset.act === 'archive') {
          await archiveAppConfirm(app)
        } else if (item.dataset.act === 'unarchive') {
          await unarchiveAppConfirm(app)
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
        {
          name: 'icon',
          label: '图标（可选，一个字符或 emoji）',
          value: app.icon || '',
          placeholder: '◇',
        },
        {
          name: 'execution_mode',
          label: '执行方式',
          type: 'select',
          value: app.execution_mode || 'workflow',
          options: [
            { value: 'workflow', label: '按步骤自动跑完（推荐）' },
            { value: 'lead_supervised', label: '先生成计划再确认（监督模式）' },
          ],
          hint: '一般选「自动跑完」；需要人工确认计划时再选监督模式。',
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
            icon: (result.icon || '').trim() || '◇',
            execution_mode: result.execution_mode || 'workflow',
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
    const ok = await showConfirm(`确定删除工作流「${app.name || '未命名'}」？\n删除后不可恢复，工作流定义和运行记录将一并删除。`)
    if (!ok) return
    try {
      await api.deleteApp(app.id)
      toast.success('已删除')
      await loadApps()
    } catch (err) {
      toast.error('删除失败: ' + (err?.message || err))
    }
  }

  async function archiveAppConfirm(app) {
    const ok = await showConfirm(
      `归档工作流「${app.name || '未命名'}」？\n归档后不在默认列表显示，也不能新开填参运行 / API；编排仍可查看。可随时恢复为草稿。`,
    )
    if (!ok) return
    try {
      await api.updateApp(app.id, { status: 'archived' })
      toast.success('已归档')
      await loadApps()
    } catch (err) {
      toast.error('归档失败: ' + (err?.message || err))
    }
  }

  async function unarchiveAppConfirm(app) {
    const ok = await showConfirm(
      `将「${app.name || '未命名'}」恢复为草稿？\n恢复后需重新点「发布」，才能填参运行或创建 API Key。`,
    )
    if (!ok) return
    try {
      await api.updateApp(app.id, { status: 'draft' })
      toast.success('已恢复为草稿')
      listFilter = 'active'
      await loadApps()
    } catch (err) {
      toast.error('恢复失败: ' + (err?.message || err))
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
        if (act === 'blank') {
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
  page.querySelector('#btn-empty-template')?.addEventListener('click', () => showTemplateModal())
  page.querySelector('#btn-refresh').addEventListener('click', loadApps)
  page.querySelectorAll('.apps-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      listFilter = /** @type {'active' | 'archived' | 'all'} */ (btn.dataset.filter || 'active')
      listPage = 1
      renderAppsList()
    })
  })

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
          navigate(`/apps/${created.id}`)
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
        icon: '🔍',
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
        icon: '📝',
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
        icon: '📊',
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
            <div class="apps-template-icon">${t.icon}</div>
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
            plan: {
              goal: template.goal,
              steps: template.steps,
            },
            parameters: template.parameters,
          })
          toast.success('模板工作流创建成功')
          modal.close()
          navigate(`/apps/${created.id}`)
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
            const created = await api.createApp({
              source: 'from_task',
              source_task_id: taskId,
              name: (task.name || task.title || '从任务沉淀') + ' - 工作流',
              execution_mode: 'workflow',
              auto_extract: true,
            })
            toast.success('工作流创建成功')
            modal.close()
            navigate(`/apps/${created.id}`)
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
