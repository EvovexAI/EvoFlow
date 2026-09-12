/**
 * 会话调试页 UI 文案：仅中文（第二参数保留兼容调用，不再展示）。
 * 日志字段英文取值旁的中文释义见 agent-trace-field-glossary.js。
 */

function e(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 纯文本（仅中文） */
export function biText(zh, _en) {
  return String(zh ?? '').trim()
}

/** 行内 HTML（仅中文） */
export function biHtml(zh, _en) {
  return `<span class="agent-trace-i18n agent-trace-i18n--mono" lang="zh-CN">${e(zh)}</span>`
}

/** 时间线类型徽标（仅中文） */
export function biBadgeHtml(zh, _en) {
  return `<span class="agent-trace-tl-badge-inner"><span class="agent-trace-tl-badge-zh" lang="zh-CN">${e(zh)}</span></span>`
}

export const AT = {
  pageTitleZh: '会话调试',
  pageTitleEn: 'Session debug',
  pageDescZh:
    '按 thread 查看模型请求、工具 I/O、协作周期、任务生命周期与 Token 调试；数据来自 Gateway',
  pageDescEn:
    'Per-thread model requests, tool I/O, collab cycle, task lifecycle & token debug via Gateway',

  liveRefreshZh: '每 3 秒刷新',
  liveRefreshEn: 'Refresh every 3s',
  reloadZh: '刷新',
  reloadEn: 'Reload',
  copyExportZh: '复制导出链接',
  copyExportEn: 'Copy export URL',
  openExportZh: '新标签打开导出',
  openExportEn: 'Open export in tab',

  filterPlaceholderZh: '筛选 thread_id…',
  filterPlaceholderEn: 'Filter thread_id…',

  /** 左侧 thread 列表数据来源说明（随 loadThreadList 切换） */
  threadListSourceSqliteZh:
    '左侧列表：SQLite 观测表 evoflow_obs_threads（按 last_seen_at）。',
  threadListSourceSqliteEn: 'Thread list: SQLite evoflow_obs_threads (last_seen_at).',
  threadListSourceLogZh:
    '左侧列表：Gateway 调试接口 GET /debug/agent-trace/recent-threads（日志索引，与右侧合并时间线同源）。',
  threadListSourceLogEn: 'Thread list: Gateway /debug/agent-trace/recent-threads (log index).',
  threadListSourceObsFallbackZh:
    '左侧列表：观测线程接口不可用，已回退为 recent-threads 日志索引。',
  threadListSourceObsFallbackEn: 'Observability threads API failed; fell back to recent-threads.',

  manualTidPlaceholderZh: '手动输入 thread_id',
  manualTidPlaceholderEn: 'Enter thread_id',
  openZh: '打开',
  openEn: 'Open',

  turnColumnZh: '对话轮次',
  turnColumnEn: 'Turns',
  /** 中栏顶部折叠：当前选中用户轮次总览 */
  turnOverviewSummaryZh: '本轮总览',
  turnOverviewSummaryEn: 'Turn overview',
  turnOverviewPickTurnZh: '请选择左侧轮次',
  turnOverviewPickTurnEn: 'Select a turn on the left',

  /** 用户当前轮次内：某次模型交互折叠区标题（非用户对话「轮」，而是本轮里第几次调模型） */
  modelCycleFoldNthZh: (n) => `第 ${n} 次模型交互`,
  modelCycleFoldNthEn: (n) => `Model interaction #${n}`,
  /** 整轮尚无 model_cycles（仅有调用前日志）时的单折叠标题 */
  modelCycleFoldTimelineOnlyZh: '本轮时间线',
  modelCycleFoldTimelineOnlyEn: 'This turn timeline',
  modelCycleFoldMetaZh: (nodes) => `${Number(nodes)} 个节点`,
  modelCycleFoldMetaEn: (nodes) => `${Number(nodes)} nodes`,
  /** 折叠 summary 主标题下一行：成因（非 JSON） */
  modelCycleFoldCauseUserZh: (text) => `用户问题：${text}`,
  modelCycleFoldCauseUserEn: (text) => `User: ${text}`,
  modelCycleFoldCauseToolZh: (name, hint) =>
    hint ? `因「${name}」工具返回：${hint}` : `因「${name}」工具返回触发本次模型交互`,
  modelCycleFoldCauseToolEn: (name, hint) =>
    hint ? `After tool «${name}»: ${hint}` : `Triggered by tool «${name}»`,
  /** 折叠标题上方的摘要条（与 LangGraph ui_messages 第 N 条 AI 对齐，仅供参考） */
  modelCycleBannerScenarioZh: '场景',
  modelCycleBannerScenarioEn: 'Scenarios',
  modelCycleBannerToolsZh: '工具',
  modelCycleBannerToolsEn: 'Tools',
  modelCycleBannerTokenInZh: 'Token 输入',
  modelCycleBannerTokenInEn: 'Tokens in',
  modelCycleBannerTokenOutZh: '输出',
  modelCycleBannerTokenOutEn: 'out',
  modelCycleBannerTokenNAZh: '—',
  modelCycleBannerTokenNAEn: '—',

  toolbarPickZh: '请选择左侧会话或输入 thread_id。',
  toolbarPickEn: 'Pick a thread on the left or enter thread_id.',

  detailEyebrowZh: '闭环时间线',
  detailEyebrowEn: 'Closed-loop timeline',
  detailTitleDefaultZh: '本轮追踪',
  detailTitleDefaultEn: 'This turn',

  rawSectionZh: '原始日志 · 按类别平铺',
  rawSectionEn: 'Raw logs · by category',

  summaryEyebrowZh: '会话摘要',
  summaryEyebrowEn: 'Session summary',
  threadIdLabelZh: '当前会话 thread_id',
  threadIdLabelEn: 'Current thread_id',

  sourcesSummaryZh: '查看合并来源路径（日志 / LangGraph）',
  sourcesSummaryEn: 'Merged source paths (logs / LangGraph)',

  timelineHintSummaryZh: '时间线字段说明（conversation_turns）',
  timelineHintSummaryEn: 'Timeline schema notes (conversation_turns)',

  timelineLegendZh:
    '节点按时间排序，覆盖本轮窗口内的用户输入、协作、任务状态、模型调度、厂商请求（含提示词与 payload）、工具入参与响应，形成闭环。',
  timelineLegendEn:
    'Nodes are time-ordered within this turn: user, collab, lifecycle, scheduling, vendor HTTP (prompt + payload), tool I/O — a closed loop.',

  timelineEmptyZh: '暂无时间线事件',
  timelineEmptyEn: 'No timeline events',

  timelineFootZh: (n) =>
    `共 ${n} 个时间节点 · 详情默认折叠，展开可查看 JSON、提示词与工具入出参`,
  timelineFootEn: (n) =>
    `${n} nodes · Details collapsed by default; expand for JSON, prompts & tool I/O`,

  truncatedZh: '…（已截断）',
  truncatedEn: '… (truncated)',

  jsonModalOpenZh: '在弹窗中查看完整 JSON',
  jsonModalOpenEn: 'Open full JSON',

  noUserTextZh: '（无用户文本快照）',
  noUserTextEn: '(No user text snapshot)',

  noTurnAggregateZh: '暂无对话轮次聚合（缺少回合追踪日志或尚无快照）。',
  noTurnAggregateEn: 'No conversation_turns aggregate (missing round trace or no snapshot).',

  noSuchTurnZh: '所选轮次不存在（数据可能已更新）。请从中间栏「对话轮次」重新选择。',
  noSuchTurnEn: 'Turn not found (data may have changed). Re-pick a turn in the middle column.',

  pickSessionZh: '请先选择左侧会话',
  pickSessionEn: 'Select a thread on the left',

  loadFailedZh: '加载失败，请点击「刷新」重试',
  loadFailedEn: 'Load failed — tap Reload',

  noTurnDataZh: '暂无轮次数据',
  noTurnDataEn: 'No turn data',
  needRoundLogZh: '需回合追踪日志',
  needRoundLogEn: 'Needs lead_agent_round_trace',

  modelCallsMetaZh: (n) => `${n} 次模型调用`,
  modelCallsMetaEn: (n) => `${n} model call(s)`,

  noThreadZh: '未选择 thread_id',
  noThreadEn: 'No thread_id selected',
  loadingZh: '加载中…',
  loadingEn: 'Loading…',
  loadFailedStatusZh: '加载失败',
  loadFailedStatusEn: 'Load failed',

  chooseSessionHintZh: '选择左侧带调试日志的会话，或输入 thread_id。',
  chooseSessionHintEn: 'Choose a thread with debug logs, or enter thread_id.',

  noDetailZh: '暂无轮次详情',
  noDetailEn: 'No turn detail',

  /** Tab: zh, en */
  tabs: {
    collab: ['协作周期', 'Collab cycle'],
    payload: ['模型请求', 'Model requests'],
    round: ['回合追踪', 'Round trace'],
    tools: ['工具 I/O', 'Tool I/O'],
    lifecycle: ['任务生命周期', 'Task lifecycle'],
    tps: ['任务进度快照', 'Task snapshot'],
    tokens: ['Token 用量', 'Token usage'],
    claude: ['Claude 会话', 'Claude sessions'],
    lg: ['LangGraph', 'LangGraph'],
  },

  summaryClaudeSessionsZh: 'Claude 会话',
  summaryClaudeSessionsEn: 'Claude sessions',
  claudeSessionsEmptyZh: '未从工具记录或任务快照解析到 claude_session_id（或尚未产生会话）。',
  claudeSessionsEmptyEn: 'No claude_session_id from tool rows / task snapshot yet.',
  claudeSessionsMissingFileZh: '无日志文件',
  claudeSessionsMissingFileEn: 'Log file missing',

  kinds: {
    user: ['用户', 'User'],
    collab: ['协作', 'Collab'],
    lifecycle: ['任务状态', 'Task state'],
    model_call: ['模型调度', 'Model step'],
    model_http: ['厂商请求', 'Vendor HTTP'],
    tool: ['工具', 'Tool'],
    round: ['回合追踪', 'Round trace'],
  },

  detailKeys: {
    activatedScenariosZh: '激活场景',
    activatedScenariosEn: 'activated_scenarios',
    turnSnapshotZh: '回合快照原始行',
    turnSnapshotEn: 'turn_snapshot row',
    systemPromptZh: '系统提示词（摘要）',
    systemPromptEn: 'system prompt (preview)',
    systemPromptFullZh: '系统提示词',
    systemPromptFullEn: 'system prompt',
    fullPayloadZh: '模型请求体（JSON）',
    fullPayloadEn: 'Model request body (JSON)',
    modelRecordMetaZh: '落盘元数据（除请求体外）',
    modelRecordMetaEn: 'Logged metadata (excluding request body)',
    modelRowZh: 'model_request_payload 完整记录',
    modelRowEn: 'full model_request_payload row',
    toolInputZh: '工具入参',
    toolInputEn: 'tool input',
    toolOutputZh: '工具出参',
    toolOutputEn: 'tool output',
    toolRowZh: 'tool_call_io 完整记录',
    toolRowEn: 'full tool_call_io row',
    rawJsonZh: '原始 JSON',
    rawJsonEn: 'raw JSON',
    vendorResponseZh: '模型响应（LangChain / 厂商结果）',
    vendorResponseEn: 'Model response',
    vendorRequestFullZh: '完整厂商请求体（未截断）',
    vendorRequestFullEn: 'Full vendor request body',
  },

  meta: {
    stageZh: '阶段',
    stageEn: 'Stage',
    /** 厂商请求卡片：按 user 角色条数估算多轮对话轮次（非 API messages 数组总长度） */
    contextTurnsZh: '上下文轮次数量',
    contextTurnsEn: 'Context turns (user msgs)',
    modelIdZh: '模型 ID',
    modelIdEn: 'Model ID',
    thinkingEnabledZh: '是否开启思考',
    thinkingEnabledEn: 'Thinking',
    thinkingYesZh: '是',
    thinkingYesEn: 'Yes',
    thinkingNoZh: '否',
    thinkingNoEn: 'No',
    thinkingUnknownZh: '未知',
    thinkingUnknownEn: 'Unknown',
    /** 模型请求 payload 中声明的 tools（OpenAI 风格） */
    requestToolsListZh: '工具列表',
    requestToolsListEn: 'Tools in request',
    msgCountZh: '消息条数',
    msgCountEn: 'Messages',
    sysPromptDetectedZh: '检出系统提示',
    sysPromptDetectedEn: 'System prompt detected',
    userMsgPreviewZh: '用户消息预览',
    userMsgPreviewEn: 'User message preview',
    vendorRoundtripLatencyZh: '观测往返耗时',
    vendorRoundtripLatencyEn: 'Observed round-trip latency',
    invocationKindZh: '用途',
    invocationKindEn: 'Invocation kind',
  },

  /** 时间线：发往厂商/模型的 HTTP 请求卡片主标题 */
  modelHttpDebugTitleZh: '模型请求',
  modelHttpDebugTitleEn: 'Model request',

  /** 厂商请求卡片：说明落盘范围（请求体 vs 未落盘的 HTTP 响应） */
  modelHttpVendorNoteZh:
    '说明：此处来自 model_request_payload 落盘，含发往模型的请求体（可能经截断/脱敏）。厂商 HTTP 响应全文未写入该日志；用量与部分元数据可在下方「原始日志」的「Token 调试」等标签中查看。',
  modelHttpVendorNoteEn:
    'This card reflects model_request_payload logs (outgoing request body; may be truncated/redacted). Raw HTTP response bodies are not written there; see Raw logs → Token debug for usage/metadata.',

  modelHttpHasResponseShortZh: '已关联 model_vendor_roundtrip 响应',
  modelHttpHasResponseShortEn: 'Linked model_vendor_roundtrip response',

  modelHttpVendorNoteWithResponseZh:
    '请求体来自 model_request_payload 落盘；下方「模型响应」来自同目录 model_vendor_roundtrip.jsonl（与观测 SQLite vendor_roundtrip 同源写入）。',
  modelHttpVendorNoteWithResponseEn:
    'Request body from model_request_payload logs; model response below is merged from model_vendor_roundtrip.jsonl (same pipeline as observability vendor_roundtrip).',

  prefixes: {
    collabZh: '协作',
    collabEn: 'Collab',
    lifecycleZh: '任务生命周期',
    lifecycleEn: 'Lifecycle',
    modelCallZh: '模型调度',
    modelCallEn: 'Model',
    modelHttpZh: '厂商请求',
    modelHttpEn: 'HTTP',
    toolZh: '工具',
    toolEn: 'Tool',
    roundZh: '回合追踪',
    roundEn: 'Round',
  },

  subtitles: {
    toolsInTurnZh: (n) => `附带工具 ${n} 个`,
    toolsInTurnEn: (n) => `Tools attached: ${n}`,
  },

  /** 系统提示词 summary 右侧总字符（JS .length，UTF-16 码元） */
  systemPromptCharCountZh: (n) => `共 ${n} 字符`,
  systemPromptCharCountEn: (n) => `${n} characters`,

  /** 多段系统提示（instructions / system / 多条 system 消息）之间的分隔标题 */
  vendorSystemPromptSegZh: (i, tot) => `──────── 系统提示 · 第 ${i}/${tot} 段 ────────`,
  vendorSystemPromptSegEn: (i, tot) => `──────── System prompt · part ${i}/${tot} ────────`,
  vendorSystemPromptNoneZh:
    '未检出系统提示：请求体中无 instructions、顶层 system 或 role=system 消息（完整内容见下方 JSON）。',
  vendorSystemPromptNoneEn:
    'No system prompt: no instructions, top-level system, or role=system messages (see JSON below).',

  jsonTableColZh: '内容（展开查看 JSON）',
  jsonTableColEn: 'Content (expand for JSON)',

  lifecycleEmptyZh:
    '暂无 task_lifecycle_trace（需后端写入 logs/debug/threads/&lt;id&gt;/task_lifecycle_trace.log）',
  lifecycleEmptyEn: 'No task_lifecycle_trace (backend must write JSONL per thread)',

  rawAfterLoadZh: '加载会话数据后显示',
  rawAfterLoadEn: 'Load a session to show data',

  noDataZh: '暂无数据',
  noDataEn: 'No data',

  apiDisabledZh:
    '会话调试 API 已关闭：请确认 Gateway 未设置 <code>EVOFLOW_DEBUG_TRACE_UI=0</code>，然后重启。',
  apiDisabledEn:
    'Session debug API is disabled: ensure Gateway does not set <code>EVOFLOW_DEBUG_TRACE_UI=0</code>, then restart.',

  debugOffZh:
    '会话调试已关闭：请移除 Gateway 上的 <code>EVOFLOW_DEBUG_TRACE_UI=0</code> 并重启。',
  debugOffEn:
    'Session debug is off: remove <code>EVOFLOW_DEBUG_TRACE_UI=0</code> from the Gateway env and restart.',

  lgFetchFailZh: 'LangGraph runs 拉取失败（不影响本地日志表）：',
  lgFetchFailEn: 'LangGraph runs fetch failed (local logs still OK): ',

  emptyThreadsZh: '暂无日志目录或未启用调试',
  emptyThreadsEn: 'No debug threads or logging disabled',

  /** 中栏轮次按钮默认文案 */
  turnLabelNthZh: (n) => `第 ${n} 轮`,
  turnLabelNthEn: (n) => `Turn ${n}`,

  /** 时间线 keyfacts 字段标签 */
  kf: {
    toolListZh: '工具列表',
    attachedToolsZh: '附带工具',
    attachedToolCountZh: '附带工具数',
    toolCountZh: '工具数',
    noneZh: '无',
    deferredToolsZh: '延迟加载工具',
    userInputZh: '用户输入',
    writePhaseZh: '写入阶段',
    targetPhaseZh: '目标阶段',
    sourceZh: '来源',
    requestToolListZh: '请求工具列表',
    lastMsgTypeZh: '最后消息类型',
    userPreviewZh: '用户预览',
    responseToolCallsZh: '返回 tool_calls',
    elapsedZh: '耗时',
    timeZh: '时间',
    aiPreviewZh: 'AI 预览',
    invalidToolCallsZh: '无效 tool_calls',
    finalAiToolCallsZh: '最终 AI tool_calls',
    finalAiPreviewZh: '最终 AI 预览',
    toolZh: '工具',
    resultTypeZh: '结果类型',
    resultPreviewZh: '结果预览',
    eventZh: '事件',
    statusZh: '状态',
    mainTaskZh: '主任务',
    subtaskZh: '子任务',
    unitCountZh: (n) => `${n} 个`,
  },

  /** 会话总览 metrics 行标签 */
  sum: {
    turnsZh: '对话轮次',
    modelStepsZh: '模型交互',
    collabRowsZh: '协作行',
    lifecycleRowsZh: '生命周期行',
    vendorRowsZh: '厂商请求行',
    roundRowsZh: '回合追踪行',
    toolCallsZh: '工具调用',
    graphRunsZh: '图运行',
    superstepLbZh: 'Superstep 下界',
    recursionLimitZh: '递归上限',
    mainTaskZh: '主任务',
    subtasksZh: '子任务',
    snapshotFailedZh: '快照失败',
    taskSnapshotZh: '任务快照',
    lgStateOkZh: 'LangGraph state 已拉取',
    lgStateFailZh: 'state 未拉取',
    tokenDebugZh: 'Token 调试',
    /** 本轮总览：耗时与 Token 合计 */
    turnWallZh: '本轮跨度',
    turnWallEn: 'Turn span',
    vendorLatencySumZh: '厂商调用耗时（合计）',
    vendorLatencySumEn: 'Vendor call latency (sum)',
    tokensInSumZh: '输入 Token（合计）',
    tokensInSumEn: 'Input tokens (sum)',
    tokensOutSumZh: '输出 Token（合计）',
    tokensOutSumEn: 'Output tokens (sum)',
  },

  obsUi: {
    loadingZh: '加载中…',
    noDataZh: '暂无数据',
    needObsZh: '观测数据不可用（请确认 Gateway 已启动）',
    obsConfigHintZh: '观测数据不可用（请确认 Gateway 已启动）',
    overviewLoadFailZh: 'SQLite 加载失败:',
    toolsLoadFailZh: 'SQLite 工具页加载失败:',
    modelsLoadFailZh: 'SQLite 模型页加载失败:',
    eventsCountZh: (n) => `${n} 条事件`,
    truncatedZh: '（已截断）',
  },
}
