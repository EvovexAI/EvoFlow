"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ─── Konami Code ─────────────────────────────────────────────────────────────

const KONAMI_SEQUENCE = [
  "ArrowUp", "ArrowUp",
  "ArrowDown", "ArrowDown",
  "ArrowLeft", "ArrowRight",
  "ArrowLeft", "ArrowRight",
  "b", "a",
];

const TERMINAL_LINES_EN = [
  "AI_SITE SYSTEM v2.0.26",
  "─────────────────────────────────────────",
  "",
  "> Decrypting user intent...",
  "> Pattern recognized: KONAMI_CODE",
  "> Validating clearance level...",
  "> ✓ ACCESS GRANTED",
  "",
  "┌─ CLASSIFIED INTEL ──────────────────────",
  "│  Building:  AI-native personal platform",
  "│  Stack:     Next.js · AI SDK · React Flow",
  "│  Status:    Shipping in public  🚀",
  "│  Seeking:   Interesting problems to solve",
  "└─────────────────────────────────────────",
  "",
  "> Hint: There are 3 Easter eggs on this site.",
  "> You found the first one. Well played.",
  "",
  "[ PRESS ANY KEY OR CLICK TO DISMISS ]",
];

const TERMINAL_LINES_ZH = [
  "AI_SITE SYSTEM v2.0.26",
  "─────────────────────────────────────────",
  "",
  "> 正在解密用户意图...",
  "> 已识别输入序列: KONAMI_CODE",
  "> 验证权限等级...",
  "> ✓ 访问已授权",
  "",
  "┌─ 机密情报 ──────────────────────────────",
  "│  构建中:  AI 原生个人平台",
  "│  技术栈:  Next.js · AI SDK · React Flow",
  "│  状态:    公开构建中  🚀",
  "│  寻求:    有趣的问题和合作",
  "└─────────────────────────────────────────",
  "",
  "> 提示: 这个网站一共有 3 个隐藏彩蛋。",
  "> 你找到了第一个，干得漂亮。",
  "",
  "[ 按任意键或点击关闭 ]",
];

function getLocale(): "zh" | "en" {
  if (typeof document === "undefined") return "en";
  return document.documentElement.getAttribute("data-locale") === "zh" ? "zh" : "en";
}

function KonamiOverlay({ onDismiss }: { onDismiss: () => void }) {
  const [visibleLines, setVisibleLines] = useState<number>(0);
  const [glitch, setGlitch] = useState(true);
  const locale = getLocale();
  const lines = locale === "zh" ? TERMINAL_LINES_ZH : TERMINAL_LINES_EN;

  useEffect(() => {
    // Glitch phase
    const glitchTimer = setTimeout(() => setGlitch(false), 400);

    // Typewriter lines
    let i = 0;
    const lineTimer = setInterval(() => {
      i++;
      setVisibleLines(i);
      if (i >= lines.length) clearInterval(lineTimer);
    }, 65);

    return () => {
      clearTimeout(glitchTimer);
      clearInterval(lineTimer);
    };
  }, [lines.length]);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      onClick={onDismiss}
      role="dialog"
      aria-modal="true"
      aria-label="Easter egg activated"
    >
      {/* Dark backdrop with scanlines */}
      <div className={[
        "absolute inset-0 bg-[#000a00]/97 transition-all duration-300",
        glitch ? "animate-[konami-glitch_0.1s_ease_3]" : "",
      ].join(" ")} />

      {/* CRT scanline overlay */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,80,0.15) 2px, rgba(0,255,80,0.15) 4px)",
        }}
      />

      {/* Vignette */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: "radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.7) 100%)",
        }}
      />

      {/* Terminal window */}
      <div
        className={[
          "relative mx-4 w-full max-w-[600px] rounded-sm border border-[#00ff50]/30 bg-[#000d00]/90 p-6 font-mono shadow-[0_0_60px_rgba(0,255,80,0.15)] transition-all duration-500",
          glitch ? "scale-95 opacity-0" : "scale-100 opacity-100",
        ].join(" ")}
      >
        {/* Blinking top bar */}
        <div className="mb-4 flex items-center gap-2 border-b border-[#00ff50]/10 pb-3">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-[#00ff50]" />
          <span className="text-[10px] uppercase tracking-[0.4em] text-[#00ff50]/60">terminal session active</span>
        </div>

        {/* Terminal lines */}
        <div className="space-y-0.5">
          {lines.slice(0, visibleLines).map((line, i) => (
            <div
              key={i}
              className={[
                "text-[12px] leading-6 tracking-wide",
                line.startsWith("┌") || line.startsWith("│") || line.startsWith("└")
                  ? "text-[#00ff50]/90"
                  : line.startsWith("> ✓")
                        ? "font-bold text-[#00ff50]"
                        : line.startsWith("> ")
                      ? "text-[#00cc40]/80"
                      : line.startsWith("AI_SITE") || line.startsWith("─")
                        ? "font-bold text-[#00ff50]"
                        : line.startsWith("[ ")
                          ? "animate-pulse text-center text-[11px] text-[#00ff50]/50"
                          : "text-[#00aa30]/60",
              ].join(" ")}
            >
              {line || "\u00a0"}
            </div>
          ))}
          {/* Blinking cursor */}
          {visibleLines < lines.length && (
            <span className="inline-block h-3.5 w-2 animate-[blink_0.8s_step-end_infinite] bg-[#00ff50]" />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Easter Eggs Component ───────────────────────────────────────────────

export function EasterEggs() {
  const [konamiActive, setKonamiActive] = useState(false);
  const konamiProgress = useRef<string[]>([]);

  const dismissKonami = useCallback(() => setKonamiActive(false), []);

  // Konami code detector
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (konamiActive) {
        setKonamiActive(false);
        return;
      }

      konamiProgress.current = [...konamiProgress.current, e.key].slice(-KONAMI_SEQUENCE.length);

      if (
        konamiProgress.current.length === KONAMI_SEQUENCE.length &&
        konamiProgress.current.every((k, i) => k === KONAMI_SEQUENCE[i])
      ) {
        konamiProgress.current = [];
        setKonamiActive(true);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [konamiActive]);

  if (!konamiActive) return null;

  return <KonamiOverlay onDismiss={dismissKonami} />;
}
