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

  it('opens collab-workflow without sessionKey (workspace)', () => {
    const id = openProgressFromPanelSet({
      kind: 'collab-workflow',
      data: { mainTaskId: 'mt-1' },
    })
    expect(id).toBe('workflow:mt-1')
    const tabs = rightStageStore.getSnapshot().tabs
    const tab = tabs.find((t) => t.kind === 'collab-workflow')
    expect(tab?.id).toBe('workflow:mt-1')
    expect(tab?.sessionKey).toBeFalsy()
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

  it('returns empty when required data missing', () => {
    expect(openProgressFromPanelSet({ kind: 'collab-workflow', data: {} })).toBe('')
    expect(openProgressFromPanelSet({ kind: 'employeeProcess', data: { taskId: 'x' } })).toBe('')
  })
})
