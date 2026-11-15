import { describe, it } from 'vitest'
import assert from 'node:assert/strict'

import {
  childWorkStatusById,
  mergeWorkflowRunsWithChildWorks,
} from '../src/lib/childWorkWorkflowBridge.js'

function snapshotRun(runId, status) {
  return {
    runId,
    status,
    actors: [],
    nodes: [],
  }
}

describe('child-work-workflow-bridge merge', () => {
  it('childWorkStatusById 收集 workflow 项的 taskId→状态', () => {
    const map = childWorkStatusById([
      { workId: 'w1', kind: 'workflow', status: 'running', extra: { task_id: 'Task_1' } },
      { workId: 'w2', kind: 'subagent', status: 'running', extra: { task_id: 'Task_2' } },
      { workId: 'w3', kind: 'workflow', status: 'completed', extra: { taskId: 'Task_3' } },
      { workId: 'w4', kind: 'workflow', status: 'failed', extra: {} },
    ])
    assert.equal(map.size, 2)
    assert.equal(map.get('Task_1'), 'running')
    assert.equal(map.get('Task_3'), 'completed')
  })

  it('execution/state 终态压过陈旧 running 快照（无 mirror 喂流的 run 终态不进投影）', () => {
    const merged = mergeWorkflowRunsWithChildWorks(
      [snapshotRun('Task_1', 'running'), snapshotRun('Task_9', 'running')],
      [],
      new Map([
        ['Task_1', 'completed'],
        ['Task_9', 'failed'],
      ]),
    )
    const byId = new Map(merged.map((r) => [r.runId, r.status]))
    assert.equal(byId.get('Task_1'), 'completed')
    assert.equal(byId.get('Task_9'), 'errored')
  })

  it('快照已终态时保持 snapshot 权威（反方向不覆盖，避免抖动）', () => {
    const merged = mergeWorkflowRunsWithChildWorks(
      [snapshotRun('Task_1', 'completed')],
      [],
      new Map([['Task_1', 'running']]),
    )
    assert.equal(merged[0].status, 'completed')
  })

  it('无 childWorks 证据时不改快照（轮询失败/空列表不误伤）', () => {
    const merged = mergeWorkflowRunsWithChildWorks(
      [snapshotRun('Task_1', 'running')],
      [],
      new Map(),
    )
    assert.equal(merged[0].status, 'running')
  })

  it('映射覆盖 cancelled/stopped → stopped', () => {
    const merged = mergeWorkflowRunsWithChildWorks(
      [snapshotRun('Task_1', 'running')],
      [],
      new Map([['Task_1', 'cancelled']]),
    )
    assert.equal(merged[0].status, 'stopped')
  })
})
