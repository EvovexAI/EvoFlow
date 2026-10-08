export function TrajectorySectionTitle({
  kind,
  label,
}: {
  kind: "input" | "output";
  label: string;
}) {
  return (
    <div
      data-trajectory-section-title=""
      data-trajectory-section-kind={kind}
      className="col-span-full flex h-8 items-center bg-surface px-3 font-mono text-ui-sm uppercase text-foreground"
    >
      {label}
    </div>
  );
}
