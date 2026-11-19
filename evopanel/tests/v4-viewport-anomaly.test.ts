import { describe, expect, it } from 'vitest'
import {
  classifyEmptyAssistantCompleted,
  collectViewportAnomalies,
  formatAnomalyBadge,
} from '../src/react/v4/v4-viewport-anomaly.ts'

describe('collectViewportAnomalies', () => {
  const base = {
    nowMs: 1_000_000,
    tid: 'tid-1',
    scrollTop: 3000,
    scrollHeight: 3700,
    clientHeight: 615,
    executing: true,
    uiTurnSettled: false,
    history: {
      hasOlder: true,
      loadingOlder: false,
      wouldTrigger: false,
      firstRowId: 1,
      windowFirstRowId: 1997,
      windowLastRowId: 2210,
      windowCount: 130,
      totalCount: 2210,
    },
    turns: [{ orphanHeaderNoUser: false, emptyAssistantCompleted: false, hasUserInput: true }],
  }

  it('flags stream ahead of projection window', () => {
    const anomalies = collectViewportAnomalies({
      ...base,
      streamEntries: [
        {
          atMs: 999_500,
          channel: 'v4',
          sessionId: 'tid-1',
          headline: '#2219 工具入:assets',
          jsonText: '{"rowId":2219}',
        },
      ],
    })
    expect(anomalies.some((a) => a.code === 'STREAM_AHEAD_OF_WINDOW')).toBe(true)
    expect(formatAnomalyBadge(anomalies)).toContain('STREAM_AHEAD_OF_WINDOW')
  })

  it('flags rows_range success that did not advance winFirst', () => {
    const anomalies = collectViewportAnomalies({
      ...base,
      apiEntries: [
        {
          atMs: 980_000,
          path: '/api/v4/conversation/rows_range',
          ok: true,
          sessionId: 'tid-1',
          requestText: JSON.stringify({
            body: { sessionId: 'tid-1', beforeRowId: 1997, limit: 60 },
          }),
          responseText: JSON.stringify({
            rows: [{ rowId: 1937 }, { rowId: 1938 }, { rowId: 1996 }],
          }),
        },
      ],
    })
    expect(anomalies.some((a) => a.code === 'LOADOLDER_NO_ADVANCE')).toBe(true)
  })

  it('does not flag tools-before-user when user-first render heals it', () => {
    // 重启后 late-mirror 常见：tool rowId 小于 realUser；时间线 normalize 后气泡在上。
    const anomalies = collectViewportAnomalies({
      ...base,
      executing: false,
      windowRows: [
        { rowId: 1, kind: 'turnHeader', turnId: 't1', origin: 'userInput' },
        { rowId: 2, kind: 'toolCall', turnId: 't1' },
        { rowId: 3, kind: 'userInput', origin: 'realUser', turnId: 't1', text: 'hi' },
        { rowId: 4, kind: 'assistantText', turnId: 't1', text: 'ok' },
      ],
    })
    expect(anomalies.some((a) => a.code === 'LATEST_USER_BELOW_WORK')).toBe(false)
  })

  it('skips EMPTY_ASSISTANT for workflowLaunch turns', () => {
    expect(
      classifyEmptyAssistantCompleted({
        headerOrigin: 'workflowLaunch',
        headerState: 'completedSuccess',
        rows: [
          { kind: 'turnHeader', origin: 'workflowLaunch' },
          { kind: 'userInput', origin: 'workflowLaunch', text: 'Create workflow' },
        ],
      }),
    ).toBe(false)
  })

  it('flags EMPTY_ASSISTANT for completed realUser with no assistant work', () => {
    expect(
      classifyEmptyAssistantCompleted({
        headerOrigin: 'userInput',
        headerState: 'completedSuccess',
        rows: [
          { kind: 'turnHeader', origin: 'userInput' },
          { kind: 'userInput', origin: 'realUser', text: '你好' },
        ],
      }),
    ).toBe(true)
  })

  it('flags history top stuck', () => {
    const anomalies = collectViewportAnomalies({
      ...base,
      scrollTop: 0,
      history: {
        ...base.history,
        wouldTrigger: true,
      },
    })
    expect(anomalies.some((a) => a.code === 'HISTORY_TOP_STUCK')).toBe(true)
  })

  it('flags paint media buried mid-turn', () => {
    const anomalies = collectViewportAnomalies({
      ...base,
      executing: false,
      windowRows: [
        { rowId: 1, kind: 'turnHeader', turnId: 't1' },
        { rowId: 2, kind: 'userInput', origin: 'realUser', turnId: 't1', text: '画' },
        {
          rowId: 3,
          kind: 'toolCall',
          turnId: 't1',
          displayKind: 'platform_ui',
          hasMedia: true,
        },
        { rowId: 4, kind: 'toolCall', turnId: 't1' },
        { rowId: 5, kind: 'toolCall', turnId: 't1' },
        { rowId: 6, kind: 'toolCall', turnId: 't1' },
        { rowId: 7, kind: 'assistantText', turnId: 't1' },
      ],
    })
    expect(anomalies.some((a) => a.code === 'PAINT_MEDIA_BURIED')).toBe(true)
  })

  it('returns empty badge when healthy', () => {
    expect(
      formatAnomalyBadge(
        collectViewportAnomalies({
          ...base,
          executing: false,
          history: { ...base.history, hasOlder: false, firstRowId: 1997 },
        }),
      ),
    ).toBe('')
  })
})
