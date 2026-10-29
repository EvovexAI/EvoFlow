/** Resolve employee 任务总结 text from a task row (API may use several legacy keys). */
export function taskSummaryText(task) {
  if (!task || typeof task !== 'object') return ''
  return String(
    task.summary ||
      task.result_summary ||
      task.result_text ||
      task.task_report ||
      task.result ||
      task.execution_result ||
      task.outcome ||
      '',
  ).trim()
}

/** One-line preview for list/card surfaces. */
export function taskSummaryPreview(task, maxLen = 96) {
  const text = taskSummaryText(task)
  if (!text) return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= maxLen) return flat
  return `${flat.slice(0, Math.max(1, maxLen - 1))}…`
}

const OUTPUT_TYPE_ZH = {
  file: '文件',
  url: '链接',
  text: '文本',
  other: '其他',
}

/** Source / binary code — never show as 本岗交付物 (docs/reports only). */
const CODE_OUTPUT_EXTS = new Set([
  '.py',
  '.pyi',
  '.pyw',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.rs',
  '.go',
  '.java',
  '.kt',
  '.kts',
  '.swift',
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.h',
  '.hpp',
  '.cs',
  '.php',
  '.rb',
  '.scala',
  '.vue',
  '.svelte',
  '.wasm',
  '.so',
  '.dll',
  '.dylib',
  '.o',
  '.a',
  '.class',
  '.jar',
  '.exe',
  '.bin',
  '.pyc',
  '.pyo',
])

const DELIVERABLE_FILE_EXTS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.pdf',
  '.html',
  '.htm',
  '.csv',
  '.tsv',
  '.json',
  '.yaml',
  '.yml',
  '.docx',
  '.doc',
  '.xlsx',
  '.xls',
  '.pptx',
  '.ppt',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.mp4',
  '.webm',
  '.mp3',
  '.wav',
])

export function isCodeOutputPath(value) {
  const name = String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .split('?')[0]
  if (!name) return false
  const base = name.split('/').pop() || name
  const dot = base.lastIndexOf('.')
  if (dot < 0) return false
  return CODE_OUTPUT_EXTS.has(base.slice(dot).toLowerCase())
}

function outputPathExt(value) {
  const name = String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .split('?')[0]
  const base = name.split('/').pop() || name
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(dot).toLowerCase() : ''
}

