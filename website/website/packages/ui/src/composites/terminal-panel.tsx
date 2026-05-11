import type { ComponentPropsWithoutRef } from "react";

interface TerminalPanelProps extends ComponentPropsWithoutRef<"div"> {
  lines: string[];
}

export function TerminalPanel({
  className = "",
  lines,
  ...props
}: TerminalPanelProps) {
  return (
    <div
      className={[
        "rounded-[22px] border border-outline-variant/30 bg-black px-5 py-5 font-mono text-[11px] text-green-400 shadow-2xl",
        className,
      ].join(" ")}
      {...props}
    >
      {lines.map((line, index) => (
        <p key={`${line}-${index}`} className="mb-2 last:mb-0">
          {line}
        </p>
      ))}
    </div>
  );
}
