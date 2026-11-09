import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

/**
 * 回归：输入框 `/` 面板（命令 / 技能 / 插件）的两处产品决策。
 *
 * 1) 命令清单只保留 `/goal`：`/claude`、`/lead` 不再出现在选择器里
 *    （用户手动输入这两个命令仍走 handle-send 的切换逻辑，功能未删）。
 * 2) 技能 / 插件行用两行布局：名称完整显示（不省略），简介在第二行、
 *    过长才省略。
 */
import { COMPOSER_SLASH_COMMANDS } from '../src/react/lib/workspace-mention.js'
import { WorkspaceMentionMenu } from '../src/react/components/WorkspaceMentionMenu.js'

afterEach(() => cleanup())

describe('composer slash commands list', () => {
  it('only exposes /goal in the picker', () => {
    expect(COMPOSER_SLASH_COMMANDS.map((c) => c.name)).toEqual(['goal'])
  })

  it('does not list /claude or /lead', () => {
    const names = COMPOSER_SLASH_COMMANDS.map((c) => c.name)
    expect(names).not.toContain('claude')
    expect(names).not.toContain('lead')
  })

  it('keeps a description for every listed command', () => {
    for (const cmd of COMPOSER_SLASH_COMMANDS) {
      expect(cmd.description).toBeTruthy()
    }
  })
})

describe('WorkspaceMentionMenu skill/plugin rows', () => {
  const longName = '一个特别特别长的技能名称用来验证不会被截断'
  const longDesc = '这是一个非常长的技能介绍'.repeat(12)

  function renderMenu() {
    render(
      <WorkspaceMentionMenu
        open
        loading={false}
        query=""
        type="skill"
        activeIndex={0}
        onPick={() => {}}
        onActiveIndexChange={() => {}}
        items={[
          { __kind: 'skill', name: 'demo-skill', label: longName, icon: '⚡', description: longDesc },
          { __kind: 'plugin', id: 'demo-plugin', label: longName, description: longDesc },
        ]}
      />,
    )
  }

  it('renders the full skill name', () => {
    renderMenu()
    const names = screen.getAllByText(longName)
    expect(names.length).toBeGreaterThan(0)
    // 名称节点不再带省略号截断样式（由 --stacked 规则覆盖为不截断）
    for (const el of names) {
      expect(el.className).toContain('react-chat-mention-menu-name')
    }
  })

  it('stacks skill / plugin rows so the description sits on its own line', () => {
    renderMenu()
    const mains = document.querySelectorAll('.react-chat-mention-menu-item--stacked')
    expect(mains.length).toBe(2)
    for (const row of mains) {
      const main = row.querySelector('.react-chat-mention-menu-main')
      expect(main).toBeTruthy()
      // 名称与徽标在第一行，简介在第二行
      expect(main!.querySelector('.react-chat-mention-menu-title')).toBeTruthy()
      expect(main!.querySelector('.react-chat-mention-menu-desc')).toBeTruthy()
    }
  })
})
