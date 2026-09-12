/**
 * EvoPanel 开发模式 API 插件
 * 在 Vite 开发服务器上提供真实 API 端点
 */
import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import crypto from 'crypto'
import { exec as _exec, spawn } from 'child_process'
import { promisify } from 'util'

const EVOFLOW_DIR = path.join(homedir(), '.evopanel')
const CONFIG_PATH = path.join(EVOFLOW_DIR, 'evopanel.json')
const PANEL_CONFIG_PATH = path.join(EVOFLOW_DIR, 'evopanel.json')
const AUTOMATIONS_DIR = path.join(homedir(), '.evoflow', 'tasks', 'automations')
const PROJECT_ROOT = process.env.EVOFLOW_PROJECT_ROOT || path.resolve(process.cwd(), '..')
function resolveGatewayUrl() {
  const explicit = String(process.env.EVOFLOW_GATEWAY_URL || '').trim().replace(/\/+$/, '')
  if (explicit) return explicit
  const port = parseInt(String(process.env.EVOFLOW_GATEWAY_PORT || '').trim(), 10)
  if (Number.isFinite(port) && port > 0 && port < 65536) return `http://127.0.0.1:${port}`
  return 'http://127.0.0.1:8012'
}
const EVOFLOW_GATEWAY_URL = resolveGatewayUrl()

/** Periodic automation runs on Gateway by default; set ``EVOFLOW_AUTOMATION_SCHEDULER=0`` to disable (see ``app/gateway/automation_runner.py``). */

/** Proxy to Gateway ``/api/automation/*`` (same contract as ``evopanel/src/lib/tauri-api.js`` ``gatewayProxy``). */
async function _gatewayAutomationJson(method, pathAfter, opts = {}) {
  const { body = null, timeoutMs = 60000, query = null } = opts
  const base = EVOFLOW_GATEWAY_URL.replace(/\/$/, '')
  const suffix = pathAfter.startsWith('/') ? pathAfter : `/${pathAfter}`
  let url = `${base}/api/automation${suffix}`
  if (query && typeof query === 'object') {
    const u = new URL(url)
    for (const [k, v] of Object.entries(query)) {
      if (v != null && v !== '') u.searchParams.set(k, String(v))
    }
    url = u.toString()
  }
  const ac = new AbortController()
  const tid = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const init = { method, signal: ac.signal }
    if (body != null && method !== 'GET' && method !== 'HEAD') {
      init.headers = { 'Content-Type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    const r = await fetch(url, init)
    const txt = await r.text()
    let payload = null
    try {
      payload = txt ? JSON.parse(txt) : null
    } catch {
      payload = { _non_json: txt.slice(0, 400) }
    }
    if (!r.ok) {
      const d = payload?.detail
      let msg = typeof d === 'string' ? d : ''
      if (!msg && Array.isArray(d)) msg = d.map((x) => x?.msg || JSON.stringify(x)).join('; ')
      if (!msg) msg = payload?.message || txt.slice(0, 200) || `HTTP ${r.status}`
      throw new Error(msg)
    }
    return payload
  } finally {
    clearTimeout(tid)
  }
}

function _resolveFeishuPushSecret() {
  const env = process.env.EVOFLOW_FEISHU_PUSH_SECRET
  if (env && String(env).trim()) return String(env).trim()
  for (const dir of [PROJECT_ROOT, path.join(PROJECT_ROOT, 'backend'), homedir()]) {
    const fp = path.join(dir, '.env')
    try {
      if (!fs.existsSync(fp)) continue
      const txt = fs.readFileSync(fp, 'utf8')
      for (const line of txt.split(/\r?\n/)) {
        const m = line.match(/^\s*EVOFLOW_FEISHU_PUSH_SECRET\s*=\s*(.*)$/)
        if (!m) continue
        let v = m[1].trim()
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
        if (v) return v
      }
    } catch {}
  }
  return ''
}

async function _postFeishuPush(chatId, markdown) {
  const secret = _resolveFeishuPushSecret()
  if (!secret) throw new Error('EVOFLOW_FEISHU_PUSH_SECRET missing (set in .env or env)')
  const url = `${EVOFLOW_GATEWAY_URL.replace(/\/$/, '')}/api/channels/feishu/push`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-EvoFlow-Feishu-Push-Secret': secret,
    },
    body: JSON.stringify({
      receive_id: String(chatId).trim(),
      text: String(markdown || '').slice(0, 49000),
    }),
  })
  const txt = await res.text()
  let body = {}
  try {
    body = JSON.parse(txt)
  } catch {
    body = { detail: txt }
  }
  if (!res.ok) {
    const d = body.detail
    const msg = Array.isArray(d) ? JSON.stringify(d) : d || body.message || txt || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return body
}

const exec = promisify(_exec)

