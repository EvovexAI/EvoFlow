/**
 * 右栏挂载壳页面（shell-page）：与菜单同一套 path，非 BrowserPanel。
 */
import { rightStageStore } from './right-stage-store.js'
import { resolveShellPageTabTitle, shellPageTabId } from './shell-page-mount-table.js'

export type ShellPageStagePayload = {
  path: string
  title?: string
  mountId?: string
  entityLabel?: string
  focusId?: string
  /** 员工详情签：页签旁显示智能体头像 */
  agentCode?: string
  layout?: 'half' | 'wide' | 'narrow' | 'workspace-write'
}

export type OpenShellPageStageOpts = {
  sessionKey?: string | null
  layout?: 'half' | 'wide' | 'narrow' | 'workspace-write'
  /**
   * 用户显式打开（点按钮/卡片）时传 true：清掉收起锁并展开右栏。
   * 不传 = 沿用 store 语义（用户收起锁定时只写签不撑开）——自动开栏勿传。
   */
  forceExpand?: boolean
}

function normalizePath(raw: string): string {
  let p = String(raw || '').trim()
  if (!p) return ''
  // 【self-evolution-bot · 2026-11-21 · 第103轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：外链 / 协议相对地址一律返回 ''（=不建签），不再补成 `/https://...`。
  // 为什么（本轮真机实测）：`ui.show(kind=shell-page, data.path="https://example.com")`
  //   旧逻辑会补成 `/https://example.com`，挂载表查不到就渲染成空壳页，还顶掉了
  //   用户原来 /tasks 的签。后端已加同一道校验；前端这道是兜底——老版本后端、
  //   或前端内部误传时不该造出这种死页。
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p) || p.startsWith('//')) return ''
  if (p.startsWith('#')) p = p.slice(1)
  if (!p.startsWith('/')) p = `/${p}`
  p = p.split('?')[0].replace(/\/+$/, '') || '/'
  // 与挂载表一致：/employees → /proactive
  if (p === '/employees') return '/proactive'
  const emp = p.match(/^\/employees\/([^/]+)$/)
  if (emp) return `/proactive/${emp[1]}`
  return p
}

/**
 * 【self-evolution-bot · 2026-11-21 · 第102轮 · 模型:deepseek-v4.1-flash-1017】
 * 这些是 mount table / 路径推出来的**兜底名**，不是模型或用户给的可读名。
 * 为什么单列一份：以前 openShellPageInRightStage 里有一份内联白名单，
 *   而 patchShellPageTabTitle（页面挂载后回写名称）**完全没有这道判断**，
 *   于是结果就是「传了 title 也被覆盖成兜底名」。
 * 真机实测（2026-11-21 00:44，ui.show path=/proactive title=主动任务ABC）：
 *   回读标签 title 是 `BOT`，`主动任务ABC` 被丢掉。
 */
const GENERIC_SHELL_PAGE_TITLES = new Set([
  '页面',
  '员工',
  'BOT',
  '任务',
  '待办',
  '工作流',
  '知识库',
  '设置',
  '自动化',
])

/** 这个标题是不是「没有信息量的兜底名」（空 / 路径 / mount table 默认值）。 */
export function isGenericShellPageTitle(title: string | null | undefined): boolean {
  const t = String(title || '').trim()
  if (!t || t.startsWith('/')) return true
  return GENERIC_SHELL_PAGE_TITLES.has(t)
}

/** `/proactive/:code` → agent_code（页签头像兜底） */
export function agentCodeFromShellPagePath(path: string): string {
  const p = normalizePath(path)
  const m = p.match(/^\/proactive\/([^/]+)$/)
  if (!m) return ''
  try {
    return decodeURIComponent(m[1]).trim()
  } catch {
    return String(m[1] || '').trim()
  }
}

