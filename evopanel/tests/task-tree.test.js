import { describe, expect, it } from 'vitest'
import {
  buildTaskForest,
  childRollup,
  flattenTaskRows,
  formatDownstreamHint,
  rootTasksOnly,
  selectRootTasks,
} from '../src/lib/task-tree.js'
import { toTaskStatusGroup } from '../src/lib/task-status-label.js'

describe('buildTaskForest', () => {
  it('treats parentless and orphan rows as roots', () => {
    const tasks = [
      { id: 'root', name: '根', status: 'awaiting_close' },
      { id: 'child', name: '子', status: 'completed', parent_task_id: 'root' },
      { id: 'orphan', name: '孤儿', status: 'executing', parent_task_id: 'missing' },
    ]
    const forest = buildTaskForest(tasks)
    expect(forest.roots.map((t) => t.id).sort()).toEqual(['orphan', 'root'])
    expect(forest.childrenByParent.get('root').map((t) => t.id)).toEqual(['child'])
  })
})

describe('childRollup / formatDownstreamHint', () => {
  it('counts awaiting_close as terminal for sibling rollup', () => {
    const forest = buildTaskForest([
      { id: 'p', status: 'awaiting_close' },
      { id: 'a', parent_task_id: 'p', status: 'awaiting_close' },
      { id: 'b', parent_task_id: 'p', status: 'executing' },
      { id: 'c', parent_task_id: 'p', status: 'completed' },
    ])
    const r = childRollup(forest, 'p')
    expect(r).toMatchObject({ total: 3, done: 2, open: 1, all_done: false })
    expect(formatDownstreamHint(r)).toBe('下游 2/3 已结')
  })

  it('shows accept hint when all children terminal', () => {
    const forest = buildTaskForest([
      { id: 'p', status: 'awaiting_close' },
      { id: 'a', parent_task_id: 'p', status: 'completed' },
      { id: 'b', parent_task_id: 'p', status: 'failed' },
    ])
    expect(formatDownstreamHint(childRollup(forest, 'p'))).toContain('待验收闭环')
  })
})

describe('selectRootTasks', () => {
  const tasks = [
    { id: 'pm', name: '产品方案', status: 'awaiting_close', assigned_to: 'product-manager', source: 'role' },
    { id: 'arch', name: '总监编排', status: 'awaiting_close', assigned_to: 'project-architect', parent_task_id: 'pm', source: 'role' },
    { id: 'fe', name: '前端', status: 'completed', assigned_to: 'code-agent', parent_task_id: 'arch', source: 'role' },
    { id: 'solo', name: '独立任务', status: 'completed', assigned_to: 'code-agent', source: 'chat' },
  ]

  it('lists only roots and filters completed by root status', () => {
    const { roots } = selectRootTasks(tasks, {
      statusFilter: 'completed',
      sourceKey: (t) => String(t.source || ''),
    })
    expect(roots.map((t) => t.id)).toEqual(['solo'])
  })

  it('keeps awaiting_close roots in executing group filter', () => {
    expect(toTaskStatusGroup('awaiting_close')).toBe('executing')
    const { roots } = selectRootTasks(tasks, {
      statusFilter: 'executing',
      sourceKey: (t) => String(t.source || ''),
    })
    expect(roots.map((t) => t.id)).toEqual(['pm'])
  })

  it('pulls root when searching a child and marks expand ancestors', () => {
    const { roots, autoExpandIds } = selectRootTasks(tasks, {
      textQuery: '前端',
      sourceKey: (t) => String(t.source || ''),
      taskMatchesText: (t, q) => String(t.name || '').includes(q),
    })
    expect(roots.map((t) => t.id)).toEqual(['pm'])
    expect(autoExpandIds).toEqual(expect.arrayContaining(['pm', 'arch']))
  })
})

describe('flattenTaskRows', () => {
  it('nests direct children when expanded', () => {
    const forest = buildTaskForest([
      { id: 'r', status: 'awaiting_close' },
      { id: 'c1', parent_task_id: 'r', status: 'executing' },
      { id: 'c2', parent_task_id: 'r', status: 'completed' },
    ])
    const closed = flattenTaskRows([{ id: 'r', status: 'awaiting_close' }], forest, new Set())
    expect(closed.map((x) => x.task.id)).toEqual(['r'])
    const open = flattenTaskRows([{ id: 'r', status: 'awaiting_close' }], forest, new Set(['r']))
    expect(open.map((x) => [x.task.id, x.depth])).toEqual([
      ['r', 0],
      ['c1', 1],
      ['c2', 1],
    ])
  })
})

describe('rootTasksOnly', () => {
  it('drops children from status-card counts', () => {
    const roots = rootTasksOnly([
      { id: 'r', status: 'awaiting_close' },
      { id: 'c', parent_task_id: 'r', status: 'completed' },
    ])
    expect(roots).toHaveLength(1)
    expect(roots[0].id).toBe('r')
  })
})
