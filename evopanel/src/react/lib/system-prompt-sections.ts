export type SystemPromptSection = {
  id: string
  tag: string
  label: string
  text: string
}

const TAG_LABELS: Record<string, string> = {
  employee_chat_frame: '员工对话框架',
  identity: '身份',
  communication: '沟通方式',
  contract: '职责契约',
  habits: '习惯 / Soul',
  soul: 'Soul',
  agent_system_prompt: '角色系统提示词',
  skills: '技能',
  skill_system: '技能系统',
  workspace: '工作区',
  memory: '记忆',
  mission_state: '任务状态',
  session_mind_map: '会话脑图',
  session_mode_policy: '会话模式策略',
  intent_modules: '意图模块',
  tool_catalog: '工具目录',
  plan_workflow: '计划流程',
  plan_runtime_stage: '计划运行阶段',
  committed_plan: '已确认计划',
  subagent_system: '子代理',
  evoflow_live_collab_meta: '协作元数据',
  evoflow_live_committed_plan: '协作已确认计划',
}

const BLOCK_RE =
  /<([a-zA-Z_][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g

export function labelForSystemPromptTag(tag: string): string {
  const key = String(tag || '').trim().toLowerCase()
  return TAG_LABELS[key] || key || '片段'
}

/**
 * Split a flattened system prompt into labeled XML-ish assembly blocks
 * for debug visualization (employee / lead agent prompts).
 */
export function splitSystemPromptSections(raw: string): SystemPromptSection[] {
  const text = String(raw || '')
  if (!text.trim()) return []

  const sections: SystemPromptSection[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  const re = new RegExp(BLOCK_RE.source, 'g')
  let idx = 0

  while ((match = re.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index).trim()
    if (before) {
      sections.push({
        id: `preamble-${idx}`,
        tag: '_preamble',
        label: sections.length === 0 ? '前言 / 未标记' : '间隔文本',
        text: before,
      })
      idx += 1
    }
    const full = match[0]
    const tag = String(match[1] || '').trim()
    sections.push({
      id: `block-${idx}-${tag || 'x'}`,
      tag: tag || 'block',
      label: labelForSystemPromptTag(tag),
      text: full.trim(),
    })
    idx += 1
    lastIndex = match.index + full.length
  }

  const tail = text.slice(lastIndex).trim()
  if (tail) {
    const onlyTail = sections.length === 0
    sections.push({
      id: onlyTail ? 'full' : `tail-${idx}`,
      tag: onlyTail ? '_full' : '_tail',
      label: onlyTail ? '全文' : '结尾 / 未标记',
      text: tail,
    })
  }

  if (!sections.length && text.trim()) {
    return [
      {
        id: 'full',
        tag: '_full',
        label: '全文',
        text: text.trim(),
      },
    ]
  }
  return sections
}
