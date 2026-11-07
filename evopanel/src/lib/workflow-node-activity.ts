/**
 * 工作流节点：把子智能体的实时活动压成「最新一条」。
 *
 * 节点很小（212×118），纵向只放得下两三行，所以不做 chips 列表 ——
 * 只取当前最新的那一条（正在跑的工具，或最新一段正文），
 * 保证用户扫一眼就知道「此刻在干什么」。
 */

export interface SubtaskActivityLine {
  /** 展示文本 */
  text: string
  /** 这条是工具调用（而不是正文） */
  isTool: boolean
  /** 工具仍在运行 */
  running: boolean
  /** 工具失败 */
  failed: boolean
}

export interface SubtaskNodeActivity {
  /** 最新一条活动（工具或正文） */
  latest: SubtaskActivityLine | null
  /** 正在运行的工具名（没有则空） */
  activeToolLabel: string
  /** 是否有任何可展示的活动 */
  hasActivity: boolean
}

/** 工具状态归一：running / done / failed / pending */
function toolPhase(tool: Record<string, unknown>): 'running' | 'done' | 'failed' | 'pending' {
  const raw = String(tool.status ?? tool.state ?? '').trim().toLowerCase()
  if (!raw) {
    // 没有 status 时：有 output/result 视为已完成，否则视为运行中
    const hasResult =
      tool.output != null && String(tool.output).trim() !== ''
        ? true
        : tool.result != null && String(tool.result).trim() !== ''
          ? true
          : false
    return hasResult ? 'done' : 'running'
  }
  if (
    raw === 'running' ||
    raw === 'in_progress' ||
    raw === 'executing' ||
    raw === 'active' ||
    raw === 'started' ||
    raw === 'pending_approval'
  ) {
    return 'running'
  }
  if (raw === 'failed' || raw === 'error' || raw === 'timed_out' || raw === 'cancelled') {
    return 'failed'
  }
  if (raw === 'pending' || raw === 'queued' || raw === 'submitted') return 'pending'
  return 'done'
}

/** 短标签：mcp__server__tool → tool；read_file → 读取 */
export function shortToolLabel(rawName: string): string {
  const name = String(rawName || '').trim()
  if (!name) return '工具'
  const tail = name.includes('__') ? name.split('__').pop() || name : name
  const map: Record<string, string> = {
    read: '读取',
    read_file: '读取',
    write: '写入',
    write_file: '写入',
    edit: '编辑',
    edit_file: '编辑',
    bash: '终端',
    shell: '终端',
    terminal: '终端',
    execute_command: '终端',
    web_search: '搜索',
    search: '搜索',
    grep: '搜索',
    glob: '搜索',
    ls: '浏览',
    list_dir: '浏览',
    task: '委派',
    subagent: '委派',
    browser: '浏览器',
    browser_click: '点击',
    browser_navigate: '浏览',
    python: '脚本',
    js: '脚本',
    node_repl: '脚本',
  }
  const key = tail.toLowerCase()
  if (map[key]) return map[key]
  return tail.length > 18 ? `${tail.slice(0, 17)}…` : tail
}

/**
 * 从 tools[] 里挑「最新一条」。
 * 正在跑的工具优先（那才是用户关心的当下动作）；否则取最后一次调用的工具。
 */
export function pickLatestTool(tools: unknown[] | undefined | null): {
  line: SubtaskActivityLine | null
  activeToolLabel: string
} {
  if (!Array.isArray(tools) || tools.length === 0) {
    return { line: null, activeToolLabel: '' }
  }
  let lastRunning: { label: string; failed: boolean } | null = null
  let lastAny: { label: string; failed: boolean } | null = null
  let activeToolLabel = ''

  for (const raw of tools) {
    if (!raw || typeof raw !== 'object') continue
    const tool = raw as Record<string, unknown>
    const name = String(tool.name ?? tool.tool_name ?? tool.toolName ?? '').trim()
    if (!name) continue
    const phase = toolPhase(tool)
    const label = shortToolLabel(name)
    const failed = phase === 'failed'
    const running = phase === 'running' || phase === 'pending'
    if (running) {
      lastRunning = { label, failed }
      activeToolLabel = label
    }
    lastAny = { label, failed }
  }

  const picked = lastRunning ?? lastAny
  if (!picked) return { line: null, activeToolLabel: '' }
  return {
    line: {
      text: picked.label,
      isTool: true,
      running: !!lastRunning,
      failed: picked.failed,
    },
    activeToolLabel,
  }
}

/**
 * 从实时正文里取出「最后一段自然语言」。
 * 工具行（JSON / 「工具：xxx」短行）要过滤掉，否则节点只显示工具名噪声。
 */
export function pickLiveProse(raw: string, maxLen = 68): string {
  const text = String(raw || '').trim()
  if (!text) return ''
  const segSep = '\n\n───\n\n'
  const segments = text.includes(segSep) ? text.split(segSep) : [text]
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const seg = String(segments[i] || '').trim()
    if (!seg) continue
    const body = seg.replace(/^【(?:完成|已取消)】[\s\n]*/u, '').trim()
    if (!body) continue
    // 纯工具 JSON 行不算正文
    if (/^\s*\{/.test(body) && (body.includes('"ok"') || body.includes('"action"'))) continue
    if (body.startsWith('工具：') && body.length < 120 && !/[一-鿿]{4,}/.test(body)) continue
    const flat = body.replace(/\s+/g, ' ').trim()
    if (!flat) continue
    return flat.length > maxLen ? `${flat.slice(0, maxLen - 1)}…` : flat
  }
  return ''
}

/**
 * 综合节点活动：只返回最新的一条。
 * 优先级：正在跑的工具 > 最新正文 > 最后调用的工具。
 */
export function resolveNodeActivity(input: {
  tools?: unknown[] | null
  liveOutput?: string | null
  progressHint?: string | null
  running: boolean
}): SubtaskNodeActivity {
  const { line: toolLine, activeToolLabel } = pickLatestTool(input.tools)
  const prose = pickLiveProse(String(input.liveOutput || '')) ||
    pickLiveProse(String(input.progressHint || ''))

  // 正在跑的工具最优先 —— 它就是「此刻在干什么」
  if (toolLine?.running) {
    return {
      latest: toolLine,
      activeToolLabel,
      hasActivity: true,
    }
  }
  if (prose) {
    return {
      latest: { text: prose, isTool: false, running: input.running, failed: false },
      activeToolLabel,
      hasActivity: true,
    }
  }
  if (toolLine) {
    return { latest: toolLine, activeToolLabel, hasActivity: true }
  }
  return { latest: null, activeToolLabel, hasActivity: false }
}
