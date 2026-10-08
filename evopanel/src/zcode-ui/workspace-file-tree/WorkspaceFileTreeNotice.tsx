import type { ReactNode } from "react";

export function WorkspaceFileTreeNotice({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
}) {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center gap-2 px-4 text-center text-ui-base text-foreground-subtle">
      <div className="text-foreground-subtlest">{icon}</div>
      <div className="font-medium text-foreground-subtle">{title}</div>
      {description ? (
        <div className="max-w-full break-words text-foreground-subtlest">{description}</div>
      ) : null}
    </div>
  );
}
