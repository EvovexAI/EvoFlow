import { describe, expect, it } from 'vitest'
import mermaid from 'mermaid'
import {
  bodyTextWithoutMermaid,
  detectDiagramTypeFromSource,
  diagramTypeLabel,
  extractMermaidFromNode,
  nodeHasDiagram,
  resolveNodeDiagramType,
} from '../src/lib/knowledge-map-diagram.js'
import { normalizeArchitectureBetaMermaid, normalizeMermaidCode } from '../src/lib/mermaid-code.js'
import { sanitizeMermaidNodeLabels } from '../src/react/lib/parse-plan-markdown.js'

const ARCH = `architecture-beta
  group frontend(cloud)[EvoPanel]
  service tauri(server)[Tauri v2]
  service react(server)[React UI]
  group backend(cloud)[Backend]
  service gateway(server)[FastAPI Gateway]
  service langgraph(server)[LangGraph Server]
  frontend:react --> frontend:tauri
  frontend:tauri --> backend:gateway
  backend:gateway --> backend:langgraph`

const MIND = `mindmap
  root((思维导图验证))
    基础节点
      file
      fn`

async function tryParse(code) {
  mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' })
  await mermaid.parse(code)
}

describe('knowledge-map-diagram', () => {
  it('extracts fenced mermaid from body', () => {
    const node = {
      kind: 'note',
      body: '说明\n```mermaid\nflowchart TD\n  A --> B\n```',
    }
    expect(extractMermaidFromNode(node)).toContain('flowchart TD')
    expect(nodeHasDiagram(node)).toBe(true)
    expect(bodyTextWithoutMermaid(String(node.body))).toBe('说明')
  })

  it('detects bare mermaid on diagram kind nodes', () => {
    const node = {
      kind: 'diagram',
      external_id: 'diagram:upload-seq',
      diagram_type: 'sequence',
      body: 'sequenceDiagram\n  Client->>API: POST',
      meta: { diagram_type: 'sequence' },
    }
    expect(extractMermaidFromNode(node)).toContain('sequenceDiagram')
    expect(resolveNodeDiagramType(node)).toBe('sequence')
    expect(diagramTypeLabel('sequence')).toBe('时序图')
  })

  it('detectDiagramTypeFromSource infers flowchart', () => {
    expect(detectDiagramTypeFromSource('flowchart TD\n  X --> Y')).toBe('flowchart')
    expect(detectDiagramTypeFromSource('```mermaid\nstateDiagram-v2\n  [*] --> Idle\n```')).toBe('state')
    expect(detectDiagramTypeFromSource(ARCH)).toBe('architecture')
    expect(detectDiagramTypeFromSource(MIND)).toBe('mindmap')
  })

  it('normalizeMermaidCode repairs architecture-beta and preserves mindmap', () => {
    expect(normalizeMermaidCode(MIND)).toBe(MIND)
    expect(normalizeMermaidCode(ARCH)).toContain('react:R --> L:tauri')
    expect(normalizeMermaidCode(ARCH)).toContain('service react(server)[React UI] in frontend')
  })

  it('mermaid parses mindmap and repaired architecture-beta', async () => {
    await expect(tryParse(normalizeMermaidCode(MIND))).resolves.toBeUndefined()
    await expect(tryParse(normalizeMermaidCode(ARCH))).resolves.toBeUndefined()
  })

  it('normalizeArchitectureBetaMermaid repairs common invalid edge syntax', async () => {
    const fixed = normalizeArchitectureBetaMermaid(ARCH)
    expect(fixed).toContain('service react(server)[React UI] in frontend')
    expect(fixed).toContain('react:R --> L:tauri')
    await expect(tryParse(fixed)).resolves.toBeUndefined()
  })

  it('flowchart labels still get sanitized', () => {
    const raw = "flowchart TD\n    A['hello (world)'] --> B"
    expect(normalizeMermaidCode(raw)).toContain('A["hello (world)"]')
  })

  it('sanitizeMermaidNodeLabels breaks architecture-beta', async () => {
    await expect(tryParse(sanitizeMermaidNodeLabels(ARCH))).rejects.toThrow()
  })
})
