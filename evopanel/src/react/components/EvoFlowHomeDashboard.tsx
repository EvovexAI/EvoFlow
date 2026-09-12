import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  AlertTriangle,
  AppWindow,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock3,
  Database,
  Paperclip,
  PlayCircle,
  Send,
  Settings2,
  Sparkles,
  Target,
  Users,
  Workflow,
  X,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { toast } from '../../components/toast.js'
import { EVOFLOW_INTRO_SELF_PROMPT } from '../../lib/evoflow-intro-prompt.js'
import { getPanelSetting, getVoiceReplyEnabled, patchPanelSettings } from '../../lib/panel-settings.js'
import { voiceReplyModeToSettingsPatch } from '../../lib/voice-reply-mode.js'
import { isTauri } from '../../lib/panel-login.js'
import { loadSkillCatalog, subscribeSkillCatalog } from '../../lib/skill-catalog.js'
import { api } from '../../lib/tauri-api.js'
import { ObjectUrlImg } from './ObjectUrlImg.js'
import { ImagePreviewModal, type ImagePreviewItem } from './ImagePreviewModal.js'
import { isImagePathLike, resolveChatImageSrc } from '../../lib/chat-image-src.js'
import {
  createComposeAttachHandlers,
  pickLocalContextFiles,
  type ComposePathEntry,
} from '../lib/compose-attach.js'
import {
  DEFAULT_HOME_PREFS,
  loadHomeWorkbenchPrefs,
  saveHomeWorkbenchPrefs,
  type HomeWorkbenchPrefs,
} from '../lib/home-workbench-prefs.js'
import {
  buildModelConnNameMap,
  defaultModelFromCatalog,
  modelDisplayLabel,
  normalizeModelCatalogRows,
  type ModelCatalogEntry,
} from '../lib/model-catalog.js'
import { type AgentPickerRow } from '../lib/agent-tags.js'
import {
  useHomeDashboardData,
  type HomeBadgeTone,
  type HomeKpi,
  type HomeListItem,
  type HomeSourceSlice,
  type HomeTrendPoint,
} from '../hooks/useHomeDashboardData.js'
import { AgentPickerModal } from './AgentPickerModal.js'
import { ChartSizeGate } from './ChartSizeGate.js'
import { ModelCatalogMenu } from './ModelCatalogMenu.js'
import { SkillPickerModal, type SkillPickerItem, type SkillSelection } from './SkillPickerModal.js'

type Props = {
  onPrompt?: (text: string) => void
}

type DrawerKind = 'settings' | null

const STORAGE_MODEL_KEY = 'evopanel-chat-selected-model'

function readStoredModelName(): string {
  try {
    const fromLs = String(localStorage.getItem(STORAGE_MODEL_KEY) || '').trim()
    if (fromLs) return fromLs
  } catch {
    /* ignore */
  }
  return String(getPanelSetting('lastSelectedModel') || '').trim()
}

const KPI_HREF: Record<string, string> = {
  pending: '#/tasks?tab=todo',
  running: '#/tasks?status=running',
  done: '#/tasks?status=completed&date=today',
  alert: '#/tasks?status=exception',
  auto: '#/automation?tab=runs&date=today',
}

const QUICK_ACTIONS = [
  { id: 'agent', icon: Bot, label: '创建智能体' },
  { id: 'cron', icon: Clock3, label: '创建自动化' },
  { id: 'app', icon: AppWindow, label: '创建工作流' },
  { id: 'hire', icon: Users, label: '雇佣员工' },
  { id: 'kb', icon: Database, label: '连接知识库' },
  { id: 'model', icon: Sparkles, label: '配置模型' },
] as const

/** 首页「更多 · 创意」快捷提示（与主会话底栏同源风格） */
const HOME_MORE_QUICK_PROMPTS: Array<{ label: string; prompt: string }> = [
  { label: '开始创作', prompt: '开始创作：给我一个可直接执行的第一步方案，并附上下一步行动清单。' },
  { label: '写作', prompt: '撰写一篇关于[主题]的博客文章' },
  { label: '深入研究', prompt: '深入浅出的研究一下[主题]，并总结发现。' },
  { label: '学习', prompt: '帮我学习[主题]：先给学习路线，再出练习题并批改。' },
  { label: '创建角色', prompt: '我想新建一个能长期用的[类型]角色。' },
]

const KPI_ICONS: Record<string, typeof CheckCircle2> = {
  pending: CheckCircle2,
  running: PlayCircle,
  done: CheckCircle2,
  alert: AlertTriangle,
  auto: Workflow,
}

const MODULE_LABELS: Record<keyof HomeWorkbenchPrefs['modules'], string> = {
  composer: '顶部输入框',
  kpis: 'KPI 卡片',
  trend: '任务趋势',
  source: '来源分布',
  todos: '待办',
  recent: '最近运行',
  quick: '快捷操作',
  apps: '我的工作流',
}

const TOP_ORDER_LABELS: Record<HomeWorkbenchPrefs['topOrder'][number], string> = {
  trend: '任务趋势',
  source: '来源分布',
  todos: '待办',
}

/** 工作台待办 Tab 列表最多展示条数，更多走「查看更多」 */
const HOME_TODO_LIMIT = 5

const BOTTOM_ORDER_LABELS: Record<HomeWorkbenchPrefs['bottomOrder'][number], string> = {
  recent: '最近运行',
  quick: '快捷操作',
  apps: '我的工作流',
}

function rangeDaysFromPrefs(range: HomeWorkbenchPrefs['defaultRange']): number {
  if (range === '14d') return 14
  if (range === '30d') return 30
  return 7
}

function rangeLabel(range: HomeWorkbenchPrefs['defaultRange']): string {
  if (range === '14d') return '近14天'
  if (range === '30d') return '近30天'
  return '近7天'
}

function navigateHash(href: string) {
  if (!href) return
  window.location.hash = href.startsWith('#') ? href.slice(1) : href
}

function buildTasksUrl(opts: { status?: string; date?: string; source?: string }) {
  const qs = new URLSearchParams()
  if (opts.status) qs.set('status', opts.status)
  if (opts.date) qs.set('date', opts.date)
  if (opts.source && opts.source !== 'other') qs.set('source', opts.source)
  const q = qs.toString()
  return q ? `#/tasks?${q}` : '#/tasks'
}

function SectionCard({
  title,
  action,
  children,
  className = '',
  style,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
  className?: string
  style?: CSSProperties
}) {
  return (
    <section className={`evo-home-card ${className}`.trim()} style={style}>
      <div className="evo-home-card__head">
        <h2 className="evo-home-card__title">{title}</h2>
        {action}
      </div>
      <div className="evo-home-card__body">{children}</div>
    </section>
  )
}

function StatusBadge({
  children,
  tone = 'default',
}: {
  children: ReactNode
  tone?: HomeBadgeTone
}) {
  return <span className={`evo-home-badge evo-home-badge--${tone}`}>{children}</span>
}

/** 默认态不挂徽章，减少行内噪音 */
function shouldShowTodoBadge(item: HomeListItem, tab: 'mine' | 'action'): boolean {
  if (tab === 'action') return item.bucket === 'approval' || item.bucket === 'alert'
  const st = String(item.status || '').trim()
  return Boolean(st) && st !== '待办'
}

function HomeDrawer({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="evo-home-drawer-root" role="presentation">
      <button type="button" className="evo-home-drawer-mask" aria-label="关闭抽屉" onClick={onClose} />
      <aside className="evo-home-drawer" role="dialog" aria-modal="true" aria-label={title}>
        <header className="evo-home-drawer__head">
          <h3 className="evo-home-drawer__title">{title}</h3>
          <button type="button" className="evo-home-drawer__close" onClick={onClose} aria-label="关闭">
            <X className="evo-home-ic" />
          </button>
        </header>
        <div className="evo-home-drawer__body">{children}</div>
        {footer ? <footer className="evo-home-drawer__foot">{footer}</footer> : null}
      </aside>
    </div>
  )
}

