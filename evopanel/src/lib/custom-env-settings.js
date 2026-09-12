import { gatewayProxy } from './tauri-api.js'

/** @typedef {{ key: string, value: string, configured?: boolean }} CustomEnvVar */

const PATH = '/settings/custom-env'

export async function fetchCustomEnvVars() {
  const data = await gatewayProxy('GET', `${PATH}/raw`)
  return Array.isArray(data?.vars) ? data.vars : []
}

/** @param {CustomEnvVar[]} vars */
export async function saveCustomEnvVars(vars) {
  const data = await gatewayProxy('PUT', PATH, {
    vars: vars.map((v) => ({ key: v.key || '', value: v.value || '' })),
  })
  return Array.isArray(data?.vars) ? data.vars : []
}

/** @typedef {{ key: string, ok: boolean, message: string, skipped?: boolean }} CustomEnvVerifyResult */

/** @param {CustomEnvVar[]} vars */
export async function verifyCustomEnvVars(vars) {
  const data = await gatewayProxy('POST', `${PATH}/verify`, {
    vars: vars.map((v) => ({ key: v.key || '', value: v.value || '' })),
  })
  return Array.isArray(data?.results) ? data.results : []
}
