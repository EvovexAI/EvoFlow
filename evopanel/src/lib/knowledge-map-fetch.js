/** Fetch session knowledge graph from Gateway API. */

import { gatewayJson } from './gateway-json.js'

export async function fetchSessionKnowledgeMap(sessionKey) {
  const sk = String(sessionKey || '').trim()
  if (!sk) {
    throw new Error('sessionKey required')
  }
  return gatewayJson('GET', `/api/chat/sessions/${encodeURIComponent(sk)}/knowledge-map`)
}

/** @param {string} sessionKey @param {string} externalId @param {string} status */
export async function patchSessionKnowledgeMapNodeStatus(sessionKey, externalId, status) {
  const sk = String(sessionKey || '').trim()
  const eid = String(externalId || '').trim()
  const st = String(status || '').trim()
  if (!sk || !eid || !st) {
    throw new Error('sessionKey, externalId and status required')
  }
  return gatewayJson(
    'PATCH',
    `/api/chat/sessions/${encodeURIComponent(sk)}/knowledge-map/nodes/${encodeURIComponent(eid)}`,
    { status: st },
  )
}
