/**
 * 客户端全局技能目录：统一走 Gateway GET /skills，进程内缓存 + 并发去重。
 * 技能管理页、对话窗选择器、角色编辑等共用此数据源。
 */
import { gatewayProxy } from './tauri-api.js'

/** @typedef {{ name: string, label: string, description: string, icon: string, enabled: boolean, category?: string, license?: string | null, tags: string[] }} SkillCatalogEntry */

const SKILL_ICON_MAP = [
  [/agent|openai|gpt|chatgpt|claude|gemini|copilot|llm|ai-assist/i, '🤖'],
  [/self.improv|autonomous|proactive|reasoning|thinking|chain-of-thought/i, '🧠'],
  [/memory|knowledge|rag|retriev|embedd|vector|context/i, '🧠'],
  [/github|gitlab|bitbucket|pr|pull.request|commit|issue|code.review/i, '🐙'],
  [/browser|playwright|puppeteer|selenium|crawl|scraper|web.automation/i, '🌐'],
  [/docker|kubernetes|k8s|container|deploy|ci.cd|vercel|railway|infra/i, '🐳'],
  [/code|program|develop|sdk|api|rest|graphql|integrat/i, '💻'],
  [/debug|test|lint|format|quality|vet|audit|check|spec/i, '🧪'],
  [/filesystem|file.manager|local.file|folder|directory/i, '📁'],
  [/pdf|document|docx|word|office|read.pdf/i, '📄'],
  [/excel|spreadsheet|sheet|csv|xlsx/i, '📊'],
  [/pptx|slide|presentation|powerpoint/i, '📽️'],
  [/notion|obsidian|wiki|markdown|note|write|doc/i, '📝'],
  [/image.gen|dall.e|midjourney|stable.diffus|flux|photo|picture|img.gen/i, '🎨'],
  [/video.gen|remotion|movie|film|anim|ffmpeg/i, '🎬'],
  [/audio|music|tts|voice|whisper|speech.to.text|text.to.speech|sound/i, '🎵'],
  [/edit.image|photo.edit|canvas|draw|design|svg|manipulat/i, '✏️'],
  [/brave.search|google.search|web.search|searxng|serper|search/i, '🔍'],
  [/deep.research|research|investig|analys|report|summariz/i, '🔬'],
  [/fetch|web.fetch|http|url|request|scrape/i, '🌐'],
  [/data|analytics|chart|graph|dashboard|metric|stat/i, '📈'],
  [/json|yaml|config|parse|transform|structur/i, '📋'],
  [/postgres|mysql|sqlite|supabase|mongodb|redis|database|db/i, '🗄️'],
  [/aws|azure|gcp|cloudflare|cloud|storage|s3|bucket/i, '☁️'],
  [/slack|discord|telegram|team|message|chat|im/i, '💬'],
  [/email|mail|imap|smtp|outlook|gmail/i, '📧'],
  [/feishu|lark|wecom|dingtalk|enterprise/i, '💼'],
  [/twitter|social|weibo|wechat|bilibili|tiktok|douyin|redbook/i, '📱'],
  [/calendar|schedule|meeting|event|outlook.calendar|goog.cal/i, '📅'],
  [/stock|trading|finance|market|price|coin|crypto|polymarket/i, '📈'],
  [/stripe|payment|invoice|billing|receipt/i, '💳'],
  [/ad|marketing|seo|rank|traffic|admapix/i, '📢'],
  [/ontology|knowledge.graph|schema|entity|relation|linked/i, '🔗'],
  [/security|auth|encrypt|pass|key|secret|vault|1pass|ssh/i, '🔐'],
  [/time|date|clock|cron|scheduler|timer/i, '⏰'],
  [/weather|forecast|climate/i, '🌤️'],
  [/map|location|geo|gps|place/i, '🗺️'],
  [/translate|i18n|locale|lang|translat/i, '🌍'],
  [/ssh|terminal|shell|exec|command|process|sysadmin/i, '⚙️'],
  [/everything|search.local|file.search|locate/i, '🔎'],
  [/sequential.thinking|step.by.step|logic|reason/i, '🧮'],
  [/podcast|audio.gen|voice.gen/i, '🎙️'],
]

const DEFAULT_SKILL_ICON = '⚡'

/**
 * 技能标签分类体系：通过 regex 从技能名自动推断 tags。
 * 每个标签含 key(唯一标识)、label(显示名)、icon、color(主题色)。
 */
