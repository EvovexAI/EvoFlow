/**
 * MCP 服务 ↔ Agent应用 / 本地工作台 URL。
 * 跟员工聊天时：按员工绑定的 mcp_servers 在右侧自动打开对应网站，便于边聊边看 MCP 健康与业务面板。
 */
import { showRightStageBrowserUrl } from './right-stage/open-right-stage-browser.js'
import { ensureUiExtensionReady, getUiExtension } from './ui-extensions.js'

/** showcase / 内容套件约定：MCP 名 → Agent应用 id */
export const MCP_WORKBENCH_EXTENSION_BY_SERVER = Object.freeze({
  'education-smart-coach': 'smart-coach',
  'ecommerce-shangce': 'ecommerce-content-studio',
  'selfmedia-douyin-pipeline': 'douyin-video-pipeline',
  'selfmedia-douyin-blogger': 'douyin-blogger-analyzer',
  'aigc-prompt-reverse': 'aigc-prompt-reverse',
  'ai-canvas-director': 'ai-canvas',
})

/** 扩展未装或启动失败时的兜底入口 */
export const MCP_WORKBENCH_FALLBACK_URL = Object.freeze({
  'education-smart-coach': 'http://127.0.0.1:8769/',
  'ecommerce-shangce': 'http://127.0.0.1:8790/',
  'selfmedia-douyin-pipeline': 'http://127.0.0.1:8765/',
  'selfmedia-douyin-blogger': 'http://127.0.0.1:8787/',
  'aigc-prompt-reverse': 'http://127.0.0.1:8768/',
  'ai-canvas-director': 'http://127.0.0.1:3000/',
  'selfmedia-video-decompose': 'http://127.0.0.1:3001/',
})

function normalizeMcpName(name) {
  return String(name || '').trim()
}

/**
 * @param {unknown} mcpServers
 * @returns {string[]}
 */
export function listBoundMcpServers(mcpServers) {
  if (!Array.isArray(mcpServers)) return []
  return mcpServers.map(normalizeMcpName).filter(Boolean)
}

/**
 * @param {string} mcpName
 * @returns {Promise<{ mcpName: string, extensionId: string, url: string, title: string } | null>}
 */
export async function resolveMcpWorkbenchTarget(mcpName) {
  const name = normalizeMcpName(mcpName)
  if (!name) return null
  const extensionId = String(MCP_WORKBENCH_EXTENSION_BY_SERVER[name] || '').trim()
  const fallback = String(MCP_WORKBENCH_FALLBACK_URL[name] || '').trim()

  if (extensionId) {
    try {
      const row = await getUiExtension(extensionId)
      if (row && row.enabled !== false) {
        const ready = await ensureUiExtensionReady(extensionId)
        const entry = String(ready?.entry || row?.manifest?.ui?.entry || '').trim() || fallback
        if (entry) {
          const title =
            String(row?.manifest?.nav?.title || row?.manifest?.name || extensionId).trim() || name
          return { mcpName: name, extensionId, url: entry, title }
        }
      }
    } catch {
      /* 扩展未装 / 服务起不来 → 走兜底 URL */
    }
  }

  if (!fallback) return null
  return {
    mcpName: name,
    extensionId,
    url: fallback,
    title: extensionId || name,
  }
}

/**
 * 打开单个 MCP 对应的工作台到右侧浏览器。
 * @returns {Promise<boolean>}
 */
export async function openMcpWorkbenchInRightStage(mcpName, opts = {}) {
  const target = await resolveMcpWorkbenchTarget(mcpName)
  if (!target?.url) return false
  showRightStageBrowserUrl(target.url, {
    sessionKey: opts.sessionKey || null,
    threadId: opts.threadId || null,
  })
  return true
}

/**
 * 按员工绑定的 MCP 列表，打开第一个能解析到工作台的。
 * @returns {Promise<string>} 打开的 mcp 名；失败返回 ''
 */
export async function openEmployeeMcpWorkbenchInRightStage({
  mcpServers,
  sessionKey = null,
  threadId = null,
} = {}) {
  const names = listBoundMcpServers(mcpServers)
  for (const name of names) {
    try {
      if (await openMcpWorkbenchInRightStage(name, { sessionKey, threadId })) {
        return name
      }
    } catch {
      /* try next */
    }
  }
  return ''
}

/**
 * 合并 MCP 配置里的健康状态（load_status）到绑定列表。
 * @param {string[]} mcpNames
 * @param {Record<string, any> | null | undefined} serverStatus
 */
export function annotateMcpHealth(mcpNames, serverStatus) {
  const statusMap =
    serverStatus && typeof serverStatus === 'object' ? serverStatus : {}
  return listBoundMcpServers(mcpNames).map((name) => {
    const st = statusMap[name] || {}
    const load = String(st.load_status || st.status || '').trim().toLowerCase()
    let health = 'unknown'
    if (['ready', 'connected', 'ok', 'running'].includes(load)) health = 'ready'
    else if (['pending', 'connecting', 'starting'].includes(load)) health = 'pending'
    else if (['error', 'failed', 'auth', 'config'].includes(load)) health = 'error'
    else if (['disabled'].includes(load)) health = 'disabled'
    return {
      name,
      health,
      loadStatus: load || 'unknown',
      error: String(st.error || '').trim(),
      toolCount: Number(st.tool_count || st.toolCount || 0) || 0,
      extensionId: String(MCP_WORKBENCH_EXTENSION_BY_SERVER[name] || ''),
      hasWorkbench: Boolean(
        MCP_WORKBENCH_EXTENSION_BY_SERVER[name] || MCP_WORKBENCH_FALLBACK_URL[name],
      ),
    }
  })
}
