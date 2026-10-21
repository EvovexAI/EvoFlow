/**
 * Keep chat sidebar employee roster in sync after platform / console CRUD.
 * Mirrors panel-appearance-sync + models-updated: tool writes must not leave
 * ChatApp's proactiveRoles stuck on the mount-time snapshot.
 */

export const EMPLOYEES_UPDATED_EVENT = 'evopanel:employees-updated'

const MUTATING_EMPLOYEE_ACTIONS = new Set([
  'employees.hire',
  'employees.create',
  'employees.update',
  'employees.delete',
  'employees.pause',
  'employees.resume',
  'employees.migrate',
])

function parseToolResultObject(raw) {
  if (!raw) return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw
  const text = String(raw || '').trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function parseArgsAction(argsText) {
  const text = String(argsText || '').trim()
  if (!text) return ''
  try {
    const args = JSON.parse(text)
    return String(args?.action || '').trim().toLowerCase()
  } catch {
    return ''
  }
}

function resolveEmployeeAction(obj, argsText) {
  const fromObj = String(obj?.action || '').trim().toLowerCase()
  if (fromObj.startsWith('employees.')) return fromObj
  const fromArgs = parseArgsAction(argsText)
  if (fromArgs.startsWith('employees.')) return fromArgs
  const fromUi = String(obj?.ui?.action || '').trim().toLowerCase()
  if (fromUi.startsWith('employees.')) return fromUi
  return ''
}

/**
 * @param {{ reason?: string, agentCode?: string } | undefined} [detail]
 */
export function notifyEmployeesUpdated(detail) {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(
      new CustomEvent(EMPLOYEES_UPDATED_EVENT, {
        detail: detail && typeof detail === 'object' ? detail : {},
      }),
    )
  } catch {
    /* ignore */
  }
}

/**
 * @param {unknown} raw
 * @param {{ argsText?: string }} [opts]
 * @returns {boolean} whether a roster refresh was requested
 */
export function syncEmployeesRosterFromToolResult(raw, opts = {}) {
  const obj = parseToolResultObject(raw)
  if (!obj || obj.ok === false || obj.pending_confirm === true) return false
  const action = resolveEmployeeAction(obj, opts?.argsText)
  if (!MUTATING_EMPLOYEE_ACTIONS.has(action)) return false
  const agentCode =
    String(obj?.agent_code || obj?.role?.agent_code || obj?.ui?.entityId || '').trim() || undefined
  notifyEmployeesUpdated({ reason: action, agentCode })
  return true
}