/** Cross-platform zip extract for skill install (dev server). */
async function extractZipArchive(zipPath, destDir) {
  const zip = path.resolve(zipPath)
  const dest = path.resolve(destDir)
  if (process.platform === 'win32') {
    const psZip = zip.replace(/'/g, "''")
    const psDest = dest.replace(/'/g, "''")
    await exec(
      `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${psZip}' -DestinationPath '${psDest}' -Force"`,
      { shell: true, windowsHide: true, timeout: 30_000 },
    )
    return
  }
  try {
    await exec(`unzip -o -q ${JSON.stringify(zip)} -d ${JSON.stringify(dest)}`, {
      shell: true,
      timeout: 30_000,
    })
    return
  } catch {
    /* fall through to python */
  }
  await exec(
    `python3 -m zipfile -e ${JSON.stringify(zip)} ${JSON.stringify(dest)}`,
    { shell: true, timeout: 30_000 },
  )
}

function _guessMimeTypeByExt(p) {
  const ext = String(path.extname(String(p || '')).toLowerCase())
  // Minimal set; good enough for preview in dev server
  if (ext === '.txt' || ext === '.log' || ext === '.md' || ext === '.json' || ext === '.yaml' || ext === '.yml' || ext === '.csv') return 'text/plain; charset=utf-8'
  if (ext === '.html' || ext === '.htm') return 'text/html; charset=utf-8'
  if (ext === '.js') return 'text/javascript; charset=utf-8'
  if (ext === '.css') return 'text/css; charset=utf-8'
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.svg') return 'image/svg+xml'
  if (ext === '.pdf') return 'application/pdf'
  if (ext === '.zip') return 'application/zip'
  return 'application/octet-stream'
}

function _safeJoin(baseDir, urlPathRemainder) {
  const base = path.resolve(baseDir)
  const rel = String(urlPathRemainder || '').replace(/^\/+/, '')
  const full = path.resolve(base, rel)
  // Prevent traversal outside base dir
  if (!full.toLowerCase().startsWith(base.toLowerCase() + path.sep) && full.toLowerCase() !== base.toLowerCase()) {
    throw new Error('path traversal rejected')
  }
  return full
}

async function _mntUserDataMiddleware(req, res, next) {
  const url = String(req.url || '')
  if (!url.startsWith('/mnt/user-data/')) return next()

  // Only implement outputs/workspace mapping for dev preview
  const rest = url.slice('/mnt/user-data/'.length)
  const [head, ...tailParts] = rest.split('?')[0].split('/').filter(Boolean)
  const tail = tailParts.join('/')
  const isOutputs = head === 'outputs'
  const isWorkspace = head === 'workspace'
  if (!isOutputs && !isWorkspace) {
    res.statusCode = 404
    res.end('Not found')
    return
  }

  // Workspace/outputs may live in different places depending on runtime:
  // - project root (EvoPanel UI workspace)
  // - global ~/.evoflow workspace (some tools write here)
  const baseCandidates = isOutputs
    ? [
        path.join(PROJECT_ROOT, 'outputs'),
        path.join(homedir(), '.evoflow', 'outputs'),
      ]
    : [
        path.join(PROJECT_ROOT, 'workspace'),
        path.join(homedir(), '.evoflow', 'workspace'),
      ]

  try {
    let fp = null
    for (const baseDir of baseCandidates) {
      try {
        const candidate = _safeJoin(baseDir, tail)
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          fp = candidate
          break
        }
      } catch {
        // ignore this baseDir (e.g. traversal rejected)
      }
    }
    if (!fp) {
      res.statusCode = 404
      res.end('Not found')
      return
    }
    const mime = _guessMimeTypeByExt(fp)
    res.setHeader('Content-Type', mime)

    // Force download for some types unless explicitly previewable
    const ext = path.extname(fp).toLowerCase()
    const isText = mime.startsWith('text/') || ext === '.json' || ext === '.md' || ext === '.csv' || ext === '.log'
    const isPreviewable = isText || mime.startsWith('image/') || mime === 'application/pdf'
    if (!isPreviewable) {
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(fp).replace(/"/g, '')}"`)
    }

    fs.createReadStream(fp).pipe(res)
  } catch (e) {
    res.statusCode = 400
    res.end(String(e?.message || e))
  }
}

// 会话管理
const _sessions = new Map()
const SESSION_TTL = 24 * 60 * 60 * 1000

function parseCookies(req) {
  const cookie = req.headers.cookie || ''
  return Object.fromEntries(cookie.split(';').filter(Boolean).map(c => {
    const [k, v] = c.trim().split('=')
    return [k, decodeURIComponent(v || '')]
  }))
}

function isAuthenticated(req) {
  const cookies = parseCookies(req)
  const session = _sessions.get(cookies.evopanel_session)
  return session && session.expires > Date.now()
}

function readPanelConfig() {
  try {
    return JSON.parse(fs.readFileSync(PANEL_CONFIG_PATH, 'utf8'))
  } catch {
    return {}
  }
}

/** Align with Tauri ``configured_user_workspace_root()`` (``evopanel.json``). */
function configuredUserWorkspaceRoot() {
  const cfg = readPanelConfig()
  const raw = String(cfg.userWorkspaceRoot || cfg.dataWorkspaceRoot || '').trim()
  return raw
}

/** Align with Tauri ``runtime_data_dir()`` — ``EVOFLOW_HOME`` for sidecar / tools. */
function resolveRuntimeDataDir() {
  const configured = configuredUserWorkspaceRoot()
  if (!configured) return path.join(homedir(), '.evoflow')
  const norm = configured.replace(/\\/g, '/').replace(/\/+$/, '')
  const workspaceRoot = norm.toLowerCase().endsWith('/workspace') ? configured : path.join(configured, 'workspace')
  return path.join(workspaceRoot, 'data')
}

function readBackendRuntimeState() {
  const fp = path.join(homedir(), '.evoflow', 'evopanel', 'backend-runtime.json')
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'))
  } catch {
    return null
  }
}

async function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', chunk => data += chunk)
    req.on('end', () => {
      try {
        resolve(JSON.parse(data))
      } catch {
        resolve({})
      }
    })
  })
}

async function callGateway(pathname, options = {}) {
  const resp = await fetch(`${EVOFLOW_GATEWAY_URL}${pathname}`, options)
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) {
    const detail = data?.detail || data?.error || `Gateway returned ${resp.status}`
    throw new Error(String(detail))
  }
  return data
}

function resolveLogPath(logName) {
  const key = String(logName || 'gateway')
  const prefix = ({
    gateway: 'gateway',
    'gateway-err': 'gateway',
    langgraph: 'langgraph',
    'langgraph-err': 'langgraph',
    frontend: 'frontend',
    guardian: 'guardian',
    'guardian-backup': 'guardian-backup',
    'config-audit': 'config-audit',
  })[key] || 'gateway'

  if (prefix === 'config-audit') {
    const p = path.join(PROJECT_ROOT, 'logs', 'config-audit.jsonl')
    return fs.existsSync(p) ? p : p
  }

  const today = new Date().toISOString().slice(0, 10)
  const dated = `${prefix}-${today}.log`
  const legacy = ({
    gateway: 'gateway.log',
    'gateway-err': 'gateway.err.log',
    langgraph: 'langgraph.log',
    frontend: 'frontend.log',
  })[key] || 'gateway.log'

  const dirs = [
    path.join(PROJECT_ROOT, 'logs'),
    path.join(homedir(), '.evoflow', 'logs'),
    path.join(homedir(), '.evoflow', 'logs'),
    path.join(EVOFLOW_DIR, 'logs'),
  ]

  for (const dir of dirs) {
    const datedPath = path.join(dir, dated)
    if (fs.existsSync(datedPath)) return datedPath
    const legacyPath = path.join(dir, legacy)
    if (fs.existsSync(legacyPath)) return legacyPath
    try {
      const names = fs.readdirSync(dir)
      const matches = names
        .filter((n) => n.startsWith(`${prefix}-`) && n.endsWith('.log'))
        .sort()
      if (matches.length) return path.join(dir, matches[matches.length - 1])
    } catch {
      /* dir missing */
    }
  }
  return path.join(PROJECT_ROOT, 'logs', dated)
}

function readTail(content, lines) {
  const all = String(content || '').split(/\r?\n/)
  const n = Math.max(1, Number(lines || 200))
  return all.slice(-n).join('\n').trim()
}

function resolveLocalPath(inputPath = '') {
  const raw = String(inputPath || '').trim()
  if (!raw) throw new Error('path is required')
  if (path.isAbsolute(raw)) return raw
  return path.resolve(PROJECT_ROOT, raw)
}

// 内置热门 MCP 服务器精选列表
const HOT_MCP_SERVERS = [
  { slug: 'filesystem', name: 'Filesystem', description: '读写本地文件系统，管理文件和目录操作', install_cmd: 'npx -y @modelcontextprotocol/server-filesystem', stars: 9800 },
  { slug: 'fetch', name: 'Web Fetch', description: '抓取网页内容，获取互联网上的任意 URL 数据', install_cmd: 'npx -y @modelcontextprotocol/server-fetch', stars: 8700 },
  { slug: 'brave-search', name: 'Brave Search', description: '使用 Brave Search 引擎进行实时网络搜索', install_cmd: 'npx -y @modelcontextprotocol/server-brave-search', stars: 7500 },
  { slug: 'github', name: 'GitHub MCP Server', description: 'GitHub 仓库、Issue、PR、Actions 等全功能集成', install_cmd: 'npx -y @modelcontextprotocol/server-github', stars: 7200 },
  { slug: 'puppeteer', name: 'Puppeteer Browser', description: '基于 Chromium 的浏览器自动化，支持截图、点击、表单填写', install_cmd: 'npx -y @anthropic/mcp-server-puppeteer', stars: 6500 },
  { slug: 'memory', name: 'Memory Knowledge Graph', description: '持久化记忆存储，基于知识图谱的上下文管理', install_cmd: 'npx -y @modelcontextprotocol/server-memory', stars: 6100 },
  { slug: 'postgres', name: 'PostgreSQL', description: 'PostgreSQL 数据库查询和管理，安全执行 SQL', install_cmd: 'npx -y @modelcontextprotocol/server-postgres', stars: 5800 },
  { slug: 'slack', name: 'Slack', description: 'Slack 工作区消息收发、频道管理和用户信息获取', install_cmd: 'npx -y @modelcontextprotocol/server-slack', stars: 5200 },
  { slug: 'sequential-thinking', name: 'Sequential Thinking', description: '逐步推理思维链，增强复杂问题解决能力', install_cmd: 'npx -y @modelcontextprotocol/server-sequentialthinking', stars: 4900 },
  { slug: 'docker', name: 'Docker', description: 'Docker 容器、镜像和网络管理，执行容器操作命令', install_cmd: 'npx -y @modelcontextprotocol/server-docker', stars: 4600 },
  { slug: 'notion', name: 'Notion', description: 'Notion 页面、数据库和块级内容读写管理', install_cmd: 'npx -y@mcp/notion-server', stars: 4300 },
  { slug: 'aws-kb-retrieval', name: 'AWS Knowledge Base Retrieval', description: '从 Amazon Knowledge Bases 检索 RAG 知识文档', install_cmd: 'npx -y @aws-sdk/mcp-server-kb-retrieval', stars: 4000 },
  { slug: 'gdrive', name: 'Google Drive', description: 'Google Drive 文件搜索、上传下载和权限管理', install_cmd: 'npx -y @anthropic/mcp-server-google-drive', stars: 3800 },
  { slug: 'stripe', name: 'Stripe', description: 'Stripe 支付、账单、客户和产品数据查询', install_cmd: 'npx -y @anthropic/mcp-server-stripe', stars: 3500 },
  { slug: 'everything', name: 'Everything (Windows Search)', description: 'Windows 本地文件极速搜索，基于 Everything 引擎', install_cmd: 'npx -y mcp-server-everything', stars: 3200 },
  { slug: 'supabase', name: 'Supabase', description: 'Supabase 数据库、Auth 和 Storage 服务集成', install_cmd: 'npx -y @supabase/mcp-supabase', stars: 3000 },
  { slug: 'obsidian', name: 'Obsidian', description: 'Obsidian 笔记库搜索、读取和链接管理', install_cmd: 'npx -y @modelcontextprotocol/server-obsidian', stars: 2800 },
  { slug: 'spotify', name: 'Spotify', description: 'Spotify 音乐播放控制、播放列表和推荐发现', install_cmd: 'npx -y @anthropic/mcp-server-spotify', stars: 2500 },
  { slug: 'calendar', name: 'Google Calendar', description: 'Google Calendar 日程创建、查询和提醒管理', install_cmd: 'npx -y @anthropic/mcp-server-google-calendar', stars: 2300 },
  { slug: 'time', name: 'World Time & Date', description: '全球时区时间查询、日期计算和自动化', install_cmd: 'npx -y @modelcontextprotocol/server-time', stars: 2000 },
]

// ========== SkillHub API 工具函数（https://api.skillhub.cn）==========

const SKILLHUB_API_BASE = 'https://api.skillhub.cn'

/** 调用 SkillHub REST API */
async function callSkillHubAPI(pathname, params = {}) {
  const url = new URL(`${SKILLHUB_API_BASE}${pathname}`)
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v))
  }
  const resp = await fetch(url.toString(), {
    signal: AbortSignal.timeout(15_000),
  })
  if (!resp.ok) {
    const t = await resp.text().catch(() => '')
    throw new Error(`SkillHub HTTP ${resp.status}: ${t.substring(0, 200)}`)
  }
  const data = await resp.json()
  if (data.code !== 0) throw new Error(data.message || 'SkillHub API error')
  return data.data
}

/** 将 SkillHub skill 对象映射为前端格式（保持与 mapSkillHubSkill 相同的输出契约） */
function mapSkillHubSkill(item) {
  return {
    slug: item.slug || '',
    name: item.name || '',
    description: item.description_zh || item.description || '',
    stars: item.stars || 0,
    downloads: item.downloads || 0,
    versionId: item.version || '',
    ownerHandle: item.ownerName || '',
    tags: item.tags ? (Array.isArray(item.tags) ? item.tags : Object.keys(item.tags)) : [],
    source: item.source || 'skillhub',
    iconUrl: item.iconUrl || '',
    publisherName: item.publisher?.name || '',
    publisherVerified: item.publisher?.verified || false,
    homepage: item.homepage || '',
    requiresApiKey: item.labels?.requires_api_key === 'true',
  }
}

// 处理器
const handlers = {
  // 健康检查
  async health() {
    return { ok: true, ts: Date.now() }
  },

  // 认证相关
  async auth_check() {
    const cfg = readPanelConfig()
    const pw = cfg.accessPassword || ''
    return {
      required: !!pw,
      authenticated: !pw || isAuthenticated({ headers: {} }),
      mustChangePassword: !!cfg.mustChangePassword,
    }
  },

  async auth_login(args, req) {
    const cfg = readPanelConfig()
    const pw = cfg.accessPassword || ''
    if (!pw) return { success: true }
    if (args.password !== pw) throw new Error('密码错误')
    const token = crypto.randomUUID()
    _sessions.set(token, { expires: Date.now() + SESSION_TTL })
    return {
      success: true,
      mustChangePassword: !!cfg.mustChangePassword,
      token,
    }
  },

  async auth_status() {
    const cfg = readPanelConfig()
    return { hasPassword: !!cfg.accessPassword }
  },

  async auth_logout() {
    return { success: true }
  },

  // 配置读取
  async read_evopanel_config() {
    return readPanelConfig()
  },

  /** 与 Tauri ``workspace_runtime_info`` 同构（ChatApp 默认本机工作空间根目录等） */
  async workspace_runtime_info() {
    const configuredRoot = configuredUserWorkspaceRoot()
    const runtimeDataDir = resolveRuntimeDataDir()
    const state = readBackendRuntimeState()
    const runtimePort = state?.port != null ? Number(state.port) : null
    let runtimeBaseUrl = String(state?.baseUrl || state?.runtimeBaseUrl || '').trim()
    if (!runtimeBaseUrl) {
      runtimeBaseUrl = EVOFLOW_GATEWAY_URL.replace(/\/$/, '')
    }
    const runtimeStatePath = path.join(homedir(), '.evoflow', 'evopanel', 'backend-runtime.json')
    const checkpointsDbPath = path.join(runtimeDataDir, 'checkpoints.db')
    let backendRunning = false
    let langgraphRunning = false
    try {
      const r = await fetch(`${runtimeBaseUrl}/health`, { signal: AbortSignal.timeout(2500) })
      backendRunning = r.ok
    } catch {
      backendRunning = false
    }
    const lgBase = String(process.env.EVOFLOW_LANGGRAPH_URL || 'http://127.0.0.1:2024').replace(/\/$/, '')
    try {
      const r = await fetch(`${lgBase}/ok`, { signal: AbortSignal.timeout(2500) })
      langgraphRunning = r.ok
    } catch {
      try {
        const r = await fetch(`${lgBase}/health`, { signal: AbortSignal.timeout(2500) })
        langgraphRunning = r.ok
      } catch {
        langgraphRunning = false
      }
    }
    return {
      configuredRoot,
      runtimeDataDir,
      runtimePort: Number.isFinite(runtimePort) ? runtimePort : null,
      runtimeBaseUrl,
      runtimeStatePath,
      checkpointsDbPath,
      checkpointsDbExists: fs.existsSync(checkpointsDbPath),
      backendRunning,
      langgraphRunning,
    }
  },

  /** 与 Tauri ``reveal_path_in_file_manager`` 对齐：在本机文件管理器中打开路径 */
  async reveal_path_in_file_manager(args) {
    const raw = String(args?.path || '').trim()
    if (!raw) throw new Error('路径为空')
    const target = path.resolve(raw)
    if (!fs.existsSync(target)) throw new Error(`路径不存在: ${raw}`)
    const platform = process.platform
    await new Promise((resolve, reject) => {
      let child
      if (platform === 'win32') {
        // explorer 成功打开后常以非 0 退出，只关心能否 spawn
        child = spawn('explorer', [target.replace(/\//g, '\\')], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        })
      } else if (platform === 'darwin') {
        child = spawn('open', [target], { detached: true, stdio: 'ignore' })
      } else {
        child = spawn('xdg-open', [target], { detached: true, stdio: 'ignore' })
      }
      child.on('error', (err) => reject(new Error(`打开文件管理器失败: ${err.message || err}`)))
      child.unref()
      // 给进程一点启动时间；explorer 的 exit code 不可靠
      setTimeout(resolve, 200)
    })
    return { ok: true, path: target }
  },

  // Agent 管理（对齐 Web /api/agents）
  async agents_list() {
    return callGateway('/api/agents')
  },

  async agents_get(args) {
    const name = String(args?.name || '').trim()
    if (!name) throw new Error('name is required')
    return callGateway(`/api/agents/${encodeURIComponent(name)}`)
  },

  async agents_create(args) {
    const body = {
      name: args?.name,
      description: args?.description || '',
      model: args?.model ?? null,
      tool_groups: args?.tool_groups ?? null,
      soul: args?.soul || '',
    }
    return callGateway('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  },

  async agents_update(args) {
    const name = String(args?.name || '').trim()
    if (!name) throw new Error('name is required')
    const body = {
      description: args?.description ?? null,
      model: args?.model ?? null,
      tool_groups: args?.tool_groups ?? null,
      soul: args?.soul ?? null,
    }
    return callGateway(`/api/agents/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  },

  async agents_delete(args) {
    const name = String(args?.name || '').trim()
    if (!name) throw new Error('name is required')
    await callGateway(`/api/agents/${encodeURIComponent(name)}`, { method: 'DELETE' })
    return { success: true }
  },

  // Agent 管理 - 兼容旧命令（映射到 agents_list）
  async list_agents() {
    try {
      const data = await callGateway('/api/agents')
      return (data.agents || []).map(agent => ({
        id: agent.name,
        isDefault: agent.name === 'main',
        identityName: agent.description || agent.name,
        identityEmoji: '',
        model: agent.model,
        workspace: null,
        tool_groups: agent.tool_groups,
        soul: agent.soul
      }))
    } catch (e) {
      console.error('[list_agents] 从 Gateway 获取失败:', e.message)
      return []
    }
  },

  // ========== Skills 管理（对齐 Tauri skills_* 命令）==========

  async skills_list() {
    // 扫描本地 skills 目录
    const skillsDir = path.join(EVOFLOW_DIR, 'skills')
    if (!fs.existsSync(skillsDir)) {
      return { skills: [], source: 'local-scan', cliAvailable: false }
    }
    const skills = []
    try {
      for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const name = entry.name
        const skillMd = path.join(skillsDir, name, 'SKILL.md')
        let description = ''
        if (fs.existsSync(skillMd)) {
          const content = fs.readFileSync(skillMd, 'utf8')
          const m = content.match(/^description:\s*["']?(.+?)["']?$/m)
          if (m) description = m[1].trim()
        }
        skills.push({ name, description, source: 'managed', eligible: true, bundled: false, filePath: skillMd })
      }
    } catch (_) { /* ignore */ }
    return { skills, source: 'local-scan', cliAvailable: false }
  },

  async skills_info(args) {
    const name = String(args?.name || '').trim()
    if (!name) throw new Error('name is required')
    const skillMd = path.join(EVOFLOW_DIR, 'skills', name, 'SKILL.md')
    if (!fs.existsSync(skillMd)) throw new Error(`Skill「${name}」不存在`)
    return fs.readFileSync(skillMd, 'utf8')
  },

  async skills_check() {
    return { status: 'ok', node: true, message: 'dev mode skip' }
  },

  async skills_install_dep(args) {
    const kind = args?.kind || ''
    const spec = args?.spec || {}
    let cmdStr = ''
    if (kind === 'node') cmdStr = `npm install -g ${spec.package}`
    else if (kind === 'brew') cmdStr = `brew install ${spec.formula}`
    else if (kind === 'go') cmdStr = `go install ${spec.module}`
    else if (kind === 'uv') cmdStr = `uv tool install ${spec.package}`
    else throw new Error(`不支持的安装类型: ${kind}`)
    const { stdout, stderr } = await exec(cmdStr, { shell: true, windowsHide: true, timeout: 60_000 })
    return { success: true, output: `${stdout || ''}${stderr || ''}`.trim() }
  },

  async skills_skillhub_check() {
    try {
      await exec('skillhub --cli-version', { shell: true, timeout: 5_000 })
      return { installed: true, version: 'dev' }
    } catch {
      return { installed: false }
    }
  },

  async skills_skillhub_setup() {
    return { success: true, output: 'dev-mode: skip setup' }
  },

  // ========== SkillHub 技能市场（Convex 后端）==========

  /** 搜索/浏览技能（使用 SkillHub REST API）
   * - 有 query 时：传入 keyword 参数由服务端过滤
   * - 无 query 时：返回按 score 排序的热门技能列表
   * - 支持分页：page + pageSize
   */
  async skills_skillhub_search(args) {
    const query = String(args?.query || '').trim()
    const page = Math.max(1, Number(args?.page || 1))
    const pageSize = Math.min(50, Math.max(1, Number(args?.pageSize || 50)))

    try {
      const params = {
        page: String(page),
        pageSize: String(pageSize),
        sortBy: 'score',
        order: 'desc',
      }
      if (query) params.keyword = query

      const result = await callSkillHubAPI('/api/skills', params)
      const rawItems = Array.isArray(result?.skills) ? result.skills : []
      const total = result?.total || 0

      return {
        skills: rawItems.map(mapSkillHubSkill),
        hasMore: page * pageSize < total,
        cursor: null, // SkillHub 使用 page 分页，不使用 cursor
        total,
      }
    } catch (e) {
      console.error('[skillhub] search failed:', e.message)
      return { skills: [], hasMore: false, cursor: null, total: 0, error: e.message }
    }
  },

  // 浏览热门技能（别名，直接走分页接口）
  async skills_skillhub_browse(args) {
    return handlers.skills_skillhub_search(args)
  },

  // 安装技能：从 SkillHub 下载 ZIP 并解压到本地
  async skills_skillhub_install(args) {
    const slug = String(args?.slug || '').trim()
    if (!slug) throw new Error('slug is required')

    const skillsDir = path.join(EVOFLOW_DIR, 'skills')
    fs.mkdirSync(skillsDir, { recursive: true })

    // 下载 ZIP
    const dlUrl = `${SKILLHUB_API_BASE}/api/v1/download?slug=${encodeURIComponent(slug)}`
    console.log(`[skillhub] downloading ${slug} from ${dlUrl}`)
    const resp = await fetch(dlUrl, { signal: AbortSignal.timeout(60_000) })
    if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}`)

    const buf = Buffer.from(await resp.arrayBuffer())
    const tmpZip = path.join(EVOFLOW_DIR, `_tmp_${slug.replace(/\//g, '_')}.zip`)
    fs.writeFileSync(tmpZip, buf)

    // 解压（跨平台：Windows PowerShell / Unix unzip 或 python zipfile）
    const targetDir = path.join(skillsDir, slug.split('/').pop() || slug)
    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true })
    fs.mkdirSync(targetDir, { recursive: true })

    await extractZipArchive(tmpZip, targetDir)

    // 清理临时文件
    try { fs.unlinkSync(tmpZip) } catch (_) { /* ignore */ }

    return { success: true, slug, output: `已安装到 ${targetDir}` }
  },

  async skills_uninstall(args) {
    const name = String(args?.name || '').trim()
    if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) throw new Error('无效的 Skill 名称')
    const targetDir = path.join(EVOFLOW_DIR, 'skills', name)
    if (!fs.existsSync(targetDir)) throw new Error(`Skill「${name}」不存在`)
    fs.rmSync(targetDir, { recursive: true, force: true })
    return { success: true, name }
  },

  async get_status_summary() {
    return {}
  },

  // 助手文件/命令能力（供服务管理页面等复用）
  async assistant_read_file(args) {
    const p = resolveLocalPath(args?.path)
    return fs.readFileSync(p, 'utf8')
  },

  async assistant_write_file(args) {
    const p = resolveLocalPath(args?.path)
    const content = String(args?.content ?? '')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content, 'utf8')
    return { success: true, path: p }
  },

  async assistant_exec(args) {
    const command = String(args?.command || '').trim()
    if (!command) throw new Error('command is required')
    const cwd = args?.cwd ? resolveLocalPath(args.cwd) : PROJECT_ROOT
    const { stdout, stderr } = await exec(command, {
      cwd,
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024 * 8,
      shell: true,
    })
    return `${stdout || ''}${stderr || ''}`.trim()
  },

  // 日志读取（对齐 Tauri 命令）
  async read_log_tail(args) {
    const p = resolveLogPath(args?.logName || args?.log_name || 'gateway')
    if (!fs.existsSync(p)) return ''
    const raw = fs.readFileSync(p, 'utf8')
    return readTail(raw, args?.lines)
  },

  async search_log(args) {
    const p = resolveLogPath(args?.logName || args?.log_name || 'gateway')
    if (!fs.existsSync(p)) return []
    const query = String(args?.query || '').trim().toLowerCase()
    if (!query) return []
    const maxResults = Math.max(1, Number(args?.maxResults || args?.max_results || 50))
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/)
    const matched = lines.filter((l) => l.toLowerCase().includes(query))
    return matched.slice(-maxResults)
  },

  // MCP 市场（优先 Gateway Glama/Registry；Gateway 不可用时回退内置精选）
  async mcp_market_search(args) {
    const query = String(args?.query || '').trim()
    const cursor = args?.cursor ? String(args.cursor) : null
    try {
      const params = new URLSearchParams()
      if (query) params.set('query', query)
      if (cursor) params.set('cursor', cursor)
      const qs = params.toString()
      const base = EVOFLOW_GATEWAY_URL.replace(/\/$/, '')
      const url = `${base}/api/mcp/market/search${qs ? `?${qs}` : ''}`
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) })
      if (!r.ok) {
        const t = await r.text().catch(() => '')
        throw new Error(t.slice(0, 200) || `HTTP ${r.status}`)
      }
      return await r.json()
    } catch (e) {
      let results = HOT_MCP_SERVERS
      if (query) {
        const q = query.toLowerCase()
        results = results.filter(s =>
          (s.name || '').toLowerCase().includes(q) ||
          (s.description || '').toLowerCase().includes(q) ||
          (s.slug || '').toLowerCase().includes(q)
        )
      }
      return { servers: results, cursor: null, has_more: false, source: 'hot', warning: String(e?.message || e) }
    }
  },

  // ========== 自动化 / Automation（Gateway REST；与桌面 gatewayProxy 同源）==========

  async automation_list() {
    return _gatewayAutomationJson('GET', '/tasks', { timeoutMs: 30000 })
  },

  async automation_get(args) {
    const id = String(args?.id || '').trim()
    if (!id) throw new Error('id is required')
    return _gatewayAutomationJson('GET', `/tasks/${encodeURIComponent(id)}`, { timeoutMs: 30000 })
  },

  async automation_create(args) {
    return _gatewayAutomationJson('POST', '/tasks', { body: args || {}, timeoutMs: 60000 })
  },

  async automation_update(args) {
    const id = String(args?.id || '').trim()
    if (!id) throw new Error('id is required')
    return _gatewayAutomationJson('PUT', `/tasks/${encodeURIComponent(id)}`, { body: args || {}, timeoutMs: 60000 })
  },

  async automation_delete(args) {
    const id = String(args?.id || '').trim()
    if (!id) throw new Error('id is required')
    return _gatewayAutomationJson('DELETE', `/tasks/${encodeURIComponent(id)}`, { timeoutMs: 30000 })
  },

  async automation_run(args) {
    const id = String(args?.id || '').trim()
    if (!id) throw new Error('id is required')
    const runAsync = !!(args?.run_async ?? args?.async)
    let gatewayErr = null
    try {
      const gatewayBody = await _gatewayAutomationJson('POST', `/tasks/${encodeURIComponent(id)}/run`, {
        timeoutMs: runAsync ? 120000 : 660000,
        query: runAsync ? { run_async: 'true' } : null,
      })
      return { success: true, id, via: 'gateway', message: 'ok', gateway_body: gatewayBody }
    } catch (e) {
      gatewayErr = String(e?.message || e)
    }

    const task = _loadAutomation(id)
    if (!task) throw new Error(`Automation '${id}' not found (Gateway failed: ${gatewayErr}); ensure Gateway is up and task exists under ~/.evoflow/tasks/automations`)

    const record = {
      run_id: crypto.randomUUID().slice(0, 12),
      started_at: new Date().toISOString(),
      trigger_type: 'manual',
      status: 'success',
      output: '',
      error: '',
      duration_seconds: 0,
    }
    const t0 = Date.now()
    try {
      const lines = []
      if (gatewayErr) lines.push(`gateway_run_skipped: ${gatewayErr}`)
      if (task.feishu_push_enabled) {
        let pushChatId = ''
        try {
          const d = await _gatewayAutomationJson('GET', '/feishu-push-default', { timeoutMs: 10000 })
          if (d && d.chat_id) pushChatId = String(d.chat_id).trim()
        } catch (_) {}
        if (pushChatId) {
          const title = task.name || '自动化'
          const md = `**${title}**（手动运行·仅摘要·Gateway 不可用或未连上）\n\n${String(task.prompt || '').slice(0, 800)}${String(task.prompt || '').length > 800 ? '…' : ''}\n\n_时间_: ${record.started_at}`
          await _postFeishuPush(pushChatId, md)
          lines.push('feishu: ok (legacy)')
        } else {
          lines.push('feishu: skipped (no chat_id)')
        }
      } else {
        lines.push('feishu: disabled')
      }
      record.output = lines.join('\n')
    } catch (e) {
      record.status = 'fail'
      record.error = String(e?.message || e)
    }
    record.duration_seconds = Math.round((Date.now() - t0) / 1000)
    const hp = _historyPath(id)
    try {
      fs.appendFileSync(hp, JSON.stringify(record) + '\n', 'utf8')
    } catch {}
    return {
      success: true,
      id,
      run_id: record.run_id,
      via: 'legacy_feishu_only',
      message: record.error ? String(record.error) : record.output || 'ok',
    }
  },

  async automation_history(args) {
    const id = String(args?.id || '').trim()
    if (!id) throw new Error('id is required')
    const limit = Math.min(50, Math.max(1, Number(args?.limit || 50)))
    return _gatewayAutomationJson('GET', `/tasks/${encodeURIComponent(id)}/history?limit=${limit}`, { timeoutMs: 30000 })
  },

  async automation_start() {
    return _gatewayAutomationJson('POST', '/scheduler/start', { timeoutMs: 15000 })
  },

  async automation_stop() {
    return _gatewayAutomationJson('POST', '/scheduler/stop', { timeoutMs: 10000 })
  },

  async automation_pause(args) {
    const id = String(args?.id || '').trim()
    if (!id) throw new Error('id is required')
    return _gatewayAutomationJson('POST', `/tasks/${encodeURIComponent(id)}/pause`, { timeoutMs: 30000 })
  },

  async automation_resume(args) {
    const id = String(args?.id || '').trim()
    if (!id) throw new Error('id is required')
    return _gatewayAutomationJson('POST', `/tasks/${encodeURIComponent(id)}/resume`, { timeoutMs: 30000 })
  },
}

