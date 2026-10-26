import { describe, it, expect } from 'vitest'
import {
  STAGE_TAB_GAP_PX,
  STAGE_TAB_MIN_WIDTH_PX,
  resolveStageTabsOverflow,
  resolveStageTabsOverflowEdges,
} from '../src/react/components/rightStageTabLayout.ts'

describe('resolveStageTabsOverflow', () => {
  it('tab 少且空间充裕时不溢出，新增按钮留在条内', () => {
    expect(
      resolveStageTabsOverflow({
        addButtonInside: true,
        addButtonWidth: 28,
        tabCount: 2,
        viewportWidth: 600,
      }),
    ).toBe(false)
  })

  it('空间不足以容纳 min-width 下限才判定溢出', () => {
    // 5 tab：5*STAGE_TAB_MIN_WIDTH + 4*gap + gap + 按钮
    const required =
      5 * STAGE_TAB_MIN_WIDTH_PX + 4 * STAGE_TAB_GAP_PX + STAGE_TAB_GAP_PX + 28
    // 容差 1px：required > viewport + 1 才溢出
    expect(
      resolveStageTabsOverflow({
        addButtonInside: true,
        addButtonWidth: 28,
        tabCount: 5,
        viewportWidth: required - 1,
      }),
    ).toBe(false)

    expect(
      resolveStageTabsOverflow({
        addButtonInside: true,
        addButtonWidth: 28,
        tabCount: 5,
        viewportWidth: required - 2,
      }),
    ).toBe(true)
  })

  it('按钮在条内/条外得到相同结论——避免状态切换引发反馈抖动', () => {
    const base = { addButtonWidth: 28, tabCount: 6, viewportWidth: 400 }
    const inside = resolveStageTabsOverflow({ ...base, addButtonInside: true })
    const outside = resolveStageTabsOverflow({ ...base, addButtonInside: false })
    expect(inside).toBe(outside)
  })

  it('无 tab 时永远不溢出（按钮无处安放但也无滚动需求）', () => {
    expect(
      resolveStageTabsOverflow({
        addButtonInside: true,
        addButtonWidth: 28,
        tabCount: 0,
        viewportWidth: 20,
      }),
    ).toBe(false)
  })
})

describe('resolveStageTabsOverflowEdges', () => {
  it('未溢出时两侧都不渐隐', () => {
    expect(
      resolveStageTabsOverflowEdges({ isOverflowing: false, scrollLeft: 0, maxScrollLeft: 100 }),
    ).toEqual({ left: false, right: false })
  })

  it('溢出且滚在起点只提示右侧', () => {
    expect(
      resolveStageTabsOverflowEdges({ isOverflowing: true, scrollLeft: 0, maxScrollLeft: 100 }),
    ).toEqual({ left: false, right: true })
  })

  it('溢出且滚到终点只提示左侧', () => {
    expect(
      resolveStageTabsOverflowEdges({ isOverflowing: true, scrollLeft: 100, maxScrollLeft: 100 }),
    ).toEqual({ left: true, right: false })
  })

  it('中间位置两侧都渐隐', () => {
    expect(
      resolveStageTabsOverflowEdges({ isOverflowing: true, scrollLeft: 50, maxScrollLeft: 100 }),
    ).toEqual({ left: true, right: true })
  })
})
