/**
 * Reproduce: leave #/chat → other route → back to #/chat.
 * Assert #chat-persistent-host is visible and ChatApp root is still mounted.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

describe('chat host route toggle', () => {
  /** @type {HTMLElement} */
  let mainCol
  /** @type {HTMLElement} */
  let chatHost
  /** @type {HTMLElement} */
  let content
  /** @type {HTMLElement} */
  let chatAppRoot

  beforeEach(() => {
    document.body.innerHTML = ''
    mainCol = document.createElement('div')
    mainCol.id = 'main-col'
    chatHost = document.createElement('div')
    chatHost.id = 'chat-persistent-host'
    chatHost.hidden = true
    chatHost.style.display = 'none'
    chatAppRoot = document.createElement('div')
    chatAppRoot.className = 'chat-react-full'
    chatAppRoot.textContent = 'CHAT_APP_ALIVE'
    chatHost.appendChild(chatAppRoot)
    content = document.createElement('main')
    content.id = 'content'
    mainCol.appendChild(chatHost)
    mainCol.appendChild(content)
    document.body.appendChild(mainCol)

    // Mimic production CSS rules that matter for visibility
    const style = document.createElement('style')
    style.textContent = `
      #chat-persistent-host { display: none; }
      #chat-persistent-host:not([hidden]) { display: flex; }
      [hidden] { display: none !important; }
    `
    document.head.appendChild(style)
  })

  afterEach(() => {
    document.body.innerHTML = ''
    document.head.querySelectorAll('style').forEach((el) => el.remove())
  })

  function setChatHostVisible(visible) {
    chatHost.hidden = !visible
    chatHost.style.display = visible ? 'flex' : 'none'
  }

  function setContentVisible(visible) {
    content.hidden = !visible
    content.style.display = visible ? '' : 'none'
  }

  it('shows chat host after leave→return without wiping ChatApp', () => {
    // start on chat
    setContentVisible(false)
    setChatHostVisible(true)
    expect(chatHost.hidden).toBe(false)
    expect(chatHost.querySelector('.chat-react-full')?.textContent).toBe('CHAT_APP_ALIVE')

    // leave to knowledge (cleanup + content route)
    setChatHostVisible(false)
    setContentVisible(true)
    content.innerHTML = '<div class="page knowledge-owned-outlet">KB</div>'
    expect(chatHost.hidden).toBe(true)
    // ChatApp must still be in DOM while hidden
    expect(chatHost.querySelector('.chat-react-full')?.textContent).toBe('CHAT_APP_ALIVE')

    // return to chat
    setContentVisible(false)
    content.innerHTML = ''
    setChatHostVisible(true)

    expect(chatHost.hidden).toBe(false)
    // [hidden]{display:none!important} must not still win
    const cs = getComputedStyle(chatHost)
    expect(cs.display).not.toBe('none')
    expect(chatHost.querySelector('.chat-react-full')?.textContent).toBe('CHAT_APP_ALIVE')
  })

  it('BUG repro: setting only style.display=flex while hidden=true keeps host invisible', () => {
    setChatHostVisible(false)
    // wrong recovery path (only inline display)
    chatHost.style.display = 'flex'
    expect(chatHost.hidden).toBe(true)
    const cs = getComputedStyle(chatHost)
    // UA / [hidden]!important wins → still none
    expect(cs.display).toBe('none')
  })

  it('wiping host innerHTML disconnects ChatApp (must never happen on return)', () => {
    setChatHostVisible(true)
    expect(chatAppRoot.isConnected).toBe(true)
    chatHost.innerHTML = ''
    expect(chatAppRoot.isConnected).toBe(false)
  })
})
