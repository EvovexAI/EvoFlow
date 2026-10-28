/**
 * 员工名册页挂载右栏（工作过程 = employeeProcess）。
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { ProactiveRosterRightStageHost } from '../react/components/ProactiveRosterRightStageHost.tsx'

/**
 * @param {HTMLElement} container
 */
export function mountProactiveRosterRightStage(container) {
  if (!container) {
    return { destroy() {} }
  }
  const host = document.createElement('div')
  host.className = 'pro-right-stage-react-host'
  container.appendChild(host)
  const root = createRoot(host)
  root.render(createElement(ProactiveRosterRightStageHost))

  return {
    destroy() {
      try {
        root.unmount()
      } catch {
        /* ignore */
      }
      host.remove()
    },
  }
}
