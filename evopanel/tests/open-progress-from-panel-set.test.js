import { afterEach, describe, expect, it } from 'vitest'
import { rightStageStore } from '../src/lib/right-stage/right-stage-store.js'
import {
  isProgressStageKind,
  openProgressFromPanelSet,
} from '../src/lib/right-stage/open-progress-from-panel-set.ts'

describe('openProgressFromPanelSet', () => {
  afterEach(() => {
    rightStageStore.hideAll()
  })

  it('recognizes progress kinds', () => {
    expect(isProgressStageKind('collab-workflow')).toBe(true)
    expect(isProgressStageKind('employeeProcess')).toBe(true)
    expect(isProgressStageKind('collabSubtaskTranscript')).toBe(true)
    expect(isProgressStageKind('browser')).toBe(false)
  })

  it('opens collab-workflow and stamps explicit sessionKey', () => {
    const id = openProgressFromPanelSet(
      {
        kind: 'collab-workflow',
        data: { mainTaskId: 'mt-1' },
      },
      { sessionKey: 'sess-a' },
    )
    expect(id).toBe('workflow:mt-1')
    const tabs = rightStageStore.getSnapshot().tabs
    const tab = tabs.find((t) => t.kind === 'collab-workflow')
    expect(tab?.id).toBe('workflow:mt-1')
    expect(tab?.sessionKey).toBe('sess-a')
    expect(tab?.data?.mainTaskId).toBe('mt-1')
  })

  it('opens employeeProcess with required fields', () => {
    const id = openProgressFromPanelSet({
      kind: 'employeeProcess',
      title: '值班过程',
      data: { taskId: 'mt-2', agentCode: 'duty-ops', busy: true },
    })
    // 对话侧一人一签：不按 wake taskId 拆签
    expect(id).toBe('process:live:duty-ops')
    const tab = rightStageStore.getSnapshot().tabs.find((t) => t.kind === 'employeeProcess')
    expect(tab?.data?.agentCode).toBe('duty-ops')
    expect(tab?.data?.taskId).toBe('mt-2')
    expect(tab?.sessionKey).toBeFalsy()
  })

  it('stacks one tab per employee when opening two follow-ups', () => {
    openProgressFromPanelSet(
      {
        kind: 'employeeProcess',
        data: { taskId: 't-a', agentCode: 'dev-a', roleName: '全栈工程师', busy: true },
      },
      { sessionKey: 'sess-main' },
    )
    openProgressFromPanelSet(
      {
        kind: 'employeeProcess',
        data: { taskId: 't-b', agentCode: 'dev-b', roleName: '测试工程师', busy: true },
      },
      { sessionKey: 'sess-main' },
    )
    const tabs = rightStageStore
      .getSnapshot()
      .tabs.filter((t) => t.kind === 'employeeProcess')
    expect(tabs.map((t) => t.id).sort()).toEqual([
      'process:live:dev-a',
      'process:live:dev-b',
    ])
    expect(tabs.every((t) => t.sessionKey === 'sess-main')).toBe(true)
  })

  it('reuses the same tab when the same employee is opened again with a new taskId', () => {
    openProgressFromPanelSet(
      {
        kind: 'employeeProcess',
        data: { taskId: 't-1', agentCode: 'dev-a', roleName: '全栈', busy: true },
      },
      { sessionKey: 'sess-main' },
    )
    openProgressFromPanelSet(
      {
        kind: 'employeeProcess',
        data: { taskId: 't-2', agentCode: 'dev-a', roleName: '全栈', busy: true },
      },
      { sessionKey: 'sess-main' },
    )
    const tabs = rightStageStore
      .getSnapshot()
      .tabs.filter((t) => t.kind === 'employeeProcess')
    expect(tabs).toHaveLength(1)
    expect(tabs[0].id).toBe('process:live:dev-a')
    expect(tabs[0].data?.taskId).toBe('t-2')
  })

  it('opens employeeProcess with agent only (dispatch/wake without taskId)', () => {
    // afterEach 的 hideAll 会钉住收起锁；先归位再显式锁定，保证用例自洽。
    rightStageStore.hideAll()
    const id = openProgressFromPanelSet({
      kind: 'employeeProcess',
      title: '值班',
      data: { agentCode: 'duty-ops', roleName: '值班小助手', busy: true },
    })
    expect(id).toBe('process:live:duty-ops')
    const tab = rightStageStore.getSnapshot().tabs.find((t) => t.kind === 'employeeProcess')
    expect(tab?.data?.agentCode).toBe('duty-ops')
    expect(tab?.data?.taskId).toBeFalsy()
    expect(tab?.title).toBe('值班小助手')
    // f31b7138 起收起锁不被 autoOpen 抢回：panel_set 员工签只写入不强行撑开。
    expect(rightStageStore.getSnapshot().collapsed).toBe(true)
  })

  it('drops caller main sessionKey so employee pane cannot pin left chat stream', () => {
    const id = openProgressFromPanelSet(
      {
        kind: 'employeeProcess',
        title: '技术总监',
        data: {
          agentCode: 'dev-tech-director',
          roleName: '技术总监',
          sessionKey: 'agent:main:new-10a8acbd',
          busy: true,
        },
      },
      { sessionKey: 'agent:main:new-10a8acbd' },
    )
    expect(id).toBe('process:live:dev-tech-director')
    const tab = rightStageStore.getSnapshot().tabs.find((t) => t.kind === 'employeeProcess')
    expect(tab?.sessionKey).toBe('agent:main:new-10a8acbd')
    expect(tab?.data?.employeeSessionKey).toBeFalsy()
  })

  it('keeps owned proactive employeeSessionKey', () => {
    openProgressFromPanelSet({
      kind: 'employeeProcess',
      data: {
        agentCode: 'dev-qa',
        sessionKey: 'proactive:dev-qa:chat:x1',
        busy: true,
      },
    })
    const tab = rightStageStore.getSnapshot().tabs.find((t) => t.kind === 'employeeProcess')
    expect(tab?.data?.employeeSessionKey).toBe('proactive:dev-qa:chat:x1')
  })

  it('opens shell-page /employees as proactive board', () => {
    const id = openProgressFromPanelSet({
      kind: 'shell-page',
      data: { path: '/employees', mountId: 'employees.board' },
    })
    expect(id).toBe('shell:/proactive')
    const tab = rightStageStore.getSnapshot().tabs.find((t) => t.kind === 'shell-page')
    expect(tab?.data?.path).toBe('/proactive')
    expect(tab?.sessionKey).toBeFalsy()
  })

  it('employeeProcess tab title prefers roleName over task title', () => {
    const id = openProgressFromPanelSet({
      kind: 'employeeProcess',
      title: '某个任务名',
      data: {
        taskId: 'mt-role',
        agentCode: 'duty-ops',
        roleName: '值班小助手',
        busy: true,
      },
    })
    expect(id).toBe('process:live:duty-ops')
    const tab = rightStageStore.getSnapshot().tabs.find((t) => t.kind === 'employeeProcess')
    expect(tab?.title).toBe('值班小助手')
    expect(tab?.data?.roleName).toBe('值班小助手')
  })

  it('returns empty when required data missing', () => {
    expect(openProgressFromPanelSet({ kind: 'collab-workflow', data: {} })).toBe('')
    expect(openProgressFromPanelSet({ kind: 'employeeProcess', data: { taskId: 'x' } })).toBe('')
  })
})

