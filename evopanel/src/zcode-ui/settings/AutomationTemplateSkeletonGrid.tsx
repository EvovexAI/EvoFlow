const DEFAULT_TEMPLATE_SKELETON_CARD_KEYS = [
  "template-skeleton-1",
  "template-skeleton-2",
  "template-skeleton-3",
  "template-skeleton-4",
] as const;

export function AutomationTemplateSkeletonGrid({ label }: { label: string }) {
  return (
    <div role="status" className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <span className="sr-only">{label}</span>
      {DEFAULT_TEMPLATE_SKELETON_CARD_KEYS.map((key) => (
        <div
          key={key}
          data-automation-template-skeleton-card
          aria-hidden="true"
          className="motion-safe:animate-pulse flex min-h-[114px] flex-col gap-2 rounded-xl border border-card-border bg-background p-3"
        >
          <div className="flex items-center gap-1">
            <span className="size-5 shrink-0 rounded-md bg-surface" />
            <span className="h-5 w-1/2 rounded-md bg-surface" />
          </div>
          <div className="flex flex-1 flex-col gap-2">
            <span className="h-5 w-full rounded-md bg-surface" />
            <span className="h-5 w-3/4 rounded-md bg-surface" />
          </div>
          <span className="h-5 w-1/2 rounded-md bg-surface" />
        </div>
      ))}
    </div>
  );
}
