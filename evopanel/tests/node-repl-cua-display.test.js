import { describe, it, expect } from 'vitest'
import { buildNodeReplDisplayModel } from '../src/zcode-ui/lib/nodeReplToolDisplay.ts'
import { cuaIconLocatorsToAppKey } from '../src/zcode-ui/lib/cuaAppIconRequest.ts'
import { readToolResultDisplay } from '../src/zcode-ui/ToolCallBlocks/toolResultDisplay.ts'

describe('cuaIconLocatorsToAppKey', () => {
  it('round-trips windows-exe locators', () => {
    expect(
      cuaIconLocatorsToAppKey([
        { kind: 'windows-executable-path', value: 'd:\\app\\Tencent\\WeChat\\Weixin.exe' },
      ]),
    ).toBe('windows-exe:d:\\app\\Tencent\\WeChat\\Weixin.exe')
  })
})

describe('readToolResultDisplay kind:cua media', () => {
  it('accepts artifactUri-only media and empty iconLocators', () => {
    const display = readToolResultDisplay({
      display: {
        kind: 'cua',
        schemaVersion: 1,
        toolName: 'computer_use',
        status: 'success',
        text: 'ok',
        media: [
          {
            mimeType: 'image/png',
            artifactUri: '/api/threads/t1/browser-snapshots/abc',
          },
        ],
        targetApp: {
          schemaVersion: 1,
          displayName: '微信',
          iconLocators: [
            {
              kind: 'windows-executable-path',
              value: 'd:\\app\\Tencent\\WeChat\\Weixin.exe',
            },
          ],
        },
      },
    })
    expect(display?.kind).toBe('cua')
    expect(display?.media?.[0]?.artifactUri).toContain('browser-snapshots')
    expect(display?.targetApp?.displayName).toBe('微信')
  })
})

describe('buildNodeReplDisplayModel evoflow cua display', () => {
  it('pulls app key and snapshot url from kind:cua display on node_repl rows', () => {
    const model = buildNodeReplDisplayModel({
      toolId: 'call_1',
      toolName: 'mcp__node_repl__js',
      kind: 'mcp__node_repl__js',
      status: 'completed',
      input: { title: '截取微信窗口画面', code: 'await page.screenshot()' },
      output: '[Screenshot captured]',
      raw: {
        toolName: 'mcp__node_repl__js',
        display: {
          kind: 'cua',
          schemaVersion: 1,
          toolName: 'computer_use',
          status: 'success',
          text: '[Screenshot captured]',
          media: [
            {
              mimeType: 'image/png',
              artifactUri: '/api/threads/t1/browser-snapshots/shot1',
            },
          ],
          targetApp: {
            schemaVersion: 1,
            displayName: '微信',
            iconLocators: [
              {
                kind: 'windows-executable-path',
                value: 'd:\\app\\Tencent\\WeChat\\Weixin.exe',
              },
            ],
          },
        },
      },
    })
    expect(model.userTitle).toBe('截取微信窗口画面')
    // 有截图时按轮尾画廊渲染，不挂 app（避免再画一整张工具卡）
    expect(model.app).toBeUndefined()
    expect(model.displaySource).toBe('browser_turn_end')
    expect(model.images).toEqual([
      {
        mimeType: 'image/png',
        url: '/api/threads/t1/browser-snapshots/shot1',
      },
    ])
  })
})
