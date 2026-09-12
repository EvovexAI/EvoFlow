import type { RightStageLayout } from './right-stage-types.js'

export type RightPanelLayoutKind =
  | 'half'
  | 'wide'
  | 'narrow'
  | 'workspace-browse'
  | 'workspace-write'

export function rightStageLayoutToPanelKind(layout: RightStageLayout | undefined): RightPanelLayoutKind {
  switch (layout) {
    case 'narrow':
      return 'workspace-browse'
    case 'workspace-write':
      return 'workspace-write'
    case 'wide':
      return 'wide'
    case 'half':
    default:
      return 'half'
  }
}

export function defaultRightPanelWidth(mainBodyWidth: number, kind: RightPanelLayoutKind): number {
  const w = Math.max(320, mainBodyWidth)
  // 克制版（right-stage-intelligent-panel.md §8.2）
  // 文件树侧栏：窄栏即可，勿沿用 half/write 的宽分栏
  if (kind === 'workspace-browse' || kind === 'narrow') return 260
  if (kind === 'workspace-write') return Math.min(520, Math.round(w * 0.4))
  if (kind === 'wide') return Math.min(640, Math.round(w * 0.55))
  // half / collab / mind-map
  return Math.min(560, Math.round(w * 0.44))
}

export function clampRightPanelWidth(width: number, mainBodyWidth: number): number {
  const min = 240
  const max = Math.max(min, Math.round(mainBodyWidth * 0.7))
  return Math.min(max, Math.max(min, Math.round(width)))
}
