/**
 * Off-main-thread markdown render for streaming chat bubbles.
 */
import { renderMarkdown, renderMarkdownStreaming } from './markdown.js'

export type MarkdownWorkerRequest = {
  id: number
  kind: 'streaming' | 'full'
  text: string
}

export type MarkdownWorkerResponse = {
  id: number
  html?: string
  error?: string
}

self.onmessage = (event: MessageEvent<MarkdownWorkerRequest>) => {
  const msg = event.data
  if (!msg || typeof msg.id !== 'number') return
  const text = String(msg.text || '')
  try {
    const html =
      msg.kind === 'full' ? renderMarkdown(text) : renderMarkdownStreaming(text)
    const payload: MarkdownWorkerResponse = { id: msg.id, html }
    self.postMessage(payload)
  } catch (err) {
    const payload: MarkdownWorkerResponse = {
      id: msg.id,
      error: err instanceof Error ? err.message : String(err),
    }
    self.postMessage(payload)
  }
}
