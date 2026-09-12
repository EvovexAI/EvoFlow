/** 设置中心：左侧导航图标与 Tab 元信息 */

import { LICENSE_GATE_ENABLED } from '../../lib/license.js'

export const NAV_ICONS = {
  general:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>',
  models:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/></svg>',
  search:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>',
  im: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>',
  security:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  shortcuts:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h8M6 16h.01M10 16h4"/></svg>',
  api:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>',
  users:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>',
  sso:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 012 2v4M10 14L21 3M5 7H3a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2v-2"/><path d="M7 7l10 10"/></svg>',
  usage:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19V5M4 19h16M8 17V9M12 17v-6M16 17V7"/></svg>',
  resources:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>',
  'code-index':
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="10" cy="18" r="2.5"/><circle cx="18" cy="17" r="2.5"/><path d="M8 7.5l7.5.8M8 16.5l7.5-6.2M12 16.5l4-.4"/></svg>',
  license:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>',
  about:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
}

/** 左侧导航短标题（右侧标题区仍用 TAB_META.title） */
export const NAV_LABELS = {
  general: '通用',
  models: '模型',
  search: '联网搜索',
  im: 'IM 通信',
  security: '安全中心',
  shortcuts: '快捷键',
  api: '远程访问',
  users: '用户权限',
  sso: '企业 SSO',
  usage: '使用统计',
  resources: '资源中心',
  'code-index': '代码索引',
  license: '授权',
  about: '关于',
}

export const TAB_META = {
  // general tab 顶部标题区会被整体隐藏；保留空字符串避免任何"闪现/回退显示"
  general: { title: '', desc: '' },
  models: { title: '模型配置', desc: '对话模型服务商、套餐与主模型选择。' },
  search: { title: '联网搜索', desc: '配置 web_search 引擎；Agent Plan 默认优先豆包（Harness 联网 Key），也可改引擎或自备 Key。' },
  im: { title: '消息渠道', desc: '飞书、Slack、Telegram 等 IM 对接。' },
  security: { title: '安全中心', desc: 'OS 沙箱、新对话默认权限、终端命令策略与审计。' },
  shortcuts: { title: '快捷键', desc: '自定义聊天与全局快捷键，避免与系统冲突。' },
  api: { title: 'WebUI 远程访问', desc: '启用后，手机、平板或远程浏览器可以访问 EvoPanel。' },
  users: { title: '用户与权限', desc: '组织管理员管理用户目录、管理员角色与 ACL 模式。' },
  sso: { title: '企业 SSO', desc: '配置 OpenID Connect，让 Web 与桌面客户端使用企业 IdP 单点登录。' },
  usage: { title: '使用统计', desc: 'Token 与费用账本：按日趋势、类型与模型拆分。' },
  resources: {
    title: '资源中心',
    desc: '本机清单、已装资源包与资源市场。',
  },
  'code-index': { title: '代码索引图谱', desc: '工作空间导入关系、引用链与类型继承图谱。' },
  license: { title: '授权', desc: '粘贴激活码解锁任务中心、工作流、智能体员工。' },
  about: { title: '关于', desc: '版本信息与更新检查。' },
}

/** 左栏分组（仅展示可见 Tab） */
export const NAV_GROUPS = [
  { id: 'basic', title: '基础设置', tabs: ['general', 'models', 'search', 'shortcuts'] },
  { id: 'capability', title: '能力与集成', tabs: ['im', 'security', 'api', 'sso', 'users'] },
  { id: 'data', title: '数据与资源', tabs: ['usage', 'resources', 'code-index'] },
  { id: 'about', title: '关于', tabs: ['about', 'license'] },
]

export const ALLOWED_TABS = Object.keys(TAB_META)

/** 设置左侧导航实际展示的 Tab（授权页默认隐藏，代码与路由挂载仍保留）。 */
export function visibleSettingsTabs() {
  return ALLOWED_TABS.filter((tab) => LICENSE_GATE_ENABLED || tab !== 'license')
}

export function parseTabFromLocation() {
  const h = window.location.hash.slice(1) || ''
  const path = h.split('?')[0]
  if (path !== '/settings') return 'general'
  const q = h.includes('?') ? h.split('?')[1] : ''
  const tab = new URLSearchParams(q).get('tab')
  // 旧 settings?tab=memory 已退役 → 资产中心
  if (tab === 'memory') return 'general'
  // 旧「我的资源 / 资源市场」双 Tab → 合一「资源中心」
  if (tab === 'my-resources' || tab === 'resource-market') return 'resources'
  const mapped = tab === 'plans' ? 'models' : tab
  if (mapped && ALLOWED_TABS.includes(mapped) && (LICENSE_GATE_ENABLED || mapped !== 'license')) {
    return mapped
  }
  return 'general'
}
