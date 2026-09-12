import { useCallback, useEffect } from 'react'
import {
  showPageHelpPanel,
  checkOnboardingGuide,
} from '../../lib/page-help.js'

export type UseGuideOptions = {
  /**
   * 当前页面路由（可选）。
   * 不传则使用当前 URL 的路径，由 page-help 内部自动匹配。
   * 适用于非路由驱动的组件或需要强制指定指南的场景。
   */
  route?: string
  /**
   * 是否在组件挂载时检查 onboarding 自动弹出。
   * 默认 false，由全局 router 统一处理。
   * 特殊页面（如工作流画布有「空画布触发」逻辑）可设为 true。
   */
  checkOnboarding?: boolean
  /**
   * 触发 onboarding 的额外条件（除了 storage 标记之外）。
   * 比如工作流画布要求 stepCount <= 2 才弹。
   */
  onboardingCondition?: boolean
  /**
   * onboarding 延迟弹出时间（ms），默认 0。
   * 画布类页面建议设 300~800ms，等首屏渲染完再弹。
   */
  onboardingDelay?: number
}

export type UseGuideReturn = {
  /** 打开当前页的使用指南面板 */
  openGuide: () => void
  /** 手动检查并触发 onboarding 引导 */
  triggerOnboarding: () => void
}

/**
 * React Hook — 接入统一使用指南（GuidePanel v2）。
 *
 * 用法：
 * ```tsx
 * const { openGuide } = useGuide()
 * <button onClick={openGuide}>使用指南</button>
 * ```
 *
 * 带 onboarding 条件触发：
 * ```tsx
 * useGuide({
 *   checkOnboarding: true,
 *   onboardingCondition: stepCount <= 2,
 *   onboardingDelay: 600,
 * })
 * ```
 */
export function useGuide(options: UseGuideOptions = {}): UseGuideReturn {
  const {
    route,
    checkOnboarding: enableOnboarding = false,
    onboardingCondition = true,
    onboardingDelay = 0,
  } = options

  const openGuide = useCallback(() => {
    showPageHelpPanel(route)
  }, [route])

  const triggerOnboarding = useCallback(() => {
    if (!onboardingCondition) return
    if (onboardingDelay > 0) {
      setTimeout(() => checkOnboardingGuide(route), onboardingDelay)
    } else {
      checkOnboardingGuide(route)
    }
  }, [route, onboardingCondition, onboardingDelay])

  // 自动检查 onboarding
  useEffect(() => {
    if (!enableOnboarding) return
    triggerOnboarding()
  }, [enableOnboarding, triggerOnboarding])

  return { openGuide, triggerOnboarding }
}
