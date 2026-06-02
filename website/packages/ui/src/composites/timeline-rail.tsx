import type { ReactNode } from "react";

interface TimelineEvent {
  id: string;
  date: string;
  title: string;
  accent?: "primary" | "secondary" | "tertiary";
  detail?: ReactNode;
}

interface TimelineRailProps {
  events: TimelineEvent[];
  className?: string;
}

const dotColors: Record<string, string> = {
  primary: "bg-primary",
  secondary: "bg-secondary",
  tertiary: "bg-tertiary",
};

const textColors: Record<string, string> = {
  primary: "text-primary",
  secondary: "text-secondary",
  tertiary: "text-tertiary",
};

export function TimelineRail({
  events,
  className = "",
}: TimelineRailProps) {
  return (
    <div className={`relative ${className}`}>
      {/* Rail line */}
      <div className="absolute left-3.5 top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-primary/30 to-transparent" />

      <div className="space-y-8">
        {events.map((event) => {
          const accent = event.accent ?? "primary";
          return (
            <div key={event.id} className="group relative flex gap-5 pl-0">
              {/* Dot */}
              <div className="relative z-10 mt-1.5 flex h-7 w-7 shrink-0 items-center justify-center">
                <div
                  className={[
                    "h-2.5 w-2.5 rounded-full transition-transform duration-200 group-hover:scale-150",
                    dotColors[accent],
                  ].join(" ")}
                />
              </div>

              {/* Content */}
              <div className="min-w-0 pb-2">
                <p
                  className={[
                    "font-label-ui text-[10px] uppercase tracking-[0.22em]",
                    textColors[accent],
                  ].join(" ")}
                >
                  {event.date}
                </p>
                <p className="font-display-ui mt-1.5 text-sm font-semibold tracking-[-0.02em]">
                  {event.title}
                </p>
                {event.detail && (
                  <div className="mt-2 text-sm leading-6 text-foreground-muted">
                    {event.detail}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
