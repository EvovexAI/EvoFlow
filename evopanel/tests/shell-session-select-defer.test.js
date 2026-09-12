/**
 * From other routes, selecting a session must NOT call onSelectSession immediately
 * (host is display:none). It should stash pending + navigate, then chat-route-shown selects.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const SS_PENDING_SHELL_SESSION = 'evopanel_pending_shell_session'

describe('shell session select while off chat route', () => {
  beforeEach(() => {
    sessionStorage.clear()
    // pretend we are on knowledge
    window.location.hash = '#/knowledge'
  })

  afterEach(() => {
    sessionStorage.clear()
    window.location.hash = '#/chat'
  })

  it('defers select: stash pending and navigate, do not select while host hidden', () => {
    const onSelectSession = vi.fn()
    const navigate = vi.fn((path) => {
      window.location.hash = `#${String(path).replace(/^#/, '')}`
    })

    function isChatHashRoute() {
      const p = (window.location.hash.slice(1) || '/chat').split('?')[0]
      return p === '/chat' || p === '/chat-react'
    }

    /** Mirror ShellSessionList.handleSelect (post-fix) */
    function handleSelect(sessionKey) {
      const key = String(sessionKey || '').trim()
      if (!key) return
      try {
        sessionStorage.removeItem(SS_PENDING_SHELL_SESSION)
      } catch {
        /* ignore */
      }
      if (!isChatHashRoute()) {
        try {
          sessionStorage.setItem(SS_PENDING_SHELL_SESSION, key)
        } catch {
          /* ignore */
        }
        navigate('/chat')
        return
      }
      onSelectSession(key)
    }

    handleSelect('agent:main:abc')

    expect(onSelectSession).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(SS_PENDING_SHELL_SESSION)).toBe('agent:main:abc')
    expect(navigate).toHaveBeenCalledWith('/chat')

    // After route shown, pending is consumed
    window.location.hash = '#/chat'
    const pending = sessionStorage.getItem(SS_PENDING_SHELL_SESSION)
    expect(pending).toBe('agent:main:abc')
    sessionStorage.removeItem(SS_PENDING_SHELL_SESSION)
    onSelectSession(pending)
    expect(onSelectSession).toHaveBeenCalledWith('agent:main:abc')
  })

  it('selects immediately when already on chat route', () => {
    window.location.hash = '#/chat'
    const onSelectSession = vi.fn()
    function isChatHashRoute() {
      const p = (window.location.hash.slice(1) || '/chat').split('?')[0]
      return p === '/chat' || p === '/chat-react'
    }
    function handleSelect(sessionKey) {
      const key = String(sessionKey || '').trim()
      if (!key) return
      if (!isChatHashRoute()) {
        sessionStorage.setItem(SS_PENDING_SHELL_SESSION, key)
        return
      }
      onSelectSession(key)
    }
    handleSelect('agent:main:xyz')
    expect(onSelectSession).toHaveBeenCalledWith('agent:main:xyz')
    expect(sessionStorage.getItem(SS_PENDING_SHELL_SESSION)).toBeNull()
  })
})
