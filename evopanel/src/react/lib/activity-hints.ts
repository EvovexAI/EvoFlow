/**
 * EvoFlow 运行状态提示话术
 * 根据当前活动类型和上下文，生成有趣、有用、定制化的提示文字
 */

// 工具调用话术池 - EvoFlow 定制版
const TOOL_HINTS: Record<string, string[]> = {
  // 文件操作
  'write_file': [
    '正在落盘代码… 📝',
    '敲键盘中，别催 🚀',
    '正在写文件，稍等片刻~',
    '代码在指尖流淌… ✨',
    'EvoFlow 正在创作中~',
  ],
  'read_file': [
    '翻阅文档中… 📖',
    '正在找文件…',
    '读取文件ing…',
    '翻翻看看有什么…',
  ],
  'terminal': [
    '跑命令中… 💻',
    '终端里正在执行…',
    '命令行已启动，正在跑~',
    '终端小哥在干活了~',
  ],
  'search': [
    '搜索信息中… 🔍',
    '正在查找…',
    '搜索一波~',
    '全网搜寻中…',
  ],
  
  // 子任务/协作
  'subagent': [
    '派单给同事了，等回复… 📨',
    '已派发任务，正在处理中~',
    '叫了个帮手，稍等~',
    '同事在赶来的路上…',
  ],
  'plan': [
    '制定计划中… 📋',
    '规划方案ing…',
    '正在拆解任务~',
    '大脑在画流程图…',
  ],
  
  // 工具执行
  'tool_call': [
    '工具执行中… 🔧',
    '正在调用工具…',
    '干活了干活了~',
    '工具箱已打开~',
  ],
  
  // 思考
  'think': [
    '思考中… 🤔',
    '大脑高速运转中…',
    '正在组织语言…',
    '想一下怎么回你~',
    '推理引擎启动中…',
  ],
  
  // 澄清
  'clarification': [
    '等你选择呢~ 🎯',
    '请选择一个选项吧',
    '需要你的决策~',
    '选一个？',
  ],
  
  // 审批
  'approval': [
    '等你批准… ✋',
    '请审批这个操作~',
    '需要确认一下',
  ],
  
  // 记忆整理
  'compacting': [
    '整理记忆碎片… 🧠',
    '正在归纳总结…',
    '回忆一波~',
    '把东西收一收~',
  ],
  
  // 重试
  'retrying': [
    '重来一次… 🔄',
    '重试中…',
    '再试一把~',
    '卷土重来~',
  ],
  
  // 默认
  'default': [
    '正在处理中… ⚡',
    '干活ing…',
    '稍等，正在执行~',
    'EvoFlow 在忙~',
  ]
}

// 思考/推理话术
const THINKING_HINTS: string[] = [
  '思考中… 🤔',
  '大脑高速运转中…',
  '正在组织语言…',
  '想一下怎么回你~',
  '推理引擎启动中…',
  'CPU 在燃烧… 🔥',
  '神经网络在放电~',
]

// 澄清/等待用户话术
const CLARIFICATION_HINTS: string[] = [
  '等你选择呢~ 🎯',
  '请选择一个选项吧',
  '需要你的决策~',
  '选一个？',
  '等你拍板~',
]

// 工具审批话术
const APPROVAL_HINTS: string[] = [
  '等你批准… ✋',
  '请审批这个操作~',
  '需要确认一下',
  '老板请签字~',
]

// 记忆整理话术
const COMPACTING_HINTS: string[] = [
  '整理记忆碎片… 🧠',
  '正在归纳总结…',
  '回忆一波~',
  '把东西收一收~',
  '大脑在归档…',
]

// 重试话术
const RETRYING_HINTS: string[] = [
  '重来一次… 🔄',
  '重试中…',
  '再试一把~',
  '卷土重来~',
  '再来一局~',
]

/**
 * 获取工具名称的友好显示
 */
export function getToolFriendlyName(toolName: string): string {
  const nameMap: Record<string, string> = {
    'write_file': '写文件',
    'read_file': '读文件',
    'terminal': '终端',
    'search': '搜索',
    'subagent': '子任务',
    'plan': '规划',
    'tool_call': '工具调用',
    'think': '思考',
    'clarification': '澄清',
    'approval': '审批',
    'compacting': '整理',
    'retry': '重试',
  }
  return nameMap[toolName] || toolName
}

/**
 * 获取工具执行时的随机话术
 */
export function getToolHint(toolName?: string): string {
  const pool = toolName ? (TOOL_HINTS[toolName] || TOOL_HINTS['default']) : TOOL_HINTS['default']
  return pool[Math.floor(Math.random() * pool.length)]
}

/**
 * 获取思考阶段的随机话术
 */
export function getThinkingHint(): string {
  return THINKING_HINTS[Math.floor(Math.random() * THINKING_HINTS.length)]
}

/**
 * 获取澄清阶段的随机话术
 */
export function getClarificationHint(): string {
  return CLARIFICATION_HINTS[Math.floor(Math.random() * CLARIFICATION_HINTS.length)]
}

/**
 * 获取审批阶段的随机话术
 */
export function getApprovalHint(): string {
  return APPROVAL_HINTS[Math.floor(Math.random() * APPROVAL_HINTS.length)]
}

/**
 * 获取整理记忆阶段的随机话术
 */
export function getCompactingHint(): string {
  return COMPACTING_HINTS[Math.floor(Math.random() * COMPACTING_HINTS.length)]
}

/**
 * 获取重试阶段的随机话术
 */
export function getRetryingHint(): string {
  return RETRYING_HINTS[Math.floor(Math.random() * RETRYING_HINTS.length)]
}

/**
 * 根据活动类型获取提示文字
 */
export function getActivityHint(
  activityKind: string,
  toolName?: string,
  toolPreview?: string
): string {
  const kind = (activityKind || 'idle').trim().toLowerCase()
  switch (kind) {
    case 'thinking':
      return getThinkingHint()
    case 'clarification':
      return getClarificationHint()
    case 'tool_approval':
      return getApprovalHint()
    case 'compacting':
      return getCompactingHint()
    case 'retrying':
      return getRetryingHint()
    case 'tools':
      // 如果有工具预览，优先显示工具名
      if (toolPreview) {
        return `执行 ${toolPreview}…`
      }
      return getToolHint(toolName)
    case 'idle':
      return ''
    default:
      return getToolHint(kind)
  }
}

/**
 * 获取活动类型标签
 */
export function getActivityLabel(activityKind: string): string {
  const kind = (activityKind || 'idle').trim().toLowerCase()
  const labels: Record<string, string> = {
    'thinking': '思考中',
    'tools': '执行工具',
    'clarification': '等待选择',
    'tool_approval': '待审批',
    'compacting': '整理记忆',
    'retrying': '重试中',
    'idle': '就绪',
  }
  return labels[kind] || '处理中'
}
