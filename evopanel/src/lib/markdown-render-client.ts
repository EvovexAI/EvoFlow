/**
 * Singleton Web Worker client for markdown HTML generation (streaming + large bodies).
 */
import {
  renderMarkdown,
  renderMarkdownStreaming,
  lookupMarkdownRenderCache,
  cacheMarkdownRenderResult,
} from './markdown.js'
import type { MarkdownWorkerRequest, MarkdownWorkerResponse } from './markdown-render-worker.js'

let worker: Worker | null = null
let workerDisabled = false
const callbacks = new Map<number, (html: string) => void>()
let nextReqId = 0

function ensureWorker(): Worker | null {
  if (workerDisabled || typeof Worker === 'undefined') return null
  if (worker) return worker
  try {
    worker = new Worker(new URL('./markdown-render-worker.ts', import.meta.url), {
      type: 'module',
    })
    worker.onmessage = (event: MessageEvent<MarkdownWorkerResponse>) => {
      const { id, html, error } = event.data || {}
      const cb = callbacks.get(id)
      if (!cb) return
      callbacks.delete(id)
      const req = pendingTexts.get(id)
      pendingTexts.delete(id)
      if (error || html == null) {
        // Worker 失败回退主线程渲染（renderMarkdown 内部自带 LRU 缓存）
        // @ts-ignore
        cb(req?.kind === 'full' ? renderMarkdown(req.text) : renderMarkdownStreaming(req.text))
        return
      }
      // Worker 成功：写回主线程 LRU；虚拟列表重挂载时直接命中，免 postMessage 往返
      if (req?.kind === 'full') cacheMarkdownRenderResult(req.text, html)
      cb(html)
    }
    worker.onerror = () => {
      workerDisabled = true
      worker?.terminate()
      worker = null
      for (const [id, cb] of [...callbacks.entries()]) {
        const req = pendingTexts.get(id)
        callbacks.delete(id)
        pendingTexts.delete(id)
        if (req) {
          cb(req.kind === 'full' ? renderMarkdown(req.text) : renderMarkdownStreaming(req.text))
        } else {
          cb('')
        }
      }
    }
    return worker
  } catch {
    workerDisabled = true
    return null
  }
}

const pendingTexts = new Map<number, { kind: 'streaming' | 'full'; text: string }>()

function queueRender(kind: 'streaming' | 'full', text: string): Promise<string> {
  // 终稿渲染先查主线程 LRU（worker 回填 / 主线程 renderMarkdown 写入）
  if (kind === 'full') {
    const hit = lookupMarkdownRenderCache(String(text || ''))
    if (hit !== undefined) return Promise.resolve(hit)
  }
  const w = ensureWorker()
  if (!w) {
    return Promise.resolve(kind === 'full' ? renderMarkdown(text) : renderMarkdownStreaming(text))
  }
  const id = ++nextReqId
  pendingTexts.set(id, { kind, text })
  return new Promise((resolve) => {
    callbacks.set(id, resolve)
    const payload: MarkdownWorkerRequest = { id, kind, text }
    w.postMessage(payload)
  })
}

export function renderMarkdownStreamingAsync(text: string): Promise<string> {
  return queueRender('streaming', String(text || ''))
}

export function renderMarkdownAsync(text: string): Promise<string> {
  return queueRender('full', String(text || ''))
}

/** Test / teardown */
export function disposeMarkdownRenderWorker(): void {
  worker?.terminate()
  worker = null
  workerDisabled = false
  callbacks.clear()
  pendingTexts.clear()
}