function kpiToneClass(tone: HomeKpi['tone']): string {
  return `evo-home-kpi__icon evo-home-kpi__icon--${tone}`
}

function deltaClass(positive: boolean | null): string {
  if (positive == null) return 'evo-home-kpi__delta'
  return positive ? 'evo-home-kpi__delta is-up' : 'evo-home-kpi__delta is-down'
}

export function EvoFlowHomeDashboard({ onPrompt }: Props) {
  const [prefs, setPrefs] = useState<HomeWorkbenchPrefs>(() => loadHomeWorkbenchPrefs())
  const [prefsDraft, setPrefsDraft] = useState<HomeWorkbenchPrefs>(() => loadHomeWorkbenchPrefs())
  const data = useHomeDashboardData({ rangeDays: rangeDaysFromPrefs(prefs.defaultRange) })
  const [draft, setDraft] = useState(() => {
    try {
      return String(sessionStorage.getItem('evopanel_home_composer_draft') || '')
    } catch {
      return ''
    }
  })
  const [chips, setChips] = useState<Array<{ id: string; label: string }>>([])
  const [drawer, setDrawer] = useState<DrawerKind>(null)
  const [agentOpen, setAgentOpen] = useState(false)
  const [skillOpen, setSkillOpen] = useState(false)
  const [agents, setAgents] = useState<AgentPickerRow[]>([])
  const [agentsLoading, setAgentsLoading] = useState(false)
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [skills, setSkills] = useState<SkillPickerItem[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [selectedSkills, setSelectedSkills] = useState<SkillSelection[]>([])
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogEntry[]>([])
  const [modelConnNameMap, setModelConnNameMap] = useState<Record<string, string>>({})
  const [modelsLoading, setModelsLoading] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string>(() => readStoredModelName())
  const [modelOpen, setModelOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [moreSubOpen, setMoreSubOpen] = useState<null | 'creative'>(null)
  const [voiceReplyEnabled, setVoiceReplyEnabled] = useState(() => getVoiceReplyEnabled())
  const [memoryEnabled, setMemoryEnabled] = useState(true)
  const [goalActive, setGoalActive] = useState(false)
  const [trendTip, setTrendTip] = useState<HomeTrendPoint | null>(null)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [imagePreviewIndex, setImagePreviewIndex] = useState<number | null>(null)
  /** 拖入/路径引用的本地图片全屏预览：null=关闭，number=打开的索引 */
  const [contextImagePreviewIndex, setContextImagePreviewIndex] = useState<number | null>(null)
  const [pendingContextFiles, setPendingContextFiles] = useState<ComposePathEntry[]>([])
  const [todoTab, setTodoTab] = useState<'mine' | 'action'>('action')
  const todoTabInitialized = useRef(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const imageFileRef = useRef<HTMLInputElement>(null)
  const moreRootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      sessionStorage.setItem('evopanel_home_composer_draft', draft)
    } catch {
      /* ignore */
    }
  }, [draft])

  const totalTasks = useMemo(
    () => data.sourceData.reduce((sum, item) => sum + item.value, 0),
    [data.sourceData],
  )

  useEffect(() => {
    if (data.error) toast(data.error, 'error')
  }, [data.error])

  useEffect(() => {
    let cancelled = false
    setAgentsLoading(true)
    void (async () => {
      try {
        const res = await api.listAgents()
        if (cancelled) return
        const list = Array.isArray(res) ? res : res?.agents || []
        setAgents(Array.isArray(list) ? list : [])
      } catch (e) {
        if (!cancelled) {
          setAgents([])
          toast(`智能体列表加载失败：${(e as Error)?.message || e}`, 'error')
        }
      } finally {
        if (!cancelled) setAgentsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    setSkillsLoading(true)
    const unsub = subscribeSkillCatalog((rows: SkillPickerItem[]) => {
      setSkills(rows.filter((s) => s.enabled !== false))
      setSkillsLoading(false)
    })
    void loadSkillCatalog({ enabledOnly: true }).catch((e) => {
      setSkillsLoading(false)
      toast(`技能列表加载失败：${(e as Error)?.message || e}`, 'error')
    })
    return () => { unsub() }
  }, [])

  useEffect(() => {
    let cancelled = false
    setModelsLoading(true)
    void (async () => {
      try {
        const data = await api.listModels()
        if (cancelled) return
        const rows = Array.isArray(data?.models)
          ? data.models
          : Array.isArray(data)
            ? data
            : []
        const next = normalizeModelCatalogRows(rows)
        setModelCatalog(next)

        let primary = ''
        try {
          const primaryInfo = await api.getPrimaryModel()
          primary =
            typeof primaryInfo?.primary_model === 'string'
              ? primaryInfo.primary_model.trim()
              : ''
        } catch {
          /* ignore */
        }

        try {
          const conns = await api.listModelConnections()
          const list = Array.isArray(conns) ? conns : conns?.connections || []
          if (!cancelled) setModelConnNameMap(buildModelConnNameMap(list))
        } catch {
          /* ignore */
        }

        setSelectedModel((prev) => {
          const cur = String(prev || '').trim()
          if (cur && next.some((m) => m.name === cur)) return cur
          return defaultModelFromCatalog(next, primary) || cur
        })
      } catch (e) {
        if (!cancelled) {
          setModelCatalog([])
          toast(`模型列表加载失败：${(e as Error)?.message || e}`, 'error')
        }
      } finally {
        if (!cancelled) setModelsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onGoalUi = (event: Event) => {
      const detail = (event as CustomEvent<{ goalActive?: boolean }>).detail
      if (typeof detail?.goalActive === 'boolean') setGoalActive(detail.goalActive)
    }
    window.addEventListener('evopanel:goal-ui', onGoalUi as EventListener)
    return () => window.removeEventListener('evopanel:goal-ui', onGoalUi as EventListener)
  }, [])

  useEffect(() => {
    if (!moreOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target
      if (!(t instanceof Node)) return
      if (moreRootRef.current?.contains(t)) return
      setMoreOpen(false)
      setMoreSubOpen(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMoreOpen(false)
        setMoreSubOpen(null)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [moreOpen])

  const closeMoreMenu = useCallback(() => {
    setMoreOpen(false)
    setMoreSubOpen(null)
  }, [])

  const pickHomeImages = useCallback(() => {
    imageFileRef.current?.click()
  }, [])

  const toggleHomeVoiceReply = useCallback(async () => {
    const next = !voiceReplyEnabled
    setVoiceReplyEnabled(next)
    await patchPanelSettings(voiceReplyModeToSettingsPatch(next))
    window.dispatchEvent(
      new CustomEvent('evopanel:home-set-voice-reply', { detail: { enabled: next } }),
    )
    toast(next ? '已开启语音播报' : '已关闭语音播报', 'success')
  }, [voiceReplyEnabled])

  const toggleHomeMemory = useCallback(() => {
    const next = !memoryEnabled
    setMemoryEnabled(next)
    window.dispatchEvent(
      new CustomEvent('evopanel:home-set-memory', { detail: { enabled: next } }),
    )
    toast(next ? '已开启记忆' : '已关闭记忆', 'success')
  }, [memoryEnabled])

  const modelPillLabel = useMemo(() => {
    if (modelsLoading && !modelCatalog.length) return '加载中…'
    const hit = modelCatalog.find((m) => m.name === selectedModel)
    if (hit) return modelDisplayLabel(hit) || selectedModel
    if (selectedModel) return selectedModel
    const fallback = modelCatalog[0]
    return fallback ? modelDisplayLabel(fallback) || fallback.name : '选择模型'
  }, [modelCatalog, modelsLoading, selectedModel])

  const applySelectedModel = useCallback((name: string) => {
    const next = String(name || '').trim()
    if (!next) return
    setSelectedModel(next)
    setModelOpen(false)
    try {
      localStorage.setItem(STORAGE_MODEL_KEY, next)
    } catch {
      /* ignore */
    }
    void patchPanelSettings({ lastSelectedModel: next })
    window.dispatchEvent(
      new CustomEvent('evopanel:home-select-model', { detail: { modelName: next } }),
    )
    toast(`已切换至 ${next}`, 'success')
  }, [])

  const openGoalPanel = useCallback(() => {
    window.dispatchEvent(new CustomEvent('evopanel:open-goal-panel', { detail: { open: true } }))
  }, [])

  const recentRuns = useMemo(
    () => data.recentRuns.slice(0, prefs.listLimit),
    [data.recentRuns, prefs.listLimit],
  )
  const todosTotal = data.todos.length
  const myTodosTotal = (data.myTodos || []).length
  const todos = useMemo(() => data.todos.slice(0, HOME_TODO_LIMIT), [data.todos])
  const myTodos = useMemo(
    () => (data.myTodos || []).slice(0, HOME_TODO_LIMIT),
    [data.myTodos],
  )
  const myTodosHasMore = myTodosTotal > HOME_TODO_LIMIT
  const todosHasMore = todosTotal > HOME_TODO_LIMIT

  useEffect(() => {
    if (todoTabInitialized.current || data.loading) return
    todoTabInitialized.current = true
    // 有需处理事项时默认打开「需你处理」；否则落到「我的待办」
    setTodoTab(todosTotal > 0 ? 'action' : 'mine')
  }, [data.loading, todosTotal])

  const topOrderVisible = useMemo(
    () => prefs.topOrder.filter((k) => prefs.modules[k]),
    [prefs.modules, prefs.topOrder],
  )
  const bottomOrderVisible = useMemo(
    () => prefs.bottomOrder.filter((k) => prefs.modules[k]),
    [prefs.bottomOrder, prefs.modules],
  )

  const moveOrder = useCallback((row: 'top' | 'bottom', key: string, dir: -1 | 1) => {
    setPrefsDraft((p) => {
      const arr = [...(row === 'top' ? p.topOrder : p.bottomOrder)] as string[]
      const i = arr.indexOf(key)
      const j = i + dir
      if (i < 0 || j < 0 || j >= arr.length) return p
      const tmp = arr[i]
      arr[i] = arr[j]
      arr[j] = tmp
      return row === 'top'
        ? { ...p, topOrder: arr as HomeWorkbenchPrefs['topOrder'] }
        : { ...p, bottomOrder: arr as HomeWorkbenchPrefs['bottomOrder'] }
    })
  }, [])

  const openKpi = useCallback((id: string) => {
    const href = KPI_HREF[id]
    if (!href) return
    navigateHash(href)
    toast('正在打开…', 'info')
  }, [])

  const attachContextFiles = useCallback((entries: ComposePathEntry[]) => {
    setPendingContextFiles((prev) => {
      const map = new Map(prev.map((f) => [f.path, f]))
      const added: ComposePathEntry[] = []
      for (const e of entries) {
        const path = String(e.path || '').trim()
        if (!path) continue
        if (!map.has(path)) {
          const entry = { path, name: e.name || path.replace(/^.*[/\\]/, '') || path }
          map.set(path, entry)
          added.push(entry)
        }
      }
      if (added.length) {
        for (const f of added) {
          toast(`已附加：${f.name}（发送后注入 Agent 上下文）`, 'info')
        }
      }
      return [...map.values()]
    })
  }, [])

  const pickHomeAttachments = useCallback(() => {
    void (async () => {
      if (isTauri) {
        const entries = await pickLocalContextFiles()
        if (!entries.length) return
        attachContextFiles(entries)
        return
      }
      fileRef.current?.click()
    })()
  }, [attachContextFiles])

  useEffect(() => {
    const onOsAttach = (event: Event) => {
      const detail = (event as CustomEvent<{ contextFiles?: ComposePathEntry[] }>).detail
      const files = Array.isArray(detail?.contextFiles)
        ? detail.contextFiles.filter((f) => String(f?.path || '').trim())
        : []
      if (files.length) attachContextFiles(files)
    }
    window.addEventListener('evopanel:home-attach-context', onOsAttach)
    return () => window.removeEventListener('evopanel:home-attach-context', onOsAttach)
  }, [attachContextFiles])

  // 与主聊天输入框共用同一套「解析→分发」逻辑（createComposeAttachHandlers），
  // 仅分发回调不同：首页写入本地 pendingFiles / pendingContextFiles / draft。
  const readClipboardImagePaste = useCallback(async () => {
    if (!isTauri) return null
    try {
      return await api.readClipboardImage()
    } catch {
      return null
    }
  }, [])

  const { handlePaste, handleDrop, handleDragOver } = useMemo(
    () =>
      createComposeAttachHandlers(
        {
          onContextFiles: attachContextFiles,
          onBlobFiles: (files) => setPendingFiles((p) => [...p, ...files]),
          onUrls: (urls) => setDraft((d) => (d ? `${d}\n${urls.join('\n')}` : urls.join('\n'))),
          onPlainText: (text) => setDraft((d) => (d ? `${d}${text}` : text)),
          onUnhandledPasteSync: (value) => setDraft((prev) => (prev === value ? prev : value)),
        },
        { insertUrlsOnDrop: true, readClipboardImage: readClipboardImagePaste },
      ),
    [attachContextFiles, readClipboardImagePaste],
  )

  const sendDraft = useCallback(async () => {
    // 粘贴后偶发 state 未跟上：以输入框 DOM 为准
    const liveDraft = String(inputRef.current?.value ?? draft)
    if (liveDraft !== draft) setDraft(liveDraft)
    const chipText = chips
      .filter((c) => !c.id.startsWith('agent-') && !c.id.startsWith('skill-'))
      .map((c) => c.label)
      .join(' ')
    const text = [chipText, liveDraft].filter((s) => s.trim()).join('\n').trim()
    if (!text && pendingFiles.length === 0 && pendingContextFiles.length === 0) {
      toast('请先输入任务内容', 'warning')
      return
    }
    setActionBusy('send')
    try {
      // 无路径的 File：图片走 base64；文档保留 File 字段由会话上传（与会话输入框一致）
      const attachments = await Promise.all(
        pendingFiles.map(async (file) => {
          const isImage =
            String(file.type || '').startsWith('image/') ||
            /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i.test(file.name || '')
          if (!isImage) {
            return {
              mimeType: file.type || 'application/octet-stream',
              filename: file.name || 'file',
              file,
            }
          }
          return new Promise<{ mimeType: string; content: string; filename: string }>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => {
              const base64 = String(reader.result || '').split(',')[1] || ''
              resolve({
                mimeType: file.type || 'image/png',
                content: base64,
                filename: file.name || 'image',
              })
            }
            reader.onerror = () => reject(reader.error || new Error('read failed'))
            reader.readAsDataURL(file)
          })
        }),
      )
      window.dispatchEvent(
        new CustomEvent('evopanel:home-send', {
          detail: {
            text,
            agentCode: selectedAgent || '',
            skills: selectedSkills,
            modelName: selectedModel || '',
            attachments,
            contextFiles: pendingContextFiles,
          },
        }),
      )
      setDraft('')
      setChips([])
      setPendingFiles([])
      setPendingContextFiles([])
      try {
        sessionStorage.removeItem('evopanel_home_composer_draft')
      } catch {
        /* ignore */
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : '发送失败', 'error')
    } finally {
      setActionBusy(null)
    }
  }, [chips, draft, selectedAgent, selectedModel, selectedSkills, pendingFiles, pendingContextFiles])

  const runQuick = useCallback(
    async (id: string) => {
      setActionBusy(id)
      try {
        if (id === 'agent') {
          try {
            sessionStorage.setItem('evopanel_pending_agent_create', '1')
          } catch {
            /* ignore */
          }
          navigateHash('#/expert')
          toast('正在打开创建智能体向导', 'success')
          return
        }
        if (id === 'cron') {
          try {
            sessionStorage.setItem('evopanel_pending_cron_create', '1')
          } catch {
            /* ignore */
          }
          navigateHash('#/cron')
          toast('正在打开自动化创建', 'success')
          return
        }
        if (id === 'app') {
          try {
            sessionStorage.setItem('evopanel_pending_app_create', '1')
          } catch {
            /* ignore */
          }
          navigateHash('#/apps')
          toast('正在打开工作流创建', 'success')
          return
        }
        if (id === 'hire') {
          try {
            sessionStorage.setItem('evopanel_pending_hire', '1')
          } catch {
            /* ignore */
          }
          navigateHash('#/proactive')
          toast('正在打开雇佣向导', 'success')
          return
        }
        if (id === 'kb') {
          try {
            sessionStorage.setItem('evopanel_pending_kb_connect', '1')
          } catch {
            /* ignore */
          }
          navigateHash('#/knowledge')
          toast('正在打开知识库连接', 'success')
          return
        }
        if (id === 'model') {
          try {
            const mod = await import('../../components/settings-modal.js')
            await mod.openSettingsModal({ initialTab: 'models' })
            toast('已打开模型设置', 'success')
          } catch {
            navigateHash('#/settings?tab=models')
            toast('正在打开模型设置', 'info')
          }
        }
      } catch (e) {
        toast(e instanceof Error ? e.message : '操作失败', 'error')
      } finally {
        setActionBusy(null)
      }
    },
    [],
  )

  const openTodo = useCallback((item: HomeListItem) => {
    if (item.href) {
      navigateHash(item.href)
      toast(item.href.includes('tab=items') || item.href.includes('/items') ? '正在打开事项' : '正在打开详情', 'success')
      return
    }
    navigateHash('#/tasks?tab=items')
    toast('已打开我的事项', 'success')
  }, [])

  const savePrefs = useCallback(() => {
    saveHomeWorkbenchPrefs(prefsDraft)
    setPrefs(prefsDraft)
    setDrawer(null)
    toast('工作台设置已保存', 'success')
  }, [prefsDraft])

  const showTodoEmpty = !data.loading && todosTotal === 0
  const showMyTodoEmpty = !data.loading && myTodosTotal === 0
  const showRecentEmpty = !data.loading && recentRuns.length === 0

  return (
    <div className="evo-home-dashboard">
      <div className="evo-home-dashboard__inner">
        <header className="evo-home-header">
          <div className="evo-home-header__text">
            <div className="evo-home-eyebrow">
              <Sparkles className="evo-home-ic" />
              工作台
            </div>
            <h1 className="evo-home-title">欢迎回来，今天想完成什么？</h1>
            <p className="evo-home-subtitle">描述你的任务，EvoFlow 将为你规划并高效推进工作。</p>
          </div>
          <button
            type="button"
            className="evo-home-btn evo-home-btn--outline"
            onClick={() => {
              setPrefsDraft(loadHomeWorkbenchPrefs())
              setDrawer('settings')
              toast('已打开工作台设置', 'info')
            }}
          >
            工作台设置
            <Settings2 className="evo-home-ic" />
          </button>
        </header>

        {data.loading ? <div className="evo-home-banner evo-home-banner--loading">正在加载工作台数据…</div> : null}
        {data.error ? (
          <div className="evo-home-banner evo-home-banner--error">
            加载失败：{data.error}
            <button type="button" className="evo-home-link" onClick={() => data.refresh()}>
              重试
            </button>
          </div>
        ) : null}

        {prefs.modules.composer ? (
          <section
            className="evo-home-composer"
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files || [])
                if (!files.length) return
                setPendingFiles((prev) => [...prev, ...files])
                toast(`已添加 ${files.length} 个附件`, 'success')
                e.target.value = ''
              }}
            />
            <input
              ref={imageFileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files || [])
                if (!files.length) return
                setPendingFiles((prev) => [...prev, ...files])
                toast(`已添加 ${files.length} 张图片`, 'success')
                e.target.value = ''
              }}
            />
            {chips.length ? (
              <div className="evo-home-composer__chips">
                {chips.map((c) => (
                  <span key={c.id} className="evo-home-chip">
                    {c.label}
                    <button
                      type="button"
                      aria-label="移除"
                      onClick={() => setChips((prev) => prev.filter((x) => x.id !== c.id))}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            {pendingContextFiles.length > 0 ? (
              <div className="evo-home-composer__context" aria-label="已附加本地文件">
                {pendingContextFiles.map((f) => {
                  const isImg = isImagePathLike(f.path)
                  const imgSrc = isImg ? resolveChatImageSrc(f.path) : ''
                  if (isImg) {
                    const imgIndex = pendingContextFiles.filter((x) => isImagePathLike(x.path)).findIndex((x) => x.path === f.path)
                    return (
                      <div
                        key={f.path}
                        className="react-chat-context-img-card"
                        role="button"
                        tabIndex={0}
                        title={f.path}
                        onClick={() => setContextImagePreviewIndex(imgIndex >= 0 ? imgIndex : 0)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            setContextImagePreviewIndex(imgIndex >= 0 ? imgIndex : 0)
                          }
                        }}
                      >
                        {imgSrc ? (
                          <img
                            src={imgSrc}
                            alt={f.name}
                            className="react-chat-context-img-thumb"
                            onError={(e) => {
                              e.currentTarget.style.display = 'none'
                            }}
                          />
                        ) : null}
                        <div className="react-chat-context-img-name">{f.name}</div>
                        <button
                          type="button"
                          className="react-chat-context-pill-remove react-chat-context-img-x"
                          aria-label="移除"
                          onClick={(e) => {
                            e.stopPropagation()
                            setPendingContextFiles((prev) => prev.filter((x) => x.path !== f.path))
                          }}
                        >
                          ×
                        </button>
                      </div>
                    )
                  }
                  return (
                    <button
                      key={f.path}
                      type="button"
                      className="evo-home-context-chip"
                      title={f.path}
                      onClick={() =>
                        setPendingContextFiles((prev) => prev.filter((x) => x.path !== f.path))
                      }
                    >
                      <span className="evo-home-context-chip-name">{f.name}</span>
                      <span aria-hidden>×</span>
                    </button>
                  )
                })}
              </div>
            ) : null}
            {contextImagePreviewIndex !== null &&
            pendingContextFiles.some((x) => isImagePathLike(x.path)) ? (
              (() => {
                const imgItems: ImagePreviewItem[] = pendingContextFiles
                  .filter((x) => isImagePathLike(x.path))
                  .map((x) => ({ src: resolveChatImageSrc(x.path), name: x.name }))
                const safeIndex = Math.min(contextImagePreviewIndex, imgItems.length - 1)
                return (
                  <ImagePreviewModal
                    images={imgItems}
                    index={safeIndex}
                    onClose={() => setContextImagePreviewIndex(null)}
                  />
                )
              })()
            ) : null}
            {pendingFiles.length > 0 && (
              <div className="evo-home-composer__images">
                {pendingFiles.map((f, i) => {
                  const isImage = String(f.type || '').startsWith('image/')
                  if (isImage) {
                    return (
                      <div
                        key={`${f.name}-${f.size}-${f.lastModified}-${i}`}
                        className="react-chat-image-preview-card"
                        onClick={() => {
                          const imageIdx = pendingFiles.filter((x) => String(x.type || '').startsWith('image/')).indexOf(f)
                          setImagePreviewIndex(imageIdx >= 0 ? imageIdx : 0)
                        }}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            const imageIdx = pendingFiles.filter((x) => String(x.type || '').startsWith('image/')).indexOf(f)
                            setImagePreviewIndex(imageIdx >= 0 ? imageIdx : 0)
                          }
                        }}
                      >
                        <ObjectUrlImg file={f} alt={f.name} className="react-chat-image-preview-card-thumb" />
                        <div className="react-chat-image-preview-card-name">{f.name}</div>
                        <button
                          type="button"
                          className="react-chat-image-preview-card-x"
                          aria-label="移除"
                          onClick={(e) => {
                            e.stopPropagation()
                            setPendingFiles((p) => p.filter((_, j) => j !== i))
                          }}
                        >
                          ×
                        </button>
                      </div>
                    )
                  }
                  return (
                    <span key={`${f.name}-${f.size}-${f.lastModified}-${i}`} className="evo-home-image-chip">
                      <span className="evo-home-image-chip-name">{f.name}</span>
                      <button
                        type="button"
                        className="evo-home-image-chip-x"
                        aria-label="移除"
                        onClick={() => setPendingFiles((p) => p.filter((_, j) => j !== i))}
                      >
                        ×
                      </button>
                    </span>
                  )
                })}
              </div>
            )}
            {imagePreviewIndex !== null && pendingFiles.some((f) => String(f.type || '').startsWith('image/')) ? (
              (() => {
                const imageItems: ImagePreviewItem[] = pendingFiles
                  .filter((f) => String(f.type || '').startsWith('image/'))
                  .map((f) => ({ file: f, name: f.name }))
                const safeIndex = Math.min(imagePreviewIndex, imageItems.length - 1)
                return (
                  <ImagePreviewModal
                    images={imageItems}
                    index={safeIndex}
                    onClose={() => setImagePreviewIndex(null)}
                    onRemove={(idx) => {
                      const imageFileToRemove = pendingFiles.filter((f) => String(f.type || '').startsWith('image/'))[idx]
                      if (imageFileToRemove) {
                        const realIdx = pendingFiles.indexOf(imageFileToRemove)
                        if (realIdx >= 0) setPendingFiles((p) => p.filter((_, j) => j !== realIdx))
                      }
                      if (imageItems.length <= 1) setImagePreviewIndex(null)
                    }}
                  />
                )
              })()
            ) : null}
            <textarea
              ref={inputRef}
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onInput={(e) => {
                // 粘贴时偶发 DOM 已有字、受控 state 未跟上；用 input 再同步一次
                const v = e.currentTarget.value
                setDraft((prev) => (prev === v ? prev : v))
              }}
              onPaste={handlePaste}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.shiftKey) return
                if (e.nativeEvent.isComposing || e.keyCode === 229) return
                e.preventDefault()
                void sendDraft()
              }}
              placeholder="描述你的任务，或拖入文件 / 粘贴路径与链接…"
              className="evo-home-composer__input"
              aria-label="任务输入"
            />
            <div className="evo-home-composer__bar">
              <div className="evo-home-composer__tools">
                <ModelCatalogMenu
                  open={modelOpen}
                  onOpenChange={(open) => {
                    setModelOpen(open)
                    if (open) closeMoreMenu()
                  }}
                  catalog={modelCatalog}
                  connNameMap={modelConnNameMap}
                  selectedModel={selectedModel}
                  pillLabel={modelPillLabel}
                  loading={modelsLoading}
                  placement="down"
                  className="evo-home-model-menu-root"
                  onSelect={applySelectedModel}
                />
                <button
                  type="button"
                  className={`evo-home-btn evo-home-btn--chip evo-home-btn--goal${
                    goalActive ? ' is-active' : ''
                  }`}
                  onClick={openGoalPanel}
                  title="打开目标面板"
                >
                  <Target className="evo-home-ic" />
                  目标
                  {goalActive ? <span className="evo-home-goal-dot" aria-hidden /> : null}
                </button>
                <button
                  type="button"
                  className="evo-home-btn evo-home-btn--chip"
                  onClick={() => {
                    closeMoreMenu()
                    pickHomeAttachments()
                  }}
                >
                  <Paperclip className="evo-home-ic" />
                  附件
                </button>
                <button
                  type="button"
                  className="evo-home-btn evo-home-btn--chip"
                  onClick={() => {
                    closeMoreMenu()
                    setAgentOpen(true)
                  }}
                >
                  <Bot className="evo-home-ic" />
                  {selectedAgent
                    ? agents.find(
                        (a) =>
                          String(a.agent_code || '').trim().toLowerCase() ===
                          selectedAgent.toLowerCase(),
                      )?.agent_name || '智能体'
                    : '智能体'}
                </button>
                <button
                  type="button"
                  className="evo-home-btn evo-home-btn--chip"
                  onClick={() => {
                    closeMoreMenu()
                    setSkillOpen(true)
                  }}
                >
                  <CircleDot className="evo-home-ic" />
                  {selectedSkills.length ? `技能 ${selectedSkills.length}` : '技能'}
                </button>
                <div className="react-chat-bottom-pill-root react-chat-bottom-pill-root--down evo-home-more-root" ref={moreRootRef}>
                  <button
                    type="button"
                    className={`react-chat-bottom-pill evo-home-more-pill${moreOpen ? ' react-chat-bottom-pill--open' : ''}`}
                    title="更多：图片 / 语音 / 记忆 / 创意"
                    aria-expanded={moreOpen}
                    onClick={() => {
                      setMoreOpen((prev) => {
                        const next = !prev
                        if (next) {
                          setModelOpen(false)
                          setMoreSubOpen(null)
                        } else {
                          setMoreSubOpen(null)
                        }
                        return next
                      })
                    }}
                  >
                    <svg
                      className="react-chat-bottom-pill-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <circle cx="5" cy="12" r="1.5" />
                      <circle cx="12" cy="12" r="1.5" />
                      <circle cx="19" cy="12" r="1.5" />
                    </svg>
                    <span className="react-chat-bottom-pill-text">更多</span>
                    <span className="react-chat-bottom-pill-caret">▾</span>
                  </button>
                  {moreOpen ? (
                    <div
                      className="react-chat-bottom-dropdown react-chat-bottom-dropdown--more evo-home-more-dropdown"
                      role="menu"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        className="react-chat-bottom-dropdown-item"
                        onClick={() => {
                          closeMoreMenu()
                          pickHomeImages()
                        }}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0 }}>
                          <rect x="3" y="5" width="18" height="14" rx="2" />
                          <circle cx="8.5" cy="10" r="1.5" />
                          <path d="M21 16l-5.2-5.2a1.5 1.5 0 00-2.1 0L3 18" />
                        </svg>
                        <span>添加图片</span>
                      </button>

                      <div className="react-chat-bottom-dropdown-divider" role="separator" />

                      <button
                        type="button"
                        role="menuitem"
                        className={`react-chat-bottom-dropdown-item${voiceReplyEnabled ? ' react-chat-bottom-dropdown-item--active' : ''}`}
                        onClick={() => {
                          void toggleHomeVoiceReply()
                        }}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0 }}>
                          <path d="M11 5L6 9H2v6h4l5 4V5z" />
                          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                        </svg>
                        <span>语音播报</span>
                        <span className="react-chat-more-submenu-badge">{voiceReplyEnabled ? '开' : '关'}</span>
                        {voiceReplyEnabled ? (
                          <span className="react-chat-skill-item-check" aria-hidden>✓</span>
                        ) : null}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className={`react-chat-bottom-dropdown-item${memoryEnabled ? ' react-chat-bottom-dropdown-item--active' : ''}`}
                        onClick={() => {
                          toggleHomeMemory()
                        }}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0 }}>
                          <path d="M12 3 4 7l8 4 8-4-8-4z" />
                          <path d="M4 12l8 4 8-4" />
                          <path d="M4 17l8 4 8-4" />
                        </svg>
                        <span>记忆</span>
                        <span className="react-chat-more-submenu-badge">{memoryEnabled ? '开' : '关'}</span>
                        {memoryEnabled ? (
                          <span className="react-chat-skill-item-check" aria-hidden>✓</span>
                        ) : null}
                      </button>

                      <div className="react-chat-more-submenu-item">
                        <button
                          type="button"
                          className={`react-chat-more-submenu-header${moreSubOpen === 'creative' ? ' react-chat-more-submenu-header--open' : ''}`}
                          onClick={() => setMoreSubOpen((p) => (p === 'creative' ? null : 'creative'))}
                        >
                          <Sparkles className="evo-home-ic" aria-hidden />
                          <span className="react-chat-more-submenu-title">创意</span>
                          <span className="react-chat-more-submenu-caret" aria-hidden>▸</span>
                        </button>
                        {moreSubOpen === 'creative' ? (
                          <div className="react-chat-more-submenu-flyout react-chat-more-submenu-flyout--scroll" role="menu">
                            {HOME_MORE_QUICK_PROMPTS.map((p) => (
                              <button
                                key={p.label}
                                type="button"
                                role="menuitem"
                                className="react-chat-bottom-dropdown-item"
                                onClick={() => {
                                  closeMoreMenu()
                                  setDraft((d) => (d.trim() ? `${d.trim()}\n${p.prompt}` : p.prompt))
                                  inputRef.current?.focus()
                                }}
                              >
                                {p.label}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="evo-home-btn evo-home-btn--ghost"
                  onClick={() => onPrompt?.(EVOFLOW_INTRO_SELF_PROMPT)}
                >
                  了解 EvoFlow
                </button>
              </div>
              <button
                type="button"
                className="evo-home-btn evo-home-btn--send"
                aria-label="发送任务"
                title="发送（Enter）"
                disabled={actionBusy === 'send'}
                onClick={() => void sendDraft()}
              >
                <Send className="evo-home-ic" />
              </button>
            </div>
            <p className="evo-home-composer__ai-tip">
              各个功能还不熟悉也没关系：找「小秘书小V」或「EvoFlow」直接说就行，例如「帮我记一条待办」「雇佣一个智能体员工」。做完后到对应页面查看结果即可。
            </p>
          </section>
        ) : null}

        {prefs.modules.kpis ? (
          <section className="evo-home-kpi-grid">
            {data.kpis.map((item) => {
              const Icon = KPI_ICONS[item.id] || CheckCircle2
              return (
                <button
                  type="button"
                  key={item.id}
                  className="evo-home-kpi"
                  onClick={() => openKpi(item.id)}
                >
                  <div className={kpiToneClass(item.tone)}>
                    <Icon className="evo-home-ic evo-home-ic--lg" />
                  </div>
                  <div className="evo-home-kpi__meta">
                    <div className="evo-home-kpi__label">{item.label}</div>
                    <div className="evo-home-kpi__value">{data.loading ? '—' : item.value}</div>
                    <div className={deltaClass(item.deltaPositive)}>{item.delta}</div>
                    {item.hint ? <div className="evo-home-kpi__hint">{item.hint}</div> : null}
                  </div>
                  <ChevronRight className="evo-home-kpi__arrow" aria-hidden="true" />
                </button>
              )
            })}
          </section>
        ) : null}

        <section className="evo-home-row evo-home-row--top">
          {prefs.modules.trend ? (
            <SectionCard
              title={`${rangeLabel(prefs.defaultRange)}任务趋势`}
              className="evo-home-card--trend"
              style={{ order: topOrderVisible.indexOf('trend') }}
              action={
                <button type="button" className="evo-home-btn evo-home-btn--chip" onClick={() => navigateHash('#/tasks')}>
                  {rangeLabel(prefs.defaultRange)}
                </button>
              }
            >
              <div className="evo-home-legend">
                <span>
                  <i className="evo-home-dot evo-home-dot--accent" /> 创建
                </span>
                <span>
                  <i className="evo-home-dot evo-home-dot--success" /> 完成
                </span>
                <span>
                  <i className="evo-home-dot evo-home-dot--error" /> 失败
                </span>
              </div>
              <div className="evo-home-chart">
                <ChartSizeGate>
                  {({ width, height }) => (
                    <ResponsiveContainer width={width} height={height}>
                      <AreaChart
                        data={data.trendData}
                        margin={{ top: 8, right: 8, left: -20, bottom: 0 }}
                        onClick={(state) => {
                          const payload = (state as { activePayload?: Array<{ payload: HomeTrendPoint }> })?.activePayload?.[0]
                            ?.payload
                          if (!payload) return
                          setTrendTip(payload)
                          toast(`已选中 ${payload.date}`, 'info')
                        }}
                      >
                        <defs>
                          <linearGradient id="evoHomeCreatedFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.24} />
                            <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-primary)" vertical={false} />
                        <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fill: 'var(--text-primary)', fontSize: 11 }} />
                        <YAxis axisLine={false} tickLine={false} tick={{ fill: 'var(--text-primary)', fontSize: 11 }} allowDecimals={false} />
                        <Tooltip
                          contentStyle={{
                            borderRadius: 12,
                            border: '1px solid var(--border-primary)',
                            background: 'var(--bg-card)',
                            color: 'var(--text-primary)',
                            boxShadow: 'var(--shadow-md)',
                            fontSize: 12,
                          }}
                        />
                        <Area type="monotone" dataKey="created" name="创建" stroke="var(--accent)" strokeWidth={2.4} fill="url(#evoHomeCreatedFill)" />
                        <Area type="monotone" dataKey="completed" name="完成" stroke="var(--success)" strokeWidth={2.2} fill="transparent" />
                        <Area type="monotone" dataKey="failed" name="失败" stroke="var(--error)" strokeWidth={2.2} fill="transparent" />
                      </AreaChart>
                    </ResponsiveContainer>
                  )}
                </ChartSizeGate>
              </div>
              {trendTip ? (
                <div className="evo-home-trend-tip">
                  <div>
                    <strong>{trendTip.date}</strong> · 创建 {trendTip.created} / 完成 {trendTip.completed} / 失败{' '}
                    {trendTip.failed}
                  </div>
                  <button
                    type="button"
                    className="evo-home-btn evo-home-btn--chip"
                    onClick={() => {
                      navigateHash(
                        buildTasksUrl({
                          date: trendTip.isoDate,
                        }),
                      )
                      toast('正在打开任务中心', 'success')
                    }}
                  >
                    查看任务
                  </button>
                </div>
              ) : null}
            </SectionCard>
          ) : null}

          {prefs.modules.source ? (
            <SectionCard
              title="任务来源分布"
              className="evo-home-card--source"
              style={{ order: topOrderVisible.indexOf('source') }}
              action={
                <button type="button" className="evo-home-btn evo-home-btn--chip" onClick={() => navigateHash('#/tasks')}>
                  {rangeLabel(prefs.defaultRange)}
                </button>
              }
            >
              <div className="evo-home-source">
                <div className="evo-home-source__chart">
                  <ChartSizeGate>
                    {({ width, height }) => (
                      <ResponsiveContainer width={width} height={height}>
                        <PieChart>
                          <Pie
                            data={data.sourceData.length ? data.sourceData : [{ name: '暂无', value: 1, color: 'var(--border-primary)', key: 'empty' }]}
                            dataKey="value"
                            nameKey="name"
                            cx="50%"
                            cy="50%"
                            innerRadius={55}
                            outerRadius={82}
                            paddingAngle={2}
                            stroke="none"
                            onClick={(_, idx) => {
                              const item = data.sourceData[idx] as HomeSourceSlice | undefined
                              if (!item?.key || item.key === 'empty') return
                              navigateHash(buildTasksUrl({ source: item.key }))
                              toast(`正在查看来源：${item.name}`, 'success')
                            }}
                          >
                            {(data.sourceData.length ? data.sourceData : [{ name: '暂无', color: 'var(--border-primary)' }]).map(
                              (entry) => (
                                <Cell
                                  key={entry.name}
                                  fill={entry.color}
                                  style={{ cursor: 'pointer' }}
                                />
                              ),
                            )}
                          </Pie>
                        </PieChart>
                      </ResponsiveContainer>
                    )}
                  </ChartSizeGate>
                  <div className="evo-home-source__center">
                    <span className="evo-home-source__total">{data.loading ? '—' : totalTasks}</span>
                    <span className="evo-home-source__total-label">总任务</span>
                  </div>
                </div>
                <div className="evo-home-source__legend">
                  {(data.sourceData.length ? data.sourceData : []).map((item) => {
                    const percent = totalTasks ? Math.round((item.value / totalTasks) * 100) : 0
                    return (
                      <button
                        type="button"
                        key={item.name}
                        className="evo-home-source__row evo-home-source__row--btn"
                        onClick={() => {
                          navigateHash(buildTasksUrl({ source: item.key }))
                          toast(`正在查看来源：${item.name}`, 'success')
                        }}
                      >
                        <div className="evo-home-source__row-left">
                          <span className="evo-home-source__swatch" style={{ backgroundColor: item.color }} />
                          <span className="evo-home-source__name">{item.name}</span>
                        </div>
                        <span className="evo-home-source__value">
                          {percent}% ({item.value})
                        </span>
                      </button>
                    )
                  })}
                  {!data.loading && !data.sourceData.length ? <div className="evo-home-empty">暂无任务数据</div> : null}
                </div>
              </div>
            </SectionCard>
          ) : null}

          {prefs.modules.todos ? (
            <SectionCard
              title="待办"
              className="evo-home-card--todos"
              style={{ order: topOrderVisible.indexOf('todos') }}
              action={
                todoTab === 'mine' ? (
                  <button
                    type="button"
                    className="evo-home-link"
                    onClick={() => {
                      navigateHash('#/tasks?tab=items&new=1')
                      toast('正在记一条事项', 'success')
                    }}
                  >
                    记一条
                  </button>
                ) : (
                  <button
                    type="button"
                    className="evo-home-link"
                    onClick={() => {
                      navigateHash('#/tasks?tab=todo')
                      toast('正在打开任务中心', 'success')
                    }}
                  >
                    查看全部
                  </button>
                )
              }
            >
              <div className="evo-home-todo-tabs" role="tablist" aria-label="待办分类">
                <button
                  type="button"
                  role="tab"
                  aria-selected={todoTab === 'action'}
                  className={`evo-home-todo-tab${todoTab === 'action' ? ' is-active' : ''}`}
                  onClick={() => setTodoTab('action')}
                >
                  需你处理
                  {!data.loading && todosTotal > 0 ? (
                    <span className="evo-home-todo-tab__count">{todosTotal}</span>
                  ) : null}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={todoTab === 'mine'}
                  className={`evo-home-todo-tab${todoTab === 'mine' ? ' is-active' : ''}`}
                  onClick={() => setTodoTab('mine')}
                >
                  我的待办
                  {!data.loading && myTodosTotal > 0 ? (
                    <span className="evo-home-todo-tab__count">{myTodosTotal}</span>
                  ) : null}
                </button>
              </div>

              {todoTab === 'mine' ? (
                <div className="evo-home-todo-panel" role="tabpanel">
                  <div className="evo-home-list evo-home-list--todos">
                    {myTodos.map((item) => (
                      <button
                        type="button"
                        key={`inbox-${item.id}`}
                        className="evo-home-list__item"
                        onClick={() => openTodo(item)}
                      >
                        <div className="evo-home-list__text">
                          <div className="evo-home-list__title">{item.title}</div>
                        </div>
                        {shouldShowTodoBadge(item, 'mine') ? (
                          <StatusBadge tone={item.badge}>{item.status}</StatusBadge>
                        ) : null}
                      </button>
                    ))}
                    {showMyTodoEmpty ? (
                      <div className="evo-home-empty evo-home-empty--todo">
                        <div className="evo-home-empty__title">还没有随手待办</div>
                        <div className="evo-home-empty__desc">点右上角「记一条」即可</div>
                      </div>
                    ) : null}
                  </div>
                  {myTodosHasMore ? (
                    <button
                      type="button"
                      className="evo-home-todo-more"
                      onClick={() => {
                        navigateHash('#/tasks?tab=items')
                        toast('正在打开我的事项', 'success')
                      }}
                    >
                      查看更多
                    </button>
                  ) : null}
                </div>
              ) : (
                <div className="evo-home-todo-panel" role="tabpanel">
                  <div className="evo-home-list evo-home-list--todos">
                    {todos.map((item) => (
                      <button
                        type="button"
                        key={item.id}
                        className={`evo-home-list__item${item.bucket === 'alert' ? ' is-alert' : ''}`}
                        onClick={() => openTodo(item)}
                      >
                        <div className="evo-home-list__text">
                          <div className="evo-home-list__title">{item.title}</div>
                        </div>
                        {shouldShowTodoBadge(item, 'action') ? (
                          <StatusBadge tone={item.badge}>{item.status}</StatusBadge>
                        ) : null}
                      </button>
                    ))}
                    {showTodoEmpty ? (
                      <div className="evo-home-empty evo-home-empty--todo">
                        <div className="evo-home-empty__title">暂无需要你处理的事项</div>
                        <div className="evo-home-empty__desc">待确认与异常会显示在这里</div>
                      </div>
                    ) : null}
                  </div>
                  {todosHasMore ? (
                    <button
                      type="button"
                      className="evo-home-todo-more"
                      onClick={() => {
                        navigateHash('#/tasks?tab=todo')
                        toast('正在打开任务中心', 'success')
                      }}
                    >
                      查看更多
                    </button>
                  ) : null}
                </div>
              )}
            </SectionCard>
          ) : null}
        </section>

        <section className="evo-home-row evo-home-row--bottom">
          {prefs.modules.recent ? (
            <SectionCard
              title="最近运行"
              className="evo-home-card--runs"
              style={{ order: bottomOrderVisible.indexOf('recent') }}
              action={
                <button
                  type="button"
                  className="evo-home-link"
                  onClick={() => {
                    navigateHash('#/tasks')
                    toast('正在打开任务中心', 'success')
                  }}
                >
                  查看全部
                </button>
              }
            >
              <div className="evo-home-list">
                {recentRuns.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className="evo-home-list__item"
                    onClick={() => item.href && navigateHash(item.href)}
                  >
                    <div className="evo-home-list__icon evo-home-list__icon--lg">
                      <Workflow className="evo-home-ic" />
                    </div>
                    <div className="evo-home-list__text">
                      <div className="evo-home-list__title">{item.title}</div>
                      <div className="evo-home-list__meta">{item.meta}</div>
                    </div>
                    <StatusBadge tone={item.badge}>{item.status}</StatusBadge>
                    <span className="evo-home-list__time">{item.time}</span>
                  </button>
                ))}
                {showRecentEmpty ? <div className="evo-home-empty">暂无运行记录</div> : null}
              </div>
            </SectionCard>
          ) : null}

          {prefs.modules.quick ? (
            <SectionCard
              title="快捷操作"
              className="evo-home-card--quick"
              style={{ order: bottomOrderVisible.indexOf('quick') }}
            >
              <div className="evo-home-quick-grid">
                {QUICK_ACTIONS.map((item) => {
                  const Icon = item.icon
                  return (
                    <button
                      type="button"
                      key={item.id}
                      className="evo-home-quick"
                      disabled={actionBusy === item.id}
                      onClick={() => void runQuick(item.id)}
                    >
                      <div className="evo-home-quick__icon">
                        <Icon className="evo-home-ic evo-home-ic--lg" />
                      </div>
                      <div className="evo-home-quick__label">
                        {actionBusy === item.id ? '打开中…' : item.label}
                      </div>
                    </button>
                  )
                })}
              </div>
            </SectionCard>
          ) : null}

          {prefs.modules.apps ? (
            <SectionCard
              title="我的工作流"
              className="evo-home-card--apps"
              style={{ order: bottomOrderVisible.indexOf('apps') }}
              action={
                <button type="button" className="evo-home-link" onClick={() => navigateHash('#/apps')}>
                  最近使用
                </button>
              }
            >
              <div className="evo-home-list">
                {data.apps.map((app) => (
                  <button
                    type="button"
                    key={app.id}
                    className="evo-home-list__item"
                    onClick={() => {
                      navigateHash(app.href)
                      toast(`正在打开 ${app.name}`, 'success')
                    }}
                  >
                    <div className="evo-home-list__icon evo-home-list__icon--muted">
                      <AppWindow className="evo-home-ic" />
                    </div>
                    <div className="evo-home-list__text">
                      <div className="evo-home-list__title">{app.name}</div>
                    </div>
                    <StatusBadge tone={app.badge}>{app.status}</StatusBadge>
                  </button>
                ))}
                {!data.loading && !data.apps.length ? <div className="evo-home-empty">暂无工作流</div> : null}
              </div>
            </SectionCard>
          ) : null}
        </section>
      </div>

      <HomeDrawer open={drawer === 'settings'} title="工作台设置" onClose={() => setDrawer(null)} footer={
        <button type="button" className="evo-home-btn evo-home-btn--send" style={{ width: 'auto', padding: '0 16px' }} onClick={savePrefs}>
          保存设置
        </button>
      }>
        <div className="evo-home-settings">
          <aside className="evo-home-settings__tip" aria-label="对话操作说明">
            <p className="evo-home-settings__tip-title">各个功能还不熟悉？直接跟「小秘书小V」说</p>
            <p className="evo-home-settings__tip-desc">
              想记待办、派任务、建工作流、雇智能体员工、建知识库等，都可以找「小秘书小V」或「EvoFlow」，用平常说话的方式告诉它。
              不用先搞清楚每个功能在哪、怎么点；它会帮你在对应模块里完成，你再到页面里查看进度和结果即可。
            </p>
          </aside>
          <h4 className="evo-home-drawer-subtitle">模块显隐</h4>
          {(Object.keys(DEFAULT_HOME_PREFS.modules) as Array<keyof HomeWorkbenchPrefs['modules']>).map((key) => (
            <label key={key} className="evo-home-settings__row">
              <span>{MODULE_LABELS[key]}</span>
              <input
                type="checkbox"
                checked={prefsDraft.modules[key]}
                onChange={(e) =>
                  setPrefsDraft((p) => ({ ...p, modules: { ...p.modules, [key]: e.target.checked } }))
                }
              />
            </label>
          ))}
          <h4 className="evo-home-drawer-subtitle">上方卡片顺序</h4>
          {prefsDraft.topOrder.map((key) => (
            <div key={key} className="evo-home-settings__row">
              <span>{TOP_ORDER_LABELS[key]}</span>
              <span className="evo-home-settings__order-btns">
                <button type="button" className="evo-home-btn evo-home-btn--chip" onClick={() => moveOrder('top', key, -1)}>
                  上移
                </button>
                <button type="button" className="evo-home-btn evo-home-btn--chip" onClick={() => moveOrder('top', key, 1)}>
                  下移
                </button>
              </span>
            </div>
          ))}
          <h4 className="evo-home-drawer-subtitle">下方卡片顺序</h4>
          {prefsDraft.bottomOrder.map((key) => (
            <div key={key} className="evo-home-settings__row">
              <span>{BOTTOM_ORDER_LABELS[key]}</span>
              <span className="evo-home-settings__order-btns">
                <button type="button" className="evo-home-btn evo-home-btn--chip" onClick={() => moveOrder('bottom', key, -1)}>
                  上移
                </button>
                <button type="button" className="evo-home-btn evo-home-btn--chip" onClick={() => moveOrder('bottom', key, 1)}>
                  下移
                </button>
              </span>
            </div>
          ))}
          <h4 className="evo-home-drawer-subtitle">默认时间范围</h4>
          <select
            className="evo-home-settings__select"
            value={prefsDraft.defaultRange}
            onChange={(e) =>
              setPrefsDraft((p) => ({ ...p, defaultRange: e.target.value as HomeWorkbenchPrefs['defaultRange'] }))
            }
          >
            <option value="7d">近 7 天</option>
            <option value="14d">近 14 天</option>
            <option value="30d">近 30 天</option>
          </select>
          <h4 className="evo-home-drawer-subtitle">列表数量</h4>
          <input
            className="evo-home-settings__select"
            type="number"
            min={3}
            max={20}
            value={prefsDraft.listLimit}
            onChange={(e) => setPrefsDraft((p) => ({ ...p, listLimit: Number(e.target.value) || 6 }))}
          />
        </div>
      </HomeDrawer>

      <AgentPickerModal
        open={agentOpen}
        onClose={() => setAgentOpen(false)}
        agents={agents}
        loading={agentsLoading}
        selected={selectedAgent}
        onConfirm={(code) => {
          const row = agents.find(
            (a) =>
              String(a.agent_code || '').trim().toLowerCase() ===
              String(code || '').trim().toLowerCase(),
          )
          const name = String(row?.agent_name || code || '').trim() || code
          setSelectedAgent(code)
          setAgentOpen(false)
          setChips((prev) => {
            const rest = prev.filter((c) => !c.id.startsWith('agent-'))
            return [...rest, { id: `agent-${code}`, label: `@${name}` }]
          })
          inputRef.current?.focus()
          toast(`已选择智能体「${name}」`, 'success')
        }}
      />

      <SkillPickerModal
        open={skillOpen}
        onClose={() => setSkillOpen(false)}
        skills={skills}
        loading={skillsLoading}
        selected={selectedSkills}
        onConfirm={(next) => {
          setSelectedSkills(next)
          setSkillOpen(false)
          setChips((prev) => {
            const rest = prev.filter((c) => !c.id.startsWith('skill-'))
            return [
              ...rest,
              ...next.map((s) => ({
                id: `skill-${s.name}`,
                label: s.label || s.name,
              })),
            ]
          })
          inputRef.current?.focus()
          if (next.length > 0) toast(`已选择 ${next.length} 个技能`, 'success')
          else toast('已清空技能选择', 'info')
        }}
      />
    </div>
  )
}

export default EvoFlowHomeDashboard
