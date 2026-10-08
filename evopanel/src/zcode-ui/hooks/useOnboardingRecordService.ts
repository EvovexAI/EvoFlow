import { useServices } from "./useServices.js";

/**
 * Onboarding 完成记录服务（本地持久化，后续上传服务器）。
 * 旧测试 double / 不支持的 host 未注册该服务时返回 null，调用方需判空降级。
 * 无 ServiceProvider 的纯渲染测试（该服务与被测行为无关）也返回 null 而不是抛错——
 * useContext 在 try 内调用且每次渲染都会执行，hook 调用顺序保持稳定。
 */
export function useOnboardingRecordService() {
  try {
    const services = useServices();
    return services.onboardingRecordService ?? null;
  } catch {
    return null;
  }
}
