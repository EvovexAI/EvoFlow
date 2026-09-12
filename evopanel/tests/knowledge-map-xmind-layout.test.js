import { describe, expect, it } from 'vitest'
import { buildKnowledgeMapTree } from '../src/lib/knowledge-map-tree.js'
import {
  branchTheme,
  edgeStyle,
  layoutXmindMindMap,
  MINIMAL_PALETTE,
} from '../src/lib/knowledge-map-xmind-layout.js'

describe('layoutXmindMindMap', () => {
  it('places root centered with alternating left/right branches', () => {
    const tree = buildKnowledgeMapTree({
      goal: 'Root goal',
      nodes: [
        { external_id: 'flow:a', kind: 'flow', title: 'Branch A', parent_external_id: 'goal:session' },
        { external_id: 'flow:b', kind: 'flow', title: 'Branch B', parent_external_id: 'goal:session' },
        { external_id: 'flow:c', kind: 'flow', title: 'Branch C', parent_external_id: 'goal:session' },
      ],
      edges: [],
    })

    const layout = layoutXmindMindMap(tree, {
      collapsedIds: new Set(),
      getVisibleChildren: (id) => tree.childrenOf.get(id) || [],
    })

    const root = layout.nodes.find((n) => n.id === tree.rootId)
    expect(root).toBeTruthy()
    expect(root?.side).toBe('center')

    const branchA = layout.nodes.find((n) => n.id === 'flow:a')
    const branchB = layout.nodes.find((n) => n.id === 'flow:b')
    const branchC = layout.nodes.find((n) => n.id === 'flow:c')

    expect(branchA?.side).toBe('right')
    expect(branchB?.side).toBe('left')
    expect(branchC?.side).toBe('right')

    expect(branchA?.x).toBeGreaterThan((root?.x ?? 0) + (root?.width ?? 0))
    expect((branchB?.x ?? 0) + (branchB?.width ?? 0)).toBeLessThan(root?.x ?? 0)
    expect(branchC?.x).toBeGreaterThan((root?.x ?? 0) + (root?.width ?? 0))

    expect(layout.edges.length).toBe(3)
    expect(layout.width).toBeGreaterThan(root?.width ?? 0)
    expect(layout.height).toBeGreaterThan(root?.height ?? 0)
  })

  it('hides edges when branch collapsed', () => {
    const tree = buildKnowledgeMapTree({
      goal: 'Goal',
      nodes: [
        { external_id: 'flow:a', kind: 'flow', title: 'A', parent_external_id: 'goal:session' },
        { external_id: 'file:x', kind: 'file', title: 'x.ts', parent_external_id: 'flow:a' },
      ],
      edges: [],
    })

    const layout = layoutXmindMindMap(tree, {
      collapsedIds: new Set(['flow:a']),
      getVisibleChildren: (id) => (new Set(['flow:a']).has(id) ? [] : tree.childrenOf.get(id) || []),
    })

    expect(layout.nodes.some((n) => n.id === 'file:x')).toBe(false)
    expect(layout.edges.some((e) => e.toId === 'file:x')).toBe(false)
  })

  it('uses minimal gray palette for theme and edges', () => {
    const theme = branchTheme()
    expect(theme.mainBg).toBe('#ffffff')
    expect(theme.mainFg).toBe('#18181b')
    expect(theme.subBorder).toBe('#e4e4e7')

    const fromRoot = edgeStyle(0, 1)
    expect(fromRoot.color).toBe(MINIMAL_PALETTE.lineFromRoot)
    expect(fromRoot.strokeWidth).toBe(2)

    const nested = edgeStyle(1, 2)
    expect(nested.color).toBe(MINIMAL_PALETTE.line)
  })
})
