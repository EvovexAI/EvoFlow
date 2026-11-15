import { describe, it, vi, beforeEach } from 'vitest'
import assert from 'node:assert/strict'
import { renderHook, waitFor } from '@testing-library/react'

vi.mock('../src/lib/collab-subtasks-from-api.js', () => ({
  fetchCollabWorkflowFromApi: vi.fn(),
}))

import { fetchCollabWorkflowFromApi } from '../src/lib/collab-subtasks-from-api.js'
import { useCollabSubtasksFromApi } from '../src/react/hooks/useCollabSubtasksFromApi.js'

const RUNNING_BUNDLE = {
  subtasks: [{ subtaskId: 'Sub_1', parentTaskId: 'Task_1', name: 'A', status: 'running' }],
  mainTask: { taskId: 'Task_1', name: '主任务', status: 'running' },
}

describe('useCollabSubtasksFromApi 拉取失败韧性', () => {
  beforeEach(() => {
    vi.mocked(fetchCollabWorkflowFromApi).mockReset()
  })

  it('一次 fetch 失败不清空 bundle、轮询不自杀（继续重试）', async () => {
    // [ok, fail, ok]：旧实现第二次失败会清空 bundle → workflowLooksActive 翻
    // false → setInterval 不再递增 → 轮询永久停止。修后保留旧值继续轮询。
    vi.mocked(fetchCollabWorkflowFromApi)
      .mockResolvedValueOnce(RUNNING_BUNDLE)
      .mockRejectedValueOnce(new Error('gateway 503'))
      .mockResolvedValue(RUNNING_BUNDLE)

    const { result } = renderHook(() =>
      useCollabSubtasksFromApi({
        taskId: 'Task_1',
        threadId: null,
        sessionKey: 'sk-1',
        enabled: true,
        pollMs: 40,
      }),
    )

    await waitFor(() => assert.ok(result.current.mainTask), { timeout: 3000 })
    const callsAfterFirst = vi.mocked(fetchCollabWorkflowFromApi).mock.calls.length

    // 至少经历一次失败 + 一次后续成功：证明轮询活着且 bundle 未被清空。
    await waitFor(
      () => assert.ok(vi.mocked(fetchCollabWorkflowFromApi).mock.calls.length >= callsAfterFirst + 2),
      { timeout: 3000 },
    )
    assert.ok(result.current.mainTask, '失败后 bundle 不得清空')
    assert.equal(result.current.mainTask?.taskId, 'Task_1')
  })
})
