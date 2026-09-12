import { useGuide } from '../../../react/hooks/useGuide.js'

type Props = {
  /** 空画布（步骤数 ≤ 2）时触发引导弹窗 */
  stepCount: number
}

/**
 * 工作流画布新手引导 — 已迁移到 GuidePanel v2 统一弹窗
 *
 * 保留组件壳和触发逻辑（空画布 + 未 dismiss），
 * 但不再渲染顶部横幅，改为弹出统一的使用指南面板。
 *
 * 内部使用 useGuide Hook 实现，便于后续其他 React 页面复用。
 */
export function WorkflowOnboardingBanner({ stepCount }: Props) {
  useGuide({
    checkOnboarding: true,
    onboardingCondition: stepCount <= 2,
    onboardingDelay: 600,
  })

  // 不渲染任何 UI，引导由 GuidePanel 统一呈现
  return null
}