export const SKILL_TAGS = [
  { key: 'ai-chat', label: 'AI 对话', icon: '🤖', color: '#8b5cf6', patterns: [/agent|openai|gpt|chatgpt|claude|gemini|copilot|llm|ai.assist/i] },
  { key: 'reasoning', label: '推理思考', icon: '🧠', color: '#6366f1', patterns: [/self.improv|autonomous|proactive|reasoning|thinking|chain.of.thought|sequential.thinking|step.by.step|logic|reason/i] },
  { key: 'memory', label: '记忆知识', icon: '📚', color: '#0ea5e9', patterns: [/memory|knowledge|rag|retriev|embedd|vector|context|ontology|knowledge.graph|schema|entity|relation|linked/i] },
  { key: 'code', label: '代码协作', icon: '💻', color: '#10b981', patterns: [/github|gitlab|bitbucket|pr|pull.request|commit|issue|code.review|code|program|develop|sdk|api|rest|graphql|integrat/i] },
  { key: 'testing', label: '测试调试', icon: '🧪', color: '#f59e0b', patterns: [/debug|test|lint|format|quality|vet|audit|check|spec/i] },
  { key: 'files', label: '文件管理', icon: '📁', color: '#64748b', patterns: [/filesystem|file.manager|local.file|folder|directory|everything|search.local|file.search|locate/i] },
  { key: 'docs', label: '文档办公', icon: '📄', color: '#3b82f6', patterns: [/pdf|document|docx|word|office|read.pdf|excel|spreadsheet|sheet|csv|xlsx|pptx|slide|presentation|powerpoint|notion|obsidian|wiki|markdown|note|write|doc/i] },
  { key: 'image', label: '图片', icon: '🎨', color: '#ec4899', patterns: [/image.gen|dall.e|midjourney|stable.diffus|flux|photo|picture|img.gen|edit.image|photo.edit|canvas|draw|design|svg|manipulat/i] },
  { key: 'video', label: '视频', icon: '🎬', color: '#ef4444', patterns: [/video.gen|remotion|movie|film|anim|ffmpeg/i] },
  { key: 'audio', label: '音频', icon: '🎵', color: '#a855f7', patterns: [/audio|music|tts|voice|whisper|speech.to.text|text.to.speech|sound|podcast|audio.gen|voice.gen/i] },
  { key: 'search', label: '搜索研究', icon: '🔍', color: '#06b6d4', patterns: [/brave.search|google.search|web.search|searxng|serper|search|fetch|web.fetch|http|url|request|scrape|deep.research|research|investig|analys|report|summariz/i] },
  { key: 'data', label: '数据分析', icon: '📊', color: '#14b8a6', patterns: [/data|analytics|chart|graph|dashboard|metric|stat|json|yaml|config|parse|transform|structur|postgres|mysql|sqlite|supabase|mongodb|redis|database|db/i] },
  { key: 'devops', label: '部署运维', icon: '🐳', color: '#0891b2', patterns: [/docker|kubernetes|k8s|container|deploy|ci.cd|vercel|railway|infra|aws|azure|gcp|cloudflare|cloud|storage|s3|bucket|ssh|terminal|shell|exec|command|process|sysadmin/i] },
  { key: 'browser', label: '浏览器', icon: '🌐', color: '#22c55e', patterns: [/browser|playwright|puppeteer|selenium|crawl|scraper|web.automation/i] },
  { key: 'comm', label: '通讯协作', icon: '💬', color: '#3b82f6', patterns: [/slack|discord|telegram|team|message|chat|im|email|mail|imap|smtp|outlook|gmail|feishu|lark|wecom|dingtalk|enterprise|calendar|schedule|meeting|event/i] },
  { key: 'social', label: '社交媒体', icon: '📱', color: '#f43f5e', patterns: [/twitter|social|weibo|wechat|bilibili|tiktok|douyin|redbook/i] },
  { key: 'finance', label: '金融支付', icon: '💳', color: '#84cc16', patterns: [/stock|trading|finance|market|price|coin|crypto|polymarket|stripe|payment|invoice|billing|receipt/i] },
  { key: 'marketing', label: '营销推广', icon: '📢', color: '#f97316', patterns: [/\bad\b|marketing|seo|rank|traffic|admapix/i] },
  { key: 'security', label: '安全认证', icon: '🔐', color: '#dc2626', patterns: [/security|auth|encrypt|pass|key|secret|vault|1pass/i] },
  { key: 'utility', label: '工具效率', icon: '⚙️', color: '#78716c', patterns: [/time|date|clock|cron|scheduler|timer|weather|forecast|climate|map|location|geo|gps|place|translate|i18n|locale|lang|translat/i] },
]

