import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSubtaskDagIndex,
  extractSubtaskDependsOn,
  layoutSubtaskDagCanvas,
} from '../src/lib/collab-subtask-dag.js'

test('buildSubtaskDagIndex nests dependents under upstream by ref', () => {
  const subtasks = [
    { subtaskId: 'st-1', ref: '1', name: 'Task 1' },
    { subtaskId: 'st-2', ref: '2', name: 'Task 2', dependsOn: ['1'] },
    { subtaskId: 'st-3', ref: '3', name: 'Task 3', dependsOn: ['1'] },
  ]
  const { roots, childrenOf } = buildSubtaskDagIndex(subtasks)
  assert.deepEqual(roots, ['st-1'])
  assert.deepEqual(childrenOf.get('st-1'), ['st-2', 'st-3'])
})

test('buildSubtaskDagIndex resolves dependsOn by subtask id', () => {
  const subtasks = [
    { subtaskId: 'a', name: 'A' },
    { subtaskId: 'b', name: 'B', dependsOn: ['a'] },
  ]
  const { roots, childrenOf } = buildSubtaskDagIndex(subtasks)
  assert.deepEqual(roots, ['a'])
  assert.deepEqual(childrenOf.get('a'), ['b'])
})

test('layoutSubtaskDagCanvas positions nodes in rows with edges', () => {
  const subtasks = [
    { subtaskId: 'st-1', ref: '1', name: 'Task 1' },
    { subtaskId: 'st-2', ref: '2', name: 'Task 2', dependsOn: ['1'] },
    { subtaskId: 'st-3', ref: '3', name: 'Task 3', dependsOn: ['1'] },
  ]
  const dag = buildSubtaskDagIndex(subtasks)
  const layout = layoutSubtaskDagCanvas(dag)
  assert.equal(layout.edges.length, 2)
  const p1 = layout.positions.get('st-1')
  const p2 = layout.positions.get('st-2')
  assert.ok(p1 && p2)
  assert.ok(p2.y > p1.y, 'child should be below parent')
})

test('extractSubtaskDependsOn prefers empty worker_profile over plan dependencies refs', () => {
  const deps = extractSubtaskDependsOn({
    id: 'Subtask_a',
    ref: '2',
    dependencies: ['1'],
    worker_profile: { base_subagent: 'general-purpose', depends_on: [] },
  })
  assert.deepEqual(deps, [])
})

test('extractSubtaskDependsOn ignores dependencies when worker_profile has no depends_on field', () => {
  const deps = extractSubtaskDependsOn({
    id: 'Subtask_b',
    ref: '2',
    dependencies: ['1'],
    worker_profile: { base_subagent: 'general-purpose', tools: ['read_file'] },
  })
  assert.deepEqual(deps, [])
})

test('layoutSubtaskDagCanvas lays parallel roots out horizontally', () => {
  const subtasks = [
    { subtaskId: 'st-1', ref: '1', name: 'Task 1' },
    { subtaskId: 'st-2', ref: '2', name: 'Task 2' },
    { subtaskId: 'st-3', ref: '3', name: 'Task 3' },
  ]
  const dag = buildSubtaskDagIndex(subtasks)
  const layout = layoutSubtaskDagCanvas(dag)
  assert.equal(layout.edges.length, 0)
  const p1 = layout.positions.get('st-1')
  const p2 = layout.positions.get('st-2')
  const p3 = layout.positions.get('st-3')
  assert.ok(p1 && p2 && p3)
  assert.equal(p1.y, p2.y)
  assert.equal(p2.y, p3.y)
  assert.ok(p2.x > p1.x)
  assert.ok(p3.x > p2.x)
})

test('buildSubtaskDagIndex ignores stale dependencies when worker_profile depends_on is empty', () => {
  const subtasks = [
    {
      subtaskId: 'st-1',
      ref: '1',
      name: 'Task 1',
      worker_profile: { depends_on: [] },
    },
    {
      subtaskId: 'st-2',
      ref: '2',
      name: 'Task 2',
      dependencies: ['1'],
      worker_profile: { depends_on: [] },
    },
    {
      subtaskId: 'st-3',
      ref: '3',
      name: 'Task 3',
      dependencies: ['2'],
      worker_profile: { depends_on: [] },
    },
  ]
  const { roots, childrenOf } = buildSubtaskDagIndex(subtasks)
  assert.equal(roots.length, 3)
  assert.equal(childrenOf.size, 0)
})
