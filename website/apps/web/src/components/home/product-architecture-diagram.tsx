"use client";

import { accentDotClassNames } from "@ai-site/ui";

type ArchAccent = "primary" | "secondary" | "tertiary";

export type ProductArchitectureLayer = {
  label: string;
  modules: Array<{
    title: string;
    description: string;
    accent: ArchAccent;
  }>;
};

function accentNodeSurface(accent: ArchAccent) {
  switch (accent) {
    case "primary":
      return "border-primary/20 bg-primary/[0.06]";
    case "secondary":
      return "border-secondary/20 bg-secondary/[0.06]";
    case "tertiary":
      return "border-tertiary/20 bg-tertiary/[0.06]";
    default:
      return "border-white/[0.1] bg-white/[0.03]";
  }
}

function LayerConnector() {
  return (
    <div className="flex flex-col items-center py-1" aria-hidden>
      <div className="h-4 w-px bg-gradient-to-b from-white/20 via-white/12 to-white/8" />
      <svg className="-mt-0.5 h-5 w-5 shrink-0 text-white/35" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M12 5v11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path
          d="M7 13l5 5 5-5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

export function ProductArchitectureDiagram({
  layers,
  className,
}: {
  layers: ProductArchitectureLayer[];
  className?: string;
}) {
  return (
    <div
      className={[
        "rounded-2xl border border-dashed border-white/[0.09] bg-linear-to-b from-white/[0.03] to-transparent p-4 md:p-6",
        className ?? "",
      ].join(" ")}
    >
      <div className="flex flex-col items-stretch">
        {layers.map((layer, layerIndex) => (
          <div key={`${layer.label}-${layerIndex}`} className="flex flex-col items-stretch">
            <div className="relative overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.02] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]">
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-white/15 to-transparent" />
              <div className="flex flex-col gap-3 p-3 md:flex-row md:items-stretch md:gap-0 md:p-4">
                <div className="flex shrink-0 flex-row items-center gap-3 md:w-[8.5rem] md:flex-col md:items-start md:border-r md:border-white/[0.06] md:pr-4">
                  <span className="font-mono text-[10px] tabular-nums leading-none text-foreground-muted">
                    L{layerIndex + 1}
                  </span>
                  <p className="font-display-ui text-xs font-semibold leading-snug tracking-[-0.02em] text-foreground md:text-[13px]">
                    {layer.label}
                  </p>
                </div>
                <div className="flex min-w-0 flex-1 flex-wrap gap-2 md:gap-2.5 md:pl-4">
                  {layer.modules.map((mod, modIndex) => (
                    <div
                      key={`${layerIndex}-${modIndex}-${mod.title}`}
                      className={[
                        "min-w-0 flex-1 rounded-lg border px-3 py-2.5 shadow-sm md:min-w-[11rem] md:max-w-[20rem] md:flex-none",
                        accentNodeSurface(mod.accent),
                      ].join(" ")}
                    >
                      <div className="flex items-start gap-2">
                        <span
                          className={["mt-1 h-1.5 w-1.5 shrink-0 rounded-full", accentDotClassNames[mod.accent]].join(
                            " ",
                          )}
                        />
                        <div className="min-w-0">
                          <p className="font-display-ui text-[12px] font-semibold leading-snug tracking-[-0.02em] text-foreground md:text-[13px]">
                            {mod.title}
                          </p>
                          <p className="mt-1.5 text-[11px] leading-relaxed text-foreground-muted md:text-xs">
                            {mod.description}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            {layerIndex < layers.length - 1 ? <LayerConnector /> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
