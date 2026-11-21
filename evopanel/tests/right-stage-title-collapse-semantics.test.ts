/**
 * 右栏两处语义缺陷的回归测试：标题被兜底名覆盖、切会话后永久锁死收起。
 *
 * 【self-evolution-bot · 2026-11-21 · 第102轮 · 模型:deepseek-v4.1-flash-1017】新建。
 *
 * 缺陷 A（真机实测抓到，2026-11-21 00:44）：
 *   ``ui.show kind=shell-page data.path=/proactive data.title=主动任务ABC``
 *   回读 ``/api/stage/right-stage/state`` 时那个签的 title 是 **BOT**。
 *   链路：openShellPageInRightStage 正确写入了「主动任务ABC」→ 页面挂载完成 →
 *   ShellPageKind 调 patchShellPageTabTitle 回写 → 该函数没有任何「别覆盖好名字」
 *   判断，而 resolveShellPageTabTitle 对 /proactive 的兜底正是「BOT」。
 *
 * 缺陷 B（代码审查 + 语义推导）：
 *   importSessionMemory 里两处 ``userCollapsed = this.collapsed``，把「现在收没收」
 *   当「用户是否亲手锁了」。新会话没标签时 collapsed 天然为 true，于是切过去后
 *   所有 autoOpen（expandUnlessUserCollapsed）被永久挡住 —— 右栏「再也不自动展开」。
 *
 * 判据：
 *   A. 已有可读标题时，兜底名回写不许生效；本来就是兜底名时仍允许回写。
 *   B. 无记忆分支 / 记忆里没有 userCollapsed 字段 → 不锁定；显式 true 才锁定。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  isGenericShellPageTitle,
  openShellPageInRightStage,
  patchShellPageTabTitle,
} from '../src/lib/right-stage/open-shell-page-stage.js'
import { rightStageStore } from '../src/lib/right-stage/right-stage-store.js'

function wipe() {
  for (const t of [...(rightStageStore.getSnapshot().tabs || [])]) {
    rightStageStore.closeTab(rightStageStore.keyOf(t))
  }
}

function titleOf(path: string): string {
  const id = path === '/proactive' ? 'shell:/proactive' : path.replace(/^\//, 'shell:/')
  const tab = rightStageStore.findTab(`shell-page:${id}`)
  return String(tab?.title || '')
}

describe('缺陷 A：兜底名不许覆盖模型给的标题', () => {
  beforeEach(() => wipe())

  it('isGenericShellPageTitle 认得 mount table 的兜底名', () => {
    expect(isGenericShellPageTitle('BOT')).toBe(true)
    expect(isGenericShellPageTitle('任务')).toBe(true)
    expect(isGenericShellPageTitle('')).toBe(true)
    expect(isGenericShellPageTitle('/proactive')).toBe(true)
    // 可读名不算兜底
    expect(isGenericShellPageTitle('主动任务ABC')).toBe(false)
    expect(isGenericShellPageTitle('发版工程师')).toBe(false)
  })

  it('打开 /proactive 带自定义标题后，挂载回写不许把它改成 BOT', () => {
    openShellPageInRightStage({ path: '/proactive', title: '主动任务ABC' })
    expect(titleOf('/proactive')).toBe('主动任务ABC')

    // 模拟 ShellPageKind 挂载完成后回写兜底名（真实链路：result.title === 'BOT'）
    patchShellPageTabTitle('/proactive', 'BOT')

    expect(titleOf('/proactive')).toBe('主动任务ABC')
  })

  it('反证对照：标题本来就是兜底名时，回写仍应生效（不能一刀切拒写）', () => {
    openShellPageInRightStage({ path: '/notes' })
    // /notes 无自定义名 → 走兜底「页面」
    patchShellPageTabTitle('/notes', '我的笔记')
    expect(titleOf('/notes')).toBe('我的笔记')
  })
})

describe('缺陷 B：收起锁不许从「现在收没收」倒推', () => {
  beforeEach(() => wipe())

  it('无记忆切会话：即使目标会话空着（collapsed=true），也不锁定收起', () => {
    rightStageStore.collapse()
    expect(rightStageStore.isUserCollapsed).toBe(true)

    rightStageStore.importSessionMemory(null)

    // 新会话没有标签 → collapsed 仍为 true，但**不是**用户锁的
    expect(rightStageStore.getSnapshot().collapsed).toBe(true)
    expect(rightStageStore.isUserCollapsed).toBe(false)
    // 因此自动开栏必须能撑开
    expect(rightStageStore.expandUnlessUserCollapsed()).toBe(true)
    expect(rightStageStore.getSnapshot().collapsed).toBe(false)
  })

  it('有记忆但没存 userCollapsed（旧版本数据）：按未锁定处理', () => {
    rightStageStore.importSessionMemory({
      tabs: [],
      activeKey: null,
      collapsed: true,
      recentClosed: [],
    })
    expect(rightStageStore.isUserCollapsed).toBe(false)
    expect(rightStageStore.expandUnlessUserCollapsed()).toBe(true)
  })

  it('记忆里显式 userCollapsed=true：必须尊重用户意图，不许自动撑开', () => {
    rightStageStore.importSessionMemory({
      tabs: [],
      activeKey: null,
      collapsed: true,
      recentClosed: [],
      userCollapsed: true,
    })
    expect(rightStageStore.isUserCollapsed).toBe(true)
    expect(rightStageStore.expandUnlessUserCollapsed()).toBe(false)
    expect(rightStageStore.getSnapshot().collapsed).toBe(true)
  })

  it('导出侧必须真的把用户手势存下来（否则上面那条永远拿不到 true）', () => {
    rightStageStore.collapse()
    const mem = rightStageStore.exportSessionMemory()
    expect(mem.userCollapsed).toBe(true)
  })
})
