import {
  bodyTextWithoutMermaid,
  diagramTypeLabel,
  extractMermaidFromNode,
  nodeHasDiagram,
  resolveNodeDiagramType,
} from '../../lib/knowledge-map-diagram.js'
import type { KnowledgeMapNode } from '../hooks/useKnowledgeMap.js'
import { KnowledgeMapDiagramView } from './KnowledgeMapDiagramView.js'

export function KnowledgeMapNodeBodyContent({
  node,
  compact = false,
  fallbackEmpty = '暂无详细描述',
}: {
  node: KnowledgeMapNode | Record<string, unknown> | null | undefined
  compact?: boolean
  fallbackEmpty?: string
}) {
  const body = String(node?.body || '').trim()
  const hasDiagram = nodeHasDiagram(node)
  const mermaidCode = extractMermaidFromNode(node)
  const textOnly = bodyTextWithoutMermaid(body)
  const title = String(node?.title || '').trim()
  const showText = Boolean(textOnly && textOnly !== title)
  const diagramLabel = hasDiagram ? diagramTypeLabel(resolveNodeDiagramType(node)) : ''

  if (!hasDiagram && !showText) {
    return <p className="km-node-body-empty">{fallbackEmpty}</p>
  }

  return (
    <div className={`km-node-body-content${compact ? ' km-node-body-content--compact' : ''}`}>
      {hasDiagram ? (
        <KnowledgeMapDiagramView code={mermaidCode} compact={compact} label={diagramLabel} />
      ) : null}
      {showText ? <p className="km-node-body-text">{textOnly}</p> : null}
    </div>
  )
}
