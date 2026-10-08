import type { ReactNode } from "react";

const CONTAINER_CLASS_NAME =
  "rounded-xl border border-dashed border-border bg-transparent px-4 py-10 text-center";

export function PluginLoadingState({ label }: { label: string }) {
  return (
    <div className={`${CONTAINER_CLASS_NAME} text-ui-base text-foreground-subtle`}>{label}</div>
  );
}

export function PluginSearchEmptyState({ label }: { label: string }) {
  return (
    <div className={`${CONTAINER_CLASS_NAME} text-ui-base text-foreground-subtle`}>{label}</div>
  );
}

export function PluginInstallEmptyState({
  actions,
  description,
  title,
}: {
  actions: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <div className={`flex flex-col items-center justify-center gap-3 ${CONTAINER_CLASS_NAME}`}>
      <div className="space-y-1">
        <div className="text-ui-base font-medium text-foreground">{title}</div>
        <div className="text-ui-sm text-foreground-subtle">{description}</div>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">{actions}</div>
    </div>
  );
}
