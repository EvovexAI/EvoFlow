/**
 * GitHub / Gitee 镜像 URL 管理
 * 国内用户自动使用 Gitee 镜像，解决 GitHub 访问慢/不可达的问题
 */

const GITHUB_ORG = 'https://github.com/EvovexAI'
const GITEE_ORG = 'https://gitee.com/YT'
const GITHUB_RAW = 'https://raw.githubusercontent.com/EvovexAI'
const GITEE_RAW = 'https://gitee.com/YT'

// 仓库名映射（GitHub → Gitee，名称不同时需映射）
const REPO_MAP = {
  EvoFlow: 'evopanel',
  evopanel: 'evopanel',
  evoflow: 'evoflow',
  EvoFlow: 'EvoFlow',
}

/**
 * 探测 GitHub 是否可达（3s 超时）
 * 结果缓存 5 分钟
 */
let _githubReachable = null
let _lastCheck = 0
const CHECK_TTL = 300000 // 5min

async function isGithubReachable() {
  const now = Date.now()
  if (_githubReachable !== null && now - _lastCheck < CHECK_TTL) return _githubReachable
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 3000)
    await fetch('https://github.com/favicon.ico', { method: 'HEAD', mode: 'no-cors', signal: ctrl.signal })
    clearTimeout(timer)
    _githubReachable = true
  } catch {
    _githubReachable = false
  }
  _lastCheck = now
  return _githubReachable
}

/**
 * 获取仓库 URL（优先 GitHub，不可达时用 Gitee）
 * @param {string} repo - 仓库名，如 'evopanel'、'evopanel'
 * @param {string} [path] - 可选路径，如 '/releases'、'/issues/new'
 */
export async function repoUrl(repo, path = '') {
  const giteeRepo = REPO_MAP[repo] || repo
  if (await isGithubReachable()) {
    return `${GITHUB_ORG}/${repo}${path}`
  }
  return `${GITEE_ORG}/${giteeRepo}${path}`
}

/**
 * 同步版本：同时返回 GitHub 和 Gitee URL，让 UI 可以展示两个链接
 * @param {string} repo
 * @param {string} [path]
 */
export function repoBothUrls(repo, path = '') {
  const giteeRepo = REPO_MAP[repo] || repo
  return {
    github: `${GITHUB_ORG}/${repo}${path}`,
    gitee: `${GITEE_ORG}/${giteeRepo}${path}`,
  }
}

/**
 * 获取 raw 文件 URL（用于 deploy.sh 等脚本下载）
 * GitHub: raw.githubusercontent.com/org/repo/branch/file
 * Gitee: gitee.com/org/repo/raw/branch/file
 * @param {string} repo
 * @param {string} branch
 * @param {string} filePath
 */
export async function rawFileUrl(repo, branch, filePath) {
  const giteeRepo = REPO_MAP[repo] || repo
  if (await isGithubReachable()) {
    return `${GITHUB_RAW}/${repo}/${branch}/${filePath}`
  }
  return `${GITEE_RAW}/${giteeRepo}/raw/${branch}/${filePath}`
}

/**
 * deploy.sh 下载命令（国内用户自动切换为 Gitee 源）
 */
export function deployCommand() {
  return {
    github: `curl -fsSL ${GITHUB_RAW}/evopanel/main/deploy.sh | bash`,
    gitee: `curl -fsSL ${GITEE_RAW}/evopanel/raw/main/deploy.sh | bash`,
  }
}

/** 强制标记 GitHub 不可达（用户手动切换时调用） */
export function forceGiteeMirror() {
  _githubReachable = false
  _lastCheck = Date.now()
}

/** 强制标记 GitHub 可达 */
export function forceGithubDirect() {
  _githubReachable = true
  _lastCheck = Date.now()
}

/** 当前是否使用 Gitee 镜像 */
export function isUsingGitee() {
  return _githubReachable === false
}

/** 手动触发一次 GitHub 可达性检测 */
export { isGithubReachable as checkGithubReachable }
