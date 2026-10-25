import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import {
  clearAllRightStageOverlayDefer,
  commitRightStageClose,
  commitRightStageOpen,
  resumeStreamBumpIfIdle,
  setRightStageOverlayDefer,
} from '../src/lib/right-stage/right-stage-overlay-commit.js'
import { isChatOverlayDeferActive, setChatOverlayDefer } from '../src/lib/chat-overlay-defer.js'
import { runSidePanelHeavyMountEffect } from '../src/react/chat-app/shell/install-overlay-defer-effects.js'

vi.mock('react-dom', () => ({
  flushSync: (fn: () => void) => fn(),
}))

beforeEach(() => {
  clearAllRightStageOverlayDefer()
  setChatOverlayDefer('unrelated', false)
})

describe('right-stage-overlay-commit', () => {
  it('commitRightStageOpen defers then runs mutate', () => {
    const order: string[] = []
    commitRightStageOpen('workspace', () => {
      expect(isChatOverlayDeferActive()).toBe(true)
      order.push('mutate')
    })
    expect(order).toEqual(['mutate'])
    expect(isChatOverlayDeferActive()).toBe(true)
  })

  it('commitRightStageClose clears defer and resumes bump when idle', () => {
    setRightStageOverlayDefer('workspace', true)
    const bump = vi.fn()
    commitRightStageClose({
      clearDefer: 'workspace',
      flush: false,
      mutate: () => undefined,
      resumeBump: bump,
    })
    expect(isChatOverlayDeferActive()).toBe(false)
    expect(bump).toHaveBeenCalledTimes(1)
  })

  it('resumeStreamBumpIfIdle waits while another overlay is active', () => {
    setRightStageOverlayDefer(['workspace', 'workflow'], true)
    setRightStageOverlayDefer('workspace', false)
    const bump = vi.fn()
    resumeStreamBumpIfIdle(bump)
    expect(bump).not.toHaveBeenCalled()
    setRightStageOverlayDefer('workflow', false)
    resumeStreamBumpIfIdle(bump)
    expect(bump).toHaveBeenCalledTimes(1)
  })
})

describe('runSidePanelHeavyMountEffect', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback) => {
        cb(0)
        return 1
      },
    )
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('queueMicrotask', (cb: () => void) => cb())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not force false→true remount while a side panel stays open', () => {
    const setSidePanelHeavyMount = vi.fn()
    runSidePanelHeavyMountEffect({
      knowledgeMapEnabled: false,
      knowledgeMapPanelOpen: false,
      rightStageOpen: true,
      workspacePanelOpen: true,
      collabExecPanelOpen: false,
      setSidePanelHeavyMount,
    })
    // 旧 bug：依赖变化时先 false 再 true，file/Python 预览整页卸载闪烁
    expect(setSidePanelHeavyMount).not.toHaveBeenCalledWith(false)
    expect(setSidePanelHeavyMount).toHaveBeenCalledWith(true)
  })

  it('clears heavy mount when all side panels close', () => {
    const setSidePanelHeavyMount = vi.fn()
    runSidePanelHeavyMountEffect({
      knowledgeMapEnabled: false,
      knowledgeMapPanelOpen: false,
      rightStageOpen: false,
      workspacePanelOpen: false,
      collabExecPanelOpen: false,
      setSidePanelHeavyMount,
    })
    expect(setSidePanelHeavyMount).toHaveBeenCalledWith(false)
    expect(setSidePanelHeavyMount).not.toHaveBeenCalledWith(true)
  })
})
