/** 工具 write 时右侧写入流的展示策略（panel.ui.writeStreamMode）。 */
export type WriteStreamMode = 'off' | 'incremental-only' | 'always'

/** 产品默认：改文件不自动拉开右侧（设置里可开「自动打开工作预览」）。 */
export const WRITE_STREAM_MODE_DEFAULT: WriteStreamMode = 'off'

const VALID_MODES = new Set<WriteStreamMode>(['off', 'incremental-only', 'always'])

export function normalizeWriteStreamMode(value: unknown): WriteStreamMode {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
  // 旧 incremental-only：与 always 同属「可自动打开」，走决策器 hint
  if (raw === 'incremental' || raw === 'incrementalonly' || raw === 'incremental-only') {
    return 'always'
  }
  if (raw === 'always' || raw === 'off') return raw
  if (VALID_MODES.has(raw as WriteStreamMode)) return raw as WriteStreamMode
  return WRITE_STREAM_MODE_DEFAULT
}

export function writeStreamModeLabel(mode: WriteStreamMode): string {
  switch (mode) {
    case 'always':
      return '自动打开工作预览'
    case 'incremental-only':
      return '自动打开工作预览'
    default:
      return '不自动打开'
  }
}

export function shouldTrackWriteStreamFromTools(mode: WriteStreamMode): boolean {
  return mode === 'always' || mode === 'incremental-only'
}

/** 是否在本次 sync 打开 write-stream 面板（不含 mayShowWriteStream / pin 判断）。 */
export function shouldOpenWriteStreamPanel(opts: {
  mode: WriteStreamMode
  contentLength: number
  prevContentLength: number
  writeCompleting?: boolean
}): boolean {
  return opts.mode === 'always' || opts.mode === 'incremental-only'
}

/** 设置是否允许自动拉开写入/产物预览（供 decideRightStage.autoPreviewEnabled）。 */
export function isAutoWorkPreviewEnabled(mode: WriteStreamMode): boolean {
  return mode === 'always' || mode === 'incremental-only'
}
