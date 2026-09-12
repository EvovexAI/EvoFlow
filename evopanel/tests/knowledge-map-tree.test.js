import { describe, expect, it } from 'vitest'
import { buildKnowledgeMapTree, nodeDisplayTitle, sortProcessingNodes } from '../src/lib/knowledge-map-tree.js'
import { layoutXmindMindMap } from '../src/lib/knowledge-map-xmind-layout.js'

describe('buildKnowledgeMapTree', () => {
  it('groups orphan notes under kind branch from root', () => {
    const tree = buildKnowledgeMapTree({
      goal: '分析上传问题',
      nodes: [
        { external_id: 'note:a', kind: 'note', body: 'step a' },
        { external_id: 'flow:auth', kind: 'flow', title: 'Auth' },
        { external_id: 'file:x', kind: 'file', title: 'x.ts', parent_external_id: 'flow:auth' },
      ],
      edges: [],
    })
    const rootKids = tree.childrenOf.get(tree.rootId) || []
    expect(rootKids).toContain('__km_kind__note')
    expect(rootKids).toContain('__km_kind__flow')
    expect(tree.childrenOf.get('__km_kind__note')).toContain('note:a')
    expect(tree.childrenOf.get('flow:auth')).toContain('file:x')
    expect(tree.syntheticLabel(tree.rootId)).toBe('分析上传问题')
  })

  it('nodeDisplayTitle prefers title then body', () => {
    expect(nodeDisplayTitle({ title: 'T', body: 'B' }, 'id')).toBe('T')
    expect(nodeDisplayTitle({ body: 'body only' }, 'id')).toBe('body only')
  })

  it('rejects parent cycles that would blow recursive layout', () => {
    const tree = buildKnowledgeMapTree({
      goal: 'cycle',
      nodes: [
        { external_id: 'a', kind: 'flow', title: 'A', parent_external_id: 'b' },
        { external_id: 'b', kind: 'flow', title: 'B', parent_external_id: 'a' },
      ],
      edges: [],
    })
    const aKids = tree.childrenOf.get('a') || []
    const bKids = tree.childrenOf.get('b') || []
    expect(aKids.includes('b') && bKids.includes('a')).toBe(false)

    const layout = layoutXmindMindMap(tree, {
      collapsedIds: new Set(),
      getVisibleChildren: (id) => tree.childrenOf.get(id) || [],
    })
    expect(layout.nodes.length).toBeGreaterThan(0)
  })
})

describe('sortProcessingNodes', () => {
  it('sorts by updated_at descending (newest first)', () => {
    const sorted = sortProcessingNodes([
      { external_id: 'flow:old', kind: 'flow', status: 'active', updated_at: '2026-07-01T10:00:00.000Z' },
      { external_id: 'task:new', kind: 'task', status: 'active', updated_at: '2026-07-06T12:00:00.000Z' },
      { external_id: 'gap:mid', kind: 'gap', status: 'stale', updated_at: '2026-07-04T08:00:00.000Z' },
    ])
    expect(sorted.map((n) => n.external_id)).toEqual(['task:new', 'gap:mid', 'flow:old'])
  })

  it('excludes goal and non-processing nodes', () => {
    const sorted = sortProcessingNodes([
      { external_id: 'goal:session', kind: 'goal', status: 'active' },
      { external_id: 'flow:a', kind: 'flow', status: 'resolved' },
      { external_id: 'file:x', kind: 'file', status: 'active', updated_at: '2026-07-06T13:00:00.000Z' },
      { external_id: 'flow:b', kind: 'flow', status: 'active', updated_at: '2026-07-06T12:00:00.000Z' },
    ])
    expect(sorted.map((n) => n.external_id)).toEqual(['flow:b'])
  })
})
