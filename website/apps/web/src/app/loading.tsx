export default function Loading() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="flex flex-col items-center gap-6">
        <div className="relative h-10 w-10">
          <div className="absolute inset-0 rounded-full border-2 border-outline-variant/20" />
          <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-primary" />
        </div>
        <p className="font-label-ui text-[10px] uppercase tracking-[0.3em] text-foreground-muted/50">
          Loading
        </p>
      </div>
    </div>
  );
}
