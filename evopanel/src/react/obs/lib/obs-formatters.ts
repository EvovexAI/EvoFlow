const AGENT_KIND_LABELS: Record<string, string> = {
  main: '主对话',
  subagent: '子代理',
  title: '标题生成',
  mission_state: '意图分析',
  memory: '长期记忆',
  compress: '上下文压缩',
  tool_summary: '工具摘要',
  hosted: '目标对话',
  hosted_panel: '目标面板',
  hosted_closure: '目标小结',
  session_intent: '会话意图',
  auxiliary: '辅助',
}

export function agentKindLabel(kind: string | null | undefined): string {
  const key = String(kind || '').trim()
  if (!key) return '—'
  return AGENT_KIND_LABELS[key] || key
}

export function fmtNum(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 10_000) return `${(v / 1_000).toFixed(1)}K`
  return v.toLocaleString()
}

/** Token counts: always show the raw integer (no K/M compaction). */
export function fmtTok(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return Math.round(v).toLocaleString()
}

const INTERNAL_PROVIDERS = new Set([
  'patched_openai',
  'patched_deepseek',
  'patched_minimax',
  'claude_provider',
  'codex_responses',
])

const MODEL_PREFIX_VENDORS: Record<string, string> = {
  google: 'google',
  anthropic: 'anthropic',
  openai: 'openai',
  deepseek: 'deepseek',
  minimax: 'minimax',
  zhipu: 'zhipu',
  qwen: 'aliyun',
  dashscope: 'aliyun',
}

export function displayProviderName(provider: string | null | undefined, model?: string | null): string {
  const raw = String(provider || '').trim()
  const key = raw.toLowerCase()
  if (raw && !INTERNAL_PROVIDERS.has(key) && !key.startsWith('patched_')) return raw

  const modelKey = String(model || '').trim().toLowerCase()
  if (modelKey.includes('/')) {
    const prefix = modelKey.split('/', 1)[0]
    if (MODEL_PREFIX_VENDORS[prefix]) return MODEL_PREFIX_VENDORS[prefix]
  }

  const alias: Record<string, string> = {
    patched_deepseek: 'deepseek',
    patched_minimax: 'minimax',
    claude_provider: 'anthropic',
    codex_responses: 'openai',
  }
  if (alias[key]) return alias[key]
  if (key.startsWith('patched_')) {
    const stripped = key.slice('patched_'.length)
    if (stripped) return stripped
  }
  return raw || '—'
}

const PROVIDER_ZH: Record<string, string> = {
  volcengine: '火山方舟',
  volces: '火山方舟',
  doubao: '火山方舟',
  aliyun: '阿里云百炼',
  dashscope: '阿里云百炼',
  bailian: '阿里云百炼',
  deepseek: 'DeepSeek',
  zhipu: '智谱',
  google: 'Google',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  minimax: 'MiniMax',
  moonshot: 'Moonshot',
}

/** Display vendor name in Chinese where we have a mapping. */
export function displayProviderLabelZh(provider: string | null | undefined, model?: string | null): string {
  const normalized = displayProviderName(provider, model).toLowerCase()
  if (PROVIDER_ZH[normalized]) return PROVIDER_ZH[normalized]
  for (const [key, label] of Object.entries(PROVIDER_ZH)) {
    if (normalized.includes(key)) return label
  }
  const raw = String(provider || '').trim()
  return raw || displayProviderName(provider, model)
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${(v * 100).toFixed(digits)}%`
}

/** Human-readable hit rate when API returns 0–100 percent. */
export function fmtHitPct(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v.toFixed(digits)}%`
}

export function fmtUsdEstimate(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v <= 0) return '—'
  if (v < 0.01) return `<$0.01`
  return `$${v.toFixed(2)}`
}

export function fmtCnyEstimate(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v <= 0) return '—'
  if (v < 0.01) return `<¥0.01`
  return `¥${v.toFixed(2)}`
}

export function fmtMs(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  if (v < 1000) return `${Math.round(v)} ms`
  return `${(v / 1000).toFixed(1)}s`
}

export function fmtDeltaPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const pct = Math.abs(v * 100)
  const arrow = v >= 0 ? '↑' : '↓'
  return `${arrow} ${pct.toFixed(1)}%`
}

export function fmtDeltaPts(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const arrow = v >= 0 ? '↑' : '↓'
  return `${arrow} ${Math.abs(v * 100).toFixed(1)}%`
}

export function fmtRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const diff = Date.now() - d.getTime()
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}秒前`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}小时前`
  const day = Math.floor(hr / 24)
  return `${day}天前`
}

export function fmtIso(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

/** Format ISO string as yyyymmdd HH:mm:ss */
export function fmtShortDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  return `${y}${mo}${dd} ${h}:${mi}:${s}`
}

export function tryFormatJson(raw: unknown): string {
  if (raw == null) return ''
  if (typeof raw === 'string') {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2)
    } catch {
      return raw
    }
  }
  try {
    return JSON.stringify(raw, null, 2)
  } catch {
    return String(raw)
  }
}

export type TokenGranularity = 'day' | 'week' | 'month'

export function rollupTokenTrends<
  T extends { day: string; prompt_tokens: number; completion_tokens: number; total_tokens: number },
>(rows: T[], granularity: TokenGranularity): T[] {
  if (granularity === 'day' || !rows.length) return rows
  const buckets = new Map<string, T>()
  for (const row of rows) {
    const d = new Date(`${row.day}T00:00:00`)
    if (Number.isNaN(d.getTime())) continue
    let key = row.day
    if (granularity === 'week') {
      const start = new Date(d)
      start.setDate(d.getDate() - d.getDay())
      key = start.toISOString().slice(0, 10)
    } else if (granularity === 'month') {
      key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
    }
    const prev = buckets.get(key)
    if (!prev) {
      buckets.set(key, { ...row, day: key })
    } else {
      prev.prompt_tokens += row.prompt_tokens
      prev.completion_tokens += row.completion_tokens
      prev.total_tokens += row.total_tokens
    }
  }
  return [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day))
}

export function fmtUsageTok(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v <= 0) return '—'
  return fmtTok(v)
}

// @ts-ignore
export function fmtCacheHitTok(cacheRead: number | null | undefined, cacheMiss?: number | null): string {
  const hit = Number(cacheRead)
  if (!Number.isFinite(hit) || hit <= 0) return '—'
  return `⚡${fmtTok(hit)}`
}

export function requestTokenTitle(row: {
  promptTokens?: number
  completionTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  cacheMissTokens?: number
}): string {
  const parts: string[] = []
  if (row.promptTokens) parts.push(`输入 ${row.promptTokens.toLocaleString()}`)
  if (row.completionTokens) parts.push(`输出 ${row.completionTokens.toLocaleString()}`)
  if (row.cacheReadTokens) parts.push(`缓存命中 ${row.cacheReadTokens.toLocaleString()}`)
  if (row.cacheCreationTokens) parts.push(`写入缓存 ${row.cacheCreationTokens.toLocaleString()}`)
  if (row.cacheMissTokens) parts.push(`未命中 ${row.cacheMissTokens.toLocaleString()}`)
  return parts.join(' · ')
}