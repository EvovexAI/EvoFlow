"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { usePathname } from "next/navigation";
import { useIsMobile } from "@/hooks/use-is-mobile";

interface RemoteCursor {
  id: string;
  x: number;
  y: number;
  name: string;
  color: string;
  page: string;
  targetX: number;
  targetY: number;
}

const THROTTLE_MS = 60;
const LERP_FACTOR = 0.18;

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function CursorSvg({ color }: { color: string }) {
  return (
    <svg
      width="18"
      height="22"
      viewBox="0 0 18 22"
      fill="none"
      style={{ filter: `drop-shadow(0 1px 3px rgba(0,0,0,0.4))` }}
    >
      <path
        d="M1.5 1L16 12.5L9 13.5L6 21L1.5 1Z"
        fill={color}
        stroke="rgba(0,0,0,0.3)"
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LiveCursorsInner() {
  const [cursors, setCursors] = useState<Map<string, RemoteCursor>>(new Map());
  const cursorsRef = useRef<Map<string, RemoteCursor>>(new Map());
  const localIdRef = useRef<string>("");
  const pathname = usePathname();
  const lastSendRef = useRef(0);
  const rafRef = useRef(0);
  const [visible, setVisible] = useState(false);
  const isMobile = useIsMobile();

  useEffect(() => {
    if (!localIdRef.current) {
      localIdRef.current = generateId();
    }
  }, []);

  // SSE: receive remote cursors
  useEffect(() => {
    if (isMobile) return;
    const id = localIdRef.current;
    if (!id) return;

    const es = new EventSource(`/api/cursors?id=${encodeURIComponent(id)}`);
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as Array<{
          id: string;
          x: number;
          y: number;
          name: string;
          color: string;
          page: string;
        }>;

        const map = cursorsRef.current;
        const seen = new Set<string>();

        for (const c of data) {
          if (c.page !== pathname) continue;
          seen.add(c.id);
          const existing = map.get(c.id);
          if (existing) {
            existing.targetX = c.x;
            existing.targetY = c.y;
            existing.name = c.name;
            existing.color = c.color;
            existing.page = c.page;
          } else {
            map.set(c.id, {
              ...c,
              targetX: c.x,
              targetY: c.y,
            });
          }
        }

        // Remove cursors no longer in the stream or on different pages
        for (const [cid] of map) {
          if (!seen.has(cid)) map.delete(cid);
        }

        cursorsRef.current = map;
      } catch { /* ignore parse errors */ }
    };

    return () => es.close();
  }, [pathname, isMobile]);

  // Animation loop: smooth interpolation
  useEffect(() => {
    let running = true;

    function tick() {
      if (!running) return;

      const map = cursorsRef.current;
      let changed = false;

      for (const [, c] of map) {
        const dx = c.targetX - c.x;
        const dy = c.targetY - c.y;
        if (Math.abs(dx) > 0.0001 || Math.abs(dy) > 0.0001) {
          c.x += dx * LERP_FACTOR;
          c.y += dy * LERP_FACTOR;
          changed = true;
        }
      }

      if (changed || map.size !== cursors.size) {
        setCursors(new Map(map));
      }

      setVisible(map.size > 0);
      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [cursors.size]);

  // POST: send local cursor position
  const sendPosition = useCallback(
    (x: number, y: number) => {
      const now = Date.now();
      if (now - lastSendRef.current < THROTTLE_MS) return;
      lastSendRef.current = now;

      const id = localIdRef.current;
      if (!id) return;

      void fetch("/api/cursors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, x, y, page: pathname }),
        keepalive: true,
      }).catch(() => {});
    },
    [pathname],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const x = e.clientX / window.innerWidth;
      const y = e.clientY / window.innerHeight;
      sendPosition(x, y);
    };

    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, [sendPosition]);

  if (isMobile || !visible || pathname.startsWith("/r/") || pathname === "/resume") {
    return null;
  }

  const entries = Array.from(cursors.values());

  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        pointerEvents: "none",
        overflow: "hidden",
      }}
    >
      {entries.map((c) => (
        <div
          key={c.id}
          style={{
            position: "absolute",
            left: `${c.x * 100}%`,
            top: `${c.y * 100}%`,
            transform: "translate(-1px, -1px)",
            transition: "opacity 0.3s ease",
            willChange: "left, top",
          }}
        >
          <CursorSvg color={c.color} />
          <span
            style={{
              display: "block",
              marginTop: 2,
              marginLeft: 14,
              padding: "2px 8px",
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 500,
              lineHeight: "16px",
              color: "#fff",
              backgroundColor: c.color,
              whiteSpace: "nowrap",
              boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
              opacity: 0.9,
            }}
          >
            {c.name}
          </span>
        </div>
      ))}
    </div>
  );
}

export function LiveCursors() {
  if (process.env.NEXT_PUBLIC_STATIC_EXPORT === "1") {
    return null;
  }
  return <LiveCursorsInner />;
}
