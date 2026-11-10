import { describe, expect, it } from 'vitest'
import { toolOutputSchema } from '../src/zcode-shared/zcode-protocol-v4/toolDisplay.ts'
import { buildConversationTurnRenderUnits } from '../src/zcode-ui/v4/conversationTurnRenderUnits.ts'
import { readToolResultDisplay } from '../src/zcode-ui/ToolCallBlocks/toolResultDisplay.ts'
import type { ConversationRow } from '@zcode/shared/zcode-protocol-v4'

describe('platform_ui media turn-end', () => {
  const mediaDisplay = {
    kind: 'platform_ui' as const,
    schemaVersion: 1 as const,
    action: 'media.generate_image',
    title: '媒体已生成',
    media: [
      {
        kind: 'image',
        mimeType: 'image/png',
        artifactUri: 'D:/ws/out/bg.png',
        absolutePath: 'D:/ws/out/bg.png',
      },
    ],
  }

  it('keeps media on toolOutput.display (zod must not strip)', () => {
    const parsed = toolOutputSchema.parse({
      text: '{"ok":true,"absolute_path":"D:/ws/out/bg.png"}',
      display: mediaDisplay,
    })
    expect(parsed.display?.kind).toBe('platform_ui')
    expect(parsed.display && 'media' in parsed.display ? parsed.display.media : undefined).toEqual(
      mediaDisplay.media,
    )
  })

  it('readToolResultDisplay accepts media-only platform_ui', () => {
    const display = readToolResultDisplay({ display: mediaDisplay })
    expect(display?.kind).toBe('platform_ui')
    expect(display && display.kind === 'platform_ui' ? display.media?.length : 0).toBe(1)
  })

  it('promotes platform media tool row to browserTurnEndRows', () => {
    const rows: ConversationRow[] = [
      {
        rowId: 1,
        turnId: 't1',
        kind: 'turnHeader',
        origin: 'userInput',
        state: 'completedSuccess',
        startedAt: 1_000,
        endedAt: 2_000,
        createdAt: 1_000,
        createdAtSeq: 1,
      },
      {
        rowId: 2,
        turnId: 't1',
        kind: 'userInput',
        text: '生一张图',
        origin: 'realUser',
        createdAt: 1_001,
        createdAtSeq: 2,
        actions: { canEdit: false },
      },
      {
        rowId: 3,
        turnId: 't1',
        kind: 'toolCall',
        toolCallId: 'call-media-1',
        toolName: 'platform',
        status: 'success',
        input: { action: 'media.generate_image' },
        output: {
          text: '{"ok":true,"absolute_path":"D:/ws/out/bg.png"}',
          display: mediaDisplay,
        },
        createdAt: 1_002,
        createdAtSeq: 3,
      },
      {
        rowId: 4,
        turnId: 't1',
        kind: 'assistantText',
        state: 'complete',
        text: '图已生成',
        createdAt: 1_003,
        createdAtSeq: 4,
      },
    ]

    const units = buildConversationTurnRenderUnits(rows, { sessionBusy: false })
    expect(units).toHaveLength(1)
    expect(units[0].browserTurnEndRows.map((r) => r.rowId)).toEqual([3])
    expect(units[0].assistantHistoryRows.some((r) => r.rowId === 3)).toBe(false)
  })
})