// ========== Automation 本地读（仅 automation_run Gateway 失败时的降级：读 TOML + 写 history）==========

function _parseTomlSimple(content) {
  /** 极简 TOML parser — 只处理我们需要的扁平键值对和基础类型 */
  const result = {}
  const lines = content.split(/\r?\n/)
  let currentSection = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const sectionMatch = trimmed.match(/^\[(.+)\]$/)
    if (sectionMatch) { currentSection = sectionMatch[1]; continue }
    const kvMatch = trimmed.match(/^(\w[\w.-]*)\s*=\s*(.+)$/)
    if (kvMatch) {
      const key = kvMatch[1]
      let value = kvMatch[2].trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      } else if (value === 'true') value = true
      else if (value === 'false') value = false
      else if (/^-?\d+(\.\d+)?$/.test(value)) value = parseFloat(value)
      if (currentSection) {
        if (!result[currentSection]) result[currentSection] = {}
        result[currentSection][key] = value
      } else {
        result[key] = value
      }
    }
  }
  return result
}

function _loadAutomation(id) {
  const f = path.join(AUTOMATIONS_DIR, `${id}.toml`)
  if (!fs.existsSync(f)) return null
  return _parseTomlSimple(fs.readFileSync(f, 'utf8'))
}

function _historyPath(id) {
  return path.join(AUTOMATIONS_DIR, `${id}_history.jsonl`)
}

