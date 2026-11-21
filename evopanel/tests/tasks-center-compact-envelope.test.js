// 【self-evolution-bot · 2026-11-21 · 第109轮 · 模型:deepseek-v4.1-flash-1017】
// 为什么写这条：右栏「任务」签在现网恒显示「暂无任务」，而 curl /api/tasks 有 40 条、
// 主区任务中心正常。根因是 asList 只在顶层找 tasks/items/results，而该路由回的是
// {success:true,data:{tasks:[...]}}（见 tasks.js:2297 的解包注释）。
// 判据：拿现网真实信封形状喂进去必须取到数组；待办那种顶层形状也不能被破坏。
import { describe, expect, it } from 'vitest'
import { asList } from '../src/pages/tasks-center-compact.js'

const KEYS = ['tasks', 'items', 'data', 'results']

describe('tasks-center-compact asList 信封解包', () => {
  it('取得到现网 /api/tasks 的 {success,data:{tasks}} 形状', () => {
    // 真实响应（curl 127.0.0.1:8382/api/tasks?page=1&page_size=40）截取
    const payload = {
      success: true,
      data: { tasks: [{ id: '2611211657_7112' }], total: 314, page: 1, page_size: 40 },
    }
    const got = asList(payload, KEYS)
    expect(got).toHaveLength(1)
    expect(got[0].id).toBe('2611211657_7112')
  })

  it('不破坏待办那种顶层 {ok,items} 形状', () => {
    const payload = { ok: true, items: [{ id: 'item_1', title: 'x' }] }
    expect(asList(payload, KEYS)).toHaveLength(1)
  })

  it('裸数组原样返回', () => {
    expect(asList([{ id: 'a' }], KEYS)).toHaveLength(1)
  })

  it('data 本身是数组时也能取', () => {
    expect(asList({ ok: true, data: [{ id: 'a' }] }, KEYS)).toHaveLength(1)
  })

  it('真为空时仍返回空数组，不许把 data 对象当列表', () => {
    expect(asList({ success: true, data: { total: 0 } }, KEYS)).toEqual([])
    expect(asList({ success: true, data: { tasks: [] } }, KEYS)).toEqual([])
    expect(asList(null, KEYS)).toEqual([])
    expect(asList('oops', KEYS)).toEqual([])
  })
})
