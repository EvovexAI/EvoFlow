import type { ReactNode } from "react";

export function SettingsFormActions({
  leadingAction,
  children,
}: {
  leadingAction?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center">
      {leadingAction}
      <div className="flex items-center justify-end gap-2 sm:ml-auto">{children}</div>
    </div>
  );
}