// 不需要认证的命令
const PUBLIC_CMDS = new Set(['health', 'auth_check', 'auth_login', 'auth_logout', 'list_agents', 'agents_list', 'agents_get', 'agents_create', 'agents_update', 'agents_delete', 'read_evopanel_config', 'workspace_runtime_info', 'reveal_path_in_file_manager', 'get_services_status', 'check_installation', 'get_version_info', 'get_status_summary', 'read_log_tail', 'search_log', 'assistant_read_file', 'assistant_write_file', 'assistant_exec', 'mcp_market_search', 'skills_list', 'skills_info', 'skills_check', 'skills_install_dep', 'skills_skillhub_check', 'skills_skillhub_setup', 'skills_skillhub_search', 'skills_skillhub_browse', 'skills_skillhub_install', 'skills_uninstall', 'automation_list', 'automation_create', 'automation_get', 'automation_update', 'automation_delete', 'automation_run', 'automation_history', 'automation_start', 'automation_stop', 'automation_pause', 'automation_resume'])

// API 中间件
async function _apiMiddleware(req, res, next) {
  if (!req.url?.startsWith('/__api/')) return next()

  const cmd = req.url.slice(7).split('?')[0]
  const handler = handlers[cmd]

  res.setHeader('Content-Type', 'application/json')

  try {
    // 公开接口不需要认证
    const cfg = readPanelConfig()
    const pw = cfg.accessPassword || ''
    if (!PUBLIC_CMDS.has(cmd) && pw && !isAuthenticated(req)) {
      res.statusCode = 401
      res.end(JSON.stringify({ error: '未登录', code: 'AUTH_REQUIRED' }))
      return
    }

    if (!handler) {
      res.statusCode = 404
      res.end(JSON.stringify({ error: `未实现的命令: ${cmd}` }))
      return
    }

    const args = await readBody(req)
    const result = await handler(args, req)
    res.end(JSON.stringify(result))
  } catch (e) {
    res.statusCode = 500
    res.end(JSON.stringify({ error: e.message || String(e) }))
  }
}

// 导出插件
export function devApiPlugin() {
  return {
    name: 'evopanel-dev-api',
    configureServer(server) {
      // Serve /mnt/user-data/{outputs,workspace}/* as real local files in dev
      server.middlewares.use(_mntUserDataMiddleware)
      server.middlewares.use(_apiMiddleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(_mntUserDataMiddleware)
      server.middlewares.use(_apiMiddleware)
    },
  }
}

export { _apiMiddleware }
