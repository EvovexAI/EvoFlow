/**
 * Interactive workspace terminal (ZCode SidePaneTerminalPane parity).
 * Host assembly only: Intl + ServiceProvider with WS-backed terminalService.
 */
import '@xterm/xterm/css/xterm.css'
import '@/styles-bridge.css'
import { useMemo } from 'react'
import { SidePaneTerminalPane } from '@zcode/ui/SidePaneTerminalPane.js'
import { ZCodeIntlProvider } from '@zcode/ui/i18n/IntlProvider.js'
import { ServiceProvider } from '@zcode/ui/hooks/useServices.js'
import type { IServiceAccessor } from '@zcode/services'
import { createEvoflowTerminalService } from '../../../lib/evoflow-terminal-service.js'
import { createEvoflowPartialServices } from '../../v4/V4ZCodeTimeline.js'
import { showRightStageBrowserUrl } from '../../../lib/right-stage/open-right-stage-browser.js'

export function V4InteractiveTerminalPane(props: {
  cwd?: string
  threadId?: string
  sessionKey?: string
  sessionId: string
  workspaceKey?: string
  isVisible: boolean
}): React.JSX.Element {
  const { cwd, threadId, sessionKey, sessionId, workspaceKey, isVisible } = props
  const workCwd = String(cwd || '').trim()
  const tid = String(threadId || '').trim()

  const services = useMemo(() => {
    const base = createEvoflowPartialServices(tid, workCwd) as IServiceAccessor
    const terminalService = createEvoflowTerminalService({
      defaultCwd: workCwd || undefined,
      defaultRoot: workCwd || undefined,
      threadId: tid || undefined,
    })
    return {
      ...base,
      terminalService,
    } as IServiceAccessor
  }, [tid, workCwd])

  const isWindowsDesktop =
    typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || navigator.userAgent || '')

  return (
    <ZCodeIntlProvider initialLocale="zh-CN">
      <ServiceProvider services={services}>
        <div className="zcode-bridge-root h-full min-h-0">
          <SidePaneTerminalPane
            services={services}
            sessionId={sessionId}
            workspaceKey={workspaceKey || workCwd || sessionId}
            cwd={workCwd || undefined}
            isVisible={isVisible}
            isWindowsDesktop={isWindowsDesktop}
            onOpenBrowserUrl={(url) => {
              showRightStageBrowserUrl(url, {
                sessionKey: sessionKey || undefined,
              })
            }}
          />
        </div>
      </ServiceProvider>
    </ZCodeIntlProvider>
  )
}
