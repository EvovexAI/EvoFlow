import type { RightStageLayout } from './right-stage-types.js'

export type RightPanelLayoutKind =
  | 'half'
  | 'wide'
  | 'narrow'
  | 'workspace-browse'
  | 'workspace-write'

/** ZCode 对齐：侧栏最小 280px（ZCode min 240，略抬一点可读性）。 */
export const RIGHT_PANEL_MIN_PX = 280
/** ZCode maxSize 65%。 */
export const RIGHT_PANEL_MAX_RATIO = 0.65
/** 浏览器 / 壳页等宽内容：首次展开默认占比（对话约 48% / 侧栏约 52%）。 */
export const RIGHT_PANEL_DEFAULT_RATIO = 0.52
/**
 * 摘要等窄内容默认宽度。
 * 对话默认开摘要时用这个，不要一上来就占半栏。
 * 旧默认 340 偏紧，卡片会贴边；400 仍是窄栏，只多留一点内容区。
 */
export const RIGHT_PANEL_NARROW_DEFAULT_PX = 400
/** 升级前的窄栏默认。已保存成这个值时抬到新默认，用户拖过的其它宽度不动。 */
export const RIGHT_PANEL_NARROW_LEGACY_PX = 340

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

/** 摘要 / 窄栏默认宽度。 */
export function defaultNarrowRightPanelWidth(mainBodyWidth: number): number {
  return clampRightPanelWidth(RIGHT_PANEL_NARROW_DEFAULT_PX, mainBodyWidth)
}

/**
 * 浏览器等宽内容的系统默认宽度（约 45%）。
 * 仅「本会话第一次打开浏览器」调用；之后尊重用户拖过的像素。
 */
export function defaultWideRightPanelWidth(mainBodyWidth: number): number {
  const w = Math.max(320, mainBodyWidth)
  return clampRightPanelWidth(Math.round(w * RIGHT_PANEL_DEFAULT_RATIO), w)
}

/**
 * @deprecated 用 defaultNarrowRightPanelWidth / defaultWideRightPanelWidth。
 * 保留旧名：无 kind 时按窄栏种子（对话默认摘要）。
 */
export function defaultRightPanelWidth(
  mainBodyWidth: number,
  _kind?: RightPanelLayoutKind,
): number {
  return defaultNarrowRightPanelWidth(mainBodyWidth)
}

export function clampRightPanelWidth(width: number, mainBodyWidth: number): number {
  const min = RIGHT_PANEL_MIN_PX
  const max = Math.max(min, Math.round(mainBodyWidth * RIGHT_PANEL_MAX_RATIO))
  return Math.min(max, Math.max(min, Math.round(width)))
}

/** @deprecated 窄摘要是合法默认，不再把 <35% 当异常抬宽。 */
export function isStaleNarrowRightPanelWidth(width: number, mainBodyWidth: number): boolean {
  void width
  void mainBodyWidth
  return false
}
