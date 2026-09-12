/**
 * Helpers for agent custom image avatars (crop metadata + URL).
 */

export type AgentAvatarMetaWire = {
  aspect?: number
  head_box?: { x?: number; y?: number; w?: number; h?: number }
}

export type AvatarImageMeta = {
  aspect: number
  headBox: { x: number; y: number; w: number; h: number }
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function avatarMetaFromWire(raw?: AgentAvatarMetaWire | null): AvatarImageMeta | null {
  if (!raw) return null
  const hb = raw.head_box
  if (!isFiniteNumber(raw.aspect) || raw.aspect <= 0) return null
  if (!hb || !isFiniteNumber(hb.x) || !isFiniteNumber(hb.y) || !isFiniteNumber(hb.w) || hb.w <= 0) return null
  const h = isFiniteNumber(hb.h) && hb.h > 0 ? hb.h : hb.w * raw.aspect
  return {
    aspect: raw.aspect,
    headBox: { x: hb.x, y: hb.y, w: hb.w, h },
  }
}

export function avatarMetaToWire(meta: AvatarImageMeta): AgentAvatarMetaWire {
  return {
    aspect: meta.aspect,
    head_box: { x: meta.headBox.x, y: meta.headBox.y, w: meta.headBox.w, h: meta.headBox.h },
  }
}

export function agentAvatarImageUrl(baseUrl: string, agentCode: string, version?: string | number): string {
  const v = version != null ? `?v=${encodeURIComponent(String(version))}` : ''
  const path = `/api/agents/${encodeURIComponent(agentCode)}/avatar${v}`
  if (!baseUrl) return path
  return `${baseUrl.replace(/\/$/, '')}${path}`
}

/** System gallery cutout: ``GET /api/agents/avatar-presets/{id}``. */
export function agentAvatarPresetUrl(baseUrl: string, presetId: string, version?: string | number): string {
  const id = String(presetId || '').trim().toLowerCase()
  const v = version != null ? `?v=${encodeURIComponent(String(version))}` : ''
  const path = `/api/agents/avatar-presets/${encodeURIComponent(id)}${v}`
  if (!baseUrl) return path
  return `${baseUrl.replace(/\/$/, '')}${path}`
}

export function bustCropStyle(
  headBox: { x: number; y: number; w: number; h: number },
  aspect: number,
  side: number
): { width: number; height: number; left: number; top: number } {
  const h = headBox.h > 0 ? headBox.h : headBox.w * aspect
  const cropAspect = (headBox.w * aspect) / h
  const boxW = cropAspect >= 1 ? side : side * cropAspect
  const boxH = cropAspect >= 1 ? side / cropAspect : side
  const imgW = boxW / headBox.w
  const imgH = boxH / h
  return {
    width: imgW,
    height: imgH,
    left: (side - boxW) / 2 - headBox.x * imgW,
    top: (side - boxH) / 2 - headBox.y * imgH,
  }
}
