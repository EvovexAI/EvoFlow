// @ts-nocheck — mechanical P122 extract.
/**
 * Resolve live write-file preview for the right-stage workspace pane.
 * Extracted from ChatApp.tsx (P122).
 */
export type ResolveStreamingWritePreviewForPaneCtx = Record<string, any>

export function resolveStreamingWritePreviewForPane(
  ctx: ResolveStreamingWritePreviewForPaneCtx,
): any {
  const tools = ctx.streamRef.current?.turn.tools as unknown[] | undefined
  if (Array.isArray(tools) && tools.length) {
    const live = ctx.detectStreamingWritePreview(tools, { requireReady: false })
    if (live) return live
  }
  const streamSession = ctx.rightStageStore.getStream('write_file')
  const streamText =
    streamSession?.chunks?.map((chunk) => String(chunk.text || '')).join('') || ''
  if (
    ctx.rightStageSurface?.kind === 'write' &&
    (streamText || ctx.streamingWritePreview?.streaming)
  ) {
    const path = String(
      streamSession?.path ||
        ctx.rightStageSurface.data?.path ||
        ctx.streamingWritePreview?.path ||
        '',
    )
    const baseName = path.replace(/\\/g, '/').split('/').filter(Boolean).pop()
    return {
      path,
      name: ctx.streamingWritePreview?.name || baseName || '写入中…',
      content: streamText || ctx.streamingWritePreview?.content || '',
      streaming: streamSession ? !streamSession.closed : !!ctx.streamingWritePreview?.streaming,
    }
  }
  return ctx.streamingWritePreview
}
