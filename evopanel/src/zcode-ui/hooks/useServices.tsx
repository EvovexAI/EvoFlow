/**
 * useServices —— 通过 React Context 提供 IServiceAccessor
 *
 * 替代 props drilling，组件通过 useServices() 直接获取服务。
 */
import { createContext, useContext, type ReactNode } from "react";
import type { IServiceAccessor } from "@zcode/services";

const ServiceContext = createContext<IServiceAccessor | null>(null);

export function ServiceProvider({
  services,
  children,
}: {
  services: IServiceAccessor;
  children: ReactNode;
}) {
  return <ServiceContext.Provider value={services}>{children}</ServiceContext.Provider>;
}

export function useServices(): IServiceAccessor {
  const ctx = useContext(ServiceContext);
  if (!ctx) {
    throw new Error("useServices 必须在 ServiceProvider 内使用");
  }
  return ctx;
}

export function useOptionalServices(): IServiceAccessor | null {
  return useContext(ServiceContext);
}
