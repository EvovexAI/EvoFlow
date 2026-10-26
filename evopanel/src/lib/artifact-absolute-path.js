/**
 * 产物（artifacts）路径 → 本机绝对路径。
 *
 * 背景：模型 / 工具产出的路径常是「相对工作区」或「临时路径」（如 ``outputs/x.md``、
 * ``docs/roles/<code>/x.md``），右栏与产物列表直接显示会看不懂，也可能读不到文件。
 * 这里统一补成绝对路径，供「展示 + 打开预览」共用。
 *
 * 复用 ``task-output-preview.js`` 的既有解析链（角色工作区推断 → 多候选 root 探测 →
 * 后端 resolve），避免再造一套路径规则。
 */
import { cleanHostPath, isAbsoluteHostPath } from './workspace-abs-path.js'
import { getChatWorkspaceRoot } from './chat-workspace-context.js'
import {
  agentCodeFromRoleOutputPath,
  resolveTaskOutputAbsolutePath,
} from './task-output-preview.js'

/**
 * 解析结果缓存。
 *
 * 同一个产物路径可能在多处被展示（产物列表 / 交付物卡片 / 右栏），
 * 每次都打后端既慢又可能抖动。缓存命中就直接返回。
 * 仅缓存「成功解析出绝对路径」的结果；失败不缓存（后端状态可能变）。
 */
/** @type {Map<string, string>} */
const _absCache = new Map()

const CACHE_MAX = 512

/** @param {string} key @param {string} value */
function cacheAbs(key, value) {
  if (_absCache.size >= CACHE_MAX) {
    const oldest = _absCache.keys().next().value
    if (oldest) _absCache.delete(oldest)
  }
  _absCache.set(key, value)
}

/** 清空缓存（切工作区 / 切会话时调用）。 */
export function clearArtifactAbsolutePathCache() {
  _absCache.clear()
}

/**
 * 解析产物路径为绝对本机路径；失败返回空串（调用方保留原路径）。
 * @param {string} rawPath
 * @param {{ workspaceRoot?: string, agentCode?: string, threadId?: string }} [opts]
 * @returns {Promise<string>}
 */
export async function resolveArtifactAbsolutePath(rawPath, opts = {}) {
  const cleaned = cleanHostPath(rawPath)
  if (!cleaned) return ''
  // 网络链接没有本机路径
  if (/^https?:\/\//i.test(cleaned)) return ''
  if (isAbsoluteHostPath(cleaned)) return cleaned.replace(/\\/g, '/')

  const workspaceRoot = String(opts.workspaceRoot || '').trim() || getChatWorkspaceRoot() || ''
  const agentCode = String(opts.agentCode || '').trim() || agentCodeFromRoleOutputPath(cleaned)
  const cacheKey = `${workspaceRoot}|${agentCode}|${opts.threadId || ''}|${cleaned}`
  const cached = _absCache.get(cacheKey)
  if (cached) return cached

  try {
    const abs = await resolveTaskOutputAbsolutePath({
      path: cleaned,
      workspaceRoot,
      agentCode,
    })
    if (abs) {
      const norm = String(abs).replace(/\\/g, '/')
      cacheAbs(cacheKey, norm)
      return norm
    }
  } catch {
    /* 继续尝试线程沙箱 */
  }

  // 兜底：按会话线程沙箱解析（语音会话 / 后台会话与主对话 root 不同）。
  const threadId = String(opts.threadId || '').trim()
  if (threadId) {
    try {
      const { api } = await import('./tauri-api.js')
      const info = await api.resolveWorkspaceTarget('', cleaned, threadId)
      const resolved = String(info?.resolved || '').replace(/\\/g, '/')
      if (resolved && info?.exists !== false && isAbsoluteHostPath(resolved)) {
        cacheAbs(cacheKey, resolved)
        return resolved
      }
    } catch {
      /* ignore */
    }
  }

  return ''
}

/**
 * 把产物列表的 ``path`` 就地升级为绝对本机路径（解析不出来就保留原值）。
 *
 * 直接替换 ``path`` 而不是新增字段：产物列表展示、右栏打开、文件预览全都读同一处，
 * 避免「显示绝对路径但打开的还是相对路径」的分裂。
 *
 * @template {{ path?: string }} T
 * @param {T[]} items
 * @param {{ workspaceRoot?: string, threadId?: string }} [opts]
 * @returns {Promise<T[]>}
 */
export async function withAbsoluteArtifactPaths(items, opts = {}) {
  const list = Array.isArray(items) ? items : []
  if (!list.length) return list
  const out = await Promise.all(
    list.map(async (it) => {
      if (!it || typeof it !== 'object') return it
      const p = String(/** @type {{ path?: string }} */ (it).path || '').trim()
      if (!p) return it
      const abs = await resolveArtifactAbsolutePath(p, opts)
      return abs ? { ...it, path: abs } : it
    }),
  )
  return /** @type {T[]} */ (out)
}
