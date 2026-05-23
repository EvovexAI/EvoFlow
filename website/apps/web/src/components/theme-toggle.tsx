"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

const btnClass =
  "flex min-h-10 min-w-10 items-center justify-center rounded-md text-foreground-muted transition-colors hover:bg-surface-high/80 hover:text-foreground";

export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const isDark = mounted && resolvedTheme === "dark";

  return (
    <button
      type="button"
      className={[btnClass, className].filter(Boolean).join(" ")}
      aria-label={isDark ? "切换到浅色" : "切换到深色"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {mounted ? (
        isDark ? (
          <Sun aria-hidden className="h-5 w-5" strokeWidth={1.5} />
        ) : (
          <Moon aria-hidden className="h-5 w-5" strokeWidth={1.5} />
        )
      ) : (
        <Moon aria-hidden className="h-5 w-5 opacity-40" strokeWidth={1.5} />
      )}
    </button>
  );
}