/** Strip agent typos: backticks, quotes, trailing punctuation around paths. */
export function sanitizeDeliverablePath(value) {
  let s = String(value || '').trim()
  if (!s) return ''
  while (s.length >= 2 && ((s[0] === '`' && s.endsWith('`')) || (s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    s = s.slice(1, -1).trim()
  }
  s = s.replace(/^[`'"“”‘’]+/, '').replace(/[`'"“”‘’,.;:，。；：]+$/, '').trim()
  return s
}

/** Basename key so abs/rel/`abs paths of the same file collapse. */
function deliverableBasenameKey(value) {
  const cleaned = sanitizeDeliverablePath(value).replace(/\\/g, '/').split('?')[0]
  if (!cleaned) return ''
  const base = cleaned.split('/').filter(Boolean).pop() || cleaned
  return base.toLowerCase()
}

/** Normalize for dedupe: drop leading repo folder like ContentOS/. */
function deliverableDedupeKey(value) {
  let p = sanitizeDeliverablePath(value)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
  p = p.replace(/^(contentos|evoflow)\//i, '')
  const base = deliverableBasenameKey(p)
  // Prefer basename for files so abs/rel/dirty variants merge.
  if (base && /\.[a-z0-9]{1,8}$/i.test(base)) return `base:${base}`
  return p.toLowerCase()
}

function deliverableQualityScore(item) {
  if (!item || typeof item !== 'object') return 0
  const value = sanitizeDeliverablePath(item.value)
  const label = String(item.label || '').trim()
  let score = 0
  const meta = item._resolve_meta
  if (meta && typeof meta === 'object') {
    if (meta.found === true) score += 100
    if (meta.absolute) score += 40
  }
  if (label) score += 35
  if (/★|最终交付|汇总报告|验收/.test(label)) score += 50
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('/')) score += 30
  if (/\/outputs\//i.test(value) || /^outputs\//i.test(value)) score += 12
  if (item.source_label) score += 8
  score += Math.min(24, Math.floor(value.length / 16))
  return score
}

/**
 * Keep docs/media/urls for 交付物 UI; drop source-code paths.
 * Also dedupe the same file listed as abs / rel / backtick-prefixed.
 */
export function filterDeliverableOutputs(items) {
  const list = Array.isArray(items) ? items : []
  const out = []
  const indexByKey = new Map()
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const typ = String(item.type || 'file').trim().toLowerCase() || 'file'
    const value = sanitizeDeliverablePath(item.value)
    if (!value) continue
    if (typ === 'url' || /^https?:\/\//i.test(value)) {
      const key = `url:${value}`
      if (indexByKey.has(key)) continue
      indexByKey.set(key, out.length)
      out.push({ ...item, type: 'url', value })
      continue
    }
    if (typ === 'text') {
      const key = `text:${value.slice(0, 120)}`
      if (indexByKey.has(key)) continue
      indexByKey.set(key, out.length)
      out.push({ ...item, type: 'text', value })
      continue
    }
    if (isCodeOutputPath(value)) continue
    const ext = outputPathExt(value)
    if (ext && !DELIVERABLE_FILE_EXTS.has(ext)) continue
    const key = deliverableDedupeKey(value)
    const next = { ...item, type: typ === 'other' ? 'file' : typ, value }
    if (indexByKey.has(key)) {
      const idx = indexByKey.get(key)
      const prev = out[idx]
      if (deliverableQualityScore(next) > deliverableQualityScore(prev)) {
        out[idx] = {
          ...prev,
          ...next,
          label: next.label || prev.label,
          source_label: next.source_label || prev.source_label,
          _resolve_meta: next._resolve_meta || prev._resolve_meta,
        }
      } else if (!prev.label && next.label) {
        out[idx] = { ...prev, label: next.label }
      } else if (!prev.source_label && next.source_label) {
        out[idx] = { ...prev, source_label: next.source_label }
      }
      continue
    }
    indexByKey.set(key, out.length)
    out.push(next)
  }
  return out
}

/** Basenames like ``_outcome_report_Step4`` / ``_summary_report`` are worker
 * bookkeeping drops, not user deliverables — demote to process artifacts. */
const PROCESS_ARTIFACT_BASENAME_RE = /^_(?:outcome_report|summary|report|review_outcome)[\w-]*/i

export function isProcessArtifactBasename(value) {
  const name = String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .split('?')[0]
    .split('/')
    .pop() || ''
  return PROCESS_ARTIFACT_BASENAME_RE.test(name)
}

/**
 * Split resolved deliverables into { primary, process }:
 * - ``primary``: files the user is meant to consume (final deliverables)
 * - ``process``: intermediate review/analysis reports + worker bookkeeping drops
 *   (e.g. ``_outcome_report_*``), worth keeping reachable but not headline.
 */
export function splitDeliverableOutputs(items) {
  const list = Array.isArray(items) ? items : []
  const primary = []
  const process = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const value = String(item.value || '').trim()
    const label = String(item.label || '').trim()
    const looksProcess =
      isProcessArtifactBasename(value) ||
      isProcessArtifactBasename(label) ||
      /^outcome_report$/i.test(String(item.key || '').trim()) ||
      /^step[0-9_-]*outcome$/i.test(String(item.key || '').trim())
    if (looksProcess) process.push(item)
    else primary.push(item)
  }
  return { primary, process }
}

const PREVIEWABLE_EXT_RE = /\.(md|markdown|txt|json|ya?ml|csv|html?|py|js|ts|tsx|jsx|css|xml|log)$/i

/** Strip leftover brackets from agent pseudo-JSON typos. */
function stripWrappingBrackets(text) {
  let s = String(text || '').trim()
  while (
    s.length >= 2 &&
    ((s[0] === '[' && s.endsWith(']')) ||
      (s[0] === '{' && s.endsWith('}')) ||
      (s[0] === '(' && s.endsWith(')')))
  ) {
    s = s.slice(1, -1).trim()
  }
  while (s.endsWith(']') || s.endsWith('}')) s = s.slice(0, -1).trimEnd()
  while (s.startsWith('[') || s.startsWith('{')) s = s.slice(1).trimStart()
  return s
}

/**
 * Repair agent typos like ``path.md,label:标题}]`` → ``{ path, label }``.
 */
export function splitPathLabelSuffix(value) {
  const s = stripWrappingBrackets(value)
  if (!s) return { path: '', label: '' }
  const m = s.match(/,\s*label\s*[:=]\s*(.+)$/i)
  if (!m) return { path: s, label: '' }
  let path = s.slice(0, m.index).trim().replace(/^['"]|['"]$/g, '')
  let label = String(m[1] || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
  while (label.endsWith(']') || label.endsWith('}')) label = label.slice(0, -1).trimEnd()
  return { path, label }
}

const KV_FIELD_RE =
  /["']?(type|key|name|value|path|url|content|label|title)["']?\s*[:=]\s*["']?([^,"'\]}]+)["']?/gi
const FILE_EXT_RE = /\.(md|html?|pdf|json|ya?ml|tsx?|jsx?|py|css|txt|csv)$/i
const MESSY_PATH_LABEL_RE =
  /((?:docs|evoflow|outputs|backend|evopanel|frontend)\/[^\s,\]}]+?|(?:[^\s,\]}]+\/)*[^\s,\]}]+)\.(md|html?|pdf|json|ya?ml|tsx?|jsx?|py|css|txt|csv)(?:\s*,\s*label\s*[:=]\s*([^,\]}]+))?/gi
