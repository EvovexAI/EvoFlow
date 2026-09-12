/**
 * Real per-skill / per-tool context token estimates from Gateway
 * (POST /api/agents/context-overhead) — same tiktoken path as model bind.
 */
import { gatewayProxy } from './tauri-api.js'

/**
 * @typedef {{ name: string, tokens: number | null, status?: string }} CapabilityTokenRow
 * @typedef {{
 *   skills: CapabilityTokenRow[],
 *   tools: CapabilityTokenRow[],
 *   skillsTotal: number,
 *   toolsTotal: number,
 *   model: string,
 * }} CapabilityContextOverhead
 */

/**
 * @param {{ skills?: string[], tools?: string[], model?: string | null }} input
 * @returns {Promise<CapabilityContextOverhead>}
 */
export async function fetchCapabilityContextOverhead(input = {}) {
  const skills = Array.isArray(input.skills)
    ? input.skills.map((s) => String(s || '').trim()).filter(Boolean)
    : []
  const tools = Array.isArray(input.tools)
    ? input.tools.map((s) => String(s || '').trim()).filter(Boolean)
    : []
  const model = String(input.model || '').trim() || undefined

  const data = await gatewayProxy(
    'POST',
    '/agents/context-overhead',
    {
      skills,
      tools,
      model: model || null,
      compact: false,
      use_virtual_paths: false,
    },
    null,
    { silent: true, timeoutMs: 20_000 },
  )

  const skillRows = Array.isArray(data?.skills) ? data.skills : []
  const toolRows = Array.isArray(data?.tools) ? data.tools : []
  return {
    skills: skillRows.map((r) => ({
      name: String(r?.name || '').trim(),
      tokens: r?.tokens != null && Number.isFinite(Number(r.tokens)) ? Number(r.tokens) : null,
      status: String(r?.status || 'ok'),
    })),
    tools: toolRows.map((r) => ({
      name: String(r?.name || '').trim(),
      tokens: r?.tokens != null && Number.isFinite(Number(r.tokens)) ? Number(r.tokens) : null,
      status: String(r?.status || 'ok'),
    })),
    skillsTotal: Number(data?.skills_total) || 0,
    toolsTotal: Number(data?.tools_total) || 0,
    model: String(data?.model || model || ''),
  }
}