// 【self-evolution-bot · 2026-11-20 · 第95轮 · 模型:deepseek-v4.1-flash-1017】
// 改了什么：新增 3 组回归测试，锁死「expand 必须真的把新签切为激活」与
// 「sessionRuntime 必须有实现」两条判据。
// 为什么：本轮现网矩阵实测（8 kind 全量）暴露三处真缺陷：
//   ① collabSubtaskTranscript 的 open 选项里没有 forceExpand → 只建签不激活；
//   ② employeeProcess 分支只传 sessionKey/layout，forceExpand 被吞 → 同上；
//   ③ sessionRuntime 在 isProgressStageKind 名单里、契约真源也要求 data.sessionKey，
//      但 openProgressFromPanelSet 里**没有实现分支** → ui.show 静默丢弃、标签不出现。
// 这三条的共同症状都是「工具回 ok:true，用户屏幕上什么都没变」，所以断言必须落在
// store 的 activeKey 上，不能只断言「标签存在」——标签存在正是当时的假绿来源。
describe('expand 必须真的激活新签（第95轮矩阵实测缺陷回归）', () => {
  const SK = 'proactive:probe-bot:chat:2026-11-20T00-00-00.000Z'

  afterEach(() => {
    rightStageStore.hideAll()
  })

  /** 先钉在 A 签上，模拟「用户正看着别的面板」。 */
  function pinOtherTab() {
    rightStageStore.show({ kind: 'shell-page', id: 'shell:/tasks', title: '任务', sessionKey: SK })
    rightStageStore.activateTab('shell-page:shell:/tasks')
    expect(rightStageStore.getSnapshot().activeKey).toBe('shell-page:shell:/tasks')
  }

  it('collabSubtaskTranscript + forceExpand 切到新签', () => {
    pinOtherTab()
    const id = openProgressFromPanelSet(
      {
        kind: 'collabSubtaskTranscript',
        title: '节点进度',
        data: { mainTaskId: 'mt-x', subtaskId: 'sub-x' },
      },
      { sessionKey: SK, forceExpand: true },
    )
    expect(id).toBe('collabSubtaskTranscript:sub-x')
    expect(rightStageStore.getSnapshot().activeKey).toBe(`collabSubtaskTranscript:${id}`)
  })

  it('collabSubtaskTranscript 不带 forceExpand 时只写签不抢激活（保持既有语义）', () => {
    pinOtherTab()
    openProgressFromPanelSet(
      {
        kind: 'collabSubtaskTranscript',
        data: { mainTaskId: 'mt-y', subtaskId: 'sub-y' },
      },
      { sessionKey: SK },
    )
    // 用户已钉在别的签上：auto show 不得抢走视线
    expect(rightStageStore.getSnapshot().activeKey).toBe('shell-page:shell:/tasks')
    expect(
      rightStageStore.getSnapshot().tabs.some((t) => t.id === 'collabSubtaskTranscript:sub-y'),
    ).toBe(true)
  })

  it('employeeProcess + forceExpand 切到新签', () => {
    pinOtherTab()
    const id = openProgressFromPanelSet(
      { kind: 'employeeProcess', data: { agentCode: 'probe-bot', busy: true } },
      { sessionKey: SK, forceExpand: true },
    )
    expect(id).toBe('process:live:probe-bot')
    expect(rightStageStore.getSnapshot().activeKey).toBe(`employeeProcess:${id}`)
  })

  it('sessionRuntime 有实现：按 data.sessionKey 建签并激活', () => {
    pinOtherTab()
    const id = openProgressFromPanelSet(
      { kind: 'sessionRuntime', data: { sessionKey: SK } },
      { sessionKey: SK, forceExpand: true },
    )
    expect(id).toBe(`sessionRuntime:${SK}`)
    const tab = rightStageStore.getSnapshot().tabs.find((t) => t.kind === 'sessionRuntime')
    expect(tab?.data?.sessionKey).toBe(SK)
    expect(rightStageStore.getSnapshot().activeKey).toBe(`sessionRuntime:${id}`)
  })

  it('sessionRuntime 缺 sessionKey 时返回空串（不静默建残签）', () => {
    expect(openProgressFromPanelSet({ kind: 'sessionRuntime', data: {} })).toBe('')
  })
})
