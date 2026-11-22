/**
 * 右栏面板类型契约（前端侧）—— 从后端唯一真源读取，本文件不另立规则。
 *
 * 【self-evolution-bot · 2026-11-20 · 第87轮 · 模型:deepseek-v4.1-flash-1017】
 * 改了什么：新建本文件。前端不再自己维护「哪种 kind 必需什么字段 / 哪些动作要自动开」，
 * 改为 GET /api/stage/right-stage/kinds 拉后端 evoflow.stage.right_panel_kinds 的同一份表。
 * 为什么：用户 2026-11-20 明确要求「前端跟后端架构不能是混乱的」。此前后端
 * stage_tool._build_progress_surface 与前端 open-progress-from-panel-set.ts
 * 各写一套必填校验，已经漂移（后端强要 employeeProcess.taskId，前端只查 agentCode）；
 * 自动打开白名单也在前后端各写一份。
 *
 * 兜底策略：拉取失败（离线 / 构建期 / 旧网关）时退回 BUILTIN_SPECS，
 * 但**只用于给用户提示，不用于决定自动打开**——自动打开由后端 CTA 决定，
 * 前端只读 payload 里的 autoOpen 字段，不再自行推导。
 */

export type RightPanelKindSpec = {
  kind: string
  label: string
  trigger: 'user' | 'agent' | 'auto'
  layout: string
  required: string[]
  optional?: string[]
  description: string
  example?: Record<string, unknown>
}

export type RightPanelContract = {
  ok: boolean
  kinds: RightPanelKindSpec[]
  autoOpenActions: string[]
  readOnlyActions: string[]
}

/** 兜底表：仅用于「后端不可达时」给用户一句可读提示，不参与自动打开判定。 */
const BUILTIN_SPECS: RightPanelKindSpec[] = [
  {
    kind: 'collab-workflow',
    label: '协作工作流图',
    trigger: 'agent',
    layout: 'wide',
    required: ['data.mainTaskId'],
    description: '多节点协作任务的实时流程图。',
  },
  {
    kind: 'collabSubtaskTranscript',
    label: '协作节点进度',
    trigger: 'agent',
    layout: 'wide',
    required: ['data.mainTaskId', 'data.subtaskId'],
    description: '工作流里单个节点的会话过程。',
  },
  {
    kind: 'employeeProcess',
    label: '员工执行过程',
    trigger: 'agent',
    layout: 'wide',
    required: ['data.agentCode'],
    description: '员工/岗位的实时对话与执行过程；taskId 可选。',
  },
  {
    kind: 'sessionRuntime',
    label: '本会话运行中',
    trigger: 'agent',
    layout: 'wide',
    required: ['data.sessionKey'],
    description: '当前会话下正在跑的子工作列表。',
  },
  {
    kind: 'web-embed',
    label: '网页内嵌',
    trigger: 'agent',
    layout: 'wide',
    required: ['data.url'],
    description: '在右栏内嵌打开一个网页。',
  },
  {
    kind: 'shell-page',
    label: '平台内嵌页',
    trigger: 'agent',
    layout: 'wide',
    required: ['data.path'],
    description: '把 EvoPanel 站内页面嵌进右栏。',
  },
  // 【self-evolution-bot · 2026-11-20 · 第87轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：补齐 mind-map / news-dashboard 两个 kind（后端契约共 8 个，这里原只有 6 个）。
  // 为什么：兜底表漏项会让「后端不可达时」前端对这两个 kind 报「未知」，与真源漂移。
  // 由 backend/tests/test_right_panel_contract_parity.py 逐 kind 对账兜住，新增 kind 漏补会红。
  {
    kind: 'mind-map',
    label: '思维导图',
    trigger: 'user',
    layout: 'wide',
    required: [],
    description: '当前会话的知识/记忆思维导图。',
  },
  {
    kind: 'news-dashboard',
    label: '热榜',
    trigger: 'user',
    layout: 'wide',
    required: [],
    description: '热点资讯面板。',
  },
  // 【self-evolution-bot · 2026-11-22 · 第120轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：补 file / asset / codeViewer / screenshot 四种「内容预览」kind。
  // 为什么：后端契约已把它们提升为可申请类型（用户当面问「为什么不能支持打开文件」，
  //   而功能其实一直都在）。兜底表是后端不可达时前端唯一能读到的清单，
  //   漏一个就会把能开的 kind 报成「未知」。由 parity 测试逐 kind 对账兜住。
  // 判据：required 必须与后端逐字一致（data. 前缀保留，消费侧统一剥）。
  {
    kind: 'file',
    label: '本地文件预览',
    trigger: 'agent',
    layout: 'wide',
    required: ['data.path'],
    description: '在右栏预览本地文件：md / 代码 / 文本 / 图片 / 视频 / 音频 / PDF。',
  },
  {
    kind: 'asset',
    label: '资产文件预览',
    trigger: 'agent',
    layout: 'wide',
    required: ['data.path'],
    description: '预览资产库（memory / craft / standing）里的文件。',
  },
  {
    kind: 'codeViewer',
    label: '代码查看器',
    trigger: 'agent',
    layout: 'wide',
    required: ['data.source'],
    description: '按 ZCode PreviewPane 打开代码/diff/多文件内容。',
  },
  {
    kind: 'screenshot',
    label: '截图预览',
    trigger: 'agent',
    layout: 'wide',
    required: ['data.uri'],
    description: '大图预览 CUA / 电脑控制 / 浏览器截图。',
  },
]