const KV_BLOB_HINT_RE = /(?:^|[,{\s])["']?(?:type|key|value|path|url|label)["']?\s*[:=]/i

function cleanFieldToken(raw) {
  let s = String(raw || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
  while (s.endsWith(']') || s.endsWith('}')) s = s.slice(0, -1).trimEnd()
  return s.trim()
}

/** Parse ``type:file,key:x,value:path.md[,label:标题]`` style blobs. */
export function parseOutputKvBlob(text) {
  const s = stripWrappingBrackets(text)
  if (!s) return null
  if (!KV_BLOB_HINT_RE.test(s)) return null
  KV_BLOB_HINT_RE.lastIndex = 0
  const out = {}
  KV_FIELD_RE.lastIndex = 0
  let m
  while ((m = KV_FIELD_RE.exec(s)) !== null) {
    let field = String(m[1] || '').toLowerCase()
    if (field === 'name') field = 'key'
    else if (field === 'title') field = 'label'
    else if (field === 'path' || field === 'url' || field === 'content') {
      if (out.value) continue
      field = 'value'
    }
    out[field] = cleanFieldToken(m[2])
  }
  return Object.keys(out).length ? out : null
}

/** Return cleaned ``{ path, label, key }`` from a path or agent typo blob. */
export function extractOutputPathFields(value) {
  const s = stripWrappingBrackets(sanitizeDeliverablePath(value))
  if (!s) return { path: '', label: '', key: '' }

  const kv = parseOutputKvBlob(s)
  if (kv?.value) {
    let path = String(kv.value).replace(/\\/g, '/')
    let label = kv.label || ''
    const key = kv.key || ''
    const nested = splitPathLabelSuffix(path)
    if (nested.path) path = nested.path
    if (!label && nested.label) label = nested.label
    return { path, label, key }
  }

  const split = splitPathLabelSuffix(s)
  let path = split.path
  let label = split.label
  if (
    path &&
    !/^type\s*:/i.test(path) &&
    (path.includes('/') || FILE_EXT_RE.test(path) || /^https?:\/\//i.test(path))
  ) {
    return { path, label, key: '' }
  }

  MESSY_PATH_LABEL_RE.lastIndex = 0
  const m = MESSY_PATH_LABEL_RE.exec(s)
  if (m) {
    path = `${m[1]}.${m[2]}`.replace(/\\/g, '/').trim().replace(/^['"]|['"]$/g, '')
    label = cleanFieldToken(m[3] || '') || label
    return { path, label, key: '' }
  }
  return { path: split.path || '', label, key: '' }
}

/** Best-effort parse when stored ``outputs`` is not valid structured data. */
export function coerceOutputsFromMessyText(text) {
  const raw = String(text || '').trim()
  if (!raw) return []

  const chunks = raw.split(/\}\s*,\s*\{/).map((part, i, arr) => {
    let chunk = part.trim()
    if (i > 0 && !chunk.startsWith('{')) chunk = `{${chunk}`
    if (i < arr.length - 1 && !chunk.endsWith('}')) chunk = `${chunk}}`
    return chunk
  })

  const collected = []
  for (const chunk of chunks) {
    const kv = parseOutputKvBlob(chunk)
    if (kv?.value) {
      const { path, label, key } = extractOutputPathFields(chunk)
      if (path) {
        const item = { type: 'file', key: key || kv.key || 'artifact', value: path }
        if (label || kv.label) item.label = label || kv.label
        collected.push(item)
        continue
      }
    }
    MESSY_PATH_LABEL_RE.lastIndex = 0
    let m
    while ((m = MESSY_PATH_LABEL_RE.exec(chunk)) !== null) {
      const path = `${m[1]}.${m[2]}`.replace(/\\/g, '/').trim().replace(/^['"]|['"]$/g, '')
      if (!path) continue
      const item = { type: 'file', key: `artifact_${collected.length + 1}`, value: path }
      const label = cleanFieldToken(m[3] || '')
      if (label) item.label = label
      collected.push(item)
    }
  }
  if (collected.length) return collected

  const kv = parseOutputKvBlob(raw)
  if (kv?.value) {
    const { path, label, key } = extractOutputPathFields(raw)
    if (path) {
      const item = { type: 'file', key: key || 'artifact', value: path }
      if (label) item.label = label
      return [item]
    }
  }

  const found = []
  const seen = new Set()
  MESSY_PATH_LABEL_RE.lastIndex = 0
  let m
  while ((m = MESSY_PATH_LABEL_RE.exec(raw)) !== null) {
    const path = `${m[1]}.${m[2]}`.replace(/\\/g, '/').trim().replace(/^['"]|['"]$/g, '')
    if (!path || seen.has(path)) continue
    seen.add(path)
    let label = cleanFieldToken(m[3] || '')
    const item = { type: 'file', key: `artifact_${found.length + 1}`, value: path }
    if (label) item.label = label
    found.push(item)
  }
  if (found.length) return found
  const { path, label, key } = extractOutputPathFields(raw)
  if (!path) return []
  const item = { type: 'file', key: key || 'artifact', value: path }
  if (label) item.label = label
  return [item]
}

/** Expand one raw output entry into zero+ normalized items (handles multi-blob values). */
function expandOutputEntries(item, index) {
  if (item == null) return []
  if (typeof item === 'string') {
    const repaired = coerceOutputsFromMessyText(item)
    if (repaired.length > 1) {
      return repaired.map((rep, j) => normalizeOutputItem(rep, index * 100 + j)).filter(Boolean)
    }
    const one = normalizeOutputItem(repaired[0] || item, index)
    return one ? [one] : []
  }
  if (typeof item === 'object') {
    const value = String(item.value || item.path || item.url || item.content || '').trim()
    if (
      value &&
      (value.includes('}, {') ||
        value.includes('"}, {"') ||
        (value.match(/"value"/g) || []).length > 1 ||
        (value.match(/\bvalue\s*:/gi) || []).length > 1)
    ) {
      const repaired = coerceOutputsFromMessyText(value)
      if (repaired.length > 1) {
        return repaired.map((rep, j) => normalizeOutputItem(rep, index * 100 + j)).filter(Boolean)
      }
    }
  }
  const one = normalizeOutputItem(item, index)
  return one ? [one] : []
}

/** Normalize structured task outputs (main or subtask). */
export function taskOutputsOf(task) {
  if (!task || typeof task !== 'object') return []
  const raw = Array.isArray(task.outputs) ? task.outputs : null
  if (raw && raw.length) {
    const out = []
    const seen = new Set()
    raw.forEach((item, i) => {
      for (const normalized of expandOutputEntries(item, i)) {
        const sig = `${normalized.type}|${normalized.key}|${normalized.value}`
        if (seen.has(sig)) continue
        seen.add(sig)
        out.push(normalized)
      }
    })
    return out
  }
  // Legacy: entire outputs field stored as a messy string
  if (typeof task.outputs === 'string' && task.outputs.trim()) {
    return coerceOutputsFromMessyText(task.outputs)
      .map((item, i) => normalizeOutputItem(item, i))
      .filter(Boolean)
  }
  const paths = Array.isArray(task.evidence_paths) ? task.evidence_paths : []
  const out = []
  const seen = new Set()
  paths.forEach((p, i) => {
    const value = String(p || '').trim()
    if (!value) return
    for (const normalized of expandOutputEntries(
      { type: 'file', key: `file_${i + 1}`, value },
      i,
    )) {
      const sig = `${normalized.type}|${normalized.key}|${normalized.value}`
      if (seen.has(sig)) continue
      seen.add(sig)
      out.push(normalized)
    }
  })
  return out
}

function isRollupSubtaskRow(st) {
  if (!st || typeof st !== 'object') return false
  if (st.is_rollup_step) return true
  if (String(st.ref || '').trim() === '__rollup__') return true
  const wp = st.worker_profile
  return !!(wp && typeof wp === 'object' && wp.is_rollup_step)
}

/** Prefer rollup-step deliverables as the main-task view (workflow summary node). */
export function mergeRollupOutputsOntoTask(task) {
  if (!task || typeof task !== 'object') return task
  const subs = Array.isArray(task.subtasks) ? task.subtasks : []
  const rollup = subs.find((st) => isRollupSubtaskRow(st))
  if (!rollup) return task
  const fromRollup = taskOutputsOf(rollup)
  if (!fromRollup.length) return task
  // Summary node present with outputs → show those only (not intermediate steps).
  const sorted = [...fromRollup].sort((a, b) => {
    const score = (it) => {
      const v = String(it?.value || '').toLowerCase()
      const k = String(it?.key || '').toLowerCase()
      if (k.includes('result') || v.endsWith('.html') || v.endsWith('.htm')) return 0
      return 1
    }
    return score(a) - score(b)
  })
  return { ...task, outputs: sorted }
}

/** Upstream read-refs (child handoff); never treated as this task's deliverables. */
export function taskInputRefsOf(task) {
  if (!task || typeof task !== 'object') return []
  const raw = Array.isArray(task.input_refs) ? task.input_refs : null
  if (!raw || !raw.length) return []
  return raw.map((item, i) => normalizeOutputItem(item, i)).filter(Boolean)
}

function normalizeOutputItem(item, index) {
  if (item == null) return null
  if (typeof item === 'string') {
    const repaired = coerceOutputsFromMessyText(item)
    if (repaired.length) return normalizeOutputItem(repaired[0], index)
    const value = item.trim()
    if (!value) return null
    const { path, label, key } = extractOutputPathFields(value)
    if (!path) return null
    const out = { type: 'file', key: key || `artifact_${index + 1}`, value: path }
    if (label) out.label = label
    return out
  }
  if (typeof item !== 'object') return null
  let value = String(item.value || item.path || item.url || item.content || '').trim()
  if (!value) return null
  if (parseOutputKvBlob(value) || value.includes('}, {') || value.includes('"}, {"')) {
    const repaired = coerceOutputsFromMessyText(value)
    if (repaired.length) {
      const first = { ...repaired[0] }
      const outerKey = String(item.key || item.name || '').trim()
      const outerLabel = String(item.label || item.title || '').trim()
      if (outerKey && (!first.key || /^artifact[_-]?\d*$/i.test(first.key))) first.key = outerKey
      if (outerLabel && !first.label) first.label = outerLabel
      first.type = String(item.type || first.type || 'file').trim().toLowerCase() || 'file'
      return normalizeOutputItem(first, index)
    }
  }
  const typeRaw = String(item.type || 'file').trim().toLowerCase()
  const type = ['file', 'url', 'text', 'other'].includes(typeRaw) ? typeRaw : 'other'
  let key = String(item.key || item.name || `artifact_${index + 1}`).trim() || `artifact_${index + 1}`
  let label = String(item.label || item.title || '').trim()
  const extracted = extractOutputPathFields(value)
  if (extracted.path) value = sanitizeDeliverablePath(extracted.path)
  else value = sanitizeDeliverablePath(value)
  if (!value) return null
  if (!label && extracted.label) label = extracted.label
  if (extracted.key && /^artifact[_-]?\d*$/i.test(key)) key = extracted.key
  const out = { type, key, value }
  if (label) out.label = label
  // Pass through backend resolution metadata so the panel can open the right
  // workspace root without re-probing the filesystem.
  if (item && typeof item === 'object' && item._resolve_meta && typeof item._resolve_meta === 'object') {
    out._resolve_meta = item._resolve_meta
  }
  if (item && typeof item === 'object' && item.source_label) {
    out.source_label = String(item.source_label).trim()
  }
  return out
}

function subtaskDisplayLabel(st) {
  if (!st || typeof st !== 'object') return ''
  if (isRollupSubtaskRow(st)) return '结果汇总'
  const title =
    String(st.title || st.name || st.goal || st.description || '').trim() ||
    String(st.ref || st.semantic_ref || '').trim()
  return title.length > 36 ? `${title.slice(0, 35)}…` : title
}

/** Attach which workflow node produced each file (best-effort by basename). */
export function annotateDeliverableSources(task, items) {
  const list = Array.isArray(items) ? items : []
  const subs = Array.isArray(task?.subtasks) ? task.subtasks : []
  if (!subs.length) return list
  const byBase = new Map()
  for (const st of subs) {
    const source = subtaskDisplayLabel(st)
    if (!source) continue
    for (const o of taskOutputsOf(st)) {
      const base = deliverableBasenameKey(o.value)
      if (!base) continue
      const prev = byBase.get(base)
      // Prefer rollup / later nodes when the same basename appears multiple times.
      if (!prev || isRollupSubtaskRow(st)) byBase.set(base, source)
    }
  }
  return list.map((item) => {
    if (!item || typeof item !== 'object') return item
    if (item.source_label) return item
    const base = deliverableBasenameKey(item.value)
    const source = base ? byBase.get(base) : ''
    return source ? { ...item, source_label: source } : item
  })
}

export function isFeaturedDeliverable(item) {
  const label = String(item?.label || '').trim()
  const key = String(item?.key || '').trim().toLowerCase()
  if (/★|最终交付|最终汇总|验收核对/.test(label)) return true
  if (key.includes('final') || key.includes('deliver')) return true
  return false
}

export function outputTypeLabel(type) {
  return OUTPUT_TYPE_ZH[String(type || '').toLowerCase()] || OUTPUT_TYPE_ZH.other
}

/** Whether task is an automation-run collab job (prompt-only scheduler). */
export function isAutomationCollabTask(task) {
  return !!(String(task?.automation_id || task?.automationId || '').trim())
}

/** Canonical deliverable registered at enqueue time (backend ``automation_output_*``). */
export function automationExpectedOutputItems(task) {
  const abs = String(task?.automation_output_path || task?.automationOutputPath || '').trim()
  const rel = String(task?.automation_output_rel || task?.automationOutputRel || '').trim()
  const value = abs || rel
  if (!value) return []
  const name = String(task?.automation_name || task?.automationName || '自动化').trim()
  return [{
    type: 'file',
    key: 'automation_deliverable',
    value,
    label: `${name} · 交付文件`,
    source: 'automation_expected',
  }]
}

/** Compact list-card hint: "· 2 项产出" / optional input refs. */
export function taskOutputsHint(task) {
  const n = resolveTaskOutputItems(task).length
  const refs = taskInputRefsOf(task).length
  const parts = []
  if (n) parts.push(`${n} 项产出`)
  if (refs) parts.push(`${refs} 项上游参考`)
  return parts.join(' · ')
}

/** Basename for display; keep last 2 segments when nested. */
export function outputDisplayName(item) {
  if (!item) return '产出'
  if (item.label) return item.label
  const value = String(item.value || '').trim()
  if (!value) return item.key || '产出'
  if (/^https?:\/\//i.test(value)) {
    try {
      const u = new URL(value)
      return u.pathname.split('/').filter(Boolean).pop() || u.hostname
    } catch {
      return value.slice(0, 48)
    }
  }
  const parts = value.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length >= 2) return parts.slice(-2).join('/')
  return parts[0] || value
}

/** File basename only (cleaner card title when no label). */
export function outputFileBasename(item) {
  const value = String(item?.value || '').trim().replace(/\\/g, '/')
  if (!value) return outputDisplayName(item)
  if (/^https?:\/\//i.test(value)) return outputDisplayName(item)
  const parts = value.split('/').filter(Boolean)
  return parts[parts.length - 1] || value
}

export function shortenPath(path, maxLen = 52) {
  const s = String(path || '').replace(/\\/g, '/')
  if (s.length <= maxLen) return s
  return `…${s.slice(-(maxLen - 1))}`
}

export function isPreviewableOutput(item) {
  if (!item) return false
  if (item.type === 'url' || /^https?:\/\//i.test(String(item.value || ''))) return true
  if (item.type === 'text') return true
  const raw = String(item.value || '').trim()
  if (!raw) return false
  const cleaned = extractOutputPathFields(raw).path || raw
  return item.type === 'file' || item.type === 'other' || !item.type
    ? PREVIEWABLE_EXT_RE.test(cleaned)
    : false
}

/**
 * Heuristic split of free-text summary into conclusion / findings / nextSteps.
 * Also collects path-like strings mentioned in the body.
 */
export function parseTaskResultSections(text) {
  const raw = String(text || '').trim()
  if (!raw) {
    return { conclusion: '', findings: [], nextSteps: [], mentionedPaths: [] }
  }

  // Stop path capture at commas / brackets so ``path.md,label:…`` does not leak.
  const pathRe =
    /(?:^|[\s「『（(])((?:docs|evoflow|outputs|backend|evopanel|frontend)\/[^\s，。；、,」』）)}\]]+|[^\s，。；、,」』）)}\]]+\.(?:md|html?|pdf|json|ya?ml|tsx?|jsx?|py|css))/gi
  const mentionedPaths = []
  const seen = new Set()
  let m
  while ((m = pathRe.exec(raw)) !== null) {
    let p = String(m[1] || '').trim().replace(/[.,;:]+$/, '')
    const split = splitPathLabelSuffix(p)
    p = split.path || p
    if (p && !seen.has(p)) {
      seen.add(p)
      mentionedPaths.push(p)
    }
  }

  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const findings = []
  const nextSteps = []
  const conclusionParts = []
  let mode = 'conclusion'

  const isFindingHead = (l) => /^(关键)?发现|问题|风险|待完善|缺口|缺失/.test(l) || /^发现[:：]/.test(l)
  const isNextHead = (l) => /^(建议)?下一步|后续|建议|待办|行动项/.test(l) || /下一步[:：]/.test(l)
  const isOutputHead = (l) => /^(主要)?产出|产物|交付|附件|文档/.test(l)
  const isBullet = (l) => /^[-*•·□■✅☑️]\s+/.test(l) || /^\d+[.)、]\s+/.test(l)
  const stripBullet = (l) => l.replace(/^[-*•·□■✅☑️]\s+/, '').replace(/^\d+[.)、]\s+/, '').trim()

  for (const line of lines) {
    if (isFindingHead(line)) {
      mode = 'findings'
      const rest = line.replace(/^[^:：]*[:：]\s*/, '').trim()
      if (rest && rest !== line && !isFindingHead(rest)) findings.push(rest)
      continue
    }
    if (isNextHead(line)) {
      mode = 'next'
      const rest = line.replace(/^[^:：]*[:：]\s*/, '').trim()
      if (rest && rest !== line && !isNextHead(rest)) nextSteps.push(rest)
      continue
    }
    if (isOutputHead(line)) {
      mode = 'outputs'
      continue
    }
    if (mode === 'findings') {
      findings.push(stripBullet(line) || line)
      continue
    }
    if (mode === 'next') {
      nextSteps.push(stripBullet(line) || line)
      continue
    }
    if (mode === 'outputs') continue
    if (/^(?:docs|evoflow|outputs)\//i.test(line) || /\.(md|html?|pdf)$/i.test(line)) continue
    conclusionParts.push(line)
  }

  let conclusion = conclusionParts.join('\n').trim()
  if (!conclusion) {
    const flat = raw.replace(/\s+/g, ' ').trim()
    // COMPAT(macOS12-JSC): no lookbehind — split after sentence end, drop following spaces.
    const parts = []
    {
      const ends = '。！？.!?'
      let start = 0
      for (let i = 0; i < flat.length; i++) {
        if (ends.includes(flat[i])) {
          let end = i + 1
          while (end < flat.length && /\s/.test(flat[end])) end += 1
          const part = flat.slice(start, i + 1).trim()
          if (part) parts.push(part)
          start = end
          i = end - 1
        }
      }
      const tail = flat.slice(start).trim()
      if (tail) parts.push(tail)
    }
    conclusion = parts.slice(0, 2).join('')
    if (conclusion.length > 220) conclusion = `${conclusion.slice(0, 219)}…`
  } else if (conclusion.length > 360) {
    conclusion = `${conclusion.slice(0, 359)}…`
  }

  return { conclusion, findings, nextSteps, mentionedPaths }
}

/** Merge structured outputs with paths mentioned in summary text (docs only). */
export function resolveTaskOutputItems(task) {
  const view = mergeRollupOutputsOntoTask(task)
  const items = [...taskOutputsOf(view)]

  if (isAutomationCollabTask(view)) {
    for (const expected of automationExpectedOutputItems(view)) {
      const key = deliverableDedupeKey(expected.value)
      const haveKeys = new Set(items.map((i) => deliverableDedupeKey(i.value)))
      if (!key || haveKeys.has(key)) continue
      items.unshift(expected)
    }
  }

  const { mentionedPaths } = parseTaskResultSections(taskSummaryText(task))
  const have = new Set(items.map((i) => deliverableDedupeKey(i.value)))
  // Automation tasks: don't infer phantom paths from free-text summaries.
  if (!isAutomationCollabTask(view)) {
    for (const p of mentionedPaths) {
      const cleaned = sanitizeDeliverablePath(p)
      if (!cleaned || isCodeOutputPath(cleaned)) continue
      const key = deliverableDedupeKey(cleaned)
      if (!key || have.has(key)) continue
      have.add(key)
      items.push({ type: 'file', key: `mentioned_${items.length + 1}`, value: cleaned })
    }
  }
  return annotateDeliverableSources(task, filterDeliverableOutputs(items))
}

function answerRefOutputsOf(task) {
  if (!task || typeof task !== 'object') return []
  const ref = String(task.answer_from_ref || task.answerFromRef || '').trim()
  if (!ref || ref === '__rollup__') return []
  const subs = Array.isArray(task.subtasks) ? task.subtasks : []
  const answerStep = subs.find((st) => {
    if (!st || typeof st !== 'object') return false
    if (isRollupSubtaskRow(st)) return false
    return (
      String(st.ref || '').trim() === ref ||
      String(st.semantic_ref || '').trim() === ref ||
      String(st?.worker_profile?.semantic_ref || '').trim() === ref
    )
  })
  if (!answerStep) return []
  return filterDeliverableOutputs(taskOutputsOf(answerStep))
}

/**
 * Layered view for task detail UI:
 * - ``primary``: what the user should look at (answer-step / rollup deliverables only)
 * - ``process``: intermediate step reports + worker bookkeeping drops (collapsed by default)
 */
export function resolveTaskDeliverableLayers(task) {
  const all = resolveTaskOutputItems(task)
  if (!isWorkflowAppTaskRow(task)) {
    const { primary, process } = splitDeliverableOutputs(all)
    // Non-workflow: still surface ★/最终 as primary when mixed with noise.
    if (primary.some(isFeaturedDeliverable) && process.length === 0) {
      const featured = primary.filter(isFeaturedDeliverable)
      const rest = primary.filter((i) => !isFeaturedDeliverable(i))
      if (featured.length && rest.length) return { primary: featured, process: rest }
    }
    return { primary: primary.length ? primary : all, process }
  }

  // Explicit answer sink: answer-step outputs are the headline; everything else
  // (upstream review/analysis reports) becomes process artifacts.
  const fromAnswer = annotateDeliverableSources(task, answerRefOutputsOf(task))
  if (fromAnswer.length) {
    const have = new Set(fromAnswer.map((i) => deliverableDedupeKey(i.value)))
    const process = all.filter((i) => !have.has(deliverableDedupeKey(i.value)))
    return { primary: fromAnswer, process }
  }

  const { primary, process } = splitDeliverableOutputs(all)
  // Prefer ★ / 最终交付 as the visible primary block when present.
  const featured = primary.filter(isFeaturedDeliverable)
  if (featured.length && featured.length < primary.length) {
    const rest = primary.filter((i) => !isFeaturedDeliverable(i))
    return { primary: featured, process: [...rest, ...process] }
  }
  return { primary, process }
}

function isWorkflowAppTaskRow(task) {
  if (!task || typeof task !== 'object') return false
  const src = String(task.source || '').trim().toLowerCase()
  if (src === 'workflow') return true
  return !!String(task.source_app_id || '').trim()
}

/**
 * Render outputs as HTML list (caller must pass escapeHtml).
 */
export function renderTaskOutputsHtml(task, escapeHtml) {
  const items = taskOutputsOf(task)
  if (!items.length) return ''
  const esc = typeof escapeHtml === 'function' ? escapeHtml : (s) => String(s ?? '')
  const rows = items
    .map((item) => {
      const typeZh = esc(outputTypeLabel(item.type))
      const title = esc(item.label || item.key)
      const value = String(item.value || '')
      let valueHtml = esc(value)
      if (item.type === 'url' || /^https?:\/\//i.test(value)) {
        valueHtml = `<a href="${esc(value)}" target="_blank" rel="noopener noreferrer">${esc(value)}</a>`
      } else if (item.type === 'file' || item.type === 'other') {
        valueHtml = `<code class="task-output-path">${esc(value)}</code>`
      }
      return `<li class="task-output-item" data-type="${esc(item.type)}">
        <span class="task-output-type">${typeZh}</span>
        <span class="task-output-key">${title}</span>
        <span class="task-output-value">${valueHtml}</span>
      </li>`
    })
    .join('')
  return `<ul class="task-output-list">${rows}</ul>`
}

/** Resource cards for files/urls (result page). */
export function renderOutputItemCardsHtml(items, escapeHtml, opts = {}) {
  const list = Array.isArray(items) ? items : []
  if (!list.length) return ''
  const esc = typeof escapeHtml === 'function' ? escapeHtml : (s) => String(s ?? '')
  const workHref = String(opts.workItemHref || '').trim()
  const canPreview = opts.enablePreview !== false
  const sorted = [...list].sort(
    (a, b) => Number(isFeaturedDeliverable(b)) - Number(isFeaturedDeliverable(a)),
  )
  return `<ul class="td-output-list">${sorted
    .map((item) => {
      const resolveMeta =
        item._resolve_meta && typeof item._resolve_meta === 'object' ? item._resolve_meta : null
      const rawValue = sanitizeDeliverablePath(item.value)
      // Prefer resolved absolute path so preview / reveal actually open.
      const value = sanitizeDeliverablePath(resolveMeta?.absolute || rawValue)
      const title = esc(item.label || outputFileBasename({ ...item, value: rawValue }))
      const short = esc(shortenPath(value || rawValue, 72))
      const isUrl = item.type === 'url' || /^https?:\/\//i.test(value)
      const isText = item.type === 'text'
      const featured = isFeaturedDeliverable(item)
      const sourceLabel = String(item.source_label || '').trim()
      const previewable = canPreview && isPreviewableOutput({ ...item, value })
      const existenceAttr =
        !isUrl && !isText && value ? ` data-path-for-existence="${esc(value)}"` : ''
      const resolveAttr = resolveMeta
        ? ` data-resolve-meta='${esc(JSON.stringify(resolveMeta))}'`
        : ''
      const badges = []
      if (featured) {
        badges.push('<span class="td-output-badge td-output-badge--final">最终交付</span>')
      }
      if (item.source === 'automation_expected') {
        badges.push(
          '<span class="td-output-badge td-output-badge--pending" data-role="existence-badge">检测中…</span>',
        )
      } else if (resolveMeta && resolveMeta.found === true) {
        badges.push(
          '<span class="td-output-badge td-output-badge--ready" data-role="existence-badge">已生成</span>',
        )
      } else if (resolveMeta && resolveMeta.found === false) {
        badges.push(
          '<span class="td-output-badge td-output-badge--missing" data-role="existence-badge">未生成</span>',
        )
      }
      const cardAct =
        previewable && !isUrl
          ? ` data-act="preview-output" data-path="${esc(value)}" data-title="${title}" data-type="${esc(item.type)}"`
          : ''
      const rowClass = [
        'td-output-row',
        previewable && !isUrl ? 'is-clickable' : '',
        featured ? 'is-featured' : '',
        resolveMeta?.found === true ? 'is-ready' : '',
        resolveMeta?.found === false ? 'is-missing' : '',
      ]
        .filter(Boolean)
        .join(' ')
      let actions = ''
      const revealBtn =
        !isUrl && !isText && value
          ? `<button type="button" class="td-output-action td-output-action--muted" data-act="reveal-path" data-path="${esc(value)}" title="在本地文件管理器中显示">打开位置</button>`
          : ''
      if (isUrl) {
        actions = `<a class="td-output-action" href="${esc(value)}" target="_blank" rel="noopener noreferrer">打开</a>`
      } else if (isText) {
        actions = `<button type="button" class="td-output-action" data-act="preview-output" data-path="" data-title="${title}" data-type="text" data-content="${esc(value)}">预览</button>`
      } else if (previewable) {
        actions = `<button type="button" class="td-output-action" data-act="preview-output" data-path="${esc(value)}" data-title="${title}" data-type="${esc(item.type)}">预览</button>
          <button type="button" class="td-output-action td-output-action--muted" data-act="copy-path" data-path="${esc(value)}">复制路径</button>
          ${revealBtn}`
      } else {
        actions = `<button type="button" class="td-output-action" data-act="copy-path" data-path="${esc(value)}">复制路径</button>
          ${revealBtn}`
      }
      if (workHref) {
        actions += `<a class="td-output-action td-output-action--muted" href="${esc(workHref)}">工作项</a>`
      }
      const metaBits = [
        sourceLabel ? `<span class="td-output-source">来自节点 · ${esc(sourceLabel)}</span>` : '',
        !isText && short
          ? `<span class="td-output-path" title="${esc(value)}">${short}</span>`
          : '',
      ].filter(Boolean)
      return `<li class="${rowClass}" data-type="${esc(item.type)}"${cardAct}${existenceAttr}${resolveAttr} title="${previewable && !isUrl ? '点击预览' : esc(value)}">
        <div class="td-output-main">
          <div class="td-output-name">${title}${badges.join('')}</div>
          ${metaBits.length ? `<div class="td-output-meta">${metaBits.join('')}</div>` : ''}
        </div>
        <div class="td-output-actions">${actions}</div>
      </li>`
    })
    .join('')}</ul>`
}

export function renderTaskOutputCardsHtml(task, escapeHtml, opts = {}) {
  return renderOutputItemCardsHtml(resolveTaskOutputItems(task), escapeHtml, opts)
}

/** Upstream input_refs cards (handoff read list). */
export function renderTaskInputRefsCardsHtml(task, escapeHtml, opts = {}) {
  return renderOutputItemCardsHtml(taskInputRefsOf(task), escapeHtml, opts)
}
