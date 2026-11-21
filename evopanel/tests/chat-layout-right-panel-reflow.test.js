/**
 * 右栏宽度在窗口尺寸变化时要重新钳制，且不能改写用户拖出来的意图。
 *
 * 【self-evolution-bot · 2026-11-21 · 第114轮 · 模型:deepseek-v4.1-flash-1017】
 * 为什么要有这条：现网（1440×810，已装包）把右栏拖到 896px 后缩小窗口，
 *   右栏**停在 896px 不动**并伸出视口，实测：
 *     vw=1280 → aside.right 1273，clipped 0
 *     vw=1100 → aside.right 1176，clipped 76px
 *     vw=1000 → aside.right 1176，clipped 176px
 *     vw= 960（tauri minWidth）→ aside.right 1176，clipped 216px
 *   对话列被压到 220px 底限不再收缩，溢出全部落在右栏右边缘被裁，
 *   标签条（tabsR 恒 1176）与内容一起看不到。
 *   根因：宽度只在「打开面板」与「拖拽过程」两个时刻钳制，窗口 resize 无人重算。
 * 判据（可反证）：把 useChatLayoutResize 里新增的 resize/RO effect 删掉，
 *   下面 reflow 用例仍绿（它测纯函数），但 `源码必须常驻重算入口` 那条立刻红。
 *   把持久化改回显示值，`保存的是意图不是显示值` 那条立刻红。
 *
 * 注：纯函数断言用的 mainBodyWidth 全部取自本轮现网测量值，不是自造样例。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { clampRightPanelWidth } from '../src/lib/right-stage/right-stage-layout.ts'

const here = dirname(fileURLToPath(import.meta.url))
const HOOK = resolve(here, '../src/react/hooks/useChatLayoutResize.ts')

/**
 * 侧栏左栏固定 60px（实测 convL=60）。
 *
 * 【self-evolution-bot · 2026-11-21 · 第114轮 · 模型:deepseek-v4.1-flash-1017】
 * 更正：我第一版把拖拽手柄的 6px 也算进水平占用，五条断言全红（expected 222 to be 216）。
 *   实测手柄 CSS 是 `width:6px; margin:0 -3px` —— 左右各溢出 3px，**净占 0**：
 *   实测 convR 280 == asideL 280，中间没有 6px 空隙。判据要用测量值对账，不是按 CSS 读法推。
 */
const LEFT_GUTTER_PX = 60
/** 对话列实测底限 220px（CSS min-width: 220px，缩窗时恒停在这个值）。 */
const CONV_MIN_PX = 220

/**
 * 现网实测（vw, bodyW, convW, asideW, clippedPx）——全部本轮 1440×810 已装包探针取回。
 * bodyW = .react-chat-main-body clientWidth；clippedPx = aside.right - innerWidth（<0 记 0）。
 */
const MEASURED = [
  { vw: 1440, bodyW: 1379, convW: 477, asideW: 896, clipped: 0 },
  { vw: 1280, bodyW: 1219, convW: 317, asideW: 896, clipped: 0 },
  { vw: 1100, bodyW: 1039, convW: 220, asideW: 896, clipped: 76 },
  { vw: 1000, bodyW: 939, convW: 220, asideW: 896, clipped: 176 },
  { vw: 960, bodyW: 899, convW: 220, asideW: 896, clipped: 216 },
]

describe('右栏宽度随窗口重算（reflow）', () => {
  for (const { vw, bodyW, convW, asideW, clipped } of MEASURED) {
    it(`vw=${vw} 修复前的溢出量与现网实测一致`, () => {
      const rightBefore = LEFT_GUTTER_PX + convW + asideW
      expect(Math.max(0, rightBefore - vw)).toBe(clipped)
    })

    it(`vw=${vw} 重算后不溢出视口`, () => {
      const next = clampRightPanelWidth(896, bodyW)
      const convAfter = Math.max(CONV_MIN_PX, bodyW - next)
      const rightEdge = LEFT_GUTTER_PX + convAfter + next
      expect(rightEdge).toBeLessThanOrEqual(vw)
      // 右栏自身也不得超过 65% 主列
      expect(next).toBeLessThanOrEqual(Math.round(bodyW * 0.65))
      expect(next).toBeGreaterThanOrEqual(280)
    })
  }

  it('窗口够宽时不缩小用户拖出来的宽度', () => {
    // 1440 下 896 恰好是 65% 上限，重算必须原值返回
    expect(clampRightPanelWidth(896, 1379)).toBe(896)
  })

  it('窄窗钳制后，放大回来能回到原意图', () => {
    const intent = 896
    const narrow = clampRightPanelWidth(intent, 939)
    const back = clampRightPanelWidth(intent, 1379)
    expect(narrow).toBeLessThan(intent)
    // 若把显示值当意图落盘再重算，这里会得到 narrow 而不是 intent —— 即本条的反证点
    expect(back).toBe(intent)
  })
})

describe('源码必须常驻重算入口（接线，不是函数层）', () => {
  const src = readFileSync(HOOK, 'utf8')

  it('挂了 window resize 监听与 ResizeObserver', () => {
    expect(src).toContain("window.addEventListener('resize'")
    expect(src).toContain('new ResizeObserver(')
    expect(src).toContain('ro?.disconnect()')
  })

  it('拖拽入口写回意图 ref（否则缩窗后按旧值走）', () => {
    const dragBlock = src.slice(src.indexOf('const onRightPanelDragDelta'))
    expect(dragBlock.slice(0, 900)).toContain('rightPanelWidthPrefRef.current = next')
  })

  it('保存的是意图不是显示值', () => {
    const persistBlock = src.slice(src.indexOf('layoutSizesRef.current = {'))
    expect(persistBlock.slice(0, 400)).toContain('rightPanelWidthPrefRef.current ?? rightPanelWidthPx')
  })
})
