/**
 * Knowledge Vault API — wraps EvoPanel gatewayProxy (tauri-api).
 * Keeps the page import surface from the design package.
 */
import { api } from '../lib/tauri-api.js'

function unwrapItems(body) {
  if (!body) return []
  if (Array.isArray(body)) return body
  if (Array.isArray(body.items)) return body.items
  if (Array.isArray(body.vaults)) return body.vaults
  if (Array.isArray(body.results)) return body.results
  if (Array.isArray(body.notes)) return body.notes
  return []
}

export async function listKnowledgeVaults() {
  const body = await api.listKnowledgeVaults()
  return { items: unwrapItems(body), ...body }
}

export function createKnowledgeVault(payload) {
  return api.createKnowledgeVault(payload)
}

export function updateKnowledgeVault(vaultId, payload) {
  return api.updateKnowledgeVault(vaultId, payload)
}

export function deleteKnowledgeVault(vaultId) {
  return api.deleteKnowledgeVault(vaultId)
}

export function testKnowledgeVault(vaultId) {
  return api.testKnowledgeVault(vaultId)
}

export function getKnowledgeVaultStatus(vaultId) {
  return api.getKnowledgeVaultStatus(vaultId)
}

export async function listKnowledgeNotes(vaultId, payload = {}) {
  const body = await api.listKnowledgeVaultNotes(vaultId, payload)
  return { items: unwrapItems(body), ...body }
}

export function reindexKnowledgeVault(vaultId, payload = {}) {
  return api.reindexKnowledgeVault(vaultId, payload?.path, {
    force: payload?.force !== false,
    wait: !!payload?.wait,
  })
}

export function getKnowledgeVaultReindexJob(vaultId) {
  return api.getKnowledgeVaultReindexJob(vaultId)
}

export function installKnowledgeVault(vaultId) {
  return api.installKnowledgeVault(vaultId)
}

export async function searchKnowledgeVault(vaultId, payload) {
  const body = await api.searchKnowledgeVault(vaultId, {
    query: payload.query,
    mode: payload.mode,
    topK: payload.topK,
    tags: payload.tags,
    scopes: payload.scopes,
    threshold: payload.threshold,
    rerank: payload.rerank,
  })
  return { items: unwrapItems(body), ...body }
}

export async function readKnowledgeNotes(vaultId, payload) {
  const body = await api.readKnowledgeVault(vaultId, payload)
  return { items: unwrapItems(body), ...body }
}

export function saveKnowledgeNote(vaultId, payload) {
  return api.saveKnowledgeVaultNote(vaultId, payload)
}

export function graphKnowledgeVault(vaultId, payload) {
  return api.graphKnowledgeVault(vaultId, payload)
}

export function fullGraphKnowledgeVault(vaultId, params = {}) {
  return api.fullGraphKnowledgeVault(vaultId, params)
}

export function openKnowledgeNote(vaultId, payload) {
  return api.openKnowledgeVaultNote(vaultId, payload?.path || payload)
}
