import { createContext, useContext } from "react";

interface SessionPluginIconProjection {
  sessionId: string;
  iconByPluginId: ReadonlyMap<string, string>;
}

const PluginReferenceIconContext = createContext<SessionPluginIconProjection | null>(null);

export const PluginReferenceIconProvider = PluginReferenceIconContext.Provider;

export function usePluginReferenceIconProjection(): SessionPluginIconProjection | null {
  return useContext(PluginReferenceIconContext);
}
