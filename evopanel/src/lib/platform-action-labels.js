/**
 * platform(action=domain.op) 展示文案枚举。
 * 与 backend ``evoflow.admin.platform_actions`` 注册表 DOMAIN_GUIDES / summary 对齐。
 * 重新生成：python evopanel/scripts/gen-platform-action-labels.py
 */

/** @type {Record<string, string>} */
export const PLATFORM_DOMAIN_ZH = {
  agents: '智能体角色',
  appearance: '界面外观',
  approvals: '审批',
  assets: '资产中心',
  automation: '定时自动化',
  channels: 'IM 渠道',
  diagnostics: '日志与异常诊断',
  employees: '智能体员工岗位',
  eval: '评测中心',
  extensions: 'Agent应用',
  items: '用户事项/备忘',
  knowledge: '知识库',
  mcp: 'MCP',
  media: '生图/生视频',
  org: '资源包',
  plugins: '插件',
  sessions: '会话与上下文',
  settings: '设置（模型/联网搜索）',
  skills: '技能',
  tasks: '协作任务台账（行政视角）',
  ui: '右侧面板',
  verification: '系统验证',
  workflow: '工作流/应用',
}

/** @type {Record<string, string>} */
export const PLATFORM_ACTION_ZH = {
  'agents.bindings': '可绑定能力包 packs + 工具/技能/MCP/知识库（创建前先查；优先选 pack）',
  'agents.create': '创建智能体（优先 capability_pack；省略 tools→空；tools:null 须 confirm_inherit_all）',
  'agents.delete': '删除智能体',
  'agents.get': '查看智能体详情',
  'agents.list': '列出智能体角色',
  'agents.update': '更新智能体配置',
  'appearance.patch': '更新界面外观（主题/色卡/背景/液态玻璃）',
  'approvals.approve': '同意审批',
  'approvals.list': '列出审批（默认 pending；传 status=all 看全部）',
  'approvals.reject': '驳回审批',
  'assets.export': '导出实体资产为 .evoflow-pack',
  'assets.get_profile': '查看用户画像（资产中心：basic-info / preferences / persona）',
  'assets.import': '导入 .evoflow-pack 到指定实体',
  'assets.init': '初始化 Asset Hub 目录树与内置 vault',
  'assets.migrate': '把遗留 SQLite 记忆/经验迁移到资产文件',
  'assets.update_profile': '更新用户画像某一维度（资产中心）',
  'automation.create': '创建定时自动化',
  'automation.delete': '删除自动化',
  'automation.get': '查看自动化详情',
  'automation.history': '自动化运行历史',
  'automation.list': '列出定时自动化',
  'automation.set_status': '启用/停用自动化',
  'automation.update': '更新自动化',
  'channels.enable': '启用/禁用渠道',
  'channels.get': '查看单个渠道配置与运行状态',
  'channels.list': '列出 IM 渠道状态',
  'channels.push_targets': '列出可推送的 IM 会话目标',
  'channels.registration_apply': '把扫码拿到的凭证写入并尝试启动渠道',
  'channels.registration_begin': '开始扫码注册（飞书/微信/企微/钉钉）',
  'channels.registration_poll': '轮询扫码注册状态',
  'channels.restart': '重启渠道',
  'channels.set_config': '更新渠道配置（默认 merge）',
  'diagnostics.run': '综合系统诊断（日志/知识库/模型/员工/定时）；focus 可只跑对应模块：logs|knowledge|models|employees|automation 或中文别名',
  'diagnostics.scan': '扫描近期 ERROR/异常行',
  'diagnostics.sources': '列出系统已知日志源，并标出哪些近期有报错',
  'diagnostics.status': '查看当前系统运行状态（系统端口、前后端端口、服务状态、数据目录、安装目录）',
  'diagnostics.timeline': '汇总可转发的异常时间线（markdown）',
  'employees.bind_channel_apply': '把扫码凭证绑到本岗 AI 员工（勿用 channels.registration_apply）',
  'employees.bind_channel_begin': '为指定员工发起飞书/企微扫码，绑定本岗 AI 员工',
  'employees.bind_channel_poll': '轮询员工渠道扫码状态（对话卡通常会自动轮询；仅兜底）',
  'employees.board_overview': '跨岗未结看板 + stuck_candidates（催办前先看）',
  'employees.brief': '单岗近况简报：忙闲、未结任务、轨迹摘要',
  'employees.create': '一次创建员工（优先 capability_pack=duty|research|writer|coding|none；禁止灌全表 tools）',
  'employees.delete': '删除员工岗位（可选一并删除智能体）',
  'employees.dispatch': '把新目标派给指定员工（后台值班轮；小V/前台 source=xiaomi）',
  'employees.get': '查看员工详情',
  'employees.hire': '雇佣智能体为值班员工',
  'employees.list': '列出智能体员工岗位',
  'employees.migrate': '把可执行旧事项(initiatives)迁移为 Task（可 dry_run）',
  'employees.org_status': '名册汇总：人数、忙闲、待审批（不含小V自身）',
  'employees.pause': '暂停员工值班',
  'employees.resume': '恢复员工值班',
  'employees.stop': '停止员工当前轮次',
  'employees.trail': '查看员工某一轮值班的工具调用轨迹（steps[] / tool_counts）',
  'employees.update': '更新员工岗位配置',
  'employees.wake': '唤醒员工（按 agent_code 或 role_name；可带 goal/task）',
  'employees.worklog': '查看员工某日/近N日工作日志（rounds=值班轮次；tasks=台账任务；勿因 round_count=0 判空，请看 task_count/tasks/hint）',
  'eval.cases': '列出评测用例',
  'eval.get': '查看某次评测详情',
  'eval.progress': '查看评测进度',
  'eval.run': '启动一次评测（默认同步等结果；async=true 可后台跑）',
  'eval.runs': '列出近期评测运行',
  'extensions.enable': '启用/禁用 Agent应用',
  'extensions.get': '查看单个 Agent应用详情',
  'extensions.install': '安装 Agent应用：远程入口(id+url) / 本地目录(path) / 直接登记(manifest)',
  'extensions.list': '列出已安装的 Agent应用（侧栏扩展）',
  'extensions.uninstall': '卸载 Agent应用（folder-link 只摘登记不删源目录）',
  'items.create': '登记用户事项/备忘（记事，不自动开跑；要执行再 items.dispatch）',
  'items.delete': '删除用户事项',
  'items.dispatch': '从事项派发给员工并派生可执行 Task',
  'items.get': '查看事项详情',
  'items.list': '列出用户事项/备忘（持久化；≠ 对话 todo、≠ Task）',
  'items.update': '更新用户事项',
  'knowledge.create': '新建平台自有知识库',
  'knowledge.delete': '删除平台自有知识库（软删；内置库不可删）',
  'knowledge.enable': '启用/停用 Obsidian Vault（遗留）',
  'knowledge.ingest': '写入一篇笔记',
  'knowledge.list': '列出平台自有知识库',
  'knowledge.note_delete': '删除一篇笔记',
  'knowledge.note_get': '读取一篇笔记',
  'knowledge.notes': '列出库内笔记',
  'knowledge.reindex': '整库重索引（可改向量模型；force 默认 false，true=强制全量重建）',
  'knowledge.requeue': '重排队卡住的索引任务',
  'knowledge.search': '检索自有知识库（默认 hybrid 多库扇出）',
  'mcp.add': '新增或更新单个 MCP 服务器',
  'mcp.get': '查看 MCP 服务器配置（整表）',
  'mcp.list': '列出 MCP 服务器与运行状态',
  'mcp.login': '刷新 HTTP MCP 的 OAuth 登录',
  'mcp.logout': '清除 MCP OAuth 缓存（提示级）',
  'mcp.remove': '删除单个 MCP 服务器',
  'mcp.set': '整体替换 MCP 配置',
  'mcp.test': '测通单个 MCP（连上并列工具）',
  'media.catalog': '查看生图/生视频能力目录（厂商、档位、同步/异步接口与传参）',
  'media.generate_image': '生成图片（提交+轮询+落盘，一次返回路径）',
  'media.generate_video': '提交生视频任务（异步；再用 media.task_wait）',
  'media.status': '检查生图/生视频是否已配置可用',
  'media.task_wait': '等待生视频/生图异步任务完成并落盘',
  'org.export': '导出本地员工/应用等为资源包',
  'org.get': '查看资源包实例详情',
  'org.install': '安装资源包（本地目录/zip/市场路径）',
  'org.list': '列出已装资源包实例',
  'org.market_catalog': '拉取资源市场目录',
  'org.market_install': '按市场相对路径安装资源包',
  'org.preflight': '预检资源包（不安装）',
  'org.uninstall': '卸载资源包实例',
  'plugins.describe': '查看插件组件（commands/skills/MCP 等）',
  'plugins.enable': '启用/禁用已装插件',
  'plugins.install': '从市场安装插件',
  'plugins.list': '列出已安装插件',
  'plugins.marketplace_add': '添加插件市场源',
  'plugins.marketplace_refresh': '刷新插件市场目录（可指定 id；省略则刷新全部）',
  'plugins.marketplace_remove': '移除插件市场源',
  'plugins.overview': '插件总览：市场 + 可装 + 已装',
  'plugins.restore': '恢复内置插件（卸过可再装回）',
  'plugins.uninstall': '卸载插件',
  'plugins.update': '更新已装插件到市场最新',
  'sessions.compact': '主动压缩当前（或指定）对话上下文（与 /compact 同引擎；需 confirm=true）',
  'sessions.search': '按关键词搜历史会话',
  'sessions.status': '查看当前（或指定）对话状态：运行态、消息数、上下文占用、是否已压缩',
  'settings.create_model': '新增模型配置',
  'settings.delete_model': '删除模型配置',
  'settings.get_default_model': '查看默认模型',
  'settings.get_model': '查看单个模型配置',
  'settings.get_web_search': '查看联网搜索配置与助手引导（密钥已脱敏；含 Agent Plan 状态）',
  'settings.list_models': '列出模型与默认模型',
  'settings.patch_web_search': '更新联网搜索密钥/首选渠道（对话代配，勿让用户自己翻复杂设置页）',
  'settings.set_default_model': '设置默认模型',
  'settings.test_web_search': '测通联网搜索渠道并可采纳推荐首选',
  'settings.update_model': '更新已有模型配置（改 Key/地址/参数；掩码 **** 的 api_key 会忽略）',
  'skills.delete': '删除自定义技能',
  'skills.enable': '启用/停用技能',
  'skills.get': '查看技能详情',
  'skills.import_orphans': '把非生效技能根里「生效根没有」的 custom 技能复制进当前生效根（不删除源）',
  'skills.install': '安装技能（path 或市场 slug；本地 path 可 link=true 挂载）',
  'skills.list': '列出技能',
  'tasks.cleanup_noise': '清理噪音任务（默认 dry_run；apply=true 才真正删）',
  'tasks.create': '行政侧创建 Task（值班开单/progress/handlers 结案优先用专用工具 tasks）',
  'tasks.delete': '删除 Task',
  'tasks.execution_trail': '查看任务/子任务内部工具调用轨迹（steps[]，非状态清单）',
  'tasks.get': '查看 Task 详情',
  'tasks.list': '列出协作 Task 台账（行政视角；默认不含子任务，limit 默认 50、上限 200）',
  'tasks.progress': '更新 Task 进度（0-100；可顺带改 status）',
  'tasks.reclaim_zombies': '回收僵尸任务（默认 dry_run；apply=true 才执行）',
  'tasks.set_state': '行政侧变更 Task 状态（合法流转：pending→executing→completed 等；非法时错误含 next_states）',
  'ui.hide': '关闭右侧面板',
  'ui.show': '打开右侧面板（进度/网页/产物等；读操作无需 confirm）',
  'ui.update': '更新已打开的右侧面板内容',
  'verification.catalog': '查询全平台可验证接口清单（按域/风险/关键词）',
  'verification.conclude': '结束一轮：写结论、终态、异常汇总',
  'verification.delete': '删除一轮验证及步骤',
  'verification.get': '查看一轮验证详情与步骤',
  'verification.init': '把接口清单初始化进已有轮次（状态=待开始/pending）',
  'verification.start': '开启或复用一轮系统验证；可 seed 接口清单为待开始步骤',
  'verification.step': '记录/回填一步验证（同 api 的待开始步骤会就地更新）',
  'verification.update': '更新轮次进度/状态/结论草稿',
  'workflow.create': '新建工作流草稿',
  'workflow.delete': '删除工作流',
  'workflow.duplicate': '复制工作流',
  'workflow.generate': '从目标+步骤生成工作流',
  'workflow.get': '查看工作流详情',
  'workflow.list': '列出应用/工作流',
  'workflow.list_runs': '查看应用运行历史',
  'workflow.publish': '发布工作流',
  'workflow.recover': '从断点/失败节点续跑（读库纠状态后重派）',
  'workflow.restore_revision': '从历史版本恢复',
  'workflow.resume': '恢复已暂停运行',
  'workflow.revisions': '查看历史版本',
  'workflow.run': '启动一次运行',
  'workflow.run_status': '查看运行状态',
  'workflow.schema': '查看创建工作流所需的步骤/参数模板',
  'workflow.stop': '取消或暂停运行',
  'workflow.unpublish': '退回草稿',
  'workflow.update': '修改工作流定义',
}

