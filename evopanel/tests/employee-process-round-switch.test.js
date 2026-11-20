import { describe, it, expect, beforeEach } from 'vitest'
import { openEmployeeProcessInRightStage } from '../src/lib/right-stage/open-employee-process-stage.ts'
import { rightStageStore } from '../src/lib/right-stage/right-stage-store.ts'

describe('新轮不继承旧会话', () => {
  const SK1 = 'proactive:release-engineer:chat:2026-11-18T17-31-25.538Z'
  const SK2 = 'proactive:release-engineer:chat:2026-11-20T10-06-09.084Z'
  beforeEach(() => {
    for (const t of rightStageStore.getSnapshot().tabs || []) {
      rightStageStore.discardTab(`employeeProcess:${t.id}`)
    }
  })
  it('roundId 变了 => 不继承上一轮的 employeeSessionKey', () => {
    openEmployeeProcessInRightStage(
      { taskId: 'live:release-engineer', agentCode: 'release-engineer', roundId: 'dispatch:A', employeeSessionKey: SK1 },
      { forceExpand: true },
    )
    const k1 = rightStageStore.getSnapshot().tabs[0]
    expect(k1.data.employeeSessionKey).toBe(SK1)

    openEmployeeProcessInRightStage(
      { taskId: 'live:release-engineer', agentCode: 'release-engineer', roundId: 'dispatch:B' },
      { forceExpand: true },
    )
    const k2 = rightStageStore.getSnapshot().tabs[0]
    expect(k2.data.roundId).toBe('dispatch:B')
    expect(k2.data.employeeSessionKey).toBeFalsy()
  })
  it('roundId 相同 => 仍继承（用户手选的会话不被冲掉）', () => {
    openEmployeeProcessInRightStage(
      { taskId: 'live:release-engineer', agentCode: 'release-engineer', roundId: 'dispatch:A' },
      { forceExpand: true },
    )
    openEmployeeProcessInRightStage(
      { taskId: 'live:release-engineer', agentCode: 'release-engineer', roundId: 'dispatch:A', employeeSessionKey: SK2 },
      { forceExpand: true },
    )
    openEmployeeProcessInRightStage(
      { taskId: 'live:release-engineer', agentCode: 'release-engineer', roundId: 'dispatch:A' },
      { forceExpand: true },
    )
    const k = rightStageStore.getSnapshot().tabs[0]
    expect(k.data.employeeSessionKey).toBe(SK2)
  })

  // 【self-evolution-bot · 2026-11-20 · 第95轮 · 模型:deepseek-v4.1-flash-1017】
  // 为什么单开这两条：真实派单路径上后端根本不给 roundId（in-process 分支只回
  // 调用方传入的 round_id，Platform 工具不带），所以上面两条在现网等于没跑。
  // 现网唯一「每轮必变」的信号是 dispatched_at → 前端 roundStamp。
  it('roundStamp 变了（真实派单路径）=> 不继承上一轮的 employeeSessionKey', () => {
    openEmployeeProcessInRightStage(
      { taskId: 'live:release-engineer', agentCode: 'release-engineer', roundStamp: '2026-11-20T10:09:55.369Z', employeeSessionKey: SK1 },
      { forceExpand: true },
    )
    expect(rightStageStore.getSnapshot().tabs[0].data.employeeSessionKey).toBe(SK1)

    openEmployeeProcessInRightStage(
      { taskId: 'live:release-engineer', agentCode: 'release-engineer', roundStamp: '2026-11-20T11:20:01.000Z' },
      { forceExpand: true },
    )
    const k = rightStageStore.getSnapshot().tabs[0]
    expect(k.data.roundStamp).toBe('2026-11-20T11:20:01.000Z')
    expect(k.data.employeeSessionKey).toBeFalsy()
  })
  it('roundStamp 缺失时沿用旧值，不得误判成换轮清掉手选会话', () => {
    openEmployeeProcessInRightStage(
      { taskId: 'live:release-engineer', agentCode: 'release-engineer', roundStamp: '2026-11-20T10:09:55.369Z', employeeSessionKey: SK2 },
      { forceExpand: true },
    )
    openEmployeeProcessInRightStage(
      { taskId: 'live:release-engineer', agentCode: 'release-engineer' },
      { forceExpand: true },
    )
    const k = rightStageStore.getSnapshot().tabs[0]
    expect(k.data.roundStamp).toBe('2026-11-20T10:09:55.369Z')
    expect(k.data.employeeSessionKey).toBe(SK2)
  })
})
