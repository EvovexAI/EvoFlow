import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('proactive-approval-notify badges', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button type="button" data-shell-nav="/tasks" data-premium-nav="tasks">
        <span class="react-chat-aside-nav-label">任务中心</span>
      </button>
      <button type="button" data-shell-nav="/proactive" data-premium-nav="proactive">
        <span class="react-chat-aside-nav-label">员工</span>
      </button>
    `
  })

  afterEach(async () => {
    const mod = await import('../src/lib/proactive-approval-notify.js')
    mod.stopProactiveApprovalNotify()
    document.getElementById('approval-corner-notify')?.remove()
    document.body.innerHTML = ''
  })

  it('setShellApprovalBadges shows number only and clears when zero', async () => {
    const { setShellApprovalBadges } = await import('../src/lib/proactive-approval-notify.js')
    setShellApprovalBadges(1)
    const tasksBtn = document.querySelector('[data-shell-nav="/tasks"]')
    const badge = tasksBtn.querySelector('.shell-nav-approval-badge')
    expect(badge).toBeTruthy()
    expect(badge.textContent).toBe('1')
    expect(tasksBtn.getAttribute('data-approval-pending')).toBe('1')

    setShellApprovalBadges(3)
    expect(tasksBtn.querySelector('.shell-nav-approval-badge')?.textContent).toBe('3')

    setShellApprovalBadges(0)
    expect(tasksBtn.querySelector('.shell-nav-approval-badge')).toBeNull()
  })

  it('startProactiveApprovalNotify polls and paints corner chip', async () => {
    vi.resetModules()
    vi.doMock('../src/lib/tauri-api.js', () => ({
      api: {
        proactiveListApprovals: vi.fn(async () => ({
          approvals: [
            {
              id: 'appr_test1',
              status: 'pending',
              role_agent_code: 'dev-tech-director',
              role_name: '技术总监',
              task_id: 't1',
              initiative_title: '阶段4 方案',
            },
          ],
        })),
      },
    }))
    vi.doMock('../src/lib/desktop-notification.js', () => ({
      notifyDesktopCompletion: vi.fn(),
    }))
    vi.doMock('../src/components/toast.js', () => ({
      toast: Object.assign(vi.fn(), { warning: vi.fn(), success: vi.fn() }),
    }))
    vi.doMock('../src/router.js', () => ({ navigate: vi.fn() }))

    const mod = await import('../src/lib/proactive-approval-notify.js')
    mod.startProactiveApprovalNotify()
    await vi.waitFor(() => {
      const chip = document.getElementById('approval-corner-notify')
      expect(chip).toBeTruthy()
      expect(chip.hidden).toBe(false)
      expect(chip.textContent).toContain('待审核')
    })
    expect(document.querySelector('[data-shell-nav="/tasks"] .shell-nav-approval-badge')?.textContent).toBe(
      '1',
    )
    mod.stopProactiveApprovalNotify()
  })
})
