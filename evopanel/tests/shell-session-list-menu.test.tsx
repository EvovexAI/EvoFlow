import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ShellSessionListRow, SessionContextMenuPortal } from '../src/react/components/ShellSessionListRow.tsx'
import type { ShellSidebarSyncRow } from '../src/react/lib/session-list/types.js'

afterEach(() => cleanup())

function baseRow(overrides: Partial<ShellSidebarSyncRow> = {}): ShellSidebarSyncRow {
  return {
    sessionKey: 'sess-1',
    title: '测试会话',
    time: '12:00',
    createdAt: 1,
    updatedAt: 2,
    active: false,
    canDelete: true,
    executing: false,
    runningPreviewLine: '',
    hasUnseenRunningUpdate: false,
    isPinned: false,
    pinOrder: 0,
    goalActive: false,
    workspaceKey: 'd:/ws/a',
    workspaceLabel: 'a',
    ...overrides,
  }
}

const MOVE_TARGETS = [
  { workspaceKey: 'd:/ws/b', label: '工作空间B' },
  { workspaceKey: 'd:/ws/c', label: '工作空间C' },
]

describe('侧栏会话菜单（对齐 zcode task context menu）', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('右键菜单包含 zcode 对齐项：移到顶部/归档/标为未读/复制路径/复制会话 ID/在文件管理器打开', () => {
    const actions: string[] = []
    render(
      <SessionContextMenuPortal
        menu={{ sessionKey: 'sess-1', x: 100, y: 100 }}
        row={baseRow()}
        hasWorkspacePath={true}
        moveTargets={MOVE_TARGETS}
        onClose={() => {}}
        onAction={(a) => actions.push(a)}
      />,
    )
    for (const label of [
      '固定',
      '移到顶部',
      '修改标题',
      '归档',
      '标为未读',
      '移动到工作空间',
      '在文件管理器打开',
      '复制路径',
      '复制会话 ID',
      '分叉会话',
      '刷新',
      '删除会话',
    ]) {
      expect(screen.getByText(label), `缺少菜单项：${label}`).toBeTruthy()
    }
    fireEvent.click(screen.getByText('复制会话 ID'))
    expect(actions).toContain('copy-id')
  })

  it('归档行显示「取消归档」，未归档显示「归档」', () => {
    render(
      <SessionContextMenuPortal
        menu={{ sessionKey: 'sess-1', x: 100, y: 100 }}
        row={baseRow()}
        archived={true}
        onClose={() => {}}
        onAction={() => {}}
      />,
    )
    expect(screen.getByText('取消归档')).toBeTruthy()
    expect(screen.queryByText(/^归档$/)).toBeNull()
  })

  it('无工作空间路径时「在文件管理器打开/复制路径」呈禁用态且不触发动作', () => {
    const actions: string[] = []
    render(
      <SessionContextMenuPortal
        menu={{ sessionKey: 'sess-1', x: 100, y: 100 }}
        row={baseRow()}
        hasWorkspacePath={false}
        onClose={() => {}}
        onAction={(a) => actions.push(a)}
      />,
    )
    const revealBtn = screen.getByText('在文件管理器打开').closest('button') as HTMLButtonElement
    expect(revealBtn.className).toContain('react-chat-session-more-item--disabled')
    fireEvent.click(screen.getByText('在文件管理器打开'))
    fireEvent.click(screen.getByText('复制路径'))
    expect(actions).toEqual([])
  })

  it('移动到工作空间子菜单：点击展开目标，选中后回调 onMoveToWorkspace 并关闭菜单', () => {
    const moves: Array<[string, string]> = []
    let closed = false
    render(
      <SessionContextMenuPortal
        menu={{ sessionKey: 'sess-1', x: 100, y: 100 }}
        row={baseRow()}
        moveTargets={MOVE_TARGETS}
        onClose={() => {
          closed = true
        }}
        onAction={() => {}}
        onMoveToWorkspace={(key) => moves.push(['sess-1', key])}
      />,
    )
    expect(screen.queryByText('工作空间B')).toBeNull()
    fireEvent.click(screen.getByText('移动到工作空间'))
    expect(screen.getByText('工作空间B')).toBeTruthy()
    expect(screen.getByText('工作空间C')).toBeTruthy()
    fireEvent.click(screen.getByText('工作空间B'))
    expect(moves).toEqual([['sess-1', 'd:/ws/b']])
    expect(closed).toBe(true)
  })

  it('行内 ··· 菜单与右键菜单一致，且归档行回调用 archive/unarchive 区分', () => {
    const actions: string[] = []
    const { rerender } = render(
      <SessionContextMenuPortal
        menu={{ sessionKey: 'sess-1', x: 100, y: 100 }}
        row={baseRow()}
        onClose={() => {}}
        onAction={(a) => actions.push(a)}
      />,
    )
    fireEvent.click(screen.getByText('归档'))
    expect(actions).toContain('archive')
    cleanup()
    render(
      <SessionContextMenuPortal
        menu={{ sessionKey: 'sess-1', x: 100, y: 100 }}
        row={baseRow()}
        archived={true}
        onClose={() => {}}
        onAction={(a) => actions.push(a)}
      />,
    )
    fireEvent.click(screen.getByText('取消归档'))
    expect(actions).toContain('unarchive')
    void rerender
  })

  it('ShellSessionListRow：unreadMarked 渲染未读点；菜单动作从行透传', () => {
    const actions: string[] = []
    const { container } = render(
      <ShellSessionListRow
        row={baseRow()}
        active={false}
        moreOpen={true}
        editingTitle={false}
        unreadMarked={true}
        moveTargets={MOVE_TARGETS}
        onSelect={() => {}}
        onMoreToggle={() => {}}
        onRefresh={() => {}}
        onMenuAction={(a) => actions.push(a)}
        onTitleCommit={() => {}}
        onTitleCancel={() => {}}
        onStartTitleEdit={() => {}}
        onContextMenu={() => {}}
        onPinnedReorder={() => {}}
      />,
    )
    expect(container.querySelector('.react-chat-session-unread-dot')).toBeTruthy()
    expect(container.querySelector('.react-chat-history-item--unread-marked')).toBeTruthy()
    expect(screen.getByText('移到顶部')).toBeTruthy()
    expect(screen.getByText('移动到工作空间')).toBeTruthy()
    fireEvent.click(screen.getByText('移到顶部'))
    expect(actions).toContain('top')
  })
})
