import { describe, expect, it } from 'vitest'
import { isChatWsEventBackground } from '../src/react/lib/chat-ws-foreground.ts'

describe('isChatWsEventBackground', () => {
  it('marks foreign session as background when main UI has a selection', () => {
    expect(
      isChatWsEventBackground({
        eventSk: 'xiaomi-1',
        uiSk: 'main-1',
        xiaomiSk: 'xiaomi-1',
      }),
    ).toBe(true)
  })

  it('keeps matching selection as foreground', () => {
    expect(
      isChatWsEventBackground({
        eventSk: 'main-1',
        uiSk: 'main-1',
        xiaomiSk: 'xiaomi-1',
      }),
    ).toBe(false)
  })

  it('forces Xiaomi events background on empty home selection', () => {
    expect(
      isChatWsEventBackground({
        eventSk: 'xiaomi-1',
        uiSk: '',
        xiaomiSk: 'xiaomi-1',
      }),
    ).toBe(true)
  })

  it('still allows new-session race: empty UI + non-Xiaomi event stays foreground', () => {
    expect(
      isChatWsEventBackground({
        eventSk: 'brand-new',
        uiSk: '',
        xiaomiSk: 'xiaomi-1',
      }),
    ).toBe(false)
  })

  it('treats Xiaomi as foreground only when main UI selected that key', () => {
    expect(
      isChatWsEventBackground({
        eventSk: 'xiaomi-1',
        uiSk: 'xiaomi-1',
        xiaomiSk: 'xiaomi-1',
      }),
    ).toBe(false)
  })
})