/** 常见 op 动词（未登记完整 action 时的回退）。 */
/** @type {Record<string, string>} */
export const PLATFORM_OP_ZH = {
  list: '列出',
  get: '查看',
  create: '创建',
  update: '更新',
  delete: '删除',
  search: '检索',
  enable: '启停',
  install: '安装',
  uninstall: '卸载',
  run: '运行',
  stop: '停止',
  resume: '恢复',
  publish: '发布',
  hire: '雇佣',
  pause: '暂停',
  wake: '唤醒',
  approve: '批准',
  reject: '拒绝',
  catalog: '查看目录',
  help: '查看说明',
  test: '测通',
  patch: '更新',
  ingest: '写入',
  dispatch: '派发',
  progress: '更新进度',
}

/**
 * @param {string | null | undefined} action
 * @returns {string}
 */
export function platformActionLabelZh(action) {
  const raw = String(action || '').trim()
  if (!raw) return ''
  const hit = PLATFORM_ACTION_ZH[raw]
  if (hit) return hit
  const lower = raw.toLowerCase()
  if (lower !== raw) {
    const hit2 = PLATFORM_ACTION_ZH[lower]
    if (hit2) return hit2
  }
  const dot = raw.indexOf('.')
  if (dot > 0) {
    const domain = raw.slice(0, dot)
    const op = raw.slice(dot + 1)
    const domainZh = PLATFORM_DOMAIN_ZH[domain] || domain
    const opZh = PLATFORM_OP_ZH[op.toLowerCase()]
    if (opZh) return `${domainZh} · ${opZh}`
    return `${domainZh} · ${op}`
  }
  return PLATFORM_DOMAIN_ZH[raw] || raw
}

/**
 * 折叠条 / 活动行用的短标签：优先完整 summary，过长则截到域 · op。
 * @param {string | null | undefined} action
 * @param {{ max?: number }} [opts]
 * @returns {string}
 */
export function platformActionShortLabelZh(action, opts) {
  const full = platformActionLabelZh(action)
  if (!full) return ''
  const max = opts?.max ?? 18
  if (full.length <= max) return full
  const raw = String(action || '').trim()
  const dot = raw.indexOf('.')
  if (dot > 0) {
    const domain = raw.slice(0, dot)
    const op = raw.slice(dot + 1)
    const domainZh = PLATFORM_DOMAIN_ZH[domain] || domain
    const opZh = PLATFORM_OP_ZH[op.toLowerCase()] || op
    const short = `${domainZh} · ${opZh}`
    return short.length <= max ? short : `${short.slice(0, max)}…`
  }
  return `${full.slice(0, max)}…`
}

/**
 * @param {string | null | undefined} domain
 * @returns {string}
 */
export function platformDomainLabelZh(domain) {
  const d = String(domain || '').trim()
  if (!d) return ''
  return PLATFORM_DOMAIN_ZH[d] || d
}
