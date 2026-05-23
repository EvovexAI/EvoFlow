"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Scroll-triggered reveal hook.
 * Returns `inView: true` once the element enters the viewport, then stops observing.
 */
export function useInView(threshold = 0.15) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let obs: IntersectionObserver | null = null;

    const reveal = () => {
      setInView(true);
      if (obs) { obs.disconnect(); obs = null; }
    };

    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight && rect.bottom > 0) {
      reveal();
      return;
    }

    obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) reveal(); },
      { threshold },
    );
    obs.observe(el);
    return () => { if (obs) obs.disconnect(); };
  }, [threshold]);

  return { ref, inView };
}
