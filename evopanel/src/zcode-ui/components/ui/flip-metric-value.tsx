import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/components/lib/utils.js";

const FLIP_TRANSITION = {
  duration: 0.16,
  ease: [0.4, 0, 0.2, 1],
} as const;

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setPrefersReducedMotion(query.matches);
    };
    update();

    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", update);
      return () => {
        query.removeEventListener("change", update);
      };
    }

    query.addListener(update);
    return () => {
      query.removeListener(update);
    };
  }, []);

  return prefersReducedMotion;
}

function isDigitCharacter(character: string) {
  return /^[0-9]$/.test(character);
}

function getCharacterWidthClass(character: string) {
  if (isDigitCharacter(character)) {
    return "w-[0.66em]";
  }
  if (character === ":" || character === ".") {
    return "w-[0.34em]";
  }
  return "w-[0.7em]";
}

function MetricCharacter({
  character,
  index,
  reducedMotion,
  animateInitial,
}: {
  character: string;
  index: number;
  reducedMotion: boolean;
  animateInitial: boolean;
}) {
  const widthClass = getCharacterWidthClass(character);

  // 数字槽以前用 baseline + 负偏移，冒号和 K/M 单位走静态 inline，
  // 混排时视觉中线不一致；所有字符统一固定高度并居中，翻页只发生在槽内。
  if (!isDigitCharacter(character) || reducedMotion) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex h-[1.15em] shrink-0 items-center justify-center leading-none",
          widthClass,
        )}
      >
        {character}
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-flex h-[1.15em] shrink-0 items-center justify-center overflow-hidden leading-none [perspective:8em]",
        widthClass,
      )}
    >
      <AnimatePresence initial={animateInitial}>
        <motion.span
          key={`${index}-${character}`}
          className="absolute inset-0 flex items-center justify-center leading-none"
          initial={{ rotateX: -90, y: "-0.45em", opacity: 0 }}
          animate={{ rotateX: 0, y: 0, opacity: 1 }}
          exit={{ rotateX: 90, y: "0.45em", opacity: 0 }}
          style={{ transformOrigin: "50% 50%" }}
          transition={FLIP_TRANSITION}
        >
          {character}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

export function FlipMetricValue({
  value,
  className,
  animateInitial = false,
}: {
  value: string;
  className?: string;
  animateInitial?: boolean;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const characters = useMemo(() => Array.from(value), [value]);

  return (
    <span
      aria-label={value}
      data-animate-initial={animateInitial ? "true" : undefined}
      className={cn(
        "inline-flex max-w-full items-center overflow-hidden whitespace-nowrap align-middle leading-none",
        className,
      )}
      role="text"
      title={value}
    >
      {characters.map((character, index) => (
        <MetricCharacter
          key={index}
          character={character}
          index={index}
          reducedMotion={reducedMotion}
          animateInitial={animateInitial}
        />
      ))}
    </span>
  );
}
