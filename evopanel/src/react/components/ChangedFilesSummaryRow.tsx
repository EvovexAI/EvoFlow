import { memo, useState } from 'react'
import { ChevronRight, Undo2 } from 'lucide-react'
import type { TurnChangedFile } from '../file-diff-util.js'

function leafName(path: string): string {
  const parts = String(path || '').replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || path
}

function DiffStat({ added, removed }: { added: number; removed: number }) {
  if (!added && !removed) return null
  return (
    <span className="evf-changed-files-stat tabular-nums">
      {added > 0 ? <span className="evf-diff-added">+{added}</span> : null}
      {removed > 0 ? <span className="evf-diff-removed">−{removed}</span> : null}
    </span>
  )
}

/**
 * 回合末尾的「N 个文件已更改 +X −Y」聚合行（对齐工作台变更摘要形态）：
 * 折叠列文件清单（点击打开预览），右侧撤销按钮交由宿主执行。
 */
function ChangedFilesSummaryRowInner({
  files,
  onOpenFile,
  onRevert,
  revertibleCount,
  revertBusy,
}: {
  files: readonly TurnChangedFile[]
  onOpenFile?: (rawPath: string, displayName?: string) => void
  onRevert?: () => void
  /** 当前会话日志里可撤销的文件数；为 0 时撤销按钮禁用 */
  revertibleCount?: number
  revertBusy?: boolean
}) {
  const [open, setOpen] = useState(false)
  if (!files.length) return null

  const totals = files.reduce(
    (acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }),
    { added: 0, removed: 0 },
  )
  const canRevert = !!onRevert && (revertibleCount ?? 0) > 0

  return (
    <section className="evf-changed-files" data-testid="changed-files-summary">
      <div className="evf-changed-files-header">
        <button
          type="button"
          className="evf-changed-files-toggle"
          aria-label="展开已更改文件"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronRight
            className={`evf-changed-files-arrow${open ? ' is-open' : ''}`}
            size={14}
            strokeWidth={1.5}
            aria-hidden
          />
          <span className="evf-changed-files-label">{files.length} 个文件已更改</span>
          <DiffStat added={totals.added} removed={totals.removed} />
        </button>
        {onRevert ? (
          <button
            type="button"
            className="evf-changed-files-revert"
            disabled={!canRevert || revertBusy}
            title={
              canRevert
                ? '把本回合更改的文件恢复到修改前（仅覆盖文件工具产生的变更）'
                : '当前会话没有可用的修改前快照（刷新页面后快照会丢失）'
            }
            onClick={onRevert}
          >
            <Undo2 size={12} strokeWidth={1.5} aria-hidden />
            <span>{revertBusy ? '撤销中…' : '撤销'}</span>
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="evf-changed-files-list">
          {files.map((f) => (
            <div
              key={f.path}
              role={f.deleted ? undefined : 'button'}
              tabIndex={f.deleted ? undefined : 0}
              className={`evf-changed-file-row${f.deleted ? ' is-deleted' : ''}`}
              title={f.path}
              onClick={() => {
                if (!f.deleted) onOpenFile?.(f.path, leafName(f.path))
              }}
              onKeyDown={(event) => {
                if (f.deleted) return
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                onOpenFile?.(f.path, leafName(f.path))
              }}
            >
              <span className="evf-changed-file-name">{leafName(f.path)}</span>
              <span className="evf-changed-file-path">{f.path}</span>
              {f.deleted ? (
                <span className="evf-changed-file-deleted">已删除</span>
              ) : (
                <DiffStat added={f.added} removed={f.removed} />
              )}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}

export const ChangedFilesSummaryRow = memo(ChangedFilesSummaryRowInner)