let cached: RightPanelContract | null = null
let inflight: Promise<RightPanelContract> | null = null

function specToRequiredFields(spec: RightPanelKindSpec): string[] {
  // 契约里写的是 data.xxx，实际校验时剥掉 data. 前缘
  return (spec.required || []).map((p) => String(p).replace(/^data\./, ''))
}

export function normalizeRightPanelContract(raw: unknown): RightPanelContract | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.ok !== true || !Array.isArray(r.kinds)) return null
  const kinds: RightPanelKindSpec[] = []
  for (const item of r.kinds as unknown[]) {
    if (!item || typeof item !== 'object') continue
    const s = item as Record<string, unknown>
    const kind = String(s.kind || '').trim()
    if (!kind) continue
    kinds.push({
      kind,
      label: String(s.label || kind),
      trigger: (String(s.trigger || 'agent') as RightPanelKindSpec['trigger']) || 'agent',
      layout: String(s.layout || 'half'),
      required: Array.isArray(s.required) ? s.required.map(String) : [],
      optional: Array.isArray(s.optional) ? s.optional.map(String) : [],
      description: String(s.description || ''),
      example: (s.example as Record<string, unknown>) || undefined,
    })
  }
  if (!kinds.length) return null
  return {
    ok: true,
    kinds,
    autoOpenActions: Array.isArray(r.autoOpenActions) ? r.autoOpenActions.map(String) : [],
    readOnlyActions: Array.isArray(r.readOnlyActions) ? r.readOnlyActions.map(String) : [],
  }
}

/**
 * 取契约（带进程内缓存 + 并发去重）。
 * 后端不可达时返回内置表并把 ok 置 false，调用方据此决定是否提示。
 */
