import { memo, useEffect, useRef, useState } from 'react'
import type { RightStageSurface } from '../../../lib/right-stage/right-stage-types.js'
import { matchShellPagePath } from '../../../lib/right-stage/shell-page-mount-table.js'
import { patchShellPageTabTitle } from '../../../lib/right-stage/open-shell-page-stage.js'
import { navigatePlatformFeedbackRoute } from '../../../lib/right-stage/platform-feedback.js'

/**
 * 右栏挂载壳内页：按 Mount Table 把页面模块 render 进 host（非 iframe / BrowserPanel）。
 *
 * 注意：只按 path / surface.id 重挂。onClose / title 会随对话流式重渲染变引用，
 * 绝不能进 effect deps，否则员工页会一直销毁重建（看起来像不停刷新）。
 */
export const ShellPageKind = memo(function ShellPageKind({
  surface,
  onClose,
}: {
  surface: RightStageSurface
  onClose?: () => void
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const path = String(surface.data?.path || surface.data?.route || '').trim()
  const surfaceId = String(surface.id || '').trim()
  const [status, setStatus] = useState<'loading' | 'ready' | 'unsupported' | 'error'>('loading')
  const [errorText, setErrorText] = useState('')

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    let destroy: (() => void) | undefined
    setStatus('loading')
    setErrorText('')
    host.replaceChildren()

    void (async () => {
      const matched = matchShellPagePath(path)
      if (!matched) {
        if (!cancelled) setStatus('unsupported')
        return
      }
      try {
        const result = await matched.mount(host, matched.params, {
          onClose: () => onCloseRef.current?.(),
          title: String(surface.title || '').trim(),
          onTitle: (nice) => {
            if (!cancelled && nice) patchShellPageTabTitle(path, nice)
          },
        })
        if (cancelled) {
          result.destroy()
          return
        }
        destroy = () => result.destroy()
        if (result.title) patchShellPageTabTitle(path, result.title)
        setStatus('ready')
      } catch (e) {
        if (cancelled) return
        setStatus('error')
        setErrorText(e instanceof Error ? e.message : String(e || '挂载失败'))
      }
    })()

    return () => {
      cancelled = true
      try {
        destroy?.()
      } catch {
        /* ignore */
      }
      destroy = undefined
      host.replaceChildren()
    }
    // 故意不依赖 onClose / surface.title：父级 RightStagePanel 每次 render 都会 new 箭头函数
    // eslint-disable-next-line react-hooks/exhaustive-deps -- path/id 才是挂载身份
  }, [path, surfaceId])

  return (
    <aside
      className="react-chat-right-stage-panel react-chat-shell-page-panel"
      role="region"
      aria-label={surface.title || path || '页面'}
    >
      {status === 'loading' ? (
        <div className="react-chat-shell-page-status" aria-live="polite">
          加载中…
        </div>
      ) : null}
      {status === 'unsupported' ? (
        <div className="react-chat-shell-page-status">
          <p>该页面尚未接入右栏挂载表。</p>
          {path ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => navigatePlatformFeedbackRoute(path)}
            >
              在主区打开 {path}
            </button>
          ) : null}
        </div>
      ) : null}
      {status === 'error' ? (
        <div className="react-chat-shell-page-status react-chat-shell-page-status--error">
          <p>挂载失败：{errorText || '未知错误'}</p>
          {path ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => navigatePlatformFeedbackRoute(path)}
            >
              改在主区打开
            </button>
          ) : null}
        </div>
      ) : null}
      <div
        ref={hostRef}
        className="react-chat-shell-page-host"
        hidden={status !== 'ready'}
      />
    </aside>
  )
})
