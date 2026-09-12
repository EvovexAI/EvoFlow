import { describe, expect, it } from 'vitest'
import {
  USER_NODE_STATUS_OPTIONS,
  canUserEditNodeStatus,
  filterProcessingNodes,
  isUserPatchableStatus,
  shouldDisplayNodeStatus,
} from '../src/lib/knowledge-map-node-status.js'
import { isProcessingNodeStatus, nodeStatusLabel } from '../src/lib/knowledge-map-tree.js'

describe('knowledge-map-node-status', () => {
  it('parked is not processing but has label', () => {
    expect(isProcessingNodeStatus('parked')).toBe(false)
    expect(nodeStatusLabel('parked')).toBe('搁置')
  })

  it('user can edit tracked kinds only', () => {
    expect(canUserEditNodeStatus('flow:auth', 'flow')).toBe(true)
    expect(canUserEditNodeStatus('gap:x', 'gap')).toBe(true)
    expect(canUserEditNodeStatus('file:x.js', 'file')).toBe(false)
    expect(canUserEditNodeStatus('note:a', 'note')).toBe(false)
    expect(canUserEditNodeStatus('goal:session')).toBe(false)
    expect(canUserEditNodeStatus('__km_kind__note')).toBe(false)
  })

  it('filterProcessingNodes includes tracked kinds only and hides closed ancestors', () => {
    const nodes = [
      { external_id: 'flow:parent', kind: 'flow', status: 'resolved', parent_external_id: 'goal:session' },
      { external_id: 'gap:child', kind: 'gap', status: 'active', parent_external_id: 'flow:parent' },
      { external_id: 'file:x', kind: 'file', status: 'active', parent_external_id: 'flow:open' },
      { external_id: 'flow:open', kind: 'flow', status: 'active', parent_external_id: 'goal:session', updated_at: '2026-07-06T12:00:00.000Z' },
    ]
    const filtered = filterProcessingNodes(nodes)
    expect(filtered.map((n) => n.external_id)).toEqual(['flow:open'])
  })

  it('shouldDisplayNodeStatus is tracked kinds only', () => {
    expect(shouldDisplayNodeStatus('flow', 'flow:a')).toBe(true)
    expect(shouldDisplayNodeStatus('file', 'file:x')).toBe(false)
    expect(shouldDisplayNodeStatus('note', 'note:a')).toBe(false)
  })

  it('user patchable excludes stale', () => {
    expect(isUserPatchableStatus('parked')).toBe(true)
    expect(isUserPatchableStatus('stale')).toBe(false)
    expect(USER_NODE_STATUS_OPTIONS[0].value).toBe('parked')
  })
})
