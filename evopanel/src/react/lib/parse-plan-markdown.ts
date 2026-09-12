/** Parse ``# Plan`` markdown (aligned with backend plan_subtasks_sync). */

const ANALYSIS_SECTION_HEADINGS = ['## Analysis', '## Flowchart', '## 分析图', '## 任务分析']

export type PlanStepField = {
  key: string
  label: string
  value: string
}

export type ParsedPlanStep = {
  ref: string
  shortName: string
  displayName: string
  fields: PlanStepField[]
  /** agent_code 或 markdown 中的执行人原文 */
  assignee: string
  /** 后端/子任务下发的中文展示名（优先于 assignee 解析） */
  assigneeDisplay?: string
  dependsOn: string[]
}

export type ParsedPlan = {
  goal: string
  flowchartMermaid: string
  steps: ParsedPlanStep[]
  validation: string[]
  openQuestions: string
}

const STEP_HEADER_RE = /^###\s+Step\s+(\d+)\s*:\s*(.+?)\s*$/i
const FIELD_RES: Array<{ key: string; label: string; re: RegExp }> = [
  { key: 'goal', label: '目标', re: /^\s*-\s*\*\*目标\*\*:\s*(.*)$/i },
  { key: 'inputs', label: '输入物', re: /^\s*-\s*\*\*输入物\*\*:\s*(.*)$/i },
  { key: 'outputs', label: '输出物', re: /^\s*-\s*\*\*输出物\*\*:\s*(.*)$/i },
  { key: 'acceptance', label: '验收标准', re: /^\s*-\s*\*\*验收标准\*\*:\s*(.*)$/i },
  { key: 'failure', label: '失败处理', re: /^\s*-\s*\*\*失败处理\*\*:\s*(.*)$/i },
  {
    key: 'assignee',
    label: '执行人',
    re: /^\s*-\s*\*\*(?:执行人|Assignee|Assigned agent)\*\*:\s*(.*)$/i,
  },
  { key: 'depends', label: '依赖', re: /^\s*-\s*\*\*依赖\*\*:\s*(.*)$/i },
]

function sectionBody(md: string, heading: string): string {
  const lines = String(md || '').split('\n')
  let inSection = false
  const out: string[] = []
  for (const line of lines) {
    const stripped = line.trim()
    if (stripped.startsWith(heading)) {
      inSection = true
      continue
    }
    if (inSection && stripped.startsWith('## ') && !stripped.startsWith('### ')) break
    if (inSection) out.push(line)
  }
  return out.join('\n').trim()
}

function parseGoal(md: string): string {
  const body = sectionBody(md, '## Goal')
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (t && !t.startsWith('#')) return t
  }
  return body.split('\n').map((l) => l.trim()).find(Boolean) || ''
}

function parseBulletList(md: string, heading: string): string[] {
  const body = sectionBody(md, heading)
  const items: string[] = []
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (!t) continue
    if (t.startsWith('- ')) items.push(t.replace(/^-\s*/, '').trim())
    else if (t.startsWith('* ')) items.push(t.replace(/^\*\s*/, '').trim())
    else if (items.length) items[items.length - 1] += ` ${t}`
  }
  return items.filter(Boolean)
}

function parseDepends(raw: string): string[] {
  const text = String(raw || '').trim()
  if (!text || text === '无') return []
  return text
    .split(/[,，、\s]+/)
    .map((p) => p.replace(/^step\s*/i, '').trim())
    .filter(Boolean)
}

function stripMermaidFences(raw: string): string {
  let text = String(raw || '').trim()
  if (!text) return ''
  const fenced = /^```(?:mermaid)?\s*\n?([\s\S]*?)```\s*$/i.exec(text)
  if (fenced) text = String(fenced[1] || '').trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:mermaid)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim()
  }
  return text
}

function extractMermaid(md: string): string {
  const src = String(md || '')
  const fenced = /```mermaid\s*\n([\s\S]*?)```/gi
  let m: RegExpExecArray | null
  while ((m = fenced.exec(src)) !== null) {
    const body = stripMermaidFences(String(m[1] || ''))
    if (body) return body
  }
  for (const heading of ANALYSIS_SECTION_HEADINGS) {
    const fromSection = extractMermaidFromSection(sectionBody(md, heading))
    if (fromSection) return fromSection
  }
  return ''
}

