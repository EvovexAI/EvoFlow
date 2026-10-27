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
    expect(id).toBe('process:mt-2')
    const tab = rightStageStore.getSnapshot().tabs.find((t) => t.kind === 'employeeProcess')
    expect(tab?.data?.agentCode).toBe('duty-ops')
    expect(tab?.sessionKey).toBeFalsy()
  })

  it('opens employeeProcess with agent only (dispatch/wake without taskId)', () => {
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
    expect(rightStageStore.getSnapshot().collapsed).toBe(false)
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
    expect(id).toBe('process:mt-role')
    const tab = rightStageStore.getSnapshot().tabs.find((t) => t.kind === 'employeeProcess')
    expect(tab?.title).toBe('值班小助手')
    expect(tab?.data?.roleName).toBe('值班小助手')
  })

  it('returns empty when required data missing', () => {
    expect(openProgressFromPanelSet({ kind: 'collab-workflow', data: {} })).toBe('')
    expect(openProgressFromPanelSet({ kind: 'employeeProcess', data: { taskId: 'x' } })).toBe('')
  })
})