export async function loadRightPanelContract(): Promise<RightPanelContract> {
  if (cached) return cached
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const { apiUrlAsync } = await import('../api-client.js')
      // 【self-evolution-bot · 2026-11-20 · 第87轮 · 模型:deepseek-v4.1-flash-1017】
      // 改了什么：路径从 '/api/stage/right-stage/kinds' 改为 '/stage/right-stage/kinds'。
      // 为什么：apiUrlAsync() 自己会无条件拼 `${base}/api${path}`（见 api-client.js:105），
      // 再带 /api 就拼成 /api/api/stage/... → 后端 404 → 永远退回内置兜底表，
      // 整条「前端读后端契约」在生产里静默失效。这个 bug 是探针实测抓到的
      // （PROD_PREFETCH=["/api/api/stage/right-stage/kinds"]），不是看代码看出来的。
      const url = await apiUrlAsync('/stage/right-stage/kinds')
      const resp = await fetch(url)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const parsed = normalizeRightPanelContract(await resp.json())
      if (!parsed) throw new Error('bad payload')
      cached = parsed
      return parsed
    } catch {
      const fallback: RightPanelContract = {
        ok: false,
        kinds: BUILTIN_SPECS,
        autoOpenActions: [],
        readOnlyActions: [],
      }
      // 不缓存失败结果，下次调用还会重试后端
      return fallback
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** 同步取已缓存的契约（未加载则 null）。供同步校验路径使用。 */
export function getCachedRightPanelContract(): RightPanelContract | null {
  return cached
}

export function findKindSpec(kind: string): RightPanelKindSpec | null {
  const k = String(kind || '').trim()
  if (!k) return null
  const contract = cached || { kinds: BUILTIN_SPECS }
  return contract.kinds.find((s) => s.kind === k) || null
}

/**
 * 按契约返回缺失的必填字段（剥掉 data. 前缀）。
 * 契约里没有该 kind 时返回空数组（未知 kind 由渲染层兜底提示）。
 */
export function missingContractFields(
  kind: string,
  data: Record<string, unknown> | null | undefined,
): string[] {
  const spec = findKindSpec(kind)
  if (!spec) return []
  const payload = data && typeof data === 'object' ? data : {}
  const missing: string[] = []
  for (const field of specToRequiredFields(spec)) {
    if (!String(payload[field] ?? '').trim()) missing.push(field)
  }
  return missing
}

/** 给用户看的「这个面板缺什么」一句话提示。 */
export function describeMissingFields(kind: string, missing: string[]): string {
  const spec = findKindSpec(kind)
  const label = spec?.label || kind
  if (!missing.length) return `无法打开「${label}」：参数不全`
  return `无法打开「${label}」：缺少 ${missing.join(' / ')}`
}

/** 测试/调试用：清空缓存。 */
export function __resetRightPanelContractCache() {
  cached = null
  inflight = null
}

// 【self-evolution-bot · 2026-11-20 · 第87轮 · 模型:deepseek-v4.1-flash-1017】
// 改了什么：把契约预取从 lib/right-stage/index.ts 搬到本模块末尾，模块加载即触发一次。
// 为什么：原先把 `void import(...).then(loadRightPanelContract)` 写在 index.ts，
// 但**全仓没有任何生产代码 import 那个 barrel**（grep 结果为空），
// 于是 loadRightPanelContract() 一次都不会执行，getCachedRightPanelContract()
// 恒为 null —— platform-feedback.ts 里「优先读后端契约」的分支永远是兜底分支，
// 等于没接上。本模块被 open-progress-from-panel-set.ts / platform-feedback.ts
// 静态 import，而这两者被 create-chat-ws-on-event.ts 等生产链路引用，必定加载。
// 测试环境不预取（避免 vitest 里打网络 + 污染 __reset 语义）。
// 【self-evolution-bot · 2026-11-20 · 第87轮 · 模型:deepseek-v4.1-flash-1017】
// 实测（vitest 4.1.6）：import.meta.env.MODE === 'test'，
// 而 import.meta.env.TEST 的值是**字符串 "true"**，不是布尔 true ——
// 用 `!env.TEST` 判空在字符串上虽然恰好为 false（不预取），
// 但那是巧合，不是设计。改成按 MODE 判断，语义明确、不依赖取值类型。
if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.MODE !== 'test') {
  void loadRightPanelContract().catch(() => {
    /* 后端不可达时保持内置兜底表，不打扰用户 */
  })
}
