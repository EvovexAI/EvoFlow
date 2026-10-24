import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 常驻挂载白名单的语义守卫。
 *
 * 入列标准是「重建成本高或会丢状态」，不是「它是右栏面板」。
 * 一旦有人因为方便把低频/纯展示面板加回来，失活标签就会持续联网或占内存，
 * 这类回归在功能测试里看不出来，只能靠这条断言拦住。
 */
const SOURCE = readFileSync(
  resolve(__dirname, '../src/react/components/RightStagePanel.tsx'),
  'utf8',
)

function forcedKinds(): string[] {
  const block = SOURCE.match(/const FORCE_MOUNT_KINDS = new Set\(\[([\s\S]*?)\]\)/)
  if (!block) throw new Error('FORCE_MOUNT_KINDS not found')
  return [...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
}

describe('right stage force-mount whitelist', () => {
  it('keeps stateful / expensive panes mounted', () => {
    const kinds = forcedKinds()
    for (const kind of ['browser', 'web-embed', 'terminal', 'write', 'file', 'codeViewer']) {
      expect(kinds).toContain(kind)
    }
  })

  it('does not keep polling or pure-display panes mounted', () => {
    const kinds = forcedKinds()
    // news-dashboard: 挂载即 fetch + 30 分钟定时器，失活常驻会持续联网。
    expect(kinds).not.toContain('news-dashboard')
    // platform-feedback: 纯展示，重建零成本。
    expect(kinds).not.toContain('platform-feedback')
  })

  it('stays within a sane size budget', () => {
    // 白名单越长，"常驻挂载"越接近"全部挂载"，也就失去收敛意义。
    expect(forcedKinds().length).toBeLessThanOrEqual(12)
  })
})
