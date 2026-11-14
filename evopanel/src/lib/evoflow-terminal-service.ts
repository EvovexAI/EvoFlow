/**
 * WebSocket-backed ITerminalService for EvoFlow ChatApp.
 * Talks to gateway `/api/workspaces/pty` (ZCode side-pane terminal parity).
 */
import { Emitter } from '@zcode/rpc'
import type { Event } from '@zcode/rpc'
import type { ITerminalService } from '@zcode/services'
import type { TerminalWindowsPtyInfo } from '../zcode-services/terminal/terminal.js'
import { apiUrlAsync } from './api-client.js'

type TerminalInstance = {
  id: string
  shell: string
  ws: WebSocket
  dataEmitter: Emitter<string>
  exitEmitter: Emitter<number>
  ready: Promise<void>
  disposed: boolean
}

function httpToWs(url: string): string {
  if (url.startsWith('https://')) return `wss://${url.slice('https://'.length)}`
  if (url.startsWith('http://')) return `ws://${url.slice('http://'.length)}`
  if (url.startsWith('/')) {
    const proto = typeof window !== 'undefined' && window.location?.protocol === 'https:' ? 'wss' : 'ws'
    const host = typeof window !== 'undefined' ? window.location.host : '127.0.0.1'
    return `${proto}://${host}${url}`
  }
  return url
}

async function buildPtyWsUrl(params: {
  cols: number
  rows: number
  cwd?: string
  root?: string
  threadId?: string
}): Promise<string> {
  const q = new URLSearchParams()
  q.set('cols', String(Math.max(2, params.cols || 80)))
  q.set('rows', String(Math.max(2, params.rows || 24)))
  if (params.cwd) q.set('cwd', params.cwd)
  if (params.root) q.set('root', params.root)
  if (params.threadId) q.set('thread_id', params.threadId)
  const http = await apiUrlAsync(`/workspaces/pty?${q.toString()}`)
  return httpToWs(http)
}

export function createEvoflowTerminalService(options?: {
  defaultCwd?: string
  defaultRoot?: string
  threadId?: string
}): ITerminalService {
  const terminals = new Map<string, TerminalInstance>()
  let seq = 0

  const service: ITerminalService = {
    async create(params: { cols: number; rows: number; cwd?: string }) {
      const localId = `evo-pty-${Date.now()}-${seq++}`
      const dataEmitter = new Emitter<string>()
      const exitEmitter = new Emitter<number>()
      const wsUrl = await buildPtyWsUrl({
        cols: params.cols,
        rows: params.rows,
        cwd: params.cwd || options?.defaultCwd,
        root: options?.defaultRoot || options?.defaultCwd,
        threadId: options?.threadId,
      })

      let settled = false
      let resolveReady: () => void = () => {}
      let rejectReady: (err: Error) => void = () => {}
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = () => {
          if (settled) return
          settled = true
          resolve()
        }
        rejectReady = (err: Error) => {
          if (settled) return
          settled = true
          reject(err)
        }
      })

      const ws = new WebSocket(wsUrl)
      const instance: TerminalInstance = {
        id: localId,
        shell: '',
        ws,
        dataEmitter,
        exitEmitter,
        ready,
        disposed: false,
      }
      terminals.set(localId, instance)

      ws.addEventListener('message', (ev) => {
        let msg: { op?: string; id?: string; shell?: string; data?: string; code?: number; message?: string }
        try {
          msg = JSON.parse(String(ev.data || ''))
        } catch {
          return
        }
        const op = String(msg.op || '')
        if (op === 'ready') {
          instance.shell = String(msg.shell || '')
          resolveReady()
          return
        }
        if (op === 'data') {
          dataEmitter.fire(String(msg.data || ''))
          return
        }
        if (op === 'exit') {
          exitEmitter.fire(Number(msg.code ?? 0))
          return
        }
        if (op === 'error') {
          rejectReady(new Error(String(msg.message || 'terminal error')))
          dataEmitter.fire(`\r\n[terminal] ${String(msg.message || 'error')}\r\n`)
        }
      })

      ws.addEventListener('error', () => {
        rejectReady(new Error('terminal websocket failed'))
      })
      ws.addEventListener('close', () => {
        if (!instance.disposed) {
          exitEmitter.fire(0)
        }
      })

      // Bound open timeout so UI does not hang forever.
      const timer = window.setTimeout(() => {
        rejectReady(new Error('terminal websocket timed out'))
      }, 15000)
      try {
        await ready
      } finally {
        window.clearTimeout(timer)
      }

      // Pipe-backed host: do not claim ConPTY (xterm would apply wrong input mode).
      const windowsPty: TerminalWindowsPtyInfo | undefined = undefined

      return {
        id: localId,
        shell: instance.shell || 'shell',
        fontFamily:
          "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, 'Cascadia Mono', monospace",
        fontFamilySource: 'fallback' as const,
        windowsPty,
      }
    },

    async write(params: { id: string; data: string }) {
      const t = terminals.get(params.id)
      if (!t || t.disposed || t.ws.readyState !== WebSocket.OPEN) return
      t.ws.send(JSON.stringify({ op: 'write', data: params.data }))
    },

    async resize(params: { id: string; cols: number; rows: number }) {
      const t = terminals.get(params.id)
      if (!t || t.disposed || t.ws.readyState !== WebSocket.OPEN) return
      t.ws.send(JSON.stringify({ op: 'resize', cols: params.cols, rows: params.rows }))
    },

    async dispose(params: { id: string }) {
      const t = terminals.get(params.id)
      if (!t || t.disposed) return
      t.disposed = true
      try {
        if (t.ws.readyState === WebSocket.OPEN) {
          t.ws.send(JSON.stringify({ op: 'dispose' }))
        }
      } catch {
        /* ignore */
      }
      try {
        t.ws.close()
      } catch {
        /* ignore */
      }
      t.dataEmitter.dispose()
      t.exitEmitter.dispose()
      terminals.delete(params.id)
      if (t.id !== params.id) terminals.delete(t.id)
    },

    onDynamicData(id: string): Event<string> {
      const t = terminals.get(id)
      if (!t) return (() => ({ dispose() {} })) as Event<string>
      return t.dataEmitter.event
    },

    onDynamicExit(id: string): Event<number> {
      const t = terminals.get(id)
      if (!t) return (() => ({ dispose() {} })) as Event<number>
      return t.exitEmitter.event
    },
  }

  return service
}