/** 打开（或激活）壳页面 tab。id 按 path 去重；标签用实体名，不用 path。 */
export function openShellPageInRightStage(
  payload: ShellPageStagePayload,
  opts?: OpenShellPageStageOpts,
): string {
  const path = normalizePath(payload?.path)
  if (!path) return ''
  const id = shellPageTabId(path)
  if (!id) return ''
  const sk = String(opts?.sessionKey || '').trim() || undefined
  const mountId = String(payload.mountId || '').trim()
  const layout = opts?.layout || payload.layout || 'wide'
  const title = resolveShellPageTabTitle({
    title: payload.title,
    entityLabel: payload.entityLabel,
    path,
    mountId,
  })
  const focusId = String(payload.focusId || '').trim()
  const forceExpand = opts?.forceExpand === true
  const agentCode =
    String(payload.agentCode || '').trim() || agentCodeFromShellPagePath(path)
  // 已挂同一 path：只激活/展开；若新标题更可读则回写（不因 path 覆盖好名字）
  const existing = rightStageStore.findTab(`shell-page:${id}`)
  if (existing && String(existing.data?.path || existing.data?.route || '').trim() === path) {
    const prevTitle = String(existing.title || '').trim()
    // 【self-evolution-bot · 2026-11-21 · 第102轮 · 模型:deepseek-v4.1-flash-1017】
    // 改了什么：内联白名单抽成 ``isGenericShellPageTitle``，与回写路径共用同一判据。
    // 为什么：两处各写一份必然漂移 —— 回写那条（patchShellPageTabTitle）压根没有判断，
    //   于是「这里不覆盖好名字」被下游无条件覆盖打穿。同一规则只许有一处真源。
    const prevLooksGeneric = isGenericShellPageTitle(prevTitle)
    const nextTitle = prevLooksGeneric && title && title !== prevTitle ? title : prevTitle || title
    rightStageStore.show({
      kind: 'shell-page',
      id,
      title: nextTitle,
      layout: existing.layout || layout,
      sessionKey: sk,
      data: {
        path,
        route: path,
        mountId: String(existing.data?.mountId || mountId).trim(),
        title: nextTitle,
        entityLabel: String(
          payload.entityLabel || existing.data?.entityLabel || '',
        ).trim(),
        focusId: focusId || String(existing.data?.focusId || '').trim(),
        agentCode:
          agentCode ||
          String(existing.data?.agentCode || existing.data?.agent_code || '').trim(),
      },
      forceExpand,
    })
    return id
  }
  rightStageStore.show({
    kind: 'shell-page',
    id,
    title,
    layout,
    sessionKey: sk,
    data: {
      path,
      route: path,
      mountId,
      title,
      entityLabel: String(payload.entityLabel || '').trim(),
      focusId,
      ...(agentCode ? { agentCode } : {}),
    },
    forceExpand,
  })
  return id
}

/** 挂载完成后用真实名称回写标签（员工 role_name / 任务 name）。 */
export function patchShellPageTabTitle(path: string, title: string): void {
  const p = normalizePath(path)
  const id = shellPageTabId(p)
  if (!id || !title.trim()) return
  const key = `shell-page:${id}`
  const next = resolveShellPageTabTitle({ title, path: p })
  if (!next || next.startsWith('/')) return
  // 【self-evolution-bot · 2026-11-21 · 第102轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：回写前也过一遍 ``isGenericShellPageTitle``，兜底名不许覆盖已有好名字。
  // 为什么（真机实测 00:44）：``ui.show path=/proactive title=主动任务ABC`` 回读是 ``BOT``。
  //   链路是 openShellPageInRightStage 正确写入了 主动任务ABC，随后 ShellPageKind 挂载完成
  //   调本函数回写，而 ``resolveShellPageTabTitle`` 对 /proactive 的兜底就是 ``BOT`` ——
  //   这条路上此前**没有任何"别覆盖"判断**，于是同一个页面刚开好就被自己的兜底名改掉。
  //   已有标题不是兜底名时，回写只允许"更具体"（长度更长且不同），否则保持原样。
  if (isGenericShellPageTitle(next)) {
    const prev = String(rightStageStore.findTab(key)?.title || '').trim()
    if (prev && !isGenericShellPageTitle(prev)) return
  }
  rightStageStore.patchTab(key, {
    title: next,
    data: { title: next, entityLabel: next },
  })
}
