/** Roster page right-stage session key (isolated from task-center:* and chat sessions). */
export const EMPLOYEES_ROSTER_STAGE_SESSION_KEY = 'employees-roster'

export function isEmployeesRosterStageSessionKey(sessionKey: string | null | undefined): boolean {
  return String(sessionKey || '').trim() === EMPLOYEES_ROSTER_STAGE_SESSION_KEY
}
