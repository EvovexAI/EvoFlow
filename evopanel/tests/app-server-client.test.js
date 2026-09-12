import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  shouldUseAppServerChatPipe,
  shouldUseAppServerApiPipe,
  isAppServerWarm,
} from '../src/lib/app-server-client.js'

describe('shouldUseAppServerChatPipe', () => {
  const prevTauri = globalThis.window?.__TAURI_INTERNALS__
  const prevFlag = (() => {
    try {
      return localStorage.getItem('evoflow-desktop-pipe-chat')
    } catch {
      return null
    }
  })()
  const prevApiFlag = (() => {
    try {
      return localStorage.getItem('evoflow-desktop-pipe-api')
    } catch {
      return null
    }
  })()

  beforeEach(() => {
    if (typeof window !== 'undefined') {
      window.__TAURI_INTERNALS__ = { invoke: () => {} }
    }
    try {
      localStorage.removeItem('evoflow-desktop-pipe-chat')
      localStorage.removeItem('evoflow-desktop-pipe-api')
    } catch {
      /* ignore */
    }
  })

  afterEach(() => {
    if (typeof window !== 'undefined') {
      if (prevTauri === undefined) delete window.__TAURI_INTERNALS__
      else window.__TAURI_INTERNALS__ = prevTauri
    }
    try {
      if (prevFlag == null) localStorage.removeItem('evoflow-desktop-pipe-chat')
      else localStorage.setItem('evoflow-desktop-pipe-chat', prevFlag)
      if (prevApiFlag == null) localStorage.removeItem('evoflow-desktop-pipe-api')
      else localStorage.setItem('evoflow-desktop-pipe-api', prevApiFlag)
    } catch {
      /* ignore */
    }
  })

  it('defaults off so chat uses Rust gateway_proxy_stream', () => {
    expect(shouldUseAppServerChatPipe()).toBe(false)
  })

  it('can be forced on via localStorage', () => {
    localStorage.setItem('evoflow-desktop-pipe-chat', '1')
    expect(shouldUseAppServerChatPipe()).toBe(true)
  })

  it('can be forced off via localStorage', () => {
    localStorage.setItem('evoflow-desktop-pipe-chat', '0')
    expect(shouldUseAppServerChatPipe()).toBe(false)
  })

  it('is off without Tauri', () => {
    delete window.__TAURI_INTERNALS__
    delete window.__TAURI__
    delete window.isTauri
    localStorage.setItem('evoflow-desktop-pipe-chat', '1')
    expect(shouldUseAppServerChatPipe()).toBe(false)
  })

  it('API pipe stays independent of chat flag', () => {
    localStorage.setItem('evoflow-desktop-pipe-chat', '0')
    expect(shouldUseAppServerApiPipe()).toBe(isAppServerWarm())
    localStorage.setItem('evoflow-desktop-pipe-api', '0')
    expect(shouldUseAppServerApiPipe()).toBe(false)
  })
})
