/**
 * 「已装产物」分组文案与去重
 * 【self-evolution-bot · 2026-11-19 · 第76轮 · 模型:deepseek-v4.1-flash-1017】
 * 为什么测这层：BOT / 智能体 原本是两个 artifacts 键，包内写的是同一个对象，
 * 分开列会把同一个 BOT 显示两遍；extensions 的标签要从「扩展」改成「Agent应用」。
 * 走真实挂载 + 点开详情，避免只测函数不测接线。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const PACK = {
  org_instance_id: 'org-1',
  pack_id: 'live-workbench',
  pack_name: 'AI 直播导播',
  pack_version: '1.0.0',
  kind: 'full',
  status: 'active',
  // 同一个 BOT 在两个键里都有：employees 与 agents 是同一份配置
  artifacts: {
    employees: ['live-workbench'],
    agents: ['live-workbench'],
    apps: ['live-flow'],
    skills: [],
    extensions: ['live-workbench-ext'],
    knowledge: [],
    mcp: [],
  },
  artifact_details: {
    employees: [{ id: 'live-workbench', name: 'AI 直播导播' }],
    agents: [{ id: 'live-workbench', name: 'AI 直播导播' }],
    apps: [{ id: 'live-flow', name: '直播工作流' }],
    extensions: [{ id: 'live-workbench-ext', name: '直播工作台' }],
  },
}

vi.mock('../src/lib/tauri-api.js', () => ({
  api: {
    orgList: vi.fn().mockResolvedValue({ items: [PACK] }),
    orgGet: vi.fn().mockResolvedValue({}),
    orgMarketUpdates: vi.fn().mockResolvedValue({ items: [] }),
    getAgent: vi.fn().mockResolvedValue({
      agent_name: 'AI 直播导播',
      tools: [],
      mcp_servers: [],
      skills: [],
      knowledge_vault_ids: [],
      soul: '',
    }),
    proactiveGetRole: vi.fn().mockResolvedValue({ config: { knowledge_vault_ids: [] } }),
  },
}))

describe('已装产物分组', () => {
  let host

  beforeEach(() => {
    document.body.innerHTML = '<div id="host"></div>'
    host = document.getElementById('host')
  })

  it('BOT 与智能体合并为一组且去重，扩展改叫 Agent应用', async () => {
    const mod = await import('../src/pages/settings/installed-packs.js')
    await mod.mountInstalledPacksInto(host, { embedded: true })

    // 列表卡片摘要：同一个 BOT 只数一次
    const listText = host.textContent || ''
    expect(listText).not.toContain('智能体')
    expect(listText).toContain('BOT 1 · 工作流 1 · Agent应用 1')

    // 打开详情（点击卡片按钮，走真实事件路径）
    const detailBtn = host.querySelector('[data-ip-act="open-detail"][data-org-id]')
    expect(detailBtn).toBeTruthy()
    detailBtn.click()

    await vi.waitFor(() => {
      const text = host.querySelector('[data-ip-detail]')?.textContent || ''
      expect(text).toContain('已装产物')
    })

    const detail = host.querySelector('[data-ip-detail]')
    // 只在「已装产物」区块内数分组标题（「BOT 绑定」是另一块，不算）
    const artifactBlock = [...detail.querySelectorAll('.sr-detail-block')].find((el) =>
      (el.querySelector('h4')?.textContent || '').startsWith('已装产物'),
    )
    expect(artifactBlock).toBeTruthy()
    const headings = [...artifactBlock.querySelectorAll('h4')].map((h) => h.textContent.trim())
    const botHeadings = headings.filter((h) => /^BOT\s*\(\d+\)$/.test(h))
    expect(botHeadings.length).toBe(1)
    expect(botHeadings[0]).toContain('(1)')

    // 扩展分组不存在，Agent应用分组存在且含显示名
    expect(headings.some((h) => h.startsWith('扩展'))).toBe(false)
    const appHeading = headings.find((h) => h.startsWith('Agent应用'))
    expect(appHeading).toBeTruthy()
    expect(appHeading).toContain('(1)')

    // 同一个 BOT 的芯片只出现一次
    const chipTexts = [...detail.querySelectorAll('.sr-detail-block .sr-chip')].map((c) =>
      c.textContent.replace(/\s+/g, ' ').trim(),
    )
    expect(chipTexts.filter((t) => t.includes('AI 直播导播')).length).toBe(1)
    expect(chipTexts.some((t) => t.includes('直播工作台'))).toBe(true)

    mod.cleanup()
  })
})
