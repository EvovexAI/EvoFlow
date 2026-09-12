/**
 * Normalize Mermaid source for rendering (shared by plan flowcharts and mind map diagrams).
 */

import { sanitizeMermaidNodeLabels } from '../react/lib/parse-plan-markdown.js'

/** @param {string} raw */
export function stripMermaidFence(raw) {
  let src = String(raw || '').replace(/\r\n/g, '\n').trim()
  if (!src) return src
  const fenced = /^```(?:mermaid)?\s*\n?([\s\S]*?)```\s*$/i.exec(src)
  if (fenced) src = String(fenced[1] || '').trim()
  return src
}

/** @param {string} raw */
export function isFlowchartMermaidSource(raw) {
  const src = stripMermaidFence(raw)
  return /^(?:flowchart|graph)\b/im.test(src)
}

/** @param {string} raw */
export function isArchitectureMermaidSource(raw) {
  const src = stripMermaidFence(raw)
  return /^architecture(?:-beta)?\b/im.test(src)
}

/**
 * Repair common invalid architecture-beta from models: `group:service --> group:service`
 * and services declared after a group without `in group`.
 * @param {string} raw
 */
export function normalizeArchitectureBetaMermaid(raw) {
  let src = stripMermaidFence(raw)
  if (!/^architecture(?:-beta)?\b/im.test(src)) return src
  const lines = src.split('\n')
  /** @type {string[]} */
  const out = []
  let currentGroup = ''
  /** @type {Map<string, string>} */
  const serviceGroup = new Map()

  const badEdgeRe =
    /^(\s*)([\w]+):([\w]+)\s*(-->|<-->|<-->|==>|===)\s*([\w]+):([\w]+)\s*$/

  for (const line of lines) {
    const groupMatch = line.match(/^\s*group\s+([\w-]+)\b/i)
    if (groupMatch) {
      currentGroup = groupMatch[1]
      out.push(line)
      continue
    }

    const serviceMatch = line.match(/^\s*service\s+([\w-]+)\b/i)
    if (serviceMatch) {
      const serviceId = serviceMatch[1]
      if (!/\bin\s+[\w-]+\b/i.test(line) && currentGroup) {
        serviceGroup.set(serviceId, currentGroup)
        out.push(`${line.replace(/\s+$/, '')} in ${currentGroup}`)
        continue
      }
      const inMatch = line.match(/\bin\s+([\w-]+)\b/i)
      if (inMatch) serviceGroup.set(serviceId, inMatch[1])
      out.push(line)
      continue
    }

    const edgeMatch = badEdgeRe.exec(line)
    if (edgeMatch) {
      const [, indent, g1, s1, arrow, g2, s2] = edgeMatch
      const crossGroup = g1 !== g2
      const directed = arrow.includes('>')
      const join = directed ? '-->' : '--'
      if (crossGroup) {
        out.push(`${indent}${s1}{group}:R ${join} L:${s2}{group}`)
      } else {
        out.push(`${indent}${s1}:R ${join} L:${s2}`)
      }
      serviceGroup.set(s1, g1)
      serviceGroup.set(s2, g2)
      continue
    }

    out.push(line)
  }

  return out.join('\n')
}

/** @param {string} raw */
export function normalizeMermaidCode(raw) {
  let src = stripMermaidFence(raw)
  if (!src) return src
  if (isArchitectureMermaidSource(src)) return normalizeArchitectureBetaMermaid(src)
  if (!isFlowchartMermaidSource(src)) return src
  src = src.replace(/^graph\b/im, 'flowchart')
  if (src.includes('\n')) return sanitizeMermaidNodeLabels(src)
  if (!/^(?:flowchart|graph)\s+(TD|LR|RL|BT)\b/i.test(src)) return sanitizeMermaidNodeLabels(src)
  let code = src.replace(/^graph\b/i, 'flowchart')
  code = code.replace(/^(flowchart\s+(?:TD|LR|RL|BT))\s+/i, '$1\n')
  code = code.replace(
    /([\]})"'])\s+(?=[A-Za-z_][A-Za-z0-9_]*\s*(?:-->|==>|-.->|---))/g,
    '$1\n',
  )
  return sanitizeMermaidNodeLabels(code)
}

/** @param {string} text */
export function looksLikeMermaidSource(text) {
  const src = stripMermaidFence(text)
  if (!src) return false
  return /^(?:flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?|classDiagram|erDiagram|gantt|journey|mindmap|gitGraph|architecture(?:-beta)?|block(?:-beta)?|C4(?:Context|Container|Component|Dynamic|Deployment)|quadrantChart|timeline|ishikawa)\b/im.test(
    src,
  )
}
