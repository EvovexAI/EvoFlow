import { describe, expect, it } from 'vitest'
import { appRunControlFlags } from '../src/lib/app-run-controls.js'

describe('appRunControlFlags', () => {
  it('terminal hides all controls', () => {
    expect(appRunControlFlags('completed')).toEqual({
      canPause: false,
      canResume: false,
      canCancel: false,
      isTerminal: true,
    })
    expect(appRunControlFlags('cancelled').isTerminal).toBe(true)
  })

  it('paused allows resume + cancel', () => {
    expect(appRunControlFlags('paused')).toEqual({
      canPause: false,
      canResume: true,
      canCancel: true,
      isTerminal: false,
    })
  })

  it('executing allows pause + cancel', () => {
    expect(appRunControlFlags('executing')).toEqual({
      canPause: true,
      canResume: false,
      canCancel: true,
      isTerminal: false,
    })
  })
})