function extractMermaidFromSection(flowSection: string): string {
  const section = stripMermaidFences(flowSection)
  if (!section) return ''
  const lines = flowSection.split('\n')
  const block: string[] = []
  for (const line of lines) {
    const t = line.trim()
    if (!t || t.startsWith('```')) continue
    if (/^(?:flowchart|graph)\s+(TD|LR|RL|BT)\b/i.test(t)) {
      block.push(t.replace(/^graph\b/i, 'flowchart'))
      continue
    }
    if (/^sequenceDiagram\b/i.test(t)) {
      block.push(t)
      continue
    }
    if (
      block.length &&
      (t.includes('-->') ||
        t.includes('==>') ||
        t.includes('->>') ||
        t.includes('-.->') ||
        t.includes('---') ||
        /^[A-Za-z0-9_]+\s*[[(]/.test(t) ||
        /^participant\s+/i.test(t))
    ) {
      block.push(t)
    }
  }
  if (block.length) return block.join('\n').trim()
  if (
    (/-->|==>|->>|-->>|-.->/.test(section) || /^sequenceDiagram\b/im.test(section)) &&
    /^(?:flowchart|graph|sequenceDiagram)\b/im.test(section)
  ) {
    return section
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.replace(/^graph\b/i, 'flowchart'))
      .join('\n')
  }
  return ''
}

export function parsePlanMarkdown(markdown: string): ParsedPlan {
  const md = String(markdown || '').trim()
  const stepsSection = sectionBody(md, '## Steps')
  const blocks: string[] = []
  let current: string[] = []
  for (const line of stepsSection.split('\n')) {
    if (STEP_HEADER_RE.test(line.trim())) {
      if (current.length) blocks.push(current.join('\n'))
      current = [line]
    } else if (current.length) {
      current.push(line)
    }
  }
  if (current.length) blocks.push(current.join('\n'))

  const steps: ParsedPlanStep[] = []
  for (const block of blocks) {
    const lines = block.split('\n')
    const header = lines[0]?.trim() || ''
    const hm = STEP_HEADER_RE.exec(header)
    if (!hm) continue
    const ref = String(hm[1])
    const shortName = String(hm[2] || '').trim()
    const fieldMap = new Map<string, string>()
    for (const bodyLine of lines.slice(1)) {
      for (const { key, re } of FIELD_RES) {
        const fm = re.exec(bodyLine)
        if (fm) fieldMap.set(key, String(fm[1] || '').trim())
      }
    }
    const orderedKeys = ['goal', 'inputs', 'outputs', 'acceptance', 'failure', 'assignee', 'depends']
    const fields: PlanStepField[] = []
    for (const key of orderedKeys) {
      const spec = FIELD_RES.find((f) => f.key === key)
      const val = fieldMap.get(key)
      if (spec && val) fields.push({ key, label: spec.label, value: val })
    }
    steps.push({
      ref,
      shortName,
      displayName: shortName ? `Step ${ref}: ${shortName}` : `Step ${ref}`,
      fields,
      assignee: fieldMap.get('assignee') || '',
      dependsOn: parseDepends(fieldMap.get('depends') || ''),
    })
  }

  return {
    goal: parseGoal(md),
    flowchartMermaid: extractMermaid(md),
    steps,
    validation: parseBulletList(md, '## Validation'),
    openQuestions: sectionBody(md, '## Open Questions').split('\n').map((l) => l.trim()).filter(Boolean).join('\n') || '无',
  }
}

function mermaidSafeLabel(text: string): string {
  return String(text || '')
    .trim()
    .replace(/"/g, "'")
    .replace(/[\]#;]/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 96)
}

function stepRefKey(step: ParsedPlanStep | Record<string, unknown>, idx: number): string {
  const s = step as Record<string, unknown>
  const raw = s.ref ?? s.step_ref ?? s.stepRef ?? s.id ?? idx + 1
  return String(raw).trim() || String(idx + 1)
}

function stepDependsOn(step: ParsedPlanStep | Record<string, unknown>): string[] {
  const s = step as Record<string, unknown>
  const deps = s.dependsOn ?? s.depends_on ?? s.depends_refs
  if (!Array.isArray(deps)) return []
  return deps.map((d) => String(d).replace(/^step\s*/i, '').trim()).filter(Boolean)
}

function stepShortLabel(step: ParsedPlanStep | Record<string, unknown>, ref: string): string {
  const s = step as Record<string, unknown>
  const name = String(
    s.shortName ?? s.short_name ?? s.name ?? s.displayName ?? s.display_name ?? `Step ${ref}`,
  ).trim()
  return mermaidSafeLabel(name)
}

function escapeMermaidQuotedLabel(text: string): string {
  return String(text || '')
    .replace(/\\+/g, '/')
    .replace(/\/+/g, '/')
    .replace(/"/g, "'")
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 节点标签内双引号、反斜杠路径、单引号 stadium 语法等会破坏 mermaid 解析，统一规范化 */
export function sanitizeMermaidNodeLabels(code: string): string {
  let out = String(code || '')
  // stadium / legacy: node['label with (parens)'] → node["label with (parens)"]
  out = out.replace(/(\b[A-Za-z_][\w]*)\['([^']*)'\]/g, (_m, id, label) => {
    return `${id}["${escapeMermaidQuotedLabel(label)}"]`
  })
  // rectangle with inner double quotes only → normalize quotes
  out = out.replace(/(\b[A-Za-z_][\w]*)\["([^"]*)"\]/g, (_m, id, label) => {
    return `${id}["${escapeMermaidQuotedLabel(label)}"]`
  })
  // bare rectangle [label] (no surrounding quotes)
  out = out.replace(/(\b[A-Za-z_][\w]*)\[([^\]"'][^\]]*)\]/g, (_m, id, label) => {
    return `${id}["${escapeMermaidQuotedLabel(label)}"]`
  })
  // fallback: any remaining [...] with quotes swapped
  out = out.replace(/(\b[A-Za-z_][\w]*)\[([^\]]*)\]/g, (_m, id, label) => {
    const raw = String(label || '').trim()
    if (raw.startsWith('"') && raw.endsWith('"')) {
      return `${id}["${escapeMermaidQuotedLabel(raw.slice(1, -1))}"]`
    }
    return `${id}["${escapeMermaidQuotedLabel(raw)}"]`
  })
  out = out.replace(/(\b[A-Za-z_][\w]*)\("([^"]*)"\)/g, (_m, id, label) => {
    return `${id}("${escapeMermaidQuotedLabel(label)}")`
  })
  // subgraph 中文标题：subgraph 项目结构 → subgraph 项目结构["项目结构"]
  out = out.replace(/^(\s*)subgraph\s+(.+?)\s*$/gm, (_m, indent, rest) => {
    const tail = String(rest || '').trim()
    if (!tail || tail.includes('[')) return _m
    const id = tail.replace(/[^\w\u4e00-\u9fff]+/g, '_').replace(/^_+|_+$/g, '') || 'sg'
    return `${indent}subgraph ${id}["${escapeMermaidQuotedLabel(tail)}"]`
  })
  return out
}

