import { describe, it, expect, beforeEach } from 'vitest'
import { openProgressFromPanelSet } from '../src/lib/right-stage/open-progress-from-panel-set.ts'
import { rightStageStore } from '../src/lib/right-stage/right-stage-store.ts'

// 【self-evolution-bot · 2026-11-20 · 第95轮 · 模型:deepseek-v4.1-flash-1017】
// 这条测的是**端到端契约**，不是函数内部：
// 左侧 surface 用的是后端 `_progress_open_stage_action("employees.dispatch", ...)`
// 的真实产出（已用 python 现跑取证：data = {taskId:"live:code", agentCode, busy,
// roundStamp, roleName, title, entityLabel}，round_id 恒 None 所以 data 里没有 roundId）。
// 用户明确要求：同一个对话里连续派两单，右栏要跟到**新那一单**，不许钉着上次手挑的历史会话。
describe('派单 CTA 端到端（后端真报文形状）', () => {
  const SK_OLD = 'proactive:release-engineer:chat:2026-11-18T17-31-25.538Z'

  const ctaSurface = (roundStamp) => ({
    kind: 'employeeProcess',
    title: '发版工程师',
    layout: 'wide',
    data: {
      taskId: 'live:release-engineer',
      agentCode: 'release-engineer',
      busy: true,
      roundStamp,
      roleName: '发版工程师',
      title: '发版工程师',
      entityLabel: '发版工程师',
    },
  })

  beforeEach(() => {
    for (const t of rightStageStore.getSnapshot().tabs || []) {
      rightStageStore.discardTab(`employeeProcess:${t.id}`)
    }
  })

  it('同一对话连派两单：第二单必须切到新轮次，不再沿用上一单手挑的会话', () => {
    // 第 1 单：用户在这个面板里手挑过一条历史对话（签上带 employeeSessionKey）
    openProgressFromPanelSet(ctaSurface('2026-11-20T19:10:00.000000+08:00'), { forceExpand: true })
    // tab 对象没有 key 字段，键按 `${kind}:${id}` 拼（与 store.tabKeyOf 同口径）
    const t0 = rightStageStore.getSnapshot().tabs[0]
    const tabKey = `${t0.kind}:${t0.id}`
    rightStageStore.patchTab(tabKey, { data: { employeeSessionKey: SK_OLD } })
    expect(rightStageStore.findTab(tabKey).data.employeeSessionKey).toBe(SK_OLD)

    // 第 2 单：同一 agent、同一占位 taskId，只有 roundStamp 变了
    openProgressFromPanelSet(ctaSurface('2026-11-20T19:20:00.000000+08:00'), { forceExpand: true })
    const tab = rightStageStore.findTab(tabKey)
    expect(tab.data.roundStamp).toBe('2026-11-20T19:20:00.000000+08:00')
    expect(tab.data.employeeSessionKey).toBeFalsy()
  })

  it('同一单重复推送（roundStamp 未变）仍保留手挑会话', () => {
    const stamp = '2026-11-20T19:10:00.000000+08:00'
    openProgressFromPanelSet(ctaSurface(stamp), { forceExpand: true })
    // tab 对象没有 key 字段，键按 `${kind}:${id}` 拼（与 store.tabKeyOf 同口径）
    const t0 = rightStageStore.getSnapshot().tabs[0]
    const tabKey = `${t0.kind}:${t0.id}`
    rightStageStore.patchTab(tabKey, { data: { employeeSessionKey: SK_OLD } })

    openProgressFromPanelSet(ctaSurface(stamp), { forceExpand: true })
    expect(rightStageStore.findTab(tabKey).data.employeeSessionKey).toBe(SK_OLD)
  })
})
