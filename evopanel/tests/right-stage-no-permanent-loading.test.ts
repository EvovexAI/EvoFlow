import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 【self-evolution-bot · 2026-11-20 · 第89轮 · 模型:deepseek-v4.1-flash-1017】
 * 改了什么：新增门禁——嵌入式右栏宿主（任务中心 / 员工名册）的 renderContent
 *   兜底分支不许再返回 SidePanelBootShell（渲染出来是「加载中…」转圈）。
 * 为什么：用户实测报「右侧那个任务一直显示加载中」。根因就是这两个宿主的
 *   renderContent 只认固定几个 kind，没命中就 return <SidePanelBootShell>。
 *   BootShell 的语义是「首帧占位、下一帧换真面板」，放在永不 resolve 的兜底上
 *   等于永久转圈——用户等不到结果也看不出哪里不支持。
 *
 * 判据（可反证）：把任意一处兜底改回 SidePanelBootShell，本用例必须红。
 *
 * 注意：断言前必须剥掉注释。第一版我直接在源码里搜字符串，结果被自己写的
 * 「加载中…」说明文字判红——注释提到某词不等于代码用了它。
 *
 * 【第89轮修正】我第一版还有一条「宿主里必须先问 getRightStageKind」的断言，
 * 那是错的：RightStagePanel.renderTabBody 已经先查注册表，查不到才调
 * renderContent，所以在宿主里再查一次永远拿到 undefined，是死代码。断言已改为
 * 「分派顺序在 RightStagePanel 里」——这条才是真不变量。
 */

const HOSTS = [
  'src/react/components/TaskDetailRightStageHost.tsx',
  'src/react/components/ProactiveRosterRightStageHost.tsx',
]

function read(rel: string): string {
  return readFileSync(resolve(__dirname, '..', rel), 'utf8')
}

/** 去掉 // 与 块注释，避免注释里的同名字符串造成假红/假绿。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

describe('embedded right-stage hosts never fake a permanent loading state', () => {
  for (const rel of HOSTS) {
    it(`${rel}: uses the terminal unavailable shell, not the boot shell`, () => {
      const code = stripComments(read(rel))
      expect(code).toContain('RightStageUnavailableShell')
      // 瞬时占位组件不允许出现在这两个宿主里：它们没有任何路径能把它变成 ready。
      expect(code).not.toContain('SidePanelBootShell')
      // 宿主自身也不许直接写「加载中」当兜底文案
      expect(code).not.toContain('加载中')
    })
  }

  it('the unavailable shell says something, and never renders 加载中', () => {
    const code = stripComments(read('src/react/components/RightStageUnavailableShell.tsx'))
    expect(code).not.toContain('加载中')
    expect(code).toContain('不能在当前视图里打开')
  })

  it('RightStagePanel asks the registry first, so host renderContent is a last resort', () => {
    const src = read('src/react/components/RightStagePanel.tsx')
    const regIdx = src.indexOf('getRightStageKind(kind)')
    const renderIdx = src.indexOf('renderContent?.(tab)')
    expect(regIdx).toBeGreaterThan(-1)
    expect(renderIdx).toBeGreaterThan(-1)
    // 注册表在前、renderContent 在后 —— 顺序反了宿主就会抢走已注册 kind 的渲染权。
    expect(regIdx).toBeLessThan(renderIdx)
  })
})