/** 根据技能名推断标签列表 */
export function getSkillTags(name) {
  if (!name) return []
  const tags = []
  for (const tag of SKILL_TAGS) {
    for (const pat of tag.patterns) {
      if (pat.test(name)) {
        tags.push(tag.key)
        break
      }
    }
  }
  return tags
}

/** 根据 tag key 获取标签元信息 */
export function getSkillTagMeta(key) {
  return SKILL_TAGS.find((t) => t.key === key) || null
}

/** @type {SkillCatalogEntry[] | null} */
let _cached = null
/** @type {Promise<SkillCatalogEntry[]> | null} */
let _inflight = null
/** @type {Set<(rows: SkillCatalogEntry[]) => void>} */
const _listeners = new Set()

export function getSkillIcon(name) {
  if (!name) return DEFAULT_SKILL_ICON
  for (const [regex, icon] of SKILL_ICON_MAP) {
    if (regex.test(name)) return icon
  }
  return DEFAULT_SKILL_ICON
}

function humanSkillLabel(name) {
  return String(name || '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function firstLine(text) {
  const s = String(text || '').trim()
  if (!s) return ''
  return s.split('\n')[0].trim()
}

/** @param {Record<string, unknown>} row */
function normalizeSkillRow(row) {
  const name = String(row?.name || '').trim()
  return {
    name,
    label: humanSkillLabel(name),
    description: firstLine(row?.description),
    icon: getSkillIcon(name),
    enabled: row?.enabled !== false,
    category: row?.category != null ? String(row.category) : undefined,
    license: row?.license != null ? String(row.license) : null,
    tags: getSkillTags(name),
  }
}

function notifyListeners(rows) {
  for (const fn of _listeners) {
    try {
      fn(rows)
    } catch {
      /* ignore subscriber errors */
    }
  }
}

/** 安装/卸载/启停后调用，使下次 load 重新拉取。 */
export function invalidateSkillCatalog() {
  _cached = null
  _inflight = null
}

/** 订阅目录变更（缓存刷新后通知 React 等 UI）。 */
export function subscribeSkillCatalog(listener) {
  _listeners.add(listener)
  if (_cached) listener(_cached)
  return () => _listeners.delete(listener)
}

/**
 * 加载技能目录（全局缓存，并发去重）。
 * @param {{ force?: boolean, enabledOnly?: boolean }} [opts]
 * @returns {Promise<SkillCatalogEntry[]>}
 */
export async function loadSkillCatalog(opts = {}) {
  const { force = false, enabledOnly = false } = opts

  if (!force && _cached) {
    return enabledOnly ? _cached.filter((s) => s.enabled) : _cached.slice()
  }

  if (!force && _inflight) {
    const rows = await _inflight
    return enabledOnly ? rows.filter((s) => s.enabled) : rows.slice()
  }

  _inflight = (async () => {
    const data = await gatewayProxy('GET', '/skills')
    const raw = Array.isArray(data?.skills) ? data.skills : Array.isArray(data) ? data : []
    const rows = raw.map(normalizeSkillRow).filter((s) => s.name)
    _cached = rows
    _inflight = null
    notifyListeners(rows)
    return rows
  })()

  try {
    const rows = await _inflight
    return enabledOnly ? rows.filter((s) => s.enabled) : rows.slice()
  } catch (e) {
    _inflight = null
    throw e
  }
}

/** 应用启动或进入聊天时可预拉取，避免首次点开 pill 才请求。 */
export function prefetchSkillCatalog() {
  if (_cached || _inflight) return _inflight
  return loadSkillCatalog().catch(() => [])
}

/** 强制刷新并返回最新目录（变更后 UI 主动 reload 用）。 */
export async function reloadSkillCatalog(opts = {}) {
  invalidateSkillCatalog()
  return loadSkillCatalog({ ...opts, force: true })
}

/** 与 Gateway /skills 原始行结构兼容（供 api.loadSkills 等）。 */
export function skillCatalogToApiRows(catalog) {
  return (catalog || []).map(({ name, description, enabled, category, license }) => ({
    name,
    description,
    enabled,
    category,
    license,
  }))
}
