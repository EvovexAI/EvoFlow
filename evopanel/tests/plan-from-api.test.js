import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../src/lib/api-client.js', () => ({
  apiUrl: (p) => `http://test${p}`,
  tasksAPI: {
    getTask: vi.fn(),
    listTasks: vi.fn(),
  },
}))

import { tasksAPI } from '../src/lib/api-client.js'
import {
  fetchTaskRowByThread,
  loadBoundPlanFromApi,
  structuredPlanFromApiTask,
  syncPlanDockStateFromApi,
  invalidatePlanApiCache,
} from '../src/lib/plan-from-api.js'

function listTasksResponse(task) {
  return { success: true, data: { tasks: task ? [task] : [], total: task ? 1 : 0 } }
}

describe('plan-from-api', () => {
  beforeEach(() => {
    vi.mocked(tasksAPI.getTask).mockReset()
    vi.mocked(tasksAPI.listTasks).mockReset()
  })

  it('structuredPlanFromApiTask reads plan_goal and plan_steps from task row', () => {
    const plan = structuredPlanFromApiTask({
      plan_goal: 'API 目标',
      plan_steps: [{ name: '步骤1' }, { name: '步骤2' }],
    })
    expect(plan?.goal).toBe('API 目标')
    expect(plan?.steps).toHaveLength(2)
  })

  it('fetchTaskRowByThread calls listTasks with thread_id once', async () => {
    vi.mocked(tasksAPI.listTasks).mockResolvedValue(
      listTasksResponse({
        id: 'Task_a',
        thread_id: 'thread-1',
        plan_goal: 'g',
        plan_steps: [{ name: 's' }],
      }),
    )
    const row = await fetchTaskRowByThread('thread-1')
    expect(tasksAPI.listTasks).toHaveBeenCalledWith({ threadId: 'thread-1' })
    expect(tasksAPI.getTask).not.toHaveBeenCalled()
    expect(row?.id).toBe('Task_a')
  })

  it('loadBoundPlanFromApi uses listTasks by sessionKey', async () => {
    vi.mocked(tasksAPI.listTasks).mockResolvedValue(
      listTasksResponse({
        id: 'Task_1',
        thread_id: 'thread-abc',
        plan_goal: '从 session 查',
        plan_steps: [{ name: 'a' }],
      }),
    )
    const { plan, taskId } = await loadBoundPlanFromApi({ sessionKey: 'agent:main:new-abc' })
    expect(tasksAPI.listTasks).toHaveBeenCalledWith({ sessionKey: 'agent:main:new-abc' })
    expect(tasksAPI.getTask).not.toHaveBeenCalled()
    expect(plan?.goal).toBe('从 session 查')
    expect(taskId).toBe('Task_1')
  })

  it('syncPlanDockStateFromApi shows dock when planned and not authorized', async () => {
    vi.mocked(tasksAPI.listTasks).mockResolvedValue(
      listTasksResponse({
        id: 'Task_planned',
        thread_id: 'thread-plan',
        status: 'planned',
        plan_goal: '待授权',
        plan_steps: [{ name: 's1' }],
      }),
    )
    invalidatePlanApiCache()
    const sync = await syncPlanDockStateFromApi(
      { sessionKey: 'agent:main:plan', hintTaskId: 'Task_planned' },
      { bypassCache: true },
    )
    expect(sync.showPlanDock).toBe(true)
    expect(sync.pastPlanGate).toBe(false)
    expect(sync.plan?.goal).toBe('待授权')
  })

  it('syncPlanDockStateFromApi shows dock for planned task using name when plan_goal missing', async () => {
    vi.mocked(tasksAPI.listTasks).mockResolvedValue(
      listTasksResponse({
        id: 'Task_name_only',
        thread_id: 'thread-name',
        status: 'planned',
        name: '任务调度测试',
        description: 'Task1 先执行',
      }),
    )
    invalidatePlanApiCache()
    const sync = await syncPlanDockStateFromApi({ sessionKey: 'agent:main:name' }, { bypassCache: true })
    expect(sync.showPlanDock).toBe(true)
    expect(sync.plan?.goal).toBe('任务调度测试')
  })

  it('syncPlanDockStateFromApi hides dock when planned but execution_authorized', async () => {
    vi.mocked(tasksAPI.listTasks).mockResolvedValue(
      listTasksResponse({
        id: 'Task_auth',
        thread_id: 'thread-auth',
        status: 'planned',
        execution_authorized: true,
        plan_goal: '已授权',
        plan_steps: [{ name: 's1' }],
        subtasks: [{ id: 'Sub_1', name: 'Step 1', status: 'executing' }],
      }),
    )
    invalidatePlanApiCache()
    const sync = await syncPlanDockStateFromApi({ sessionKey: 'agent:main:auth' }, { bypassCache: true })
    expect(sync.showPlanDock).toBe(false)
    expect(sync.executionAuthorized).toBe(true)
    expect(sync.pastPlanGate).toBe(true)
  })

  it('syncPlanDockStateFromApi hides dock when executing', async () => {
    vi.mocked(tasksAPI.listTasks).mockResolvedValue(
      listTasksResponse({
        id: 'Task_run',
        thread_id: 'thread-run',
        status: 'executing',
        plan_goal: '执行中',
        plan_steps: [{ name: 's1' }],
      }),
    )
    invalidatePlanApiCache()
    const sync = await syncPlanDockStateFromApi({ sessionKey: 'agent:main:run' }, { bypassCache: true })
    expect(sync.showPlanDock).toBe(false)
    expect(sync.pastPlanGate).toBe(true)
  })

  it('syncPlanDockStateFromApi hides dock when session task is completed', async () => {
    vi.mocked(tasksAPI.listTasks).mockResolvedValue(
      listTasksResponse({
        id: 'Task_done',
        thread_id: 'thread-old',
        status: 'completed',
        execution_authorized: true,
        plan_goal: '已完成计划',
        plan_steps: [{ name: 's1' }],
      }),
    )
    invalidatePlanApiCache()
    const sync = await syncPlanDockStateFromApi(
      {
        sessionKey: 'agent:main:new-test',
        hintTaskId: 'Task_done',
        fallback: { goal: '消息里的计划', steps: [{ name: 's1' }] },
      },
      { bypassCache: true },
    )
    expect(sync.showPlanDock).toBe(false)
    expect(sync.pastPlanGate).toBe(true)
    expect(sync.taskStatus).toBe('completed')
    expect(tasksAPI.listTasks).toHaveBeenCalledWith({
      sessionKey: 'agent:main:new-test',
      preferTaskId: 'Task_done',
    })
    expect(tasksAPI.getTask).not.toHaveBeenCalled()
  })

  it('fetchTaskRowByThread bypassCache still dedupes concurrent calls', async () => {
    let resolveList
    const listPromise = new Promise((resolve) => {
      resolveList = resolve
    })
    vi.mocked(tasksAPI.listTasks).mockReturnValue(listPromise)
    const p1 = fetchTaskRowByThread('thread-dedupe', { bypassCache: true })
    const p2 = fetchTaskRowByThread('thread-dedupe', { bypassCache: true })
    resolveList(
      listTasksResponse({
        id: 'Task_dedupe',
        thread_id: 'thread-dedupe',
        plan_goal: 'once',
        plan_steps: [{ name: 's' }],
      }),
    )
    const [r1, r2] = await Promise.all([p1, p2])
    expect(tasksAPI.listTasks).toHaveBeenCalledTimes(1)
    expect(r1?.id).toBe('Task_dedupe')
    expect(r2?.id).toBe('Task_dedupe')
  })

  it('fetchTaskRowByThread does not cache empty results', async () => {
    vi.mocked(tasksAPI.listTasks).mockResolvedValue(listTasksResponse(null))
    invalidatePlanApiCache()
    await fetchTaskRowByThread('thread-empty')
    vi.mocked(tasksAPI.listTasks).mockClear()
    vi.mocked(tasksAPI.listTasks).mockResolvedValue(
      listTasksResponse({
        id: 'Task_late',
        thread_id: 'thread-empty',
        status: 'planned',
        plan_goal: 'g',
        plan_steps: [{ name: 's' }],
      }),
    )
    const row = await fetchTaskRowByThread('thread-empty')
    expect(tasksAPI.listTasks).toHaveBeenCalledTimes(1)
    expect(row?.id).toBe('Task_late')
  })

  it('fetchTaskRowByThread passes preferTaskId', async () => {
    vi.mocked(tasksAPI.listTasks).mockResolvedValue(
      listTasksResponse({
        id: 'Task_list',
        thread_id: 'thread-enrich',
        status: 'planned',
        plan_goal: '完整计划',
        plan_steps: [{ name: 's1' }],
      }),
    )
    const row = await fetchTaskRowByThread('thread-enrich', { preferTaskId: 'Task_list' })
    expect(tasksAPI.listTasks).toHaveBeenCalledWith({ threadId: 'thread-enrich', preferTaskId: 'Task_list' })
    expect(tasksAPI.getTask).not.toHaveBeenCalled()
    expect(row?.plan_goal).toBe('完整计划')
    expect(structuredPlanFromApiTask(row)).toBeTruthy()
  })
})