/** 无显式 flowchart 时，根据步骤依赖生成 mermaid */
export function flowchartMermaidFromSteps(
  steps: ParsedPlanStep[] | Array<Record<string, unknown>>,
): string {
  if (!Array.isArray(steps) || steps.length === 0) return ''
  const nodes: string[] = []
  const edges: string[] = []
  const refs: string[] = []
  for (let i = 0; i < steps.length; i++) {
    const ref = stepRefKey(steps[i], i)
    refs.push(ref)
    const nid = `S${ref}`
    const label = stepShortLabel(steps[i], ref)
    nodes.push(`    ${nid}[Step${ref}: ${label}]`)
  }
  let edgeCount = 0
  for (let i = 0; i < steps.length; i++) {
    const ref = refs[i]
    const deps = stepDependsOn(steps[i])
    for (const d of deps) {
      if (!refs.includes(d) && d !== ref) continue
      edges.push(`    S${d} --> S${ref}`)
      edgeCount++
    }
  }
  if (edgeCount === 0 && steps.length > 1) {
    for (let i = 1; i < refs.length; i++) {
      edges.push(`    S${refs[i - 1]} --> S${refs[i]}`)
    }
  }
  return `flowchart TD\n${nodes.join('\n')}\n${edges.join('\n')}`
}

export function resolvePlanFlowchartMermaid(
  explicit: string,
  steps: ParsedPlanStep[] | Array<Record<string, unknown>>,
): { code: string; synthesized: boolean } {
  const trimmed = sanitizeMermaidNodeLabels(String(explicit || '').trim())
  if (trimmed) return { code: trimmed, synthesized: false }
  const syn = flowchartMermaidFromSteps(steps)
  return { code: syn, synthesized: !!syn }
}